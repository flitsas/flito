# Diseño slim — Feature #14012: SOAT sin trámite, tipo Inicial / Renovación en la solicitud individual

**Modo:** slim (extensión del alta del canal Cliente y de las incompletas) · **Épica:** #13760 · **ADR:** [ADR-0030](adr/ADR-0030-flito-soat-renovacion-runt-por-placa-e-incompletas-multimodalidad.md) (Propuesto) · **Módulo:** `flito-soat`, canal Cliente (**no** el `soat/` legacy) · **Precedentes:** ADR-0008, ADR-0010, ADR-0019, ADR-0012

**Actualizado 2026-10-27 (decisión del humano sobre P-1):** la renovación cubre SOAT ya gestionados por FLITO. El cambio de modelo (varios SOAT por vehículo, uno abierto) va **antes** y está en [diseno-feature-14012-modelo-varios-soat-por-vehiculo.md](diseno-feature-14012-modelo-varios-soat-por-vehiculo.md) / [ADR-0031](adr/ADR-0031-flito-soat-varios-soat-por-vehiculo-uno-abierto.md): la migración `0267` es suya, por eso las de este documento pasaron a **0268** (tipo + `soat_anterior_id`) y **0269** (incompletas). Cuando este documento dice «RN-01 se conserva tal cual» o "`verificarRn01` bloquea cualquier fila", rige el ADR-0031 (bloquea solo un SOAT **abierto**; el terminal es el antecesor).

Medido sobre `develop` c93dbf36. Los números de migración (0268, 0269) y de ADR (0030, 0031) se **recomprueban** al implementar: hay sesiones en paralelo que también los crean.

F2/F3 (carga masiva) **no** se implementan aquí; el modelo de §3 los deja entrar sin otra migración de vocabulario.

---

## 0. Riesgo principal: consulta RUNT por placa + documento sin tipo de documento

### 0.1 Qué hace hoy el código (evidencia)

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Existe la modalidad placa + documento? | Sí. `consultarVehiculoRunt(placa, vin?, documento, tipoDocumento?)` exige documento cuando no hay VIN | `apps/api/src/modules/runt/runt.service.ts:132-134` |
| ¿Qué vía se usa? | `useCeaProxy()` ⇒ pasarela Kyverum; si no, vía directa con *fallback* a la pasarela | `runt.service.ts:136-141`, `integraciones/mode.ts:8-19` |
| Pasarela (Kyverum) sin tipo | Manda `{ placa, documento }` y **omite** `tipoDocumento` (falsy). Qué hace Kyverum con eso **no está en el repo** | `runt.service.ts:107-111` |
| Log de la pasarela | Escribe `tipoDoc: body.tipoDocumento \|\| 'CC'`: con tipo ausente loguea `'CC'`, que **no** es lo que se envió (engaña al medir el spike) | `runt.service.ts:112` |
| Vía directa sin tipo | `tiposVehiculoAIntentar(undefined)` = barrido **secuencial** de 8 tipos `C,E,T,P,N,D,R,PT`, cada uno con captcha (hasta 4 resoluciones por tipo) | `runt-direct.service.ts:116-118`, `runt-tipo-doc.ts:4,40-46` |
| Vía directa: negativa | Devuelve `{ ok:false, message: descripcionRespuesta }` **sin `httpStatus`** ⇒ la compuerta la toma por negativa solo si el texto casa `/propietari/i`; si no, la clasifica **caído** | `runt-direct.service.ts:145-147`, `flito-soat-cliente-runt.ts:476-479` |
| Vía directa: PII en log | `log.info({ placa: placaNorm, via: 'direct' })` — **placa en claro** | `runt-direct.service.ts:142` |
| Vía directa: `soat` | Solo se añade `data.soat` si la sub-llamada `/soat` no falló (`noErr`); un fallo de esa sub-llamada y «no hay SOAT» quedan **indistinguibles** (campo ausente) | `runt-direct.service.ts:137-139` |
| ¿Alguien ya consulta placa + documento sin tipo en producción? | Sí: certificación de impuestos y análisis post-envío (`consultarVehiculoRunt(args.placa, args.vin, args.documento)`), y el refresco del legacy | `flito-impuestos/certificacion.service.ts:230`, `flito-impuestos/flito-impuestos.runt-consulta.ts:38`, `soat/refresh.service.ts:73` |
| Modo local | `INTEGRACIONES_MODE` sin definir y sin credenciales Fasecolda en `flito-api-1` ⇒ `cea-proxy` ⇒ **pasarela**. El modo de DEV/QA/PDN vive en `flit-gitops` (configmaps) / `.env` de PDN y **no** se verificó desde aquí | `integraciones/mode.ts:8-15` |

### 0.2 Qué hay que cambiar

1. `flito-soat-cliente-runt.ts`: `consultarRuntCrudo(vin)` pasa a `consultarRuntCrudo(consulta: ConsultaRunt)` con
   `type ConsultaRunt = { modalidad: 'vin'; vin: string } | { modalidad: 'placa'; placa: string; documento: string }`.
   - `vin` ⇒ `consultarVehiculoRunt(undefined, vin, '', '')` (igual que hoy, HU #12090).
   - `placa` ⇒ `consultarVehiculoRunt(placa, undefined, documento, undefined)`. **Sin VIN** (si va placa, `runt-direct` ignora el VIN, `vinNorm = (!placa && vin)`) y **sin tipo** (decisión del Feature).
2. `runt-direct.service.ts:142`: quitar la placa del log (`{ modalidad: placaNorm ? 'placa' : 'vin', via: 'direct' }`). Hoy la placa no llegaba a esa línea desde el canal; con la renovación sí. Es **BLOQUEANTE** de seguridad de este Feature (AGENTS.md §14).
3. `runt.service.ts:112`: `tipoDoc: body.tipoDocumento ?? null` (no inventar `'CC'`). No es PII; es para que el log diga la verdad durante el spike y en DEV.

### 0.3 Qué NO se puede cerrar desde el código (no se inventa)

- **R0-a.** Si Kyverum **resuelve el tipo de documento** cuando no lo recibe (¿barre tipos?, ¿asume CC?). El caso que importa es el del canal: **propietario persona jurídica (NIT)** y CE. Si asume CC, toda flota a nombre de empresa daría `runt_no_cuadra`.
- **R0-b.** La **forma de «sin SOAT anterior»** en la respuesta: ¿`soat: []`?, ¿`soat` ausente?, ¿`null`? Ver §5: el diseño solo acepta `[]` como «no tiene SOAT».
- **R0-c.** Que una combinación placa/documento **equivocada** llegue como **HTTP 200 `ok:false`** (negativa) y no como no-200 (que la compuerta tomaría por caído y **aparcaría una incompleta** de algo que el RUNT sí rechazó).
- **R0-d.** Si algún ambiente corre en modo `direct`: allí la renovación cuesta hasta 8 tipos × captcha (puede pasar los 90 s del cliente web) y la negativa depende del texto (`/propietari/i`).

### 0.4 Verificación propuesta — spike ANTES de construir la renovación

Bloquea la HU de renovación (backend), **no** la de tipo + cola + Inicial, que pueden avanzar.

- **Dónde:** local, contra la pasarela (modo verificado arriba). Un script **desechable en el scratchpad, no en el repo**, que importe `consultarVehiculoRunt` y llame `(placa, undefined, documento)`.
- **Con qué:** ≥4 vehículos reales que aporta el PO/humano: (1) propietario CC con SOAT vigente; (2) **propietario NIT**; (3) vehículo sin SOAT anterior consultable por placa (si existe); (4) placa válida con documento equivocado. Si hay propietario CE, un 5.º.
- **Qué imprime (y nada más — sin placa, documento, VIN ni nombre):** `ok`, `httpStatus`, `/propietari/i.test(message)`, `typeof data.soat`, `Array.isArray(data.soat)`, `data.soat?.length`, `!!data.vehiculo?.vin` / `numeroVin`, `data.tipoDocPropietario`.
- **Criterio de salida:** (2) devuelve `ok:true` ⇒ R0-a cerrado. (3) devuelve `soat: []` ⇒ R0-b cerrado tal como está §5; si devuelve ausente/`null`, se vuelve al diseño (§5.3). (4) devuelve `httpStatus: 200, ok:false` ⇒ R0-c cerrado.
- **Si (2) falla:** alternativa de respaldo (requiere decisión humana y reabre el AC «no se pide tipo»): el canal reintenta la negativa con `tipoDocumento: 'NIT'` (y `CE`) — a lo sumo 3 llamadas, solo tras una negativa 200 — o se pide el tipo en el formulario. No se construye hasta tener el resultado.
- **R0-d** se resuelve preguntando a devops/humano el `INTEGRACIONES_MODE` de DEV/QA/PDN (en `flit-gitops`). Si alguno es `direct`, se repite el spike en ese modo.

---

## 1. Patrón reutilizado

- Compuerta y vocabulario: `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts` (`consultarYClasificar`, `clasificarDesenlaceRunt`, `DesenlaceRunt`).
- Alta: `flito-soat-cliente.service.ts` (`preconsulta`, `crearSolicitud`, `verificarRuntCompuerta`, `insertarSolicitudDespachada`).
- Incompletas: `flito-soat-incompletas.service.ts` (`aparcarSolicitud`) y `flito-soat-incompletas-reintento.service.ts` (`reintentarIncompleta`, `completar`).
- PII: `flito-soat.pii.ts` (`registrarAccesoRuntCliente` con tokens HMAC de ADR-0012; `registrarAccesoIncompleta`).
- Columna de vocabulario cerrado: precedente `flito_soat.origen` (varchar + CHECK, `0167`).

## 2. Dónde vive el tipo — `flito_soat_solicitud.tipo_soat`

**Decisión:** `flito_soat_solicitud.tipo_soat varchar(10) NOT NULL DEFAULT 'inicial' CHECK (tipo_soat IN ('inicial','renovacion'))`.

Por qué ahí y no en `flito_soat`:
1. El satélite es **solo del canal** por construcción (lo escribe únicamente `insertarSolicitudDespachada`, 1:1 por `soat_id`). En `flito_soat` habría que inventar un valor para las filas de trámite (un `DEFAULT 'inicial'` afirmaría «inicial» de un SOAT de traspaso) o dejarlo nullable con un hueco en el despliegue (ver 3).
2. `ADD COLUMN … NOT NULL DEFAULT 'inicial'` **es** el backfill: atómico, sin reescritura (PG ≥ 11) y sin `UPDATE`.
3. Cubre la ventana del rollout de k3s: el pod viejo, que sigue sirviendo mientras el nuevo corre `db-apply`, solo sabe crear Iniciales, y el DEFAULT las marca bien. Con la columna en `flito_soat` nullable + CHECK «cliente ⇒ no nulo», ese pod viejo fallaría el INSERT del alta.

Coste: un `LEFT JOIN flito_soat_solicitud` por PK en `conJoinsCola` (`flito-soat.service.ts`, 1076/1090 del techo: cabe). El detalle ya lee el satélite (`flito-soat.service.ts:1342`), coste cero.

El DEFAULT se queda en F1 por el rollout; `insertarSolicitudDespachada` recibe `tipoSoat` como **parámetro obligatorio** del tipo TS, así que ningún escritor nuevo lo puede omitir. Retirar el DEFAULT es opcional en una migración posterior.

**Migración `0268_flito_soat_solicitud_tipo_soat.sql`** (idempotente):

```sql
ALTER TABLE flito_soat_solicitud ADD COLUMN IF NOT EXISTS tipo_soat varchar(10) NOT NULL DEFAULT 'inicial';
ALTER TABLE flito_soat_solicitud DROP CONSTRAINT IF EXISTS flito_soat_solicitud_tipo_soat_chk;
ALTER TABLE flito_soat_solicitud ADD CONSTRAINT flito_soat_solicitud_tipo_soat_chk
  CHECK (tipo_soat IN ('inicial', 'renovacion'));
COMMENT ON COLUMN flito_soat_solicitud.tipo_soat IS
  'Feature #14012: Inicial (por VIN, factura obligatoria) o Renovación (por placa + documento, factura opcional). Existentes = inicial.';
-- Aserción del AC «ningún SOAT del canal sin tipo»: toda fila origen='cliente' tiene satélite.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM flito_soat s LEFT JOIN flito_soat_solicitud q ON q.soat_id = s.id
             WHERE s.origen = 'cliente' AND q.soat_id IS NULL) THEN
    RAISE EXCEPTION '0268: hay SOAT del canal sin flito_soat_solicitud; revisar antes de aplicar';
  END IF;
END $$;
```

`db-review-agent` debe confirmar que la aserción pasa en DEV/QA/PDN (si fallara, la cola mostraría `null` en una fila del canal).

## 3. Crecimiento de `flito_soat_incompletas` (y de sus motivos)

**Migración `0269_flito_soat_incompletas_renovacion.sql`** (idempotente; `DROP NOT NULL` y `DROP/ADD CONSTRAINT` se repiten sin efecto):

| Cambio | Detalle | Para |
|---|---|---|
| `tipo_soat varchar(10) NOT NULL DEFAULT 'inicial'` + CHECK | mismo vocabulario que §2; las existentes = inicial | F1 (y F2/F3) |
| `modalidad_consulta varchar(5) NOT NULL DEFAULT 'vin'` + CHECK `IN ('vin','placa')` | **No** se deriva del tipo: la «fila Inicial cuyo VIN ya tiene SOAT» de F2 es Renovación consultada por VIN | F1, F2 |
| `vin` DROP NOT NULL | una renovación con RUNT caído no tiene VIN | F1 |
| `placa varchar(10)` nullable | la tecleada (normalizada); mismo largo que `vehicles.plate` | F1, F2 |
| CHECK `flito_soat_incompletas_modalidad_chk` | `(modalidad_consulta = 'vin' AND vin IS NOT NULL) OR (modalidad_consulta = 'placa' AND placa IS NOT NULL)` | — |
| `factura_*` (5 columnas) DROP NOT NULL | renovación sin factura; F3 pendiente de factura | F1, F3 |
| CHECK `flito_soat_incompletas_factura_completa_chk` | las 5 columnas de factura son todas nulas o todas no nulas | — |
| CHECK `flito_soat_incompletas_factura_inicial_chk` | `tipo_soat = 'renovacion' OR factura_storage_key IS NOT NULL OR motivo_pendiente = 'falta_factura_venta'` | invariante «Inicial lleva factura» |
| `motivo_pendiente varchar(30) NOT NULL DEFAULT 'runt_sin_respuesta'` + CHECK `IN ('runt_sin_respuesta','falta_factura_venta','faltan_datos_propietario')` | **Se crean los tres ya** (el vocabulario lo cerró la Épica): F2/F3 no tocan un CHECK. F1 solo escribe `runt_sin_respuesta` | F1, F2, F3 |
| `motivo_descarte` CHECK ampliado con `'sin_soat_anterior'` | reintento de renovación al que el RUNT dice «no registra SOAT» | F1 |
| `uq_flito_soat_incompletas_placa_abierta` UNIQUE `(placa) WHERE estado = 'incompleta' AND placa IS NOT NULL` | gemelo del de VIN (que con `vin` NULL no colisiona: NULLs distintos) | F1 |

**El documento del propietario NO estrena columna.** El documento de la consulta **es** `propietario.numeroDocumento` (el `documentoSchema` del alta ya lo trae), y ya se persiste en `flito_compradores` (`soat_incompleta_id`, `orden 0`) como en la 0210. Regla del servicio: en renovación, el documento consultado y el del propietario son el **mismo campo** — no hay dos. El patrón del canal **no** cifra columnas (`flito_compradores.numero_documento` es texto plano protegido por alcance + `logPiiAccess` + logs sin PII); cifrar aquí sería un patrón nuevo con su ADR, fuera del alcance.

**Reintento** (`flito-soat-incompletas-reintento.service.ts`):
1. Lee `modalidad_consulta`, `tipo_soat`, `motivo_pendiente`, `vin`, `placa`. Si `motivo_pendiente ≠ 'runt_sin_respuesta'` ⇒ 409 «no se reintenta» (los de F2/F3 se resuelven completando, no reintentando).
2. `placa` ⇒ lee `numero_documento` del comprador `orden 0` (dentro del alcance ya aplicado) y llama `consultarYClasificar({ modalidad:'placa', placa, documento }, tipo)`.
3. Misma compuerta que el alta (§5). Nueva rama: `sin_soat_anterior` ⇒ `descartar(…, 'sin_soat_anterior')`.
4. `ok` / `renovacion_anticipada`: además del `ocupado` por VIN en `flito_soat` (hoy), comprobar **otra** incompleta abierta con `vin = vinEfectivo` e `id ≠ inc.id` ⇒ `solicitud_existente` (cubre Inicial-por-VIN + Renovación-por-placa del mismo vehículo, que sin RUNT no se podían cruzar).
5. `completar`: `factura` puede ser `null` ⇒ `insertarSolicitudDespachada` con `factura: null` no inserta soporte; pasa `tipoSoat`; escribe en la incompleta `vin = vinEfectivo` en el mismo UPDATE que la pasa a `completada` (el índice único es parcial sobre `incompleta`: no colisiona).

**Retención:** `flito-soat-retencion.service.ts` asume `factura_storage_key` NOT NULL (`Candidata.facturaStorageKey: string`, borrado del paso 2). Con nulos: saltar el paso de factura cuando es `null` y sumar 0 bytes. `borrados-pendientes` (`inArray`) no cambia.

## 4. Contrato delta

PII en **body** siempre; nada en path/query (AGENTS.md §14).

```
POST /api/flito/soat/cliente/preconsulta        (body, z.discriminatedUnion('tipo'))
  { tipo:'inicial',    vin, companiaId? }                      ← como hoy + tipo
  { tipo:'renovacion', placa, numeroDocumento, companiaId? }   ← nuevo; sin tipoDocumento
  tipo ausente ⇒ 400 (AC «no se consulta sin tipo»)
  200 Preconsulta + { tipo }   · 409 soat_vigente (igual) · 503 runt_no_disponible (igual)
  422 runt_no_cuadra (campo?: 'vin' | 'placa') · runt_sin_registro · runt_sin_vin
  422 soat_sin_anterior  «Este vehículo no registra SOAT anterior: solicite un SOAT inicial»  (solo renovación)

POST /api/flito/soat/cliente   (multipart, igual + campo `tipo`)
  inicial:    vin + facturaVenta OBLIGATORIA (routes:608 pasa a condicional) — sin cambios
  renovacion: placa (sin vin) + numeroDocumento (= consulta) + titular; facturaVenta OPCIONAL
  201 creada · 202 incompleta (renovación con RUNT caído: modalidad 'placa', factura opcional)

POST /api/flito/soat/cliente/incompletas/buscar · GET …/:id · POST …/:id/reintentar  — rutas sin cambio; DTO crece
GET  cola / detalle — `tipoSoat: 'inicial' | 'renovacion' | null` (null = fila de trámite)
```

Placa: `normalizarId` + 5–7 alfanuméricos (no se valida el formato fino; lo decide el RUNT). `numeroDocumento`: el `documentoSchema` de hoy.

**`packages/shared-types`** (`flito-estados.ts`):
- `TipoSoat` (`INICIAL`/`RENOVACION`) + `TIPOS_SOAT`; `ModalidadConsultaRunt` (`'vin' | 'placa'`); `MOTIVOS_PENDIENTE_INCOMPLETA` + tipo.
- `MOTIVOS_DESCARTE_SOAT` + `'sin_soat_anterior'`; `CodigoErrorSolicitudSoat.SOAT_SIN_ANTERIOR` (el `Record` `DESENLACE_HABLA_DEL_VEHICULO` obliga a declararlo: `true`).
- `SolicitudIncompletaFila`: `vin: string | null`, `placa: string | null` (hoy literal `null`), `+ tipoSoat`, `+ modalidadConsulta`, `+ motivoPendiente`. `SolicitudIncompletaDetalle.factura: {…} | null`.
- Ítem de la cola (`SoatColaItem`) y detalle: `+ tipoSoat: TipoSoat | null`. Preconsulta: `+ tipo`.
- **grep obligatorio en `apps/web`** (regla 7), ya identificados: `components/flito/soat/DetalleIncompletaSoat.tsx`, `components/flito/soat/useReintentoRunt.ts`, `components/flito/soat-cliente/TarjetaSolicitudGuardada.tsx`, `pages/FlitoSoat.tsx`, `pages/FlitoSoatSolicitud.tsx`, `lib/soatCliente.ts`. El `vin: string | null` rompe en compilación a quien lo pinte sin guarda: es deseado.

## 5. La compuerta en las dos modalidades

`consultarYClasificar(consulta: ConsultaRunt, tipo: TipoSoat)` y `clasificarDesenlaceRunt(respuesta, consulta, tipo, hoy)`. **El orden del diseño §2.3 de ADR-0010 se conserva entero**; solo cambian el paso 3 (qué se contrasta) y se intercala el 5-bis:

1. `ok:false` ⇒ negativa (`runt_no_cuadra`) o `caido` — igual. En renovación, «no hay registro para esa combinación» llega por aquí (R0-c).
2. `runtSinRegistro` ⇒ `runt_sin_registro` — igual.
3. `campoQueNoCuadra(consulta, datos)`: VIN tecleado vs devuelto (`'vin'`) **o** placa tecleada vs devuelta (`'placa'`). Si el RUNT no devuelve placa en modalidad placa, no se contrasta (mismo criterio «`null` no es distinto» de hoy). El 422 nunca lleva el valor del RUNT.
4. Sin VIN devuelto ⇒ `runt_sin_vin` — igual en las dos (sin VIN no hay fila: `flito_soat.vin` NOT NULL).
5. **5-bis, solo `tipo === 'renovacion'`:** `sinSoatAnterior(data)` ⇒ `{ clase: 'sin_soat_anterior' }`. Clase nueva de la unión (no un `revise`: no es «revise los datos»), y por eso rompe el build hasta que el `switch` de `verificarRuntCompuerta` y el del reintento tengan su `case` — el mismo argumento que dejó escrito la HU #12212.
6. SOAT vigente ⇒ `renovacion_anticipada` (≤30 días, `limiteRenovacionAnticipada`) o `vigente` (409) — **la misma función y la misma regla para los dos tipos**. Vencido ⇒ `ok`.
7. `ok` con organismo — igual.

**`sinSoatAnterior(data)` — la única definición de «no tiene SOAT»:**

```
true  ⇔ Array.isArray(data.soat) && data.soat.length === 0
false ⇔ data.soat es arreglo no vacío, o es objeto con al menos una clave (se tolera el objeto suelto, como nodoSoatRunt :168)
indeterminado ⇔ ausente, null, {} u otro tipo
```

El **indeterminado no es «sin SOAT»**: en renovación se clasifica **`caido`** (defecto seguro de ADR-0010: no crea, no afirma). En el alta eso aparca la incompleta con `runt_sin_respuesta` y el reintento vuelve a preguntar; nunca se le dice al usuario «pida un inicial» por un campo que no llegó. Precio declarado: si el spike (R0-b) muestra que Kyverum **omite** `soat` cuando no hay póliza, las renovaciones de vehículos sin SOAT quedarían aparcadas en bucle — por eso el spike va antes y, en ese caso, §5 se revisa con el dato real (no se adivina aquí).

Inicial **no** cambia: no evalúa `sinSoatAnterior`; `soat` vencido o ausente sigue siendo `ok`, vigente sigue siendo 409 / anticipada.

**RN-01 en renovación:** antes del RUNT no hay VIN ⇒ se comprueba solo la **incompleta abierta por placa** (`verificarIncompletaAbiertaPorPlaca`, mismo 409 recortado `propia: true|false`). Después del RUNT, `verificarRn01(vinEfectivo)` + `verificarTenenciaVehiculo(vinEfectivo)` como hoy — es la guarda autoritativa. Ver Pendiente humano P-1.

**Mensajes:** `MENSAJE_REVISE` que mencione «VIN» se parametriza por modalidad (renovación: «Revise la placa y el documento del propietario»). Copy final: `ux-agent`.

## 6. Límite de 800 líneas (medido con ESLint `max-lines`, sin blancos ni comentarios)

| Archivo | Hoy | Plan |
|---|---|---|
| `api/…/flito-soat-cliente.service.ts` | 634 | ≤ 690 al cerrar F1. Solo el cambio de firmas (`ConsultaAlta`), el `case 'sin_soat_anterior'` y la factura opcional. Lo nuevo va a archivo nuevo ↓ |
| `api/…/flito-soat-cliente-consulta.ts` **(nuevo)** | — | ~80: `ConsultaAlta` (tipo + modalidad), normalización, guardas pre-RUNT por modalidad (`verificarIncompletaAbiertaPorPlaca`) y regla «documento de consulta = documento del propietario» |
| `api/…/flito-soat-cliente-runt.ts` | 244 | ~290: `ConsultaRunt`, `sinSoatAnterior`, paso 3 y 5-bis |
| `api/…/flito-soat-cliente.routes.ts` | 274 | ~305: esquemas por `discriminatedUnion` |
| `api/…/flito-soat-incompletas.service.ts` | 264 | ~290 |
| `api/…/flito-soat-incompletas-reintento.service.ts` | 209 | ~245 |
| `api/…/flito-soat.service.ts` (techo congelado 1090) | 1076 | +2–4 (join + campo). Si pasa de 1090, el campo se mueve a un mapper aparte; **no** se sube el techo |
| `web/…/pages/FlitoSoatSolicitud.tsx` | **779** | **Sin margen.** El selector de tipo y la variante Renovación van a componentes nuevos en `components/flito/soat-cliente/`; la página solo los compone (neto ≤ +15). Si no cabe, extraer primero el bloque de consulta por VIN a `ConsultaInicial.tsx` |
| `web/…/pages/FlitoSoat.tsx` | 436 | etiqueta en el renglón vía componente del kit |

F2/F3 (masiva) nacen en archivos propios (`flito-soat-masiva*.ts`); no crecen el servicio del alta.

## 7. Archivos a crear / modificar

**API — esquema y migraciones** (dispara `db-review-agent`)
- `apps/api/src/db/migrations/0268_flito_soat_solicitud_tipo_soat.sql` (nuevo)
- `apps/api/src/db/migrations/0269_flito_soat_incompletas_renovacion.sql` (nuevo)
- `apps/api/src/db/schema.ts` (`flitoSoatSolicitud.tipoSoat` + check)
- `apps/api/src/db/schema/flito-soat-incompletas.ts` (columnas, nulabilidad, checks, índice de placa)

**API — RUNT (transversal mínimo)**
- `apps/api/src/modules/runt/runt-direct.service.ts` (quitar placa del log, línea 142)
- `apps/api/src/modules/runt/runt.service.ts` (log de `tipoDoc` sin `'CC'` inventado, línea 112)

**API — flito-soat**
- `flito-soat-cliente-runt.ts`, `flito-soat-cliente-consulta.ts` (nuevo), `flito-soat-cliente.service.ts`, `flito-soat-cliente.routes.ts`
- `flito-soat-incompletas.service.ts`, `flito-soat-incompletas-reintento.service.ts`, `flito-soat-incompletas.routes.ts` (409 «no reintentable», auditoría con placa)
- `flito-soat-retencion.service.ts` (factura nula)
- `flito-soat.pii.ts` (`registrarAccesoRuntCliente`: `vin: string | null`, `placa` tecleada como token HMAC; `CAMPOS_PII_INCOMPLETA_FILA` + `placa`)
- `flito-soat.service.ts` (cola y detalle: `tipoSoat`)
- Tests (P1): `__tests__/…/flito-soat.cliente-alta-runt-compuerta.test.ts` (paso 3 por placa, 5-bis, indeterminado ⇒ caído, Inicial intacta), test del reintento por placa, test de migración/esquema que ya exista para incompletas, test del log sin placa en `runt-direct`.

**shared-types**
- `packages/shared-types/src/flito-estados.ts`

**Web** (detalle de UI: `ux-agent` slim)
- `apps/web/src/pages/FlitoSoatSolicitud.tsx` (composición), componentes nuevos en `apps/web/src/components/flito/soat-cliente/` (selector de tipo, consulta de renovación, factura opcional)
- `apps/web/src/pages/FlitoSoat.tsx`, `apps/web/src/components/flito/soat/DetalleIncompletaSoat.tsx`, `apps/web/src/components/flito/soat/useReintentoRunt.ts`, `apps/web/src/components/flito/soat-cliente/TarjetaSolicitudGuardada.tsx`, `apps/web/src/lib/soatCliente.ts`
- `apps/web/e2e/tests/` — spec del Feature
- Ficha de ayuda: `flit-ayuda-flito` (el canal tiene ficha en `apps/web/src/content/ayuda/` si existe; delta del tipo)

## 8. Notas operativas

**backend-agent**
- Orden sugerido de HUs: (0) modelo ADR-0031 + migración 0267; (1) tipo + migración 0268 + cola + Inicial con `tipo` (sin RUNT nuevo); (2) renovación en preconsulta/alta — **tras el spike §0.4**; (3) incompletas 0269 + reintento por placa.
- `insertarSolicitudDespachada`: `tipoSoat` y `factura: … | null` obligatorios en la firma (sin `?`).
- Logs: el desenlace y el `httpStatus` como hoy, más `modalidad`; **nunca** placa, documento, VIN ni `err.message`. Añadir el aserto sobre los spies del log para la modalidad placa.
- `logPiiAccess`: preconsulta y alta de renovación declaran el acceso con tokens HMAC de la placa tecleada y del VIN devuelto (ADR-0012); el reintento por placa idem con `motivo: 'reintento'`.
- No extraer ni persistir `tipoDocPropietario` (la nota de `extraerDatosCanal` sigue valiendo).

**frontend-agent**
- «Cambiar el tipo limpia la consulta y los datos cargados» = reset del estado de consulta y del formulario (incluida la factura leída).
- Renovación: el documento de la consulta prellena y **bloquea** el número de documento del propietario (es el mismo dato del contrato). Si el OCR de la factura trae otro número, se avisa; no se sobrescribe.
- 4 estados en todo; `soat_sin_anterior` como aviso de página con acción «Cambiar a SOAT inicial».

**security-agent (diff-scoped):** rutas con cuerpo nuevo (placa + documento), PII a tercero (RUNT), log de `runt-direct`, enumeración placa↔documento (cubierta por `soatPreconsultaLimiter`; confirmar que el límite aplica igual a la modalidad placa), `logPiiAccess`.

**db-review-agent:** 0268 (aserción del satélite) y 0269 (checks combinados, índice parcial de placa, DROP NOT NULL de factura vs retención).

## 9. Pendiente humano / riesgos abiertos

- **P-1 (RESUELTO 2026-10-27).** El humano decidió que la renovación **sí** cubre SOAT de FLITO. Se implementa con el ADR-0031 (HU0): `UNIQUE` incondicionales ⇒ índices únicos parciales «abierto»; `verificarRn01` y demás lookups por VIN pasan por `soatActualDelVin`. §5 «RN-01 en renovación» y la guarda por placa siguen válidas, con la salvedad de que después del RUNT solo un SOAT **abierto** da `409 vin_ya_tiene_soat`.
- **P-2 (spike §0.4).** R0-a/b/c con vehículos reales que aporte el humano; R0-d (modo de integraciones por ambiente) lo responde devops/humano.
- **P-3 (UX/PO, menor).** La consulta no pide tipo de documento, pero la sección del propietario sí lo pide hoy (se persiste para el gestor). Se conserva en el formulario; si el PO quiere quitarlo también ahí, `tipo_documento` ya es nullable en `flito_compradores`.
