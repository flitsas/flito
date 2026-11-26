# ADR-0049 — Un trámite FLITO anulado, abortado o revocado no existe

- **Estado:** Aceptado (David Chica, 2026-11-26, con las respuestas de producto de «Decisiones de producto cerradas»)
- **Fecha:** 2026-11-26
- **Épica:** ADO #14707, trabajada en modo EPICA (sin Features ni HUs). Rama `EPICA/14707-davidchica-tramite-anulado-no-existe`. Entrega en 3 PRs en serie.
- **Supersedes:** ninguno. **Relacionados:** ADR-0031 (SOAT actual por VIN e índices únicos parciales «abierto», migración 0267), ADR-0006 (llave `salida:soat:<soatId>` de la bolsa), ADR-0041 §13.8 (primer trámite por SOAT compartido), ADR-0043 / ADR-0047 (Torre, RN-TOR-L1 «liquidación vigente»), ADR-DB-001 (el runner envuelve cada migración en una transacción).
- **Módulos:** todos FLITO (`flito-*`, montados bajo `/api/flito/...`). No toca los módulos legacy `soat`, `tramites` ni `liquidacion`. Módulo nuevo `flito-avisos`.
- **Documento de detalle:** [`docs/diseno/epica-14707-tramite-muerto.md`](../diseno/epica-14707-tramite-muerto.md). Ahí están el contrato, el modelo Drizzle, el SQL propuesto, el diagrama Mermaid y los archivos de cada bloque.

## Contexto

El humano fijó la regla madre: si FLIT anula, aborta o revoca un trámite (`flito_tramites`), FLITO lo trata como si **no existiera**. El caso real es un trámite anulado por un error de VIN, placa o documento y vuelto a crear con los datos corregidos. Hoy las solicitudes, los pagos y los soportes del trámite anulado siguen vivos y generan duplicados: hay dos impuestos solicitados para el mismo vehículo, el SOAT del anulado sigue en la cola del proveedor, y el trámite nuevo hereda un SOAT pagado con datos que pueden estar mal.

Las decisiones D1 a D12 vienen del humano y no se reabren aquí. Este ADR decide cómo cumplirlas. Lo que hay hoy en el código:

1. **El estado de muerte no está unificado.** FLIT 2 ya escribe `estado='anulado'` para `anulado` y `revocado` (`flit2-mapeo.ts`). FLIT 1 deja `estado=NULL` para `Revocado` y `Abortado` (`estadoEnumDesdeFlit`). Torre tiene su propia lista por `flit_estado` (`ESTADOS_FLIT_ANULADOS`). `ESTADOS_TRAMITE_FLITO_TERMINADOS` incluye `rechazado`, que no es muerte (D1).
2. **El SOAT es del VIN, no del trámite** (`flito_tramites.soat_id`, `soatActualDelVin`): N trámites comparten uno. El impuesto, en cambio, es 1:1 con el trámite (`flito_impuestos.tramite_id UNIQUE`).
3. **«Terminal» hoy solo es `pagado`.** Tanto en shared-types (`ESTADOS_SOAT_TERMINALES`, `soatEstaAbierto`) como en el SQL: hay 9 literales `<> 'pagado'` y los índices únicos parciales `uq_flito_soat_vin_abierto` y `uq_flito_soat_vehiculo_abierto`.
4. **Casi ninguna acción de avance comprueba que el trámite siga vivo.** Varias sí comprueban el estado del SOAT o del impuesto (enviar exige `pendiente`, cargar factura exige `solicitado`, reactivar exige `con_novedad`).
5. **`flito-soat.service.ts` ya llegó a su techo congelado** (1068 líneas efectivas, ratchet de `eslint.config.mjs`). No admite ni una línea neta más.
6. **FLITO no tiene bandeja de avisos por usuario.**

## Alternativas

### Opción 1 — Descarte en la misma transacción del sync, estado `descartado` y saneo SQL único (recomendada)

Cuando un trámite pasa de vivo a muerto, `escribirTramite` (común a FLIT 1 y FLIT 2) llama a un orquestador de descarte en la misma transacción. El orquestador aplica D3, D5, D6, D9 y D11. SOAT e impuesto ganan el valor de enum `descartado`, que es terminal. Un trigger de la base impide que una fila salga de `descartado`. Los muertos que ya existen se sanean una sola vez con una migración SQL, sin avisos y sin mover dinero.

- **Pros:** el muerto y su descarte se confirman juntos o no se confirma ninguno, así que no hay ventana en la que el SOAT de un muerto siga en una cola. Como `descartado` no es un estado de origen válido en ninguna transición existente, la mayoría de las acciones lo rechazan sin tocar su código. Las lecturas que filtran `estado='pagado'` (finanzas, Torre, conciliación) lo excluyen solas. Un único punto de entrada cubre las dos fuentes de FLIT.
- **Contras:** la transacción del sync crece en los trámites que mueren, aunque es un evento raro. Hay que cambiar a mano los 9 literales `<> 'pagado'` y los dos índices. Añadir un valor al enum obliga a tocar los `Record<EstadoSoat|EstadoImpuesto, …>` del web.
- **Esfuerzo:** L, repartido en 3 PRs.
- **Riesgos:** la trampa de `ALTER TYPE … ADD VALUE` (55P04), que se resuelve con dos archivos como en el precedente 0275/0276. Bloqueos entre el sync y una desaplicación manual simultánea, que se mitigan con `SKIP LOCKED` en los comprobantes. Las cifras históricas cambian tras el saneo.

### Opción 2 — Que el muerto «no exista» solo en las lecturas

No se toca ni el SOAT ni el impuesto. Cada lectura y cada acción hace JOIN con `flito_tramites` y filtra con el predicado.

- **Pros:** sin migración de estado ni enum nuevo. Esfuerzo inicial S/M.
- **Contras:** **no cumple D3 ni D5.** Un SOAT compartido no tiene un trámite único con el que hacer el JOIN. Un `pagado` del muerto sigue bloqueando el impuesto del vehículo (`impuestoBloqueantePorVehiculo`) y el SOAT del VIN (`soatActualDelVin`), así que el trámite nuevo nunca «arranca de cero». Los índices «abierto» siguen bloqueando el SOAT nuevo. Además, cada lectura nueva que alguien escriba sin el JOIN vuelve a contar muertos, y ningún test lo detectaría.
- **Esfuerzo:** M al principio, deuda permanente después.
- **Riesgos:** es exactamente la clase de defecto silencioso que la Épica quiere cerrar.

### Opción 3 — Descarte asíncrono con un reconciliador (cron) sobre una marca `descarte_pendiente`

El sync solo marca al trámite. Un cron aparte aplica el descarte por lotes, con reintentos.

- **Pros:** saca la lógica del sync y permite reintentar. El saneo histórico usaría el mismo código.
- **Contras:** entre la marca y el cron hay una ventana en la que el SOAT o impuesto del muerto se puede enviar, pagar o aplicar. Sería precisamente el duplicado que se quiere evitar. Añade un proceso más que vigilar, y hace falta igualmente un guard que mire la marca.
- **Esfuerzo:** M/L.
- **Riesgos:** la ventana de carrera. También, que el cron se quede atrás sin que nadie lo vea.

## Decisión

**Opción 1.** Cada punto que el pedido exige decidir:

### 1. Un solo predicado, y cómo se distingue revocado

- **Muerto ⇔ `flito_tramites.estado = 'anulado'`**, que es el estado propio de FLITO y tiene índice (`idx_flito_tramites_estado`). **Vivo ⇔ `estado IS DISTINCT FROM 'anulado'`**: un `NULL` (borrador, preparado…) cuenta como vivo.
- FLIT 1 pasa a mapear `Abortado` y `Revocado` a `anulado` (D1), igual que FLIT 2. La migración 0318 corrige las filas que ya existen, antes de que arranque el código nuevo.
- **Revocado se distingue por `lower(flit_estado) = 'revocado'`**, y abortado por `'abortado'`. **No se añade el valor `revocado` a `flito_tramite_estado`:** habría que pasar otra vez por la trampa 55P04, FLIT 2 ya modela revocado así y la distinción solo se usa para presentar el chip (D7, D8) y para decidir D11.
- Hay **un solo sitio** para cada lado:
  - shared-types: `packages/shared-types/src/flito-tramite-vigencia.ts`, con `VigenciaTramite = 'vigente' | 'anulado' | 'abortado' | 'revocado'`, `vigenciaTramite(estado, flitEstado)` y `CODIGO_TRAMITE_NO_VIGENTE`.
  - api: `apps/api/src/shared/tramite-vigente.ts`, con los fragmentos SQL `TRAMITE_MUERTO` / `TRAMITE_VIVO`, `exigirTramiteVivo` y `TramiteNoVigenteError`. Como en `cliente-operable.ts`, este archivo no importa de ningún módulo, para no abrir ciclos.
- Torre deja de declarar su lista: `ESTADOS_FLIT_ANULADOS` y `LIQUIDACION_VIGENTE` pasan a apoyarse en el predicado compartido. Tras el backfill la semántica de RN-TOR-L1 es la misma. `ESTADOS_TRAMITE_FLITO_TERMINADOS` **no se reutiliza para esto**, porque incluye `rechazado`.

### 2. Modelo del descarte

- `flito_soat_estado` y `flito_impuesto_estado` ganan **`descartado`**, que es terminal. `ESTADOS_SOAT_TERMINALES` queda en `['pagado', 'descartado']`, de modo que `soatEstaAbierto` sigue diciendo la verdad. Se añaden `ESTADOS_SOAT_OPERATIVOS` y `ESTADOS_IMPUESTO_OPERATIVOS` (todos menos `descartado`) para reemplazar los `Object.values(Estado*)` de colas, tablero y filtros.
- **Columnas nuevas:**
  - En `flito_soat`: `descartado_en`, `motivo_descarte` (`anulado|abortado|revocado`, CHECK), `descartado_por_tramite_id` y **`tramite_origen_id`**.
  - En `flito_impuestos`: `descartado_en` y `motivo_descarte`. El trámite ya lo da `tramite_id`.
  - El CHECK `(estado='descartado') = (descartado_en IS NOT NULL AND motivo_descarte IS NOT NULL)` está en las dos tablas.
  - Las dos referencias nuevas a `flito_tramites` van **sin FK dura**. Una FK cerraría el ciclo `flito_tramites.soat_id ↔ flito_soat`, igual que pasaba con `factura_venta_soporte_id`. Las filas de `flito_tramites` nunca se borran.
- Los índices `uq_flito_soat_vin_abierto` y `uq_flito_soat_vehiculo_abierto` se recrean con `WHERE estado NOT IN ('pagado','descartado')`, con el mismo nombre. Los 9 literales `<> 'pagado'` pasan a un fragmento único, `SOAT_ABIERTO`, en `flito-soat-actual.ts`. `soatActualDelVin` excluye `descartado`.
- **El `soat_id` del muerto se conserva.** Es historia y auditoría, y ninguna lectura lo cuenta porque todas excluyen muertos. Los vivos que se desligan por D3a pierden su `soat_id` y el cambio queda en la bitácora.
- **Trigger `flito_descartado_terminal`** (BEFORE UPDATE OF estado) en las dos tablas: salir de `descartado` lanza `ERRCODE 'FL409'`, que `errorHandler` traduce a 409 `TRAMITE_NO_VIGENTE`. Es la red de seguridad del archivo congelado y de las carreras. Solo vigila el estado: los crons de retención (Ley 1581) pueden seguir limpiando columnas de una fila descartada.
- **Quién originó el SOAT (D3):** se elige la **columna `tramite_origen_id`** y no «el trámite ligado más antiguo». La regla del más antiguo cambia cuando D3a desliga vivos, y además no separa el canal Cliente. La columna la escribe `resolverSoat` al dar de alta y queda en NULL para el canal Cliente y el masivo. El backfill toma el primer trámite ligado por `(created_at, id)`, la misma regla que ya usa ADR-0041 §13.8.

### 3. Dónde se dispara

- En **`escribirTramite`** (`flito-sync.service.ts`), dentro de la misma transacción y después del UPDATE, cuando `existente` estaba vivo y la fila escrita está muerta. Llama a `descartarDeTramiteMuerto(tx, tramite, { avisar: true })`, en el archivo nuevo `flito-sync/descarte-tramite-muerto.ts`. Así cubre FLIT 1 y FLIT 2 sin duplicar código, sin tocar el webhook ni la lectura a demanda (D2).
- Un trámite que **llega ya muerto** en su alta no tiene nada ligado, porque solo se arranca en `Asignado`. No hace nada.
- **Saneo único de los muertos que ya existen:** una **migración SQL**, la 0319. No se usa un job, porque no hay `db-apply` manual en ningún ambiente remoto y el initContainer es el único ejecutor garantizado. Sin avisos, sin mover dinero (no aplica D11) y sin desligar vivos (no aplica D3a). El SOAT pagado que comparte un vivo se conserva en lo histórico. Las reglas exactas están en el documento de diseño, §5.

**Reglas del SOAT al morir un trámite M.** S es su SOAT y V son los otros trámites vivos ligados a S:

| Caso | Qué pasa |
|---|---|
| S del canal Cliente (`origen='cliente'`) | No se toca: no lo originó ningún trámite. |
| S ya `descartado` | Nada (idempotente). |
| S abierto y V no está vacío (D3b) | Sigue vivo. D9: `compania_id` y `organismo_codigo` pasan a los del vivo más antiguo, si difieren, con auditoría. |
| S abierto y V vacío (D3c) | `descartado`. Si estaba `solicitado`, se avisa a `enviado_por_id` (D6). |
| S `pagado` y originado por M (D3a) | `descartado`, **salvo que un vivo de V ya lo haya consumido** (`entregado`/`aprobado` o `fecha_aprobacion` no nula). En ese caso se conserva y se audita. Los vivos de V que no lo consumieron se desligan y, si cumplen las condiciones de arranque (las mismas de la línea 230 del sync), arrancan SOAT nuevo **en la misma transacción**. Esto no puede esperar al cron, porque FLIT 2 es incremental y no vuelve a leer un trámite que no cambió. |
| S `pagado` originado por otro trámite o sin originador | No se toca. |

**Impuesto de M:** 1:1, así que siempre pasa a `descartado`, en cualquier estado (D5). Si estaba `solicitado`, se avisa (D6). `impuestoBloqueantePorVehiculo` deja de verlo por estado, de modo que el trámite nuevo arranca de cero. Esto **invierte a propósito** el comentario actual («un `pagado` sigue bloqueando aunque su trámite esté anulado»), por orden de D5.

### 4. Guard y lista de acciones

- `exigirTramiteVivo(tx, tramiteId)` lee la fila con `FOR SHARE` dentro de la transacción de la acción, igual que `exigirClienteOperable`. Choca con el UPDATE del sync, así que no hay ventana. Si el trámite está muerto lanza `TramiteNoVigenteError`: 409, `code: 'TRAMITE_NO_VIGENTE'`, con `vigencia`. **`errorHandler` lo mapea de forma global**, siguiendo el precedente de `AlcanceAjenoError`. Así un router que lo olvide no responde 500.
- **Variante SOAT:** la vigencia de un SOAT se mide por **su estado**, no por un trámite, porque un SOAT compartido sigue vivo aunque muera uno de sus trámites (D3b). Se usa `exigirSoatVigente(soat)` (`estado !== 'descartado'`) más el trigger. `exigirImpuestoVigente(impuesto)` funciona igual.
- **Acciones de avance (bloqueadas):** solicitar SOAT, impuestos o ambos; desbloquear autogestión; las acciones de SOAT (enviar al gestor, reactivar, cambiar proveedor, asumir en Operaciones, cargar factura, carga masiva, documentos); las de impuestos (enviar, reactivar, certificar, recibos, recibo de caja, reemplazar pago, dirección, documento-factura, reanalizar); los crons `flito-impuestos-analisis` y `envio-flit1/flit2`; logística (viajes, traslados, actas, cerrar lote); liquidar; elegibilidad Siigo; aplicar comprobante; resolver revisión; asignar servicio adicional. Las acciones **en lote filtran y omiten** al muerto dentro del grupo «no habilitado» que ya existe, sin 409 y sin cambiar el contrato. Las **individuales responden 409**.
- **Acciones de salida (permitidas):** rechazar, reversar (nunca *desde* `descartado`: lo impiden la ruta y el trigger), devolver al gestor, desaplicar comprobante (con un dueño `descartado` no se revierte el dueño, solo se libera el comprobante), quitar viaje o servicio, anular traslado y reversar liquidación.
- La tabla completa, con archivo y mecanismo de cada acción, está en el documento de diseño, §6.
- **`flito-soat.service.ts` no crece:** cada guard es una llamada de una línea que reemplaza una comprobación existente. Los helpers `noAdmiteTraspaso` y el validador de motivo se mudan a `flito-soat/flito-soat-vigente.ts`, lo que libera líneas. El archivo tiene que cerrar en ≤ 1068 efectivas, y lo ideal es que baje el techo.

### 5. D11: liberar comprobantes y bolsa

- Se **reutiliza la desaplicación existente** (`flito-comprobantes.desaplicar.ts`). Se extrae su núcleo con la opción `dueno: 'conservar'`: no ejecuta el paso 5 (revertir dueño, porque el dueño ya es `descartado`), pero sí el 4 (`exigirDescuentoReversible` y `revertirDescuentoComprobante`, que además libera la llave `salida:soat:<soatId>`) y el 6 (el comprobante vuelve a `pendiente` sin trámite, de vuelta a la cola).
- **Alcance:**
  - Se liberan los comprobantes aplicados del concepto (`soat` / `impuesto`) del trámite M cuando M es anulado o abortado.
  - También se liberan **siempre** los de los vivos desligados por D3a, porque pagaban un SOAT que ahora está descartado.
  - Si M es revocado, sus propios comprobantes **no** se liberan (D11).
- Los comprobantes se leen con **`FOR UPDATE SKIP LOCKED`**. Un comprobante bloqueado está siendo desaplicado o aplicado por otra persona. La aplicación acabará en el guard del trámite, y se evita el bloqueo cruzado con el orden comprobante → trámite que usa `desaplicar`.
- Si el periodo de la bolsa está cerrado (`PeriodoCerradoError`), el comprobante **no se libera** y la transacción sigue: es una comprobación de aplicación, no un error de SQL. Se registra con `auditSistema` y en el contador del sync. Ver los riesgos abiertos.
- Las salidas de bolsa que **no vienen de un comprobante** (conciliación, sellado) no se revierten automáticamente. Ver los riesgos abiertos.

### 6. D8: revocado ya cobrado

- Ninguna columna ni tabla nueva. Liquidación, factura Siigo, logística y derecho de tránsito se conservan como están.
- Las lecturas que listan trámites en esas pantallas (detalle del trámite, bandeja Siigo, documentos de logística) añaden **`vigenciaTramite`** a su DTO, y el web pinta el chip «Revocado» con el tono del kit que ya existe.
- Las acciones nuevas las impide el guard: liquidar, elegibilidad Siigo y logística. El derecho de tránsito **sigue sumando como costo histórico** y no se asocia al trámite nuevo. Su SOAT y su impuesto sí pasan a `descartado` (D5) y salen de los reportes.

### 7. Avisos

- Tabla mínima `flito_avisos_usuario`. Guarda **solo referencias** (`usuario_id`, `tipo`, `concepto`, `registro_id`, `tramite_id`, `motivo`, `creado_en`, `visto_en`) y tiene un único `(usuario_id, tipo, concepto, registro_id)` para que sea idempotente.
- Endpoints (contrato implementado en el Bloque 2; los tipos están en `packages/shared-types/src/flito-avisos.ts`):
  - `GET /api/flito/avisos`, **sin query string**. Devuelve los avisos **no vistos** del usuario, del más reciente al más antiguo y como mucho 50, con el conteo total: `{ avisos, noVistos }`.
  - `POST /api/flito/avisos/visto` con body `{ ids: uuid[] }` (de 1 a 200). Recibe la lista **exacta** que la pantalla mostró, nunca «todos», para no ocultar un retiro que llegó después. Responde `200 { marcados }`: los avisos propios que pasaron de no vistos a vistos. Es idempotente. Un id ajeno o inexistente se **ignora** y da la misma respuesta que uno ya visto, así que no hay 404 ni pistas de que exista.
  - Los dos llevan `authMiddleware`, sin `requireRole`, y filtran **siempre** por `usuario_id = req.user.sub`. Son rutas de sesión: están en `RUTAS_TRANSVERSALES` (`shared/middleware/frontera-enlace.ts`). Así los alcanza también un usuario **con enlace** (compañía cliente, proveedor u organismo), que ve solo sus avisos. Lo decidió el humano el 2026-11-26.
- **Retención:** un aviso visto se borra a los 90 días y uno sin ver a los 180, con un cron diario (`flito-avisos.cron.ts`, a las 04:00 hora de Colombia, con candado `flito-avisos-purga`). No tiene puerta por variable de entorno porque el aviso solo guarda referencias.

### 8. PII y Ley 1581

- El aviso **no guarda la placa ni ningún dato del titular**. La placa y el radicado FLIT se resuelven con JOIN al leer, y el radicado no es dato personal. La respuesta proyecta la placa (cuasi-PII), que es la misma clase de dato que el usuario ya veía en la cola donde envió la solicitud. No proyecta nombre, documento ni contacto del titular. Por eso, a juicio de este diseño, no hay registro en `pii_access_log`: las columnas personales del titular quedan fuera del §16. **La confirmación le corresponde a `security-agent`.**
- No hay PII en las URLs.
- Los logs del descarte solo llevan ids, conceptos y conteos. Nunca VIN ni placa: el `detail` de `auditSistema` usa el radicado y el id del SOAT. El mensaje actual del sync que interpola el VIN es deuda previa (Nota) y no se copia.

### 9. Riesgos y cómo se mitigan

- **`ALTER TYPE … ADD VALUE`**: el runner envuelve cada archivo en `sql.begin()`. Por eso la 0317 **solo** añade los dos valores (`IF NOT EXISTS`), y la 0318 y la 0319, que los usan en CHECK, índices, trigger y UPDATE, van en archivos aparte, como el precedente 0275/0276.
- **Backfill de FLIT 1:** lo hace la 0318 antes de que arranque el código nuevo, porque el initContainer corre primero. Si un pod viejo escribe un `Abortado` con `estado=NULL` durante el rollout, el siguiente tick del código nuevo lo ve como un cambio (`NULL → anulado`) y dispara la transición normal, con aviso. No hay hueco.
- **Carreras con el cron:** el guard de trámite usa `FOR SHARE` frente al UPDATE del sync. El SOAT y el impuesto se leen `FOR UPDATE` en el descarte, y el trigger impide revivir una fila. El único caso que queda es una acción manual que leyó la fila sin bloquearla y escribe después del descarte. El trigger la rechaza con 409, y el archivo ya subido a S3 queda huérfano: es una Nota y lo recoge la purga existente si aplica. Los avisos usan `ON CONFLICT DO NOTHING`.
- **Presupuesto de 800 líneas:** `flito-soat.service.ts` está en su techo (1068) y su crecimiento neto tiene que ser ≤ 0. El resto de archivos tocados tiene margen (`flito-sync.service.ts` 362, `flito-impuestos.service.ts` 549, `flito-tramites.service.ts` 574, `flito-liquidacion.service.ts` 655). La lógica nueva va en archivos nuevos.
- **Cifras históricas:** tras la 0319 los reportes de finanzas y Torre de periodos pasados bajan, porque los SOAT e impuestos de muertos salen. Es lo que se busca (D5), pero hay que comunicarlo al PO antes del deploy a PDN.

## Consecuencias

- `descartado` pasa a ser vocabulario de dos enums que consume todo FLITO. Toda lectura nueva que cuente SOAT o impuestos tiene que usar `ESTADOS_*_OPERATIVOS` o filtrar `pagado`, nunca `Object.values`.
- CA-03 («anular y recrear no vuelve a adquirir») **cambia** para el SOAT pagado originado por el muerto (D3a). Se mantiene para los SOAT abiertos (D3b) y para los pagados de otro origen.
- La bandeja de avisos queda como infraestructura mínima. Otros tipos de aviso necesitarán ampliar el CHECK de `tipo` con una migración.

## Decisiones de producto cerradas (2026-11-26)

El humano las respondió en la sesión. Todas coinciden con el valor por defecto del diseño.

1. **D3a con un vivo que ya consumió el SOAT:** el pagado **no** se descarta si un vivo ligado ya está `entregado`/`aprobado`, y queda auditado.
2. **Saneo histórico:** solo descarta y reasigna compañía/organismo. No desliga vivos ni libera comprobantes ni bolsa.
3. **D11 con el periodo de la bolsa cerrado, o salida por conciliación o sellado:** no se libera. Queda en la auditoría y Finanzas lo corrige a mano.
4. **SOAT del canal Cliente ligado a un muerto:** no se descarta.
5. **Trámite muerto que FLIT vuelve a poner vivo:** lo descartado no revive y el trámite arranca SOAT nuevo. El impuesto no se recrea y la anomalía queda auditada.
6. **Totales de finanzas:** los valores de un **revocado** (liquidación, derecho, logística) **suman** en los totales, con chip «Revocado». Anulado y abortado no suman.
7. **Avisos:** solo a quien envió la solicitud (`enviado_por_id`), no al gestor ni al proveedor.
