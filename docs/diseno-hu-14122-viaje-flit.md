# Diseño slim — HU #14122 Viaje a FLIT y salida de FLIT al cliente

HU BACKEND. Extiende el traslado que ya registra y recorre el viaje a cliente. No hay tabla nueva, ni concepto de precio nuevo, ni segundo agregado. ADR-0030 (recorrido Organismo → FLIT → Cliente, acta de FLIT sin cédula, motivo de catálogo) sigue siendo el precedente; este documento es el delta de implementación. El ADR sigue **Propuesto** (no se toca su estado).

Trabajo sobre la rama `HU/14122-davidchica-viaje-flit` (HEAD de partida `6e5a1ef3`, encima de HU #14121).

## Patrón reutilizado

Viaje a cliente ya entregado (HUs #14114–#14116):

- Registro: `apps/api/src/modules/flito-logistica/flito-logistica-traslados.service.ts` (`registrarTraslado`). Una transacción, `SELECT … ORDER BY id FOR UPDATE`, precio congelado con `precioTrasladoDe`, proveedor con `proveedorDeCompania`, cabecera + líneas + acta + `transicionar` / `insertarEvento`.
- Ciclo: `flito-logistica-traslados-ciclo.service.ts`. `despachar` → `entregar` / `devolver`; `anular` en `registrado`. `estadoTrasRegreso` ya devuelve `en_flit` cuando `origen = 'flit'`.
- Precio: `flito-logistica-precios.ts`. `destino 'flit'` → concepto `logistica_flit`; `destino 'cliente'` → `logistica_cliente`. Un `0` configurado es precio válido; `null` es «no hay vigencia».
- Motivos: `flito-logistica-motivos.service.ts` + `GET` ya montado en `/api/flito/logistica/motivos-llegada` (HU #14119). Esta HU no abre otro GET. `listarMotivosActivos()` ya está para validar en servidor.
- Esquema (0274 + 0275, no se editan): enum `en_flit`; `flito_logistica_traslados.destino/origen` con `ck_flito_log_traslados_ruta` (`destino = 'flit'` ⇒ `origen = 'organismo'`); `traslado_lts.motivo_llegada_id`, `motivo_por_id`, `motivo_en`, `motivo_nota` y `ck_flito_log_traslado_lts_motivo`; índice único parcial `uq_flito_log_traslado_lt_vivo` sobre `(documento_id, destino)` donde `estado NOT IN ('devuelto','anulado')` — `entregado` cuenta como vivo; `acta_firmas.usuario_id` nullable y `documento_cifrado` nullable, único `(acta_id, rol)`.

Lo que hoy corta el destino FLIT, y esta HU retira:

- `registrarTraslado` lanza `DestinoFlitNoDisponibleError` (422 `DESTINO_FLIT_NO_DISPONIBLE`) antes de la transacción si `destino !== 'cliente'`.
- `cargarTraslado` lanza el mismo error en despachar, entregar, devolver y anular.

El origen **ya se deriva** del estado de la LT (`origenDe`: `en_flit` → `'flit'`, cualquier otro estado admisible → `'organismo'`) y ya se rechaza la mezcla (`TrasladoOrigenMixtoError`, 422 `TRASLADO_ORIGEN_MIXTO`). `registrarTraslado` ya admite, para `destino: 'cliente'`, LT `clasificado` (origen `organismo`) y LT `en_flit` (origen `flit'`). El ciclo de un traslado con `destino = 'cliente'` y `origen = 'flit'` no está bloqueado: el guard es `destino === 'flit'`, no el origen.

## Contrato delta

Misma ruta, mismo permiso de alta. Body que ya parsea la ruta (`motivoLlegadaId` opcional en cabecera y en cada LT; `nota` opcional, tope 300). Se añade un discriminador opcional.

### `POST /api/flito/logistica/traslados`

Permiso sin cambio: `logistica.traslado.registrar`. `soloSinEnlace`, `trasladoRegistrarLimiter`, `Idempotency-Key` como hoy.

```
{
  companiaId, destino: 'flit' | 'cliente',
  origen?: 'organismo' | 'flit',          // solo se honra si destino = 'cliente'
  lts: [{ documentoId, motivoLlegadaId?, nota? }],
  motivoLlegadaId?, mensajeroId?
}
```

`origen` omitido = el comportamiento de hoy: se infiere con `origenDe`. Los cuerpos de las HUs #14114–#14116 no lo envían.

**Destino `flit` (AC1, AC2, AC3, AC8, AC9).** Origen de la cabecera siempre `organismo`. Solo LT `clasificado` (trámite resuelto, misma compañía, no autogestionable, proveedor asignado: las mismas guardas del viaje a cliente).

Motivo efectivo de cada LT = `lt.motivoLlegadaId ?? body.motivoLlegadaId`. Tiene que existir y estar `activo`. Si falta, no existe o está inactivo: **422 `MOTIVO_LLEGADA_REQUERIDO`**, y no hay `INSERT` (un solo código; el ADR separaba «requerido» e «inactivo», el AC2 los une). Se guarda en la línea: `motivo_llegada_id`, `motivo_por_id = ctx.userId`, `motivo_en = ahora`, `motivo_nota` si vino `nota`.

Precio: `precioTrasladoDe(companiaId, 'flit', ahora)`. `null` → **422 `PRECIO_TRASLADO_NO_CONFIGURADO`** (el texto ya dice «entrega a FLIT»), y no hay `INSERT`. Se congela `concepto_precio = 'logistica_flit'`, `precio`, `tarifa_vigencia_id`.

Orden dentro de la transacción, antes de cualquier `INSERT`: bloqueo de LT → trámite / compañía / estado / vivo → motivo → precio → proveedor. Motivo y precio invalidan solos: el primero que falle hace rollback.

Acta: `punto = 'flit'`, `estado = generada`, mismo estampado de proveedor y de dirección/contacto de la compañía que el viaje a cliente. La cédula del firmante no se escribe aquí (todavía no hay firma).

Eventos, por LT (mismo par que el cliente):

| Momento | Llamada | `tipo` guardado | Estado de la LT |
|---|---|---|---|
| Registro | `transicionar` | `destino_registrado` | `en_acta` |
| Registro | `insertarEvento` (sin cambio de estado) | `acta_flit` | sigue `en_acta` |

Payload de ambos: `{ trasladoId, actaId, destino: 'flit' }`. Sin nombre de motivo, sin firma, sin cédula. El motivo va en la línea; el evento de llegada (abajo) lo repite por id.

DTO de respuesta: el `TrasladoDetalle` actual más, en cada LT, `motivoLlegadaId`, `motivoPorId`, `motivoEn` (null en un viaje a cliente).

**AC8.** Una LT con línea viva a `destino = 'flit'` (`registrado`, `en_ruta` o `entregado`) → **409 `LT_YA_EN_TRASLADO`** (el error que ya existe; el índice `uq_flito_log_traslado_lt_vivo` es la red). Después de la llegada la línea queda `entregado` y la LT `en_flit`: el segundo viaje a FLIT cae en ese 409. `devolver` o `anular` dejan la línea en `devuelto` / `anulado` y la LT en `clasificado` (`estadoTrasRegreso('organismo')`): ahí sí puede volver a FLIT. Esa comprobación de «vivo» corre antes que la de estado, para que la LT que ya llegó responda `LT_YA_EN_TRASLADO` y no `LT_ESTADO_NO_ADMISIBLE`. Un estado distinto de `clasificado` sin línea viva sigue en **409 `LT_ESTADO_NO_ADMISIBLE`**.

No se depende del `CHECK` de ruta para el HTTP: un `origen = 'flit'` con `destino = 'flit'` lo rechaza el servicio antes del `INSERT` (si llegara a la BD sería un 500).

**AC9.** El nombre «Destino lejano (transportadora externa)» es una fila del catálogo (0275 / 0284). El registro no lee el nombre para decidir nada: no hay columna de guía, no hay proveedor distinto de `proveedorDeCompania`, no hay precio distinto de `logistica_flit`. La línea queda igual que con «Otro».

**Destino `cliente`.** Precio siempre `precioTrasladoDe(companiaId, 'cliente', ahora)` (`logistica_cliente`). El motivo se ignora y no se persiste. `cerrar-lote` no cambia: sigue armando el viaje directo con las LT `clasificado` (`idsClasificadosDe`).

### Frontera del 409 `LT_NO_EN_FLIT` (AC6)

El viaje directo y el tramo que sale de FLIT son el mismo `POST /traslados` con `destino: 'cliente'`. Se distinguen por el origen, que ya es columna. El 409 nuevo solo arma el tramo que **pide** salir de FLIT. El viaje directo no lo evalúa.

| Cuerpo | LT | Qué queda |
|---|---|---|
| `destino: 'cliente'`, sin `origen` (cuerpo de #14114) | todas `clasificado` | 201, `origen = 'organismo'`, precio de entrega a cliente. Viaje directo. |
| `destino: 'cliente'`, sin `origen` | todas `en_flit` | 201, `origen = 'flit'`, precio de entrega a cliente. Es el tramo de salida (AC6, camino feliz). Hoy el registro ya haría esto; el ciclo a cliente también, porque no mira el origen. |
| `destino: 'cliente'`, `origen: 'flit'` | alguna LT que no está `en_flit` | **409 `LT_NO_EN_FLIT`**. No se inserta nada. Este es el caso negativo del AC6. |
| `destino: 'cliente'`, `origen: 'flit'` | todas `en_flit` | 201, igual que la fila anterior del camino feliz. |
| `destino: 'cliente'`, sin `origen` | mezcla `clasificado` + `en_flit` | 422 `TRASLADO_ORIGEN_MIXTO` (ya existe). |
| `destino: 'cliente'`, `origen: 'organismo'` | alguna `en_flit` | 409 `LT_ESTADO_NO_ADMISIBLE`. Quien pide el viaje directo no se lleva LT que ya están en FLIT. |
| `destino: 'cliente'`, sin `origen` | estado distinto de `clasificado` y de `en_flit` | 409 `LT_ESTADO_NO_ADMISIBLE` (ya existe). No se renombra a `LT_NO_EN_FLIT`. |

`LtNoEnFlitError` es clase nueva en `flito-logistica-traslados.errors.ts`: 409, código `LT_NO_EN_FLIT`.

Consecuencia para la prueba: el caso «LT que no está En FLIT → 409» envía `origen: 'flit'`. El mismo LT `clasificado` sin `origen` sigue siendo el viaje directo (201). Si el negativo se prueba sin `origen`, el AC6 y la HU #14114 son el mismo request y el 409 se comería el viaje ya entregado.

### Ciclo

`cargarTraslado` deja de rechazar `destino = 'flit'`. Despachar, devolver y anular son las mismas funciones.

- **Despachar** (`logistica.actas.despachar`): `registrado` → `en_ruta`, LT → `despachado`, evento `tipo: 'salida'`. La firma opcional de despacho sigue siendo rol `entrega`, sin cédula, como hoy.
- **Devolver / anular:** sin cambio de regla. En un viaje a FLIT el origen es `organismo`, así que la LT vuelve a `clasificado`. En un viaje cliente con origen `flit`, sigue volviendo a `en_flit`. El precio de la línea no se borra.
- **Llegada a FLIT** es la rama `destino = 'flit'` de `POST /traslados/:id/entregar`. El viaje tiene que estar `en_ruta` (si no, 409 `TRASLADO_ESTADO_NO_ADMISIBLE`, el de hoy). No se firma desde `registrado`.

Body de la llegada (ADR-0030 §5 y N4; el AC4 lo confirma):

```
{ firma, lat?, lng? }
```

`firma` es el trazo (dataURL), igual que el despacho: en `users` no hay firma guardada. El nombre es `ctx.username` y `usuario_id` es `ctx.userId`. Se rechaza el cuerpo si trae `receptorNombre`, `receptorDocumento` o `firmante` → 422 `DATOS_INVALIDOS` (no se descarta en silencio: esa cédula no debe caer en una columna). Sin `firma` → 422 `FIRMA_LLEGADA_REQUERIDA`.

Fila `acta_firmas`: rol **`recibe`** (el rol `entrega` puede existir ya por el despacho; el único es `(acta_id, rol)`), `documento_cifrado` null, `documento_ultimos` null, `usuario_id` NOT NULL, `firma_storage_key` del trazo. No se llama `protegerDocumento` ni `logPiiAccess`. El PDF de después no audita cédula: no hay cédula de firmante.

Estado: cada línea que llega pasa a `entregado` y su LT a `en_flit`. El reparto parcial se reutiliza (`partirLineas`): la línea devuelta queda `devuelto`, la LT vuelve a `clasificado` (origen `organismo`) y el evento es `devolucion`. El traslado queda `entregado` si al menos una línea llegó.

Evento de llegada, uno por LT que llega, vía `transicionar` (no un segundo `insertarEvento`):

- `tipo: 'llegada'`
- `payload: { trasladoId, actaId, motivoLlegadaId }` — el id de **esa** línea
- `estadoNuevo: 'en_flit'`

`insertarEvento` persiste `tipoEventoEfectivo(opts.tipo, estadoNuevo)`. Hoy `en_flit` no está en `TIPO_DESDE_ESTADO_NUEVO` (a propósito: devolver, anular y reversar también pueden dejar la LT en `en_flit`) y un `tipo` desconocido se guarda **null**. Por eso `llegada` y `acta_flit` entran al catálogo, y el caller los pasa siempre. No se añade `en_flit` al mapa desde estado.

Catálogo en `packages/shared-types/src/flito-logistica.ts`:

- `EventoDocumentoLogisticaTipo.LLEGADA = 'llegada'`, `ACTA_FLIT = 'acta_flit'`.
- Alias de lectura: `llegada_flit` → `llegada`, `acta_flit_firmada` → `acta_flit` (nombres del ADR; se guarda el canónico, igual que `recogida_organismo` → `recogida`).

La entrega a **cliente** (cédula cifrada, rol `recibe` de una persona sin sesión, LT → `entregado`, `tipo: 'entrega'`) no se toca. Sigue exigiendo `logistica.actas.entregar`.

### Permiso de la firma (AC5)

Nombre: **`logistica.actas.firmar_flit`**.

Cierra la NQ1 del ADR: el mensajero no la recibe. Quien la tiene (Operaciones o Logística, por función, no por rol; el rol `operaciones` no existe) puede firmar la llegada. No hace falta además `logistica.actas.entregar`. Quien solo tiene `entregar` firma al cliente y recibe 403 en un viaje a FLIT.

La ruta `POST /traslados/:id/entregar` hoy lleva `exigirFuncion('logistica.actas.entregar')` en el middleware. Eso dejaría entrar al mensajero y dejaría fuera a quien solo tiene `firmar_flit`. Pasa a guarda en línea, precedente de `tieneFuncion` (inventario de guardas, mismo pliegue que `operar_ajenas`):

1. Lee el `destino` del traslado (404 `TRASLADO_NO_ENCONTRADO` si no está).
2. `flit` → `tieneFuncion(req, 'logistica.actas.firmar_flit')`; si no, 403. Schema `{ firma, lat?, lng? }`.
3. `cliente` → `tieneFuncion(req, 'logistica.actas.entregar')`; si no, 403. Schema de receptor actual, intacto.

Calco del pliegue de `logistica.motivos.gestionar` (0284), no de su padre:

| Pieza | Qué |
|---|---|
| Padre en el árbol | `accion.logistica.despachar_entregar_devolver`, en `opcionales` (junto a `despachar` y `operar_ajenas`). El mensajero recibe las operaciones de esa acción (`entregar`, `devolver`) y no los opcionales. El padre de motivos es `ver_consola` porque eso es el catálogo; la firma es del ciclo del acta. |
| `NACIDOS_DESPUES_DE_0239` | alta del código, comentario HU #14122 / migración 0285 |
| Migración | `0285_flito_logistica_permiso_firmar_flit.sql`. Solo `INSERT` de función (`padre_codigo` = esa acción) y `permisos_rol_funcion` **solo `admin`**. `ON CONFLICT DO NOTHING`. Sin `BEGIN/COMMIT`. Sin `ALTER`. |
| `permisos-seed-sql.ts` | el archivo entra en `MIGRACIONES_CON_REPARTO` y en `RETIROS_DEL_MUNDO_PLANO` |
| `catalogo-operaciones.ts` | `op` de la guarda en línea: `POST /traslados/:id/entregar [firmarFlit]` |

No se siembra a un rol llamado operaciones ni al mensajero. Concederla a Logística es el panel de permisos (la función existe; el reparto de negocio no es un `INSERT` de rol).

### Reparto (AC7)

No hay un endpoint que parta el lote. Diez LT de una compañía, cinco a FLIT y cinco al cliente, son **dos** `POST /traslados`: uno `destino: 'flit'` con sus cinco y su motivo, otro `destino: 'cliente'` sin `origen` con las otras cinco. El único vivo es por `(documento_id, destino)`, así que las dos cabeceras conviven. Meter las diez en un solo `destino: 'cliente'` es un viaje, no el reparto. Mezclar `clasificado` y `en_flit` en un solo destino cliente sigue siendo 422 `TRASLADO_ORIGEN_MIXTO`.

### Qué se retira

`DestinoFlitNoDisponibleError` / `DESTINO_FLIT_NO_DISPONIBLE`: dejan de lanzarse. Si no queda caller, se borra la clase. No se reutiliza para el 409.

### Esquema

No falta columna. **No hay migración de tablas y no se editan 0274 ni 0275.** 0285 es solo la siembra del permiso. Sin `drizzle-kit`.

## Archivos a crear/modificar

**Modificar**

- `apps/api/src/modules/flito-logistica/flito-logistica-traslados.service.ts` — quitar el corte de destino; rama `flit` (motivo, precio `logistica_flit`, acta `punto: 'flit'`, eventos); rama cliente con el discriminador `origen`.
- `apps/api/src/modules/flito-logistica/flito-logistica-traslados-ciclo.service.ts` — quitar el corte en `cargarTraslado`; `firmarLlegadaFlit` (o rama de `entregarTraslado`) con firma de sesión, rol `recibe`, LT → `en_flit`, evento `llegada`.
- `apps/api/src/modules/flito-logistica/flito-logistica-traslados.errors.ts` — `MotivoLlegadaRequeridoError` (422 `MOTIVO_LLEGADA_REQUERIDO`), `LtNoEnFlitError` (409 `LT_NO_EN_FLIT`), `FirmaLlegadaRequeridaError` (422 `FIRMA_LLEGADA_REQUERIDA`).
- `apps/api/src/modules/flito-logistica/flito-logistica.routes.ts` — `origen` opcional en el schema de alta; entrega con `tieneFuncion` según destino y schemas distintos.
- `apps/api/src/modules/permisos/arbol/acciones-gestion.ts` — opcional en `accion.logistica.despachar_entregar_devolver`.
- `apps/api/src/modules/permisos/arbol/sql-legado.ts` — `NACIDOS_DESPUES_DE_0239`.
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` — la guarda en línea.
- `apps/api/__tests__/helpers/permisos-seed-sql.ts` — `MIGRACIONES_CON_REPARTO` y `RETIROS_DEL_MUNDO_PLANO`.
- `packages/shared-types/src/flito-logistica.ts` — `llegada`, `acta_flit` y los dos alias. `tipoEventoEfectivo(null, 'en_flit')` sigue en `null`.
- Tests que hoy esperan `DESTINO_FLIT_NO_DISPONIBLE` (ver P1).

**Crear**

- `apps/api/src/db/migrations/0285_flito_logistica_permiso_firmar_flit.sql`
- `apps/api/__tests__/db/migracion-0285.test.ts` (calco de `migracion-0284.test.ts`)
- `apps/api/__tests__/services/flito-logistica-traslados-flit.test.ts`

No se crean servicio, ruta ni página nuevos. `flito-logistica-motivos.service.ts` y `flito-logistica-precios.ts` se usan y no se reescriben. Web: esta HU no tiene pantalla; el grep de `EventoDocumentoLogisticaTipo` en `apps/web` no tiene consumidores (solo el test de API fija la lista del catálogo).

## ADR: no aplica

No hay ADR nuevo. ADR-0030 ya fijó el recorrido, el precio por destino, el motivo de catálogo, la firma de la sesión sin cédula y la función `logistica.actas.firmar_flit`. NQ1 queda cerrada por el AC5 (el mensajero sin la función recibe 403). Firma, cédula y precio no se reabren: el trazo viaja en el body, el nombre y el `usuario_id` salen de la sesión, `documento_cifrado` queda null, y el precio es `precioTrasladoDe`.

## Notas operativas (backend)

- Imports ESM con `.js`. Errores `*Error` con `status` y `codigo`. SQL solo Drizzle. Mutaciones dentro de la transacción; la lectura de precio y de motivo activo, también.
- `insertarEvento` anula un `tipo` que no esté en el catálogo. Los dos tipos nuevos se añaden **antes** de escribir eventos. No mapear `en_flit` en `TIPO_DESDE_ESTADO_NUEVO`.
- Payload y `audit.detail` sin cédula, sin nombre de firmante y sin el trazo. El `detail` puede llevar id de traslado y destino.
- PDF best-effort después del commit, como el cliente. El acta FLIT no tiene cédula de firmante: no registrar `logPiiAccess` por esa firma.
- `cerrar-lote` y el viaje directo sin campo `origen` tienen que seguir verdes.
- Archivos de servicio lejos del techo de 800 líneas; la llegada cabe en el ciclo. No partir el módulo.
- Tras tocar shared-types: `npm run build -w packages/shared-types`. Grep de `EventoDocumentoLogisticaTipo` por si apareció un `Record` exhaustivo.
- `security-agent`: el diff escribe una firma y añade una función; no hay cédula nueva ni ruta nueva. `db-review-agent`: dispara porque 0285 vive en `migrations/`; el SQL es siembra idempotente, sin DDL y sin tocar 0274/0275.

### Tests P1 (archivos, no el directorio del módulo)

```bash
npm test -w apps/api -- \
  __tests__/services/flito-logistica-traslados-flit.test.ts \
  __tests__/services/flito-logistica-traslados-registrar.test.ts \
  __tests__/services/flito-logistica-traslados-ciclo.test.ts \
  __tests__/services/flito-logistica.eventos-tipo.test.ts \
  __tests__/db/migracion-0285.test.ts
```

| Archivo | Qué afirma |
|---|---|
| `flito-logistica-traslados-flit.test.ts` (nuevo) | AC1 motivo + quién/cuándo + precio `logistica_flit`. AC2 sin motivo e inactivo → 422 `MOTIVO_LLEGADA_REQUERIDO` y cero filas. AC3 sin precio FLIT → 422 y cero filas. AC4 llegada: LT `en_flit`, evento `llegada` con `motivoLlegadaId`, firma rol `recibe`, `usuario_id` de la sesión, `documento_cifrado` null. AC5 mensajero sin la función → 403; con la función firma aunque el rol no sea un nombre fijo. AC6 `origen: 'flit'` + LT `en_flit` congela `logistica_cliente`; `origen: 'flit'` + LT `clasificado` → 409 `LT_NO_EN_FLIT` y cero filas. AC7 dos `POST` de la misma compañía, cinco y cinco, dos traslados. AC8 segunda ida a FLIT con la línea `entregado` → 409 `LT_YA_EN_TRASLADO`; tras `devuelto`, otra vez 201. AC9 «transportadora externa» = misma forma de línea que «Otro». |
| `flito-logistica-traslados-registrar.test.ts` | Se reemplaza el caso `DESTINO_FLIT_NO_DISPONIBLE`. El viaje directo (`clasificado`, sin `origen`, precio cliente) sigue en verde. |
| `flito-logistica-traslados-ciclo.test.ts` | Se reemplaza «despachar un viaje a FLIT → 422». Despachar un viaje a FLIT pasa a `en_ruta`. Entregar un viaje a **cliente** sigue pidiendo cédula y `logistica.actas.entregar`, y no pide `firmar_flit`. |
| `flito-logistica.eventos-tipo.test.ts` | La lista del catálogo incluye `llegada` y `acta_flit`. `tipoEventoEfectivo(null, 'en_flit')` es `null`. `tipoEventoEfectivo('llegada_flit', 'en_flit')` es `llegada`. |
| `migracion-0285.test.ts` | Paridad del pliegue (el archivo está en las dos listas; reparto solo `admin`; segunda lectura idempotente). |

Mutantes: no en este diseño (los nombra `qa-agent` B, tope 3, sobre lógica condicional: motivo ausente/inactivo, precio null, `origen: 'flit'` con LT fuera de `en_flit`).

## Notas operativas (frontend)

No aplica en esta HU. El selector de motivo y la pantalla de firma son C3.5. El contrato que consumirá: el mismo `POST /traslados`, `origen: 'flit'` solo en el tramo de salida, y `POST /traslados/:id/entregar` con `{ firma }` cuando el destino del viaje es FLIT.
