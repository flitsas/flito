# Diseño slim — HU #11935 · Alta sin RUNT bloqueante y verificación

Feature #11912. Canal Cliente de `flito-soat` (no el legado `soat/`). Worktree `flito-11935`. **No se reescribe el Feature** (CF-07/10 quedan desfasados a propósito).

## Patrón reutilizado

| Pieza | Path real | Qué se copia |
|---|---|---|
| Alta del canal | `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` (`crearSolicitud`, `consultarRunt`, satélite `flitoSoatSolicitud`) | Mismo orden de guardas baratas (canal → PDF → RN-01 → tenencia). **Sale** del request el paso 4 (Kyverum). `crear` sigue siendo enviar: `origen='cliente'`, `pendiente_revision`, 201. |
| Upsert de ficha | `upsertVehiculoRunt` en el mismo archivo | Misma política: por VIN; `null` no borra lo que ya se sabía; ficha ajena = 409 recortado. En el alta se llama **sin** marca/organismo (el cliente no los manda). El relleno RUNT va **después**, en el job. |
| Extractor / vigencia | `extraerVehiculoRunt` + `runtSinRegistro` (`flito-impuestos/certificacion-runt.ts`); `derivePreflightChecks` (`tramites/preflight.ts`); `soatVigenteSegunRunt` / `fechaVencimientoSoatRunt` (ya en el canal) | No se reescribe el extractor. «No cuadra» = placa o VIN del RUNT **DIFIERE** de la entrada (misma normalización que `compararCampo` de certificación). Un campo que el RUNT no trajo (`NO_VERIFICABLE`) **no** es «no cuadra». |
| Fire-and-forget | `scheduleProcesarLote` en `apps/api/src/modules/tramites/lote.ts` (`setImmediate` + `catch` + log, sin cola Redis) | Tras el `COMMIT` del alta, `setImmediate(() => verificarRuntPostAlta(soatId))`. Una sola pasada. Si el proceso muere, la fila se queda en `pendiente` y Operaciones valida a mano (AC6). |
| Joins de cola | `conJoinsCola` + `detalle()` en `flito-soat.service.ts` | El `innerJoin` a `organismos_transito_config` pasa a **`leftJoin`**. `vehicles` y `clients` siguen `innerJoin` (`vehiculo_id` / `compania_id` siguen NOT NULL). El export y el ZIP heredan `conJoinsCola`. |
| Celda vacía | `organismoParaExport` (`shared/export/cola-flito-excel.ts`) | Ya admite `(null, null) → null`. ZIP ya tiene fallback `SIN-ORGANISMO`. No se inventa `"—"`. |

**No** se toca `resolverSoat()` ni el INSERT del sync: el trámite **sigue exigiendo** organismo (el sync no escribe `flito_soat` sin código). **No** cola Redis nueva. **No** `jsonb` crudo del RUNT (ADR-0008 §1.6 se **conserva** en eso).

## Contrato delta

`POST /api/flito/soat/cliente` (multipart, rol `cliente`) — **sin esperar Kyverum**:

- **201** `{ id, estado: 'pendiente_revision' }`. Cliente **no** manda marca/organismo.
- **409** RN-01 (`vin_ya_tiene_soat`) igual que hoy (propia recortada / ajena).
- **400** PDF inválido, **403** canal apagado. **Ya no** 503/422/409-vigente en el create.

Verificación **post-201**, persistida en el satélite (no en el 201). `GET /:id` (detalle) amplía `solicitud` (solo canal, no gestor):

```
solicitud.verificacionEstado: 'pendiente' | 'caido' | 'sin_registro' | 'no_cuadra' | 'ok'
solicitud.soatVigente: boolean | null          # null hasta que hay lectura concluyente
solicitud.soatVigenteHasta: 'yyyy-mm-dd' | null
solicitud.verificacionCodigo: string | null    # ver columnas
```

`POST /cliente/preconsulta` **sigue existiendo** (el wizard actual lo llama). **Deja de ser paso del alta**: `crearSolicitud` no la invoca. Su contrato HTTP **no se cambia en esta HU** (el front y el E2E actuales siguen verdes). Fuera de alcance: quitar el `disabled={!runtListo}` de `FlitoSoatSolicitud.tsx`.

`POST /:id/validar` · `rechazar-solicitud` · `PATCH /:id/solicitud`: **ninguna** exige `verificacionEstado === 'ok'`. Validar con `soatVigente=true` es excepción permitida (AC6). Subsanar no relanza el RUNT (placa/VIN no se editan).

## Columnas (satélite `flito_soat_solicitud`)

Migración **`0171_flito_soat_organismo_nullable_verificacion.sql`** (última en disco: `0170_`). SQL plano a mano. Idempotente.

**`flito_soat.organismo_codigo`:** `DROP NOT NULL`. La FK a `organismos_transito_config(codigo)` **queda**. El sync y el trámite no cambian de escritor.

**`flito_soat_solicitud` — cuatro columnas de producto + CHECK (no jsonb):**

| Columna | Tipo | Default / nulos | Valores |
|---|---|---|---|
| `verificacion_estado` | `varchar(20) NOT NULL` | `'pendiente'` | `pendiente` · `caido` · `sin_registro` · `no_cuadra` · `ok` |
| `soat_vigente` | `boolean` | `NULL` | `true`/`false` solo con lectura concluyente (`ok`); `NULL` en pendiente/caído/sin registro/no cuadra |
| `soat_vigente_hasta` | `date` | `NULL` | Solo si `soat_vigente=true` **y** el RUNT trajo fecha; si no, `NULL` (mismo contrato que hoy el 409) |
| `verificacion_codigo` | `varchar(40)` | `NULL` | Máquina, mismo vocabulario que `CodigoErrorSolicitudSoat`: `runt_no_disponible` · `runt_sin_registro` · `runt_no_cuadra` (nuevo) · `organismo_no_catalogado` (aviso con `ok`, organismo NULL). **Nunca** payload crudo |

`ok` no está en el AC2 (lista los desenlaces de fallo + pendiente); hace falta para no dejar el éxito indistinguible de «aún no corrió». CHECK en la base, constante en `flito-estados.ts`.

Backfill: filas ya radicadas del canal pasaron por RUNT bloqueante → `verificacion_estado='ok'`. `soat_vigente*` se deja `NULL` (no se persistía).

## Orden de pasos en `crearSolicitud`

```
1. canalDeLaCompania          # 403 flag / sin compañía
2. verificarPdfReal           # 400, antes de gastar nada
3. verificarRn01              # 409, antes de S3 y de RUNT
4. verificarTenenciaVehiculo  # 409 ficha ajena
5. soatId = randomUUID() + upload S3   # fuera de la tx (CA-11)
6. TRANSACTION:
     upsertVehiculoRunt(..., datos vacíos)  # placa/VIN/propietario; marca/línea/organismo NO
     INSERT flito_soat (origen=cliente, pendiente_revision, organismo_codigo=NULL)
     INSERT flito_compradores
     INSERT flito_soat_solicitud (verificacion_estado='pendiente', códigos NULL)
     INSERT flito_soportes (factura_venta)
     registrarCambio → pendiente_revision
7. COMMIT
8. setImmediate(() => verificarRuntPostAlta(soatId).catch(log))  # no await
9. return { id, estado: pendiente_revision }   # 201
```

**`verificarRuntPostAlta(soatId)`** (cierra sobre el id, **no** sobre el documento):

1. Lee placa/VIN de `flito_soat`×`vehicles` y tipo/número de `flito_compradores`. Si `verificacion_estado !== 'pendiente'`, return (idempotente).
2. `consultarVehiculoRunt` (mismo mapeo de tipo que hoy, Bug #11927).
3. Clasifica y **UPDATE del satélite** (nunca el crudo):
   - `!ok` / throw / timeout → `caido` + `runt_no_disponible`
   - `runtSinRegistro` → `sin_registro` + `runt_sin_registro`
   - placa o VIN DIFIERE → `no_cuadra` + `runt_no_cuadra` (no toca `vehicles` ni organismo)
   - resto → `ok`; `soat_vigente` / `soat_vigente_hasta` desde las funciones que ya existen; **no** pasa a `solicitado`
4. Si `ok`: rellena `vehicles` (solo campos RUNT con valor; **no** `owner_*`) y `flito_soat.organismo_codigo` **solo si** el nombre cruza catálogo nacional **y** está en `organismos_transito_config`. Si no cruza: organismo se queda `NULL`, `verificacion_codigo='organismo_no_catalogado'`, estado sigue `ok`.

Log del job (`loggerFor('flito-soat-cliente')`): `{ soatId, verificacionEstado }`. **Prohibido** placa, VIN, documento, nombre.

## leftJoin cola / detalle / export

Un solo sitio: `conJoinsCola`. `detalle()` duplica los joins a mano (líneas ~917–919) → el mismo `leftJoin`. Facetas: filtrar la fila `{ codigo: null }` igual que ya se filtra el proveedor nulo. Filtro `organismos=` de `condicionesCola` (`inArray`) no devuelve las NULL: correcto (quien filtra por secretaría no pide las que no tienen).

Pantalla: `organismoNombre` ya es `string | null`; `FlitoSoat.tsx` ya pinta `'—'`.

## Archivos a crear/modificar

**Crear**

- `apps/api/src/db/migrations/0171_flito_soat_organismo_nullable_verificacion.sql`
- `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts` — extractor ya existente + `consultarRunt` no bloqueante + `verificarRuntPostAlta`. Parte `flito-soat-cliente.service.ts` (max-lines 800; ese archivo no tiene techo congelado y no puede absorber el job).
- `apps/api/__tests__/services/flito-soat.cliente-verificacion-runt.test.ts` — AC2/AC3 post-201 (flush `setImmediate`).
- `apps/api/__tests__/services/flito-soat-migracion-0171-organismo-nullable.test.ts` — DROP NOT NULL + CHECK + idempotencia del SQL (P6: el archivo nuevo, dos veces).
- `docs/adr/ADR-0009-flito-soat-runt-no-bloquea-alta.md` (**Propuesto**).

**Modificar**

- `apps/api/src/db/schema.ts` — `flitoSoat.organismoCodigo` sin `.notNull()`; 4 columnas + check en `flitoSoatSolicitud`.
- `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` — nuevo orden de `crearSolicitud`; cabecera (RUNT ya no bloquea); `validar`/`rechazar`/`subsanar` sin guarda de verificación (hoy no la tienen: **no añadirla**); mover helpers RUNT al archivo nuevo.
- `apps/api/src/modules/flito-soat/flito-soat.service.ts` — `leftJoin` en `conJoinsCola` y en `detalle`; `RevisionSolicitud` + `revisionDeSolicitud` proyectan las 4 columnas; facetas descartan organismo nulo.
- `packages/shared-types/src/flito-estados.ts` — `EstadoVerificacionSolicitudSoat` + `CodigoErrorSolicitudSoat.RUNT_NO_CUADRA`.
- `apps/api/__tests__/services/flito-soat.cliente-alta.test.ts` — AC2/AC3 del **create** dejan de esperar 503/422/409-vigente; el INSERT nace con `organismoCodigo: null` y `verificacion_estado: 'pendiente'`. RN-01 (AC4) no se toca. Preconsulta: asertos actuales **se quedan** (endpoint no cambia).
- Cabecera de `flito-soat-cliente.service.ts` / `.routes.ts`: apuntar a ADR-0009 para el alta; no reescribir ADR-0008.

**No tocar (declarado)**

- `apps/web/**` (wizard, E2E `soat-cliente-solicitud.spec.ts`). El botón Enviar sigue exigiendo `runtListo`: el AC1 queda cubierto en **API**; el wizard se desbloquea en una HU frontend aparte.
- `flito-sync.service.ts` / `resolverSoat` / `POST /enviar` del trámite.
- Feature #11912 en ADO. ADR-0008 no se reescribe (lo supersede el 0009 en los puntos nombrados).
- Redis, crons, tabla nueva.

## ADR

**Sí aplica** — `docs/adr/ADR-0009-flito-soat-runt-no-bloquea-alta.md`, estado **Propuesto**. Sienta precedente: RUNT no es compuerta del INSERT; `organismo_codigo` nullable en la tabla caliente; verificación fire-and-forget. **Supersedes** de ADR-0008 (aún Propuesto): organismo obligatorio al crear (§1.6 en esa parte), preconsulta como paso 1 del alta (§6 fila 1) y el 409-vigente / 503 que abortaban `POST /cliente`. **No supersede** §1.6 en «no persistir el crudo», ni la tabla satélite, ni RN-01.

## Notas operativas (backend / frontend)

**backend-agent**

- Empieza por la `0171` y el `schema.ts`. Luego el split RUNT → `flito-soat-cliente-runt.ts`. Luego el orden de `crearSolicitud` y el `leftJoin`.
- Tests P1 (lista explícita, no el glob del módulo): `flito-soat.cliente-alta.test.ts`, `flito-soat.cliente-verificacion-runt.test.ts`, `flito-soat-migracion-0171-organismo-nullable.test.ts`, más el de revisión que cubra AC6 si hace falta un aserto nuevo (`flito-soat.revision-rechazo-subsanacion.test.ts` — solo si se añade guarda por error).
- Flush de `setImmediate` en Vitest: `await new Promise((r) => setImmediate(r))` después del 201, **o** inyectar el scheduler. No usar cola Redis de prueba.
- `grep organismoCodigo` en `apps/api` tras quitar el `.notNull()`: el infer de Drizzle pasa a `string | null`. El sync sigue pasando `string`.
- P6: aplicar **solo** `0171` dos veces sobre la BD local ya migrada. Avisar que se tocó la BD del usuario.
- PII: el job lee documento de `flito_compradores` y no lo loguea. `audit()` / `detail` del relleno de `vehicles` igual que hoy (uuid del SOAT, sin placa ni cédula).

**frontend-agent**

- **No aplica en esta HU.** El JSON nuevo en `solicitud` lo ignora el front actual. Pintar aviso de vigente / estado de verificación / organismo «—» en cola ya funciona (`?? '—'`).

**db-review-agent** — dispara: `schema.ts` + `migrations/0171`. FK de organismo se queda; CHECK de `verificacion_estado`; backfill `ok` de filas viejas.

**security-agent** — dispara: se sigue leyendo documento para Kyverum (post-commit) y se escriben columnas derivadas. Comprobar: cero crudo, cero PII en logs del job, RN-01 recortado intacto.

## Fuera de alcance (no preguntar: ya cerrado en el prompt)

- Reescribir el Feature o ADR-0008.
- HU frontend del wizard / preconsulta.
- Cola Redis, reintentos, cifrado del payload RUNT.
- Auto-transición a `solicitado` cuando hay SOAT vigente.
- Relanzar RUNT al subsanar.
