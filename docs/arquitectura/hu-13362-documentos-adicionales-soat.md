# Diseño slim — HU #13362 Documentos adicionales en el alta de SOAT (canal Cliente)

Épica #13201 · Feature #13360 · módulo FLITO **`flito-soat`** (`/api/flito/soat`), **no** el legacy `soat`.
Estado: **Propuesto** (diseño slim; ADR no aplica — ver al final).

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Alta multipart + `crearSolicitud` (validar → subir fuera de tx → tx) | `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` (`POST /cliente`) y `flito-soat-cliente.service.ts` (`crearSolicitud`, l. ~1336) |
| Detección de MIME por bytes | `apps/api/src/modules/pesv/magic-number.ts` → `detectMime(buf)` (`file-type`, ya en el repo). **Sin dependencia nueva**: `file-type` reconoce WEBP y HEIC/HEIF por la marca `ftyp` |
| Subida / borrado en S3-MinIO | `apps/api/src/services/storage.ts` → `uploadEntityDocument` (clave opaca por defecto, sin el nombre original: no meter `conservarNombreEnClave`) y `deleteEntityDocument` |
| URL de descarga firmada | `firmarDescargaEntidad(storageKey)` (lo mismo que `porRegistro` en `shared/soportes/soportes-consulta.ts`) |
| Frontera de acceso 404-no-403 | `buscarConAcceso(id, ctx)` de `flito-soat.service.ts` (ya exportada, l. 1137) |
| Función configurable | `exigirFuncion(codigo)` (`shared/middleware/exigir-funcion.ts`) + entrada en `modules/permisos/catalogo-operaciones.ts` + siembra SQL calcada de `0212_*.sql` / `0220_*.sql` |

## Decisiones

### D1. Disco temporal, no memoria — motor de almacenamiento propio de multer

250 MB por envío en `memoryStorage` × concurrencia puede tumbar el proceso en el VPS. Se usa un
**`StorageEngine` propio** (archivo nuevo `flito-soat-documentos.upload.ts`) para el campo
`documentosAdicionales`; `facturaVenta` sigue con el comportamiento actual.

- Límites de **busboy/multer holgados** para que nunca disparen el 413/500 genérico por un excedente
  de negocio: `limits: { fileSize: 251 MB, files: 1 + 100, fields: 100 }`. Los topes de negocio (15 MB,
  20 archivos, 250 MB) los aplica el motor + el servicio, no multer.
- Por cada archivo de `documentosAdicionales` el motor:
  1. Escribe a `os.tmpdir()/flito-soat-adic-<uuid>/<n>` (directorio por petición).
  2. Calcula **sha256 al vuelo** (`crypto.createHash` sobre los chunks) y guarda los **primeros 4100 bytes**
     en memoria para el olfateo de MIME.
  3. Si el archivo supera **15 MB**: deja de escribir, borra el parcial, **drena** el resto del stream
     (`stream.resume()`) y entrega el archivo con `excedeTamano: true` (sin `path`). No llama `cb(error)`.
  4. Si el total escrito de la petición superaría **265 MB** (250 + 15 de holgura): drena sin escribir y
     marca `excedeTotal: true` (protección de disco; la regla de negocio exacta de 250 MB la aplica el servicio).
- `facturaVenta`: si supera 15 MB el motor llama `cb(new multer.MulterError('LIMIT_FILE_SIZE','facturaVenta'))`
  → mismo error que hoy (AC3/AC7: lo que hoy falla sigue fallando igual). La factura se lee a `Buffer`
  (≤15 MB) antes de llamar a `crearSolicitud`, como hoy.
- `_removeFile` del motor borra el temporal. Además la ruta hace **`finally { rm(dirPeticion, { recursive: true, force: true }) }`**
  en todos los caminos (éxito, error de negocio, excepción).
- Ruta: `upload.single('facturaVenta')` → `upload.fields([{ name: 'facturaVenta', maxCount: 1 }, { name: 'documentosAdicionales', maxCount: 100 }])`.
  Un `facturaVenta` duplicado (>1) sigue siendo error de multer como hoy.
- Techo técnico (no de negocio): >100 adicionales → `LIMIT_FILE_COUNT` de multer. Se traduce a **413**
  con mensaje explícito «Se enviaron demasiados archivos (máximo técnico 100)»; nunca 500 genérico.
  Ver «Pendiente humano».

### D2. Clasificación (orden recibido, servicio puro, sin E/S de storage)

`clasificarAdicionales(archivos, etiquetas, hashFactura)` en `flito-soat-documentos.service.ts`.
Para cada archivo, **en el orden recibido**, la primera regla que falla decide el motivo:

| # | Regla | `codigo` | `motivo` (texto para la persona) |
|---|---|---|---|
| 1 | `excedeTamano` (>15 MB) | `supera_tamano` | «supera el tamaño máximo de 15 MB» |
| 2 | `detectMime(cabecera)` ∉ {`application/pdf`,`image/jpeg`,`image/png`,`image/webp`,`image/heic`,`image/heif`} (incluye vacío / no reconocido) | `formato_no_permitido` | «formato no permitido» |
| 3 | sha256 ya visto en este envío (**incluye el hash de la factura de venta**) | `documento_repetido` | «documento repetido» |
| 4 | ya hay 20 aceptados | `supera_cantidad` | «supera el máximo de 20 documentos por envío» |
| 5 | `excedeTotal` o suma de aceptados + tamaño > 250 MB | `supera_total` | «supera el total de 250 MB por envío» |

- El `contentType` que se persiste es el **detectado**, no el declarado.
- Etiqueta: `trim()`; vacía/ausente → nombre original del archivo (AC2). Ambas truncadas a **150**.
- Etiquetas en el multipart: campo de texto repetido `etiquetasDocumentosAdicionales`, **alineado por índice**
  con `documentosAdicionales` (multer da `string | string[]`: normalizar a array). Si sobran o faltan, el
  archivo sin etiqueta usa su nombre. Validación Zod propia (array de string ≤150), **no** dentro de `altaSchema`.

### D3. Atomicidad (AC7) — orden de operaciones

```
ruta: multer(motor) → altaSchema → clasificarAdicionales (puro)            [nada en storage ni BD]
crearSolicitud:
  1..6  validaciones de hoy (PDF real, RN-01, tenencia, RUNT compuerta…)    [si fallan: throw, nada subido]
  7     subir factura (como hoy) + subirAdicionales(aceptados) secuencial   [lee cada temporal ≤15 MB a Buffer]
  8     db.transaction: … insertarSolicitudDespachada … + insertarAdicionales(tx, filas)
        catch → Promise.allSettled(deleteEntityDocument(key) de los adicionales subidos) → rethrow
ruta (tras COMMIT): audit() por adicional guardado; 201 con documentosAdicionales
finally: rm del directorio temporal
```

- `subirAdicionales`: si una subida falla, borra las ya subidas (allSettled) y **relanza** → el alta falla
  igual que hoy cuando falla la subida de la factura. No se «descarta» por fallo de infraestructura.
- La factura de venta hoy **no** se compensa si la tx falla (objeto huérfano preexistente). Fuera de alcance
  de esta HU → Nota en el PR; si el backend lo cubre gratis en el mismo `catch`, mejor, pero no es AC.
- **Desenlace `incompleta` (RUNT caído → 202):** los adicionales **sí se guardan** (decisión de David,
  2026-10-07: «no tienen nada que ver con el RUNT»). Siguen el camino de la factura de venta. Detalle en **D3-bis**.

Integración en `crearSolicitud` (cliente.service, sin techo en eslint pero con el gate de 800 líneas
efectivas — correr `npx eslint` sobre él): **un parámetro opcional** `adicionales?: AdicionalAceptado[]`
(default `[]`) y dos llamadas a funciones del servicio nuevo (subir tras la factura; insertar dentro de la tx
con `soatId`, `subidoPorId: ctx.userId`, `subidoPorNombre: ctx.username`); el `catch` existente gana la
compensación. `crearSolicitud` devuelve además `adicionalesGuardados: { id, etiqueta, nombreArchivo, contentType, tamanoBytes }[]`
para que la ruta haga el `audit` y la respuesta. En la rama `incompleta` devuelve los guardados contra la
solicitud por validar (D3-bis), con la misma forma.

### D3-bis. Solicitud por validar (RUNT caído → 202): mismo camino que la factura de venta

**Cómo está modelado hoy** (leído en `flito-soat-incompletas.service.ts` → `aparcarSolicitud` y
`flito-soat-incompletas-reintento.service.ts`):
- La por validar vive en `flito_soat_incompletas`, que **reserva `soat_id_reservado`** (uuid) al aparcar.
- La factura de venta **no** va a `flito_soportes`: se sube a S3 con `entityId = soatIdReservado` (carpeta
  `soat/facturas-venta`) y sus datos van en columnas de la propia incompleta (`factura_storage_key`, `factura_hash`…).
  El propietario va a `flito_compradores` con la FK `soat_incompleta_id` (sin CASCADE, 0210).
- **Completar** (`reintentarIncompleta` → transacción de completar): `soatId = fila.soatIdReservado`, y
  `insertarSolicitudDespachada` crea **en ese momento** la fila de la factura en `flito_soportes`, leyendo las columnas de la incompleta.
- **Descartar** (`descartar`): solo cambia `estado = descartada`; **la factura no se borra de storage** y la
  incompleta descartada sigue consultable (`GET /cliente/incompletas/:id`, función `soat.incompleta.ver`).
  **No hay caducidad ni purga**: no existe cron ni `deleteEntityDocument` en `flito-soat`.

**Diseño (mínimo, calcado de `flito_compradores`):**
1. **FK nueva** `flito_soportes.soat_incompleta_id uuid NULL REFERENCES flito_soat_incompletas(id)` (**sin CASCADE**, como
   `flito_compradores.soat_incompleta_id`) + índice parcial `idx_flito_soportes_soat_incompleta (soat_incompleta_id) WHERE soat_incompleta_id IS NOT NULL`.
   Las filas del adicional se insertan **ya** en `flito_soportes` (a diferencia de la factura, que tiene columnas propias en la
   incompleta): N documentos no caben en columnas, y la fila nace con `tipo`, `etiqueta`, `hash`, autor y fecha de carga reales.
2. **Aparcar** — `aparcarSolicitud(entrada, ctx)`: `EntradaAparcar` gana `adicionales?: AdicionalAceptado[]` (default `[]`).
   Tras subir la factura: `subirAdicionales(carpeta, soatIdReservado, adicionales)` (mismo `entityId` que la factura).
   Dentro de la **misma** transacción que inserta la incompleta y el comprador: `insertarAdicionales(tx, filas, { soatIncompletaId: id })`
   con `soat_id = NULL`. En el `catch` (incluida la rama `UNIQUE_VIOLATION` → `vin_ocupado` → 409 `incompletaAjena`):
   **borrar de storage los adicionales subidos** (`Promise.allSettled(deleteEntityDocument)`) — AC7: nada queda.
   `aparcarSolicitud` devuelve además `adicionalesGuardados` con la misma forma que `crearSolicitud`.
3. **Completar** — en la transacción de completar de `flito-soat-incompletas-reintento.service.ts`, justo después de
   `insertarSolicitudDespachada`: `tx.update(flitoSoportes).set({ soatId }).where(and(eq(flitoSoportes.soatIncompletaId, inc.id), eq(flitoSoportes.tipo, TipoSoporte.DOCUMENTO_ADICIONAL_SOAT)))`.
   Se **conserva** `soat_incompleta_id` como rastro, igual que hace el comprador. La clave de storage no cambia: ya
   se nombró con `soatIdReservado`, que es el `soat_id` final. Si la transacción de completar se revierte, el UPDATE también.
4. **Descartar**: **no se toca nada**, igual que la factura: los adicionales quedan colgados de la incompleta descartada,
   con `soat_id NULL`. Por eso **nunca** aparecen en `GET /:id/documentos-adicionales`, que filtra por `soat_id`, ni en `soportesDeSoat`.
   **Sin borrado de storage en esta HU**: hoy no existe ni para la factura. Una purga por retención (Ley 1581) de
   incompletas descartadas tendría que cubrir factura y adicionales a la vez → WI aparte, ver «Pendiente humano».
5. **Lectura mientras está por validar**: fuera de alcance (AC8 habla de la solicitud). `GET /cliente/incompletas/:id`
   lee la factura de columnas de la incompleta, no de `flito_soportes`, así que **no** filtra los adicionales. Nada que excluir.
6. CHECK de integridad (va junto al de la etiqueta, D4): un adicional cuelga de una solicitud o de una por validar —
   `tipo <> 'documento_adicional_soat' OR (soat_id IS NOT NULL OR soat_incompleta_id IS NOT NULL)`.
   `flito_soportes_factura_excluyente_chk` no se toca: solo restringe `siigo_factura_id` y `conciliacion_boleta_id`.

**Respuesta del 202:** incluye `documentosAdicionales` con la **misma forma** que el 201 (`aceptados` = guardados contra
la por validar, `descartados` con su motivo), y solo si se envió al menos un adicional. El motivo `solicitud_por_validar` **desaparece**.

**Bitácora del 202:** un `audit` por adicional guardado, con `resource: 'flito_soat_incompletas'` y `resourceId` = id de la incompleta
(el mismo recurso que ya usa el `audit` de la 202), y el mismo `detail` de AC10. Al completar **no** se repite el «cargado»:
el documento se cargó una sola vez. El `audit` de completar que ya existe basta, y la fila conserva `soat_incompleta_id` para reconstruir el caso.

### D4. Modelado en `flito_soportes`

- `tipo` es `varchar(40)` **sin enum de Postgres y sin CHECK** → valor nuevo, **sin `ALTER TYPE`**:
  `TipoSoporte.DOCUMENTO_ADICIONAL_SOAT = 'documento_adicional_soat'` en `packages/shared-types/src/flito-estados.ts`.
- Columna nueva **`etiqueta varchar(150) NULL`** + CHECK `flito_soportes_documento_adicional_chk`:
  `tipo <> 'documento_adicional_soat' OR (etiqueta IS NOT NULL AND (soat_id IS NOT NULL OR soat_incompleta_id IS NOT NULL))`
  (las filas existentes la cumplen: son de otros tipos).
- Columna nueva **`soat_incompleta_id uuid NULL` FK → `flito_soat_incompletas(id)`**, sin CASCADE (D3-bis).
- Índices: la lectura por solicitud ya la cubre `idx_flito_soportes_soat_tipo (soat_id, tipo) WHERE descartado = false`.
  Se añade **solo** el parcial `idx_flito_soportes_soat_incompleta`, para el UPDATE de completar.

### D5. Hash

La tabla **ya tiene `hash varchar(64) NOT NULL` + `idx_flito_soportes_hash`**: se guarda ahí el sha256
calculado al vuelo. **No hace falta columna `sha256` nueva**; #13364 deduplicará contra
`(soat_id, tipo, hash) WHERE descartado = false` con el índice existente por `soat_id, tipo`.

### D6. Exclusión de la lista general, ZIP y exportaciones (AC9)

- `soportesDeSoat()` → `porRegistro()` en `shared/soportes/soportes-consulta.ts`: los roles internos leen con
  `tipos = null` (sin recorte), así que **hoy el adicional saldría**. Añadir en el `where` de `porRegistro`
  `notInArray(flitoSoportes.tipo, TIPOS_SOPORTE_FUERA_DE_LISTA)` con
  `export const TIPOS_SOPORTE_FUERA_DE_LISTA = [TipoSoporte.DOCUMENTO_ADICIONAL_SOAT] as const` (aplica a todo
  origen; inocuo en impuesto/derecho). El canal Cliente ya lo excluye por allowlist (`TIPOS_SOPORTE_VISIBLES_CLIENTE`).
- ZIP (`shared/soportes/soportes-zip.ts`): filtra por allowlist `inArray(tipo, tiposBd)` (`TipoSoporteZip`) →
  **ya excluido**; solo test de regresión, no cambio de código.
- Exportaciones: `flito-soat.export-pago.ts` filtra `tipo = factura_soat` → ya excluido. El backend hace **un**
  `grep -rn "flitoSoportes.soatId" apps/api/src/modules apps/api/src/shared` y confirma que ningún otro lector
  por `soat_id` lee sin filtro de tipo; si aparece uno, se excluye igual.

## Contrato delta

**`POST /api/flito/soat/cliente`** (multipart; función `soat.solicitud.crear`, sin cambio de permiso)
- Entrada nueva opcional: `documentosAdicionales` (0..n archivos), `etiquetasDocumentosAdicionales` (0..n textos, por índice).
- 201 **y 202** (la por validar también guarda los adicionales, D3-bis): se añade la clave **solo si se envió al menos un adicional** (AC3: sin adicionales, cuerpo idéntico a hoy):
```ts
documentosAdicionales?: {
  aceptados: { id: string; etiqueta: string; nombreArchivo: string; tipoContenido: string; tamanoBytes: number }[];
  descartados: { nombreArchivo: string; codigo: MotivoDescarteDocumentoAdicional; motivo: string }[];
}
```
- Errores existentes (400/409/422/503 de `SolicitudSoatError`) intactos; ningún adicional queda guardado (AC7).

**`GET /api/flito/soat/:id/documentos-adicionales`** (nuevo; `authMiddleware` + `exigirFuncion('soat.documentos_adicionales.ver')`)
- `:id` = uuid opaco (permitido en path, §14). `buscarConAcceso` null → **404** (proveedor sin la solicitud asignada, AC8). Sin la función → **403** (AC9).
- 200: `{ documentos: { id; etiqueta; tipoContenido; tamanoBytes; subidoEn /*ISO*/; subidoPorNombre; url /*firmarDescargaEntidad*/ }[] }`, orden `subidoEn ASC, id`; filtro `tipo = documento_adicional_soat AND descartado = false`.
- **No** se inscribe en `shared/middleware/canal-cliente.ts`: el cliente no tiene la función y la guardia del canal ya le cierra la ruta (403). Esto ajusta la nota técnica de la HU («rutas nuevas del canal se inscriben»): la única ruta del canal tocada es el alta, que ya está inscrita.

**Tipos en `@operaciones/shared-types`** (`packages/shared-types/src/flito-estados.ts` o junto a `RespuestaAltaSolicitudSoat`):
`TipoSoporte.DOCUMENTO_ADICIONAL_SOAT`, `MotivoDescarteDocumentoAdicional` (`'supera_tamano' | 'formato_no_permitido' | 'documento_repetido' | 'supera_cantidad' | 'supera_total'`),
`ResultadoDocumentosAdicionales`, `DocumentoAdicionalSoat` (fila del GET), y `RespuestaAltaSolicitudSoat` gana `documentosAdicionales?` (aditivo).
Regla 7: `grep -rn "RespuestaAltaSolicitudSoat\|TipoSoporte" apps/web/src` tras el cambio (aditivo, no debería romper).

**Bitácora (AC10)** — en la ruta, tras el COMMIT, por cada adicional guardado (en el 202: `resource: 'flito_soat_incompletas'`, `resourceId` = id de la incompleta; ver D3-bis):
`audit(req, { action: 'create', resource: 'flito_soat', resourceId: soatId, detail: \`Documento adicional cargado (soporte=${id}, etiqueta=${etiqueta})\` })`.
Si la etiqueta vino vacía (se usó el nombre) → `nombre=${nombre.slice(0, 40)}…`. Nunca contenido ni nombre completo. Usuario y fecha los pone `audit()`.

## Migración

`apps/api/src/db/migrations/0222_flito_soportes_documentos_adicionales_soat.sql` (última en develop b0efa295: `0221_…`).
Sin BEGIN/COMMIT (lo envuelve el runner), idempotente, calcada de `0212`/`0220`:
1. `ALTER TABLE flito_soportes ADD COLUMN IF NOT EXISTS etiqueta varchar(150);`
   `ALTER TABLE flito_soportes ADD COLUMN IF NOT EXISTS soat_incompleta_id uuid REFERENCES flito_soat_incompletas(id);`
   `CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_incompleta ON flito_soportes (soat_incompleta_id) WHERE soat_incompleta_id IS NOT NULL;`
2. CHECK `flito_soportes_documento_adicional_chk` (D4) dentro de `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …) THEN ALTER TABLE … ADD CONSTRAINT … END IF $$`.
3. `INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES ('soat.documentos_adicionales.ver','soat','Ver los documentos adicionales de una solicitud de SOAT','Abrir y descargar los documentos adicionales que el cliente adjuntó a la solicitud de SOAT.','operacion') ON CONFLICT (codigo) DO NOTHING;` — **textos byte a byte** con la entrada del catálogo.
4. `INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES ('admin', …), ('proveedor', …) ON CONFLICT DO NOTHING;` (operación FLIT = `admin`; proveedor SOAT = `proveedor` en `USER_ROLES`; **sin** `cliente`).
5. Bloque `DO $resumen0222$` con `RAISE EXCEPTION` si la función ≠ 1 y `RAISE NOTICE` del reparto.

**Riesgo de numeración:** otra sesión trabaja en impuestos/FLIT 1 y puede tomar `0222`. Antes del PR:
`git fetch && git ls-tree origin/develop apps/api/src/db/migrations/ | tail -3`; si `0222_` ya existe, renombrar
a la siguiente libre (y el `$resumen…$`/mensajes). Como ninguna está aplicada fuera de local, renombrar es seguro.
Verificación P6: aplicar el archivo dos veces sobre la BD local (puerto 5434).

## Archivos a crear/modificar

| Acción | Archivo | Qué |
|---|---|---|
| Crear | `apps/api/src/modules/flito-soat/flito-soat-documentos.upload.ts` | `StorageEngine` a disco (D1) + instancia `uploadAlta` con `.fields(...)` y límites holgados; tipo `ArchivoAdicionalRecibido` (`path?`, `originalname`, `size`, `sha256`, `cabecera: Buffer`, `excedeTamano`, `excedeTotal`); helper `limpiarTemporales(req)` |
| Crear | `apps/api/src/modules/flito-soat/flito-soat-documentos.service.ts` | `clasificarAdicionales` (D2), `subirAdicionales` + compensación, `insertarAdicionales(tx, …)`, `listarDocumentosAdicionales(id, ctx)` (usa `buscarConAcceso`), constantes 15 MB / 20 / 250 MB / MIMEs, `DocumentoAdicionalError` si hace falta |
| Crear | `apps/api/src/modules/flito-soat/flito-soat-documentos.routes.ts` | `router.use(authMiddleware)`; `GET /:id/documentos-adicionales` con `exigirFuncion('soat.documentos_adicionales.ver')`; validar `:id` uuid (Zod) → 404 |
| Modificar | `apps/api/src/app.ts` | montar `flitoSoatDocumentosRoutes` en `/api/flito/soat` **antes** de `flitoSoatRoutes` (junto a incompletas, l. ~265-268) |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` | alta: `upload.single` → `uploadAlta`; leer factura de `req.files.facturaVenta[0]`; llamar `clasificarAdicionales`; pasar aceptados a `crearSolicitud`; `audit` por guardado; `documentosAdicionales` en 201/202; `finally` limpieza; traducir `LIMIT_FILE_COUNT` a 413. Lo nuevo en el `.upload.ts`/`.service.ts`, no aquí (archivo cerca del límite) |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` | `crearSolicitud(..., adicionales = [])`: subir tras la factura, insertar en la tx, compensar en el `catch`; `aparcarPorRuntCaido` pasa los adicionales a `aparcarSolicitud` (D3-bis); devolver `adicionalesGuardados` en los dos desenlaces. `ArchivoSolicitud` de la factura no cambia |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-incompletas.service.ts` | `EntradaAparcar.adicionales?`; en `aparcarSolicitud`: subir con `soatIdReservado`, insertar con `soatIncompletaId` en la misma tx, compensar en el `catch` (incluida `vin_ocupado`), devolver `adicionalesGuardados` (D3-bis §2) |
| Modificar | `apps/api/src/modules/flito-soat/flito-soat-incompletas-reintento.service.ts` | en la tx de completar, tras `insertarSolicitudDespachada`: UPDATE `soat_id = soatIdReservado` de los adicionales de la incompleta (D3-bis §3). `descartar` sin cambios |
| Modificar | `apps/api/src/shared/soportes/soportes-consulta.ts` | `TIPOS_SOPORTE_FUERA_DE_LISTA` + `notInArray` en `porRegistro` (D6) |
| Modificar | `apps/api/src/modules/permisos/catalogo-operaciones.ts` | `const SOAT_DOC = 'flito-soat/flito-soat-documentos.routes.ts'` + `op(\`${SOAT_DOC} GET /:id/documentos-adicionales\`, 'soat.documentos_adicionales.ver', …)` (textos = migración) |
| Modificar | `apps/api/src/db/schema.ts` | `etiqueta: varchar('etiqueta', { length: 150 })` y `soatIncompletaId: uuid('soat_incompleta_id').references(() => flitoSoatIncompletas.id)` en `flitoSoportes`, + el CHECK y el índice parcial en el bloque de índices. **Techo congelado 3400** en `eslint.config.mjs`: correr `npx eslint apps/api/src/db/schema.ts`; si suma por encima, compactar en la misma área (p. ej. el CHECK en una línea), nunca subir el techo |
| Crear | `apps/api/src/db/migrations/0222_flito_soportes_documentos_adicionales_soat.sql` | ver «Migración» |
| Modificar | `packages/shared-types/src/flito-estados.ts` (+ donde viva `RespuestaAltaSolicitudSoat`) | tipos del contrato |
| Crear | `apps/api/__tests__/…/flito-soat-documentos.service.test.ts` | clasificación AC1-AC6 (incluye exe renombrado `.pdf`, HEIC por `ftyp`, >15 MB, 21.º archivo, suma >250 MB, repetido, repetido de la factura, etiqueta vacía→nombre) |
| Crear | `apps/api/__tests__/…/flito-soat-documentos.routes.test.ts` | GET: 200 con función, 404 sin acceso, 403 sin función; DTO sin `storageKey` |
| Modificar/crear | test del alta del cliente existente (el que cubre `POST /cliente`) | AC3 cuerpo idéntico sin adicionales; AC7 error de validación → `uploadEntityDocument` no llamado para adicionales; fallo de tx → `deleteEntityDocument` llamado con las claves; AC10 `audit` sin nombre completo; **202 con adicionales** → filas con `soat_incompleta_id` y `soat_id NULL`, `documentosAdicionales` en el cuerpo, `audit` con `flito_soat_incompletas` |
| Modificar | tests existentes de `aparcarSolicitud` y de completar/descartar una incompleta | `vin_ocupado` → adicionales borrados de storage; completar → UPDATE `soat_id` acotado a la incompleta **y** al tipo (asertar sobre el `where`, no solo sobre la llamada); descartar → adicionales intactos |
| Modificar | test de `soportes-consulta` / ZIP existente | AC9: el tipo nuevo no sale en `soportesDeSoat` para un rol interno ni en el ZIP |

(Rutas exactas de `__tests__/`: las del directorio de tests de `flito-soat` y `shared/soportes` ya existentes; P1 = solo estos archivos.)

## ADR: no aplica

Extiende `flito_soportes` (tipo nuevo en varchar, columna nullable) y el alta existente; no hay contrato
transversal nuevo ni dependencia nueva. La decisión de disco temporal (D1) es local al módulo; si se
reutiliza en #13364 / otros módulos, entonces sí merece ADR.

## Notas operativas

**backend-agent**
- Imports relativos con `.js`; Drizzle `notInArray`/`and`/`eq`; nada de `drizzle-kit`.
- `detectMime` se importa de `../pesv/magic-number.js` (reusar; no duplicar). Pasarle la **cabecera** (4100 bytes) basta para `file-type`.
- Probar el motor de multer con supertest + `attach()` de buffers de 15 MB+1; no hace falta archivo real de 250 MB en tests: inyectar los umbrales (constantes exportadas o parámetro) para probar `supera_total` con tamaños pequeños.
- `npx eslint` sobre cada archivo tocado (max-lines; `schema.ts` con techo 3400).
- Mínimo P1: `npm test -w apps/api -- <los archivos de test de arriba>` + `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` + `npm run build -w packages/shared-types`.
- Migración: aplicar el archivo nuevo dos veces contra la BD local (P6); avisar que se tocó la BD.

**security-agent / db-review-agent** (ambos aplican: multer + PII documental + migración)
- multer con `fileFilter`/`limits` y MIME real (regla 17): el filtro real es `detectMime` en el servicio; el motor no confía en el declarado.
- Temporales en disco: borrar siempre (`finally`), nombres generados (no el `originalname`), directorio por petición.
- Lectura de documentos adicionales: valorar si el GET exige `logPiiAccess` (los soportes del cliente pueden contener datos personales); hoy `GET /:id/soportes` es la referencia de criterio.

**frontend-agent**: fuera de esta HU (el formulario del alta y la vista del detalle van en las HUs hermanas del Feature). El contrato de arriba es estable para ellas.

## Decisiones cerradas (David, 2026-10-07)

1. **Alta aparcada (RUNT caído → 202):** los adicionales **se guardan** («no tienen nada que ver con el RUNT»). Diseño en D3-bis.
2. **Techo técnico de 100 archivos:** por encima → **413 con mensaje claro**. Aprobado.
3. **Adicional idéntico a la factura de venta del mismo envío** → descartado «documento repetido». Aprobado.

## Pendiente humano (no bloquea esta HU)

- **Retención de las solicitudes por validar descartadas:** hoy ni la factura ni (con este diseño) los adicionales se borran
  de storage al descartar, y no hay caducidad. Si se quiere una purga por retención (Ley 1581), es un WI aparte que cubra
  factura y adicionales a la vez. No se cuela en esta HU (P9).
