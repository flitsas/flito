# Diseño slim — HU #11966 · El RUNT vuelve a ser compuerta del alta, y el Excel del canal Cliente lee lo persistido

Feature #11912. Canal Cliente de `flito-soat` (no el legado `soat/`). Worktree `flito-11966`, rama
`HU/11966-davidchica-runt-compuerta-excel-cliente`.

**Decisión de producto que gobierna esta ráfaga:** el PO anula **ADR-0009** y la regla de las HU
#11935/#11936 **para solicitudes nuevas**. El RUNT vuelve a ser compuerta del alta. Las #11935/#11936
**no se reescriben** (siguen Resolved) y **las filas ya radicadas bajo esa regla no se tocan ni se
reconsultan**.

Esto **no es un revert de la #11935**: el organismo de tránsito **sigue sin ser compuerta** (AC5), así
que `flito_soat.organismo_codigo` se queda nullable y el `422 organismo_no_catalogado` desaparece de
los DOS endpoints. Por eso hace falta un ADR nuevo y no basta con «volver al ADR-0008». Ver §5.

---

## 1. Estado actual: qué línea codifica «el RUNT no bloquea» y qué se revierte

Ocho archivos nombran ADR-0009. Esto es lo que cada uno afirma hoy y lo que hay que hacer con ello.

### 1.1 `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts` (367 líneas)

| Bloque | Líneas | Qué codifica | Qué se hace |
|---|---|---|---|
| Cabecera | 1–8 | «El ALTA ya no espera a Kyverum… el job fire-and-forget que corre DESPUÉS del COMMIT» | Reescribir: apunta a ADR-0010; el alta espera |
| `DATOS_RUNT_VACIOS` | 63–67 | «Lo que el alta escribe en `vehicles` ANTES de consultar el RUNT» | **Borrar.** El alta ya no escribe la ficha en blanco |
| `extraerDatosCanal` | 90–104 | 10 campos del RUNT | **Ampliar** a 13: `tipoCarroceria`, `pasajerosSentados`, `puertas` |
| `clasificarRespuesta` | 219–250 | Clasifica a `EstadoVerificacionSolicitudSoat` para **persistir**, nunca para abortar | **Reutilizar el cuerpo**, cambiar el destino: mismo árbol de decisión, ahora devuelve un desenlace que la compuerta traduce a HTTP |
| `clasificarCaido` | 211–217 | `caido` sin distinguir «no respondió» de «respondió que no» | **Partir en dos** (AC2 vs AC4). Ver §2.3 |
| `rellenarVehiculoDesdeRunt` | 252–282 | UPDATE de `vehicles` **post-COMMIT** | **Borrar.** La ficha se escribe dentro de la transacción del alta, con `upsertVehiculoRunt` |
| `verificarRuntPostAlta` | 284–354 | El job entero: relee la fila por id, consulta, hace UPDATE del satélite y rellena organismo | **Borrar.** Es lo que hace estructural el «no se reconsultan» del AC6: sin función, no hay reconsulta posible por descuido |
| `programarVerificacionRunt` | 356–367 | `setImmediate` fire-and-forget | **Borrar** |

Se **conservan** intactos: `alias`, `soatVigenteSegunRunt` (112–115), `fechaVencimientoSoatRunt`
(124–138), `fechaValida`, `resolverOrganismoCatalogo` (155–161), `runtNoCuadra` (167–178),
`consultarRuntCrudo` (192–200).

### 1.2 `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` (1141 líneas)

- **Cabecera 43–48** — «El RUNT ya no bloquea el INSERT (ADR-0009): el alta escribe `vehicles` sin
  marca/organismo, `organismo_codigo` NULL y el satélite en `pendiente`, y programa
  `verificarRuntPostAlta`». Reescribir entera contra ADR-0010.
- **`consultarRunt` 320–349** — es LA función que ya traduce cada «no» del RUNT en un error tipado
  (503/422/409). Su docblock dice «SOLO la preconsulta la usa». **La compuerta que pide la HU ya está
  escrita aquí**: lo que se revierte es que el alta vuelva a llamarla. Se renombra a
  `verificarRuntCompuerta` y pasa a ser el único punto por el que los DOS endpoints consultan.
- **`resolverOrganismo` 355–366** — lanza `422 ORGANISMO_NO_CATALOGADO`. **No se restaura como
  compuerta** (AC5, última línea): devuelve `string | null` y no lanza.
- **`preconsulta` 387–426** — hoy exige VIN, exige organismo catalogado y devuelve `organismo.codigo:
  string`. Cambia: VIN opcional, organismo nullable, tres campos nuevos en `vehiculo`.
- **`crearSolicitud` 569–651** — el orden de pasos del docblock (551–567) y el cuerpo. Cambian:
  - **592**: `DATOS_RUNT_VACIOS` → los datos reales del RUNT.
  - **602**: `organismoCodigo: null` → el código cruzado (o `null` si no cruza, que sigue siendo legal).
  - **620**: `verificacionEstado: 'pendiente'` → `'ok'` + `soatVigente: false` (lectura concluyente:
    si estuviera vigente no habría fila) + `verificacionCodigo: organismo_no_catalogado | null`.
  - **650**: `programarVerificacionRunt(soatId)` → **se borra la línea**.
- **`subsanarSolicitud` ~1078–1085** — `tx.update(flitoCompradores).set({ nombreCompleto, … })`. No
  menciona ADR-0009, pero **entra en el alcance**: si la subsanación sigue escribiendo solo
  `nombre_completo`, una fila corregida saldrá en el Excel con el nombre VIEJO (que se lee de
  `nombres`/`apellidos`) mientras la cola muestra el nuevo. Divergencia silenciosa.

### 1.3 `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` (368 líneas)

- **Línea 3** — «Contrato: ADR-0008 §6; el alta ya no espera a Kyverum (ADR-0009)». Reescribir.
- **`vehiculoSchema` 117–120** — `vin` con `.min(5)`: obligatorio. Pasa a opcional.
- **`altaSchema` 164–169** — `nombreCompleto` obligatorio; `correo`/`celular`/`direccion` opcionales
  vía `vacioANull`. Se parte el nombre y se hacen obligatorios los cinco de contacto/ubicación (AC5).
- **`subsanacionSchema` 316–323** — el mismo cambio, por lo dicho arriba.
- **Comentario 154–160** («Marca, línea, modelo… NO están aquí, y esa ausencia es el AC1») — **se
  conserva tal cual**: sigue siendo cierto y ahora con más razón.

### 1.4 `apps/api/src/modules/flito-soat/flito-soat.export.service.ts` (411 líneas)

No implementa ADR-0009; lo cita en **línea 80**: «el canal los escribe desde el RUNT (ADR-0008
§1.6)», que era falso bajo la #11935 (el canal escribía `vehicles` en blanco y el job rellenaba
después) y vuelve a ser cierto con esta HU. La cita se actualiza a ADR-0010.

Lo que sí hay que cambiar es otra cosa: **`const d = datos.get(f.id) ?? SIN_TRAMITE;` (línea 367)**.
Ver §4.

### 1.5 `apps/api/src/db/schema.ts`

- **2605–2612** (`flitoSoat.organismoCodigo`) — «NOT NULL hasta la HU #11935 (ADR-0009)». **Se
  queda nullable.** Solo se actualiza la prosa: ya no es «el canal nace sin organismo» sino «el
  organismo no es compuerta: se escribe si el nombre del RUNT cruza catálogo, y si no cruza la fila
  se crea igual».
- **2735–2757** (las cuatro columnas del satélite) — «Verificación RUNT post-commit (HU #11935,
  ADR-0009)… Default `pendiente` porque el INSERT del alta no espera a Kyverum». **Las columnas se
  quedan** (no se dropean: sostienen las filas de la #11935). Cambia el comentario: desde la #11966 el
  alta nace en `ok` y `pendiente` es un **residuo histórico** de las filas radicadas entre la #11935 y
  esta HU. El CHECK no se toca.

### 1.6 `packages/shared-types/src/flito-estados.ts`

- **514** `RUNT_NO_CUADRA` — «Vive en el satélite, no aborta el alta». **Ahora aborta**: pasa a ser
  también un código HTTP (422).
- **558–569** `ESTADOS_VERIFICACION_SOLICITUD_SOAT` — se queda; se anota que `pendiente` es histórico.

### 1.7 `docs/adr/ADR-0009-flito-soat-runt-no-bloquea-alta.md` (47 líneas)

Toda la sección «Decisión» (puntos 1–6) es lo que se anula. **No se reescribe el cuerpo**: solo la
cabecera de estado. Ver §5.

### 1.8 `docs/diseno-hu-11935-alta-sin-runt-bloqueante.md` (152 líneas)

Documento de diseño de una HU ya entregada. **No se toca.** Se le añade una sola línea al principio:
`> Superseded para solicitudes nuevas por docs/diseno-hu-11966-runt-compuerta-excel-cliente.md
> (ADR-0010). Las filas radicadas bajo este diseño no se reescriben.`

---

## 2. Contrato delta — los tres desenlaces, literales

Entrada de la HU #11967 (frontend). El envelope de error **no cambia de forma**:
`{ error: string, codigo: CodigoErrorSolicitudSoat, ...datos }`, que es lo que
`apps/web/src/lib/soatCliente.ts:117-141` ya valida contra `Object.values(CodigoErrorSolicitudSoat)`.

### 2.1 `POST /api/flito/soat/cliente/preconsulta` (rol `cliente`)

**Request** — `application/json`. `vin` pasa a **opcional** (AC1: «VIN opcional»).

```json
{ "placa": "ABC123", "vin": "9BWZZZ377VT004251", "tipoDocumento": "CC", "numeroDocumento": "1020304050" }
```

**200**:

```json
{
  "vehiculo": {
    "placa": "ABC123",
    "vin": "9BWZZZ377VT004251",
    "marca": "KIA", "linea": "K3 CROSS", "modelo": "2026", "clase": "CAMIONETA",
    "cilindraje": "1591", "tipoServicio": "Particular",
    "carroceria": "WAGON", "pasajerosSentados": "5", "puertas": "5"
  },
  "organismo": { "codigo": "05001", "nombre": "Tránsito de Medellín" },
  "propietario": { "nombreCompleto": "…" }
}
```

Tres cambios de forma, los tres los consume #11967:

1. `vehiculo.vin` es **el VIN del RUNT**, no el eco normalizado de la petición. Es la única fuente
   posible cuando el Cliente no teclea VIN, y es el que se va a persistir (AC1: «el VIN guardado es el
   que trajo el RUNT si el Cliente no tecleó VIN»). `vehiculo.placa` **sigue siendo la normalizada de
   la petición** — el comentario de `preconsulta` (líneas 415–417) explica por qué el eco de la placa
   no se enseña como confirmación, y ese razonamiento sigue en pie.
2. `organismo.codigo` pasa a `string | null` y **el `422 organismo_no_catalogado` desaparece** (AC5:
   «si no cruza, igual se crea»). Si la preconsulta siguiera bloqueando por organismo, el paso 1 del
   wizard negaría un alta que el paso 2 aceptaría.
3. Tres campos nuevos en `vehiculo`: `carroceria`, `pasajerosSentados`, `puertas`.

### 2.2 `POST /api/flito/soat/cliente` (rol `cliente`, `multipart/form-data`)

**Request** — todo campo es texto (multipart). `facturaVenta` = el PDF.

| Campo | Obligatorio | Nota |
|---|---|---|
| `placa` | sí | 4–10 |
| `vin` | **no** | 5–17 si viene. VIN efectivo = el del RUNT |
| `tipoDocumento` | sí | `TIPOS_DOCUMENTO_RUNT` |
| `numeroDocumento` | sí | 4–30 |
| `nombres` | sí **si no es NIT** | ≤200. Prohibido con `NIT` |
| `apellidos` | sí **si no es NIT** | ≤200. Prohibido con `NIT` |
| `razonSocial` | sí **si es NIT** | ≤200. Prohibido con natural |
| `correo` | **sí** | email, ≤150 |
| `celular` | **sí** | ≤30 |
| `direccion` | **sí** | ≤300 |
| `municipio` | **sí** | texto libre ≤100 |
| `departamento` | **sí** | texto libre ≤100 |
| `facturaVenta` | sí | PDF por contenido |

`nombreCompleto` **sale del contrato**: lo deriva el servicio (`razonSocial ?? \`${nombres} ${apellidos}\``,
trim) y sigue alimentando la búsqueda de la cola (`condicionesCola`, `flito-soat.service.ts:404` y
`:419`). Aceptarlo del cliente dejaría dos fuentes de verdad para el mismo nombre.
`natural` = `CC | CE | TI | PAS | PPT | RC | PT`; `juridica` = `NIT`.

**201** `{ "id": "<uuid>", "estado": "pendiente_revision" }` — sin cambios.

### 2.3 Los tres desenlaces, discriminados

Los **dos** endpoints devuelven exactamente lo mismo ante el mismo RUNT. Esa simetría es la
invariante: los dos llaman a `verificarRuntCompuerta()`, una sola función.

| # | Desenlace | HTTP | `codigo` | Extras | Qué hace #11967 |
|---|---|---|---|---|---|
| 1 | Los datos no cuadran con los propietarios activos | **422** | `runt_no_cuadra` | — | «Revise los datos» |
| 1 | El VIN tecleado ≠ el del RUNT | **422** | `runt_no_cuadra` | `campo: "vin"` | «Revise los datos», foco en VIN |
| 1 | El RUNT respondió pero no hay vehículo | **422** | `runt_sin_registro` | — | «Revise los datos» |
| 1 | El RUNT trajo vehículo **sin VIN** | **422** | `runt_sin_vin` | — | «El RUNT no publica el VIN…» |
| 2 | SOAT vigente | **409** | `soat_vigente` | `fechaVencimiento?: "yyyy-mm-dd"` | Modal «ya tiene SOAT vigente» |
| 3 | RUNT no disponible (timeout, red, circuito, no-200) | **503** | `runt_no_disponible` | — | «El RUNT no está disponible, vuelva a consultar» |

Preexistentes, sin cambio: `403 sin_compania` · `403 canal_desactivado` · `400 archivo_no_pdf` ·
`400 Datos inválidos` (Zod) · `409 vin_ya_tiene_soat` (RN-01, con `propia`/`id`/`estado` o recortado).

**Cómo #11967 distingue sin adivinar por el texto.** Por `codigo`, nunca por `mensaje` — el mecanismo
ya existe. Para que la pantalla no tenga que re-listar la familia «revise los datos», se exporta desde
shared-types:

```ts
export const CODIGOS_REVISE_LOS_DATOS = [
  CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO,
  CodigoErrorSolicitudSoat.RUNT_NO_CUADRA,
  CodigoErrorSolicitudSoat.RUNT_SIN_VIN,
] as const;
```

Y se añade un código nuevo, `RUNT_SIN_VIN: 'runt_sin_vin'`. No es un lujo: «revise los datos» le dice
al usuario que corrija algo suyo, y aquí no hay nada que corregir — el registro no publica el VIN. Es
la única forma de que la pantalla no mienta.

**El 422 NUNCA devuelve el VIN del RUNT.** Un Cliente puede sondear placas ajenas; si el desenlace
«tu VIN no cuadra» respondiera con el bueno, el endpoint sería un lector de VIN por placa. Mismo
criterio que el 409 recortado de RN-01 (`MENSAJE_VEHICULO_AJENO`).

### 2.4 El discriminante AC2 vs AC4 — la decisión cara de esta HU

`consultarVehiculoRunt` (`runt/runt.service.ts:98-115`) devuelve `{ ok:false, message }` **en los dos
casos**: cuando la pasarela contesta HTTP 200 con un rechazo de negocio y cuando hay timeout, red,
no-200 o circuito abierto. Hoy, en el canal, todo `!ok` cae en `clasificarCaido()`
(`flito-soat-cliente-runt.ts:223`) → sería un `503` para un «no» de negocio, que es **exactamente lo
que el AC4 prohíbe** («ese desenlace NO se usa cuando el RUNT sí respondió que los datos no
coinciden»).

Dos formas de partirlo, y aquí sí hay tradeoff:

| | A — predicado sobre el mensaje | B — señal de transporte |
|---|---|---|
| Qué | `/propietari/i.test(message)` → negocio | `runt.service.ts` anota `httpStatus` en el `ok:false` de la vía 200 |
| Precedente | **Ya existe dos veces**: `esTraspasoEnSincronizacion` (`certificacion-runt.ts:181`) y `refresh.service.ts:76,81` | Ninguno |
| Blast radius | Cero: solo el canal | `runt.service.ts` (lo comparten impuestos, trámites, SOAT legacy) — aditivo |
| Falla si… | Kyverum cambia la redacción → un «no» de negocio sale como 503 → **viola AC4 en silencio** | Nunca: un 200 es, por construcción, «el RUNT respondió» |
| Esfuerzo | S | S (2 líneas) |

**Recomendación: las dos, en este orden.** Es negocio si `httpStatus === 200` **o** si el mensaje casa
`/propietari/i`; es caído en cualquier otro caso (incluido el `throw`). El defecto —503, no se crea
nada— es el seguro: nunca produce un alta falsa. La lógica vive en UNA función de
`flito-soat-cliente-runt.ts` y `runt.service.ts` solo gana un campo opcional que nadie más lee.

```ts
// flito-soat-cliente-runt.ts
export type DesenlaceRunt =
  | { clase: 'ok'; datos: DatosRuntCanal; vinEfectivo: string; organismoCodigo: string | null }
  | { clase: 'vigente'; fechaVencimiento: string | null }
  | { clase: 'revise'; codigo: 'runt_no_cuadra' | 'runt_sin_registro' | 'runt_sin_vin'; campo?: 'vin' }
  | { clase: 'caido' };
```

`verificarRuntCompuerta()` la traduce a `SolicitudSoatError`; la preconsulta y el alta la comparten.

### 2.5 Orden de pasos de `crearSolicitud`

```
1. canalDeLaCompania                       # 403 flag / sin compañía        (sin cambio)
2. verificarPdfReal                        # 400, antes de gastar nada      (sin cambio)
3. si vino VIN: verificarRn01 + verificarTenenciaVehiculo   # 409 barato, antes del RUNT
4. verificarRuntCompuerta(placa, vin?, doc, tipo)           # 503 | 422 | 409-vigente
5. vinEfectivo = normalizarId(datos.vin)   # AC1: el del RUNT manda
6. verificarRn01(vinEfectivo) + verificarTenenciaVehiculo(vinEfectivo)   # 409 AUTORITATIVO
7. randomUUID + upload S3                  # fuera de la tx (CA-11)
8. TRANSACTION:
     upsertVehiculoRunt(…, datos RUNT completos)   # marca, línea, año, clase, cilindraje,
                                                   # servicio, carrocería, pasajeros, puertas
     INSERT flito_soat  (origen=cliente, pendiente_revision, organismoCodigo = cruce | null)
     INSERT flito_compradores (nombres|razonSocial, municipio, departamento, contacto)
     INSERT flito_soat_solicitud (verificacion_estado='ok', soat_vigente=false,
                                  verificacion_codigo = organismo_no_catalogado | null)
     INSERT flito_soportes (factura_venta)
     registrarCambio → pendiente_revision
9. COMMIT → 201.  NO hay setImmediate.
```

El paso 3 **duplica** el 6 a propósito, y es el mismo patrón que ya usa la tenencia (previa + dentro
de la tx): evita gastar una consulta a Kyverum por un alta que ya se sabe que no entra. Cuando no hay
VIN tecleado el paso 3 no puede correr y se paga la consulta; es el coste de que el VIN sea opcional.

**PII (Ley 1581 art. 17):** el alta pasa a consultar el RUNT dentro de la petición y a recibir datos
del vehículo y, a veces, el nombre del propietario. La ruta `POST /cliente` tiene que llamar a
`registrarAccesoRuntCliente(req, { conPropietario })` igual que hace la preconsulta
(`flito-soat-cliente.routes.ts:147`), con el motivo adaptado. Bajo la #11935 no hacía falta porque la
consulta ocurría fuera de la petición.

---

## 3. Modelo Drizzle + migración

**Migración: `0172_flito_soat_canal_datos_persistidos.sql`** (última en disco: `0171_`). SQL plano a
mano, sin `BEGIN/COMMIT` propio (ADR-DB-001), sin `drizzle-kit`.

### 3.1 `vehicles` — dos columnas

| Columna | Tipo | Nulos | Por qué |
|---|---|---|---|
| `pasajeros_sentados` | `varchar(10)` | NULL | `CapacidadCargaOPasajeros` de la fila Cliente (AC6) |
| `puertas` | `varchar(5)` | NULL | `Puertas` de la fila Cliente (AC6) |

**TEXTO y no `integer`**, por la misma razón escrita en la 0166 para `cilindraje`/`carroceria`/
`tipo_servicio`: el origen es texto de un tercero y `"0"`, `"05"` y `""` son valores distinguibles que
un `integer` colapsa o rechaza con un 22P02 a mitad de un alta.

**Por qué NO son NOT NULL:** `vehicles` es la tabla compartida del pipeline entero (`upsertVehiculo()`
del sync corre para todos los trámites). Un NOT NULL exigiría un DEFAULT para las filas existentes, y
el único candidato sería `'4'` para `puertas` — es decir, escribir en la base la constante de la
plantilla como si fuera un dato medido, que es justo la mentira que el AC6 viene a quitar del archivo.
`carroceria` (0166) sienta el precedente: nullable.

**`puertas` la escribe SOLO el canal Cliente.** Es una regla de servicio, no de esquema: no hay CHECK
que la ate a `origen`, porque `vehicles` no conoce el origen del SOAT. Lo que la hace cierta es el
export, que solo la lee para filas `origen='cliente'` (§4).

### 3.2 `flito_compradores` — cinco columnas

| Columna | Tipo | Nulos |
|---|---|---|
| `nombres` | `varchar(200)` | NULL |
| `apellidos` | `varchar(200)` | NULL |
| `razon_social` | `varchar(200)` | NULL |
| `municipio` | `varchar(100)` | NULL |
| `departamento` | `varchar(100)` | NULL |

**Por qué NO son NOT NULL:** las ~7 052 filas que ya existen las escribió el sync de trámites con
`nombre_completo` fundido en una sola cadena (`flit-http.adapter.ts:74`). Un NOT NULL obligaría a un
backfill que partiera el nombre por el espacio — la heurística que `COLUMNAS_COMPRADOR`
(`flito-soat.export.service.ts:92-99`) rechaza por escrito porque falla en cada nombre compuesto y en
cada razón social. Las filas de trámite **siguen leyendo `flit_raw`** y no necesitan estas columnas
jamás.

**Un CHECK, y solo uno:**

```sql
ALTER TABLE flito_compradores
  ADD CONSTRAINT flito_compradores_titular_chk
  CHECK (razon_social IS NULL OR (nombres IS NULL AND apellidos IS NULL));
```

«Nunca las dos cosas a la vez». Las filas legacy lo cumplen (los tres campos NULL). **No** se añade el
recíproco (`tipo_documento='NIT' ⇒ razon_social IS NOT NULL`): bloquearía a un futuro escritor del
sync que rellene `tipo_documento` sin razón social, y la mitad positiva ya la exige Zod en la única
ruta que escribe estas columnas. El CHECK se declara **también en `schema.ts`**, por la lección que
dejó escrita la 0157: un CHECK que solo vive en la base convence a quien lee `schema.ts` de que no
hace falta migración, y el primer INSERT nuevo muere con 23514.

**`correo`, `celular` y `direccion` siguen nullable en la tabla** y obligatorios en la app para este
canal (AC5): la nulabilidad la necesitan las filas de trámite, que llegan sin contacto.

### 3.3 Idempotencia (P6 — la migración se corre dos veces)

- Las siete columnas: `ADD COLUMN IF NOT EXISTS`.
- El CHECK: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, el mismo patrón de la 0167 y la 0171
  (PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS`).
- `COMMENT ON COLUMN` es idempotente por definición.
- **Sin backfill.** No hay nada que rellenar: las filas de trámite no usan estas columnas y las del
  canal radicadas antes de esta HU **no se reescriben** (AC6). La segunda pasada no cambia ni una fila.

---

## 4. Fallback del export — el punto exacto de la bifurcación

**Punto exacto:** `apps/api/src/modules/flito-soat/flito-soat.export.service.ts`, dentro de
`construirFilasExportSoat`, **línea 367**:

```ts
const d = datos.get(f.id) ?? SIN_TRAMITE;
```

Ese `?? SIN_TRAMITE` (la constante de las líneas 272–276) es lo que hoy deja nueve celdas vacías en
cada fila del canal. La bifurcación va ahí y **se decide por `origen`, no por ausencia**:

```ts
const d = f.origen === ORIGEN_CLIENTE
  ? datosDeCanal(f, propietarios.get(f.id))     // nuevo
  : (datos.get(f.id) ?? SIN_TRAMITE);           // trámite: EXACTAMENTE como hoy
```

**Por `origen` y no por `datos.get(f.id) === undefined`**, que es la variante tentadora y rompe el
AC6: un SOAT `origen='tramite'` cuyo trámite ya no está (borrado, o `soat_id` nulo) también cae en
`undefined`, y con la variante perezosa cambiaría de fuente sin que nadie lo pidiera. `ORIGEN_CLIENTE`
ya está importado en el archivo (línea 46) y ya se usa en `propietariosDe` (línea 172).

Puertas, que no vive en `DatosDeTramite`, se bifurca en su propia celda (línea 382):

```ts
puertas: f.origen === ORIGEN_CLIENTE ? celdaTexto(f.puertas) : CONSTANTES_COLA_EXPORT.puertas,
```

Si el RUNT no trajo puertas para una fila Cliente, la celda va **vacía**, nunca `'4'`.

### 4.1 De dónde sale cada columna en una fila `origen='cliente'`

| Columna del archivo | Trámite (hoy, intacto) | Cliente (nuevo) |
|---|---|---|
| `Vin` | `flito_soat.vin` | igual |
| `Placa` | `vehicles.plate` | igual |
| `Modelo` (año) | `flit_raw->>'modeloAno'` | `vehicles.year` → `String(year)` |
| `Servicio` | `vehicles.tipo_servicio` | igual |
| `Marca` | `flit_raw->>'marca'` | `vehicles.brand` |
| `Linea` | `flit_raw->>'modelo'` | `vehicles.model` |
| `Clase` | `flit_raw->>'clase'` | `vehicles.vehicle_class` |
| `Carroceria` | `vehicles.carroceria` | igual |
| `Cilindraje` | `vehicles.cilindraje` | igual |
| `CapacidadCargaOPasajeros` | `flit_raw->>'capacidad'` | **`vehicles.pasajeros_sentados`** |
| `Puertas` | `'4'` constante | **`vehicles.puertas`** (vacío si no vino) |
| `OrganismoDetto` | `flito_tramites.transito_nombre_flit` | `organismoParaExport(oc.alias, fs.organismo_codigo)` |
| `N_I` | `'IMPORTADO'` | igual |
| `ClaseDeInterlocutor` … `ClaseId` | `bloqueTitular(flit_raw)` | **`bloqueTitularDesdeComprador(...)`** |
| `NumeroId` | `flito_compradores.numero_documento` | igual |
| `Direccion` | `flito_compradores.direccion` | igual |
| `Municipio` | `flito_tramites.ciudad` | **`flito_compradores.municipio`** |
| `Departamento` | `flit_raw->>'departamentoTransito'` | **`flito_compradores.departamento`** |
| `Celular` / `Correo` | `flito_compradores.*` | igual |
| `OrganismoDettoCiudad` | `ciudadDeOrganismo(fs.organismo_codigo)` | igual |

Ojo con el cruce de nombres, que ya tiene su párrafo en `CLAVES_FLIT_RAW`: **`vehicles.model` es la
LÍNEA** y `vehicles.year` es el año. El mapeo obvio (`Modelo ← vehicles.model`) mete líneas
comerciales en una columna de años y pasa cualquier aserto de cabeceras.

`OrganismoDetto` del canal usa el **alias del catálogo**, no el nombre crudo de FLIT, porque una fila
del canal no tiene FLIT. `conJoinsCola` ya hace `leftJoin` a `organismos_transito_config`
(`flito-soat.service.ts:469`), así que basta añadir `organismosTransitoConfig.alias` a
`COLUMNAS_CONSULTA` — cero consultas nuevas. `organismoParaExport` (alias, o el código si no hay
alias) ya existe y es el helper correcto.

### 4.2 El bloque del titular del canal — helper PURO en `cola-flito-derivados.ts`

```ts
export function bloqueTitularDesdeComprador(c: {
  tipoDocumento: string | null; nombres: string | null;
  apellidos: string | null; razonSocial: string | null;
}): BloqueTitular
```

Reutiliza `CLASE_INTERLOCUTOR` y `CLASE_ID` **sin ampliar el vocabulario** (`PP`, no `PAS`: son dos
catálogos distintos y el AC8 de la #11947 lo deja escrito):

| `tipo_documento` | `ClaseDeInterlocutor` | `NombrePila` | `Apellidos` | `RazonSocial` | `ClaseId` |
|---|---|---|---|---|---|
| `NIT` | `PJUR` | vacío | vacío | `razon_social` | `NIT` |
| `CC` | `PNAT` | `nombres` | `apellidos` | vacío | `CC` |
| `CE` | `PNAT` | `nombres` | `apellidos` | vacío | `CE` |
| `PAS` | `PNAT` | `nombres` | `apellidos` | vacío | `PP` |
| `TI` · `PPT` · `RC` · `PT` | `PNAT` | `nombres` | `apellidos` | vacío | **vacío** |
| ausente / desconocido | vacío | vacío | vacío | vacío | vacío |

La fila `TI·PPT·RC·PT` es la misma decisión que ya toma `otro` en `TABLA_TIPO_FLIT`: persona natural
declarada, documento sin equivalente en la plantilla del cliente → `ClaseId` vacío, nunca `CC` por
defecto. La última fila coincide con `TITULAR_VACIO` y llega por la rama por defecto, sin un `if`
propio.

**Vive en `cola-flito-derivados.ts` y es puro** por el motivo que ese archivo declara en su cabecera:
el mock de BD de las suites de export devuelve lo que el escenario registró y no evalúa la
proyección, así que una regla escrita dentro del `filas.map(...)` solo se puede probar a través de un
`.xlsx`. Aquí se prueba llamándola, con `" "` y con la clave ausente.

### 4.3 Proyecciones que crecen

`COLUMNAS_CONSULTA` (líneas 71–88): `+ brand, model, year, vehicleClass, pasajerosSentados, puertas`
(de `vehicles`) `+ organismoAlias` (de `organismosTransitoConfig`). Sigue siendo lista blanca escrita
campo a campo (RN-E1): no aparece ni `valor_pagado` ni `extraccion`.

`COLUMNAS_COMPRADOR` (líneas 101–110): `+ tipoDocumento, nombres, apellidos, razonSocial, municipio,
departamento`. Su comentario actual explica por qué `nombre_completo` NO está; ese párrafo se
**conserva y se amplía**: sigue sin leerse la cadena fundida, y ahora se leen los campos desagregados
que el canal sí guarda por separado. El tipo `Comprador` (118–127) se escribe a mano con la
nulabilidad correcta, como el resto.

### 4.4 PII del export

`CAMPOS_PII_COLA_EXPORT` (`cola-flito-excel.ts:177-180`) tiene que ganar `municipio` y `departamento`
—y conviene que gane `nombres`, `apellidos`, `razon_social`— **en la misma edición**, que es la regla
que ese archivo se aplica a sí mismo. Y hay que corregir el párrafo de arriba: hoy dice que
`Departamento` no es PII porque es la jurisdicción del organismo (`flit_raw->>'departamentoTransito'`).
**Para una fila del canal es el domicilio del titular**, que es exactamente el supuesto que ese mismo
párrafo señala como disparador («si algún día se cambiara por un departamento de la dirección, tendría
que entrar aquí en la misma edición»). Ese día es hoy, para la mitad Cliente del archivo.

---

## 5. ADR — sí hace falta un ADR-0010

**Recomendación: crear `docs/adr/ADR-0010-flito-soat-runt-compuerta-alta.md` en estado `Propuesto`, y
tocar de ADR-0009 solo la cabecera.**

Por qué no basta con marcar ADR-0009 «Rechazado» y volver al ADR-0008:

1. **ADR-0009 rigió código entregado.** Hay filas en DEV/QA con `verificacion_estado` y con
   `organismo_codigo` NULL creadas bajo esa regla, y esas cuatro columnas se quedan en el esquema.
   Borrar o reescribir el 0009 dejaría el modelo sin explicación de por qué existen.
2. **Esto no es un revert.** ADR-0010 restaura la compuerta sobre el RUNT (coincidencia, existencia,
   VIN, vigencia) pero **no** la compuerta sobre el organismo, que ADR-0008 §1.6 sí exigía. Si el
   repo dijera «vuelve a regir el 0008», el siguiente que lo lea reintroducirá el
   `422 organismo_no_catalogado` que el AC5 prohíbe.
3. El repo no puede quedar contradiciendo al Feature: ocho archivos citan ADR-0009 por nombre.

### 5.1 Cabecera a añadir en ADR-0009 (lo único que se toca de ese archivo)

```markdown
## Estado

**Propuesto — SUPERSEDED por [ADR-0010](./ADR-0010-flito-soat-runt-compuerta-alta.md)** (HU #11966).
Nunca fue aprobado por el Líder Técnico. Su decisión rigió el código entregado en DEV/QA entre la
HU #11935 y la #11966: las solicitudes radicadas en ese intervalo se crearon bajo esta regla y **no
se reescriben ni se reconsultan** (AC6 de la #11966). El cuerpo de este ADR se conserva sin cambios
porque es la única explicación de por qué existen las cuatro columnas de verificación del satélite.
```

### 5.2 Qué dice ADR-0010 (`Propuesto`)

- **Supersedes:** ADR-0009 **completo**, para solicitudes nuevas.
- **Restaura parcialmente** ADR-0008 §6 (preconsulta como paso bloqueante, 409-vigente y 503 que
  abortan el alta) y §1.6 en la parte de resolver los datos del RUNT antes del INSERT.
- **NO restaura** de ADR-0008: el organismo como compuerta. `organismo_codigo` **sigue nullable**, el
  `422 organismo_no_catalogado` **desaparece de los dos endpoints**, y el `leftJoin` de
  `conJoinsCola`/`detalle`/export se queda.
- **Conserva** de ADR-0008: no persistir el payload crudo (§1.6, esa frase), la tabla satélite (§1.2),
  el propietario en `flito_compradores` (§1.3), RN-01, el 404-no-403 del aislamiento (§5).
- **Decisiones propias que sientan precedente:**
  1. Un `ok:false` de Kyverum se clasifica por **transporte primero** (HTTP 200 = respondió) y por
     mensaje después; el defecto es «caído», que no crea nada.
  2. VIN opcional en la entrada; **VIN efectivo = el del RUNT**; sin VIN del RUNT no se crea (RN-01).
  3. El propietario se guarda **partido** (`nombres`/`apellidos` XOR `razon_social`) y
     `nombre_completo` pasa a ser un derivado para la búsqueda, no la fuente.
  4. El Excel del canal lee **columnas persistidas**; el del trámite sigue leyendo `flit_raw`. Un
     archivo, dos fuentes, y la bifurcación es por `origen`.
- **Consecuencias:** `verificacion_estado='pendiente'` queda como residuo histórico; las filas de la
  #11935 con `organismo_codigo` NULL siguen ahí y Operaciones las trabaja a mano; los CF-07/10 del
  Feature #11912 vuelven a estar alineados sin reescribir el Feature.
- **Estado: `Propuesto`.** Lo aprueba el Líder Técnico humano, no este agente ni el backend-agent.

---

## 6. Archivos a crear/modificar

### Crear

| Archivo | Qué |
|---|---|
| `docs/adr/ADR-0010-flito-soat-runt-compuerta-alta.md` | El ADR de §5.2, en `Propuesto` |
| `apps/api/src/db/migrations/0172_flito_soat_canal_datos_persistidos.sql` | Las 7 columnas + el CHECK + comentarios. Sin backfill |
| `apps/api/__tests__/services/flito-soat.cliente-alta-runt-compuerta.test.ts` | AC1–AC5: los tres desenlaces del alta y de la preconsulta, VIN opcional, VIN efectivo, partición del propietario, organismo que no cruza |
| `apps/api/__tests__/services/flito-soat-migracion-0172-datos-canal.test.ts` | P6: el archivo dos veces sobre la BD local; columnas, tipos, nulabilidad y CHECK |

### Modificar

| Archivo | Qué cambia |
|---|---|
| `apps/api/src/db/schema.ts` | `vehicles`: `pasajerosSentados`, `puertas`. `flitoCompradores`: 5 columnas + `flito_compradores_titular_chk`. Prosa de `organismoCodigo` (2605–2612) y del satélite (2735–2757) |
| `packages/shared-types/src/flito-estados.ts` | `RUNT_SIN_VIN`; `CODIGOS_REVISE_LOS_DATOS`; comentario de `RUNT_NO_CUADRA` (514) — ahora también HTTP; nota de `pendiente` como residuo (558–569) |
| `apps/api/src/modules/flito-soat/flito-soat-cliente-runt.ts` | Cabecera → ADR-0010. `extraerDatosCanal` +3 campos. `DesenlaceRunt` + clasificador que parte negocio/caído. **Borrar** `DATOS_RUNT_VACIOS`, `rellenarVehiculoDesdeRunt`, `verificarRuntPostAlta`, `programarVerificacionRunt` |
| `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` | Cabecera (43–48). `consultarRunt` → `verificarRuntCompuerta`, compartida por los dos endpoints. `resolverOrganismo` deja de lanzar. `preconsulta` (VIN opcional, organismo nullable, 3 campos). `crearSolicitud` con el orden de §2.5. `upsertVehiculoRunt` escribe carrocería/pasajeros/puertas y deriva `nombreCompleto`. `subsanarSolicitud` escribe las 5 columnas nuevas |
| `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` | Cabecera (línea 3). `vehiculoSchema`: `vin` opcional. `altaSchema` y `subsanacionSchema`: partición NIT/natural con `superRefine`, contacto y municipio/departamento obligatorios, sin `nombreCompleto`. `registrarAccesoRuntCliente` también en `POST /cliente` |
| `apps/api/src/modules/flito-soat/flito-soat.export.service.ts` | `COLUMNAS_CONSULTA` +7, `COLUMNAS_COMPRADOR` +6, `Comprador` +6, `datosDeCanal()`, bifurcación por `origen` en la línea 367 y en `puertas` (382). Cita de la línea 80 → ADR-0010 |
| `apps/api/src/shared/export/cola-flito-derivados.ts` | `bloqueTitularDesdeComprador` (puro) |
| `apps/api/src/shared/export/cola-flito-excel.ts` | `CAMPOS_PII_COLA_EXPORT` + `municipio`, `departamento`, `nombres`, `apellidos`, `razon_social`, y el párrafo de `Departamento` corregido |
| `apps/api/src/modules/runt/runt.service.ts` | **2 líneas, aditivas**: `httpStatus` en el `ok:false` de la vía 200 (opción B de §2.4) |
| `docs/adr/ADR-0009-flito-soat-runt-no-bloquea-alta.md` | **Solo la cabecera de Estado** (§5.1) |
| `docs/diseno-hu-11935-alta-sin-runt-bloqueante.md` | Una línea de superseded al principio |

### Tests a extender / borrar

| Archivo | Qué |
|---|---|
| `apps/api/__tests__/services/flito-soat.cliente-alta.test.ts` | AC2/AC3/AC4 del **create** vuelven a esperar 422/409/503; el INSERT nace con organismo cruzado y `verificacion_estado='ok'`; el 201 ya no dispara `setImmediate`. RN-01 intacta |
| `apps/api/__tests__/services/flito-soat.cliente-verificacion-runt.test.ts` | **Borrar.** Prueba un job que deja de existir. Su cobertura útil (clasificación de la respuesta) se muda al test nuevo de la compuerta |
| `apps/api/__tests__/services/flito-soat-export.test.ts` | Fila `origen='cliente'` con las 25 columnas llenas; fila de trámite **sin cambiar de fuente** (mismo `.xlsx` que hoy, byte a byte en las 25 celdas); `Puertas='4'` en trámite y valor del RUNT en Cliente; `CapacidadCargaOPasajeros` vacío cuando no vinieron pasajeros |
| `apps/api/__tests__/cola-flito-derivados.test.ts` | `bloqueTitularDesdeComprador`: las seis filas de la tabla de §4.2, más `" "` y campo ausente |
| `apps/api/__tests__/services/flito-soat.revision-rechazo-subsanacion.test.ts` | La subsanación escribe las 5 columnas nuevas y `nombre_completo` derivado |
| `apps/api/__tests__/services/flito-soat-migracion-0171-organismo-nullable.test.ts` | **No se toca.** La 0171 sigue aplicada y su sha registrado |

**Mutación exigida por gate (no vale el verde a secas).** Tres mutantes nombrados: (a) cambiar el
`503` del RUNT caído por `422` → tiene que caer el test del AC4; (b) sustituir
`f.origen === ORIGEN_CLIENTE` por `datos.get(f.id) === undefined` en el export → tiene que caer el
test de «la fila de trámite no cambia de fuente»; (c) devolver el VIN del RUNT dentro del cuerpo del
422 → tiene que caer un aserto de no-fuga.

### No tocar (declarado)

- `apps/web/**`. El wizard actual seguirá mandando `nombreCompleto` y dejará de validar: **es la HU
  #11967**, y el riesgo de secuencia está en §7. `apps/web/src/lib/soatCliente.ts` documenta
  `PreconsultaRunt.organismo.codigo: string`, que pasa a `string | null`: lo corrige la #11967.
- `flito-sync.service.ts`, `resolverSoat()`, `POST /enviar`, el ciclo del SOAT de trámite.
- `flito-impuestos.export.service.ts` — la otra mitad del mismo `.xlsx` no tiene canal Cliente y no
  se bifurca. `CONSTANTES_COLA_EXPORT.puertas` sigue siendo su valor para todas sus filas.
- Feature #11912 en ADO; ADR-0008; el cuerpo de ADR-0009; las HU #11935/#11936.
- Redis, colas, crons, tablas nuevas.

---

## 7. Riesgos abiertos

1. **Si el fallback del export se aplicara también a filas de trámite** (bifurcando por
   `datos.get(f.id) === undefined` en vez de por `origen`): un SOAT de trámite cuyo trámite se borró o
   quedó con `soat_id` nulo pasaría a leer `vehicles` + `flito_compradores`. Nueve columnas cambiarían
   de fuente **en verde**: `Marca` y `Linea` saldrían de `vehicles` (que el sync escribe, pero con
   otra normalización), `Municipio` pasaría de la ciudad del trámite al domicilio del titular —dos
   datos distintos bajo la misma cabecera— y `Puertas` dejaría de ser `'4'`. Nadie lo vería hasta que
   un cliente comparase dos descargas. Mitigación: bifurcar por `origen` y el mutante (b) de §6.
2. **Solicitudes ya radicadas sin VIN del RUNT.** No existen: `flito_soat.vin` es `NOT NULL UNIQUE` y
   siempre se guardó el VIN **tecleado**. Lo que sí existe son filas de la #11935 cuyo VIN tecleado
   nunca se contrastó contra el RUNT (el job pudo no correr, o marcó `no_cuadra` sin bloquear). Esas
   filas **no se reconsultan** (AC6) y pueden tener un VIN que el registro no confirma. Consecuencia
   concreta: su `Vin` en el Excel es el que tecleó el Cliente. No es alcance de esta HU; es una
   decisión de producto ya tomada. Lo que sí hay que evitar es «arreglarlas de paso» — por eso el job
   se borra en vez de dejarse dormido.
3. **Secuencia backend → frontend.** Al mergear esta HU sin la #11967, el wizard manda
   `nombreCompleto` y no manda `nombres`/`municipio`/`departamento`: el alta responde
   `400 Datos inválidos` en DEV hasta que entre la #11967. El merge **es** el deploy en DEV. O van
   juntas, o se avisa al QA lead antes de mergear la primera.
4. **El discriminante `/propietari/i` es texto de un tercero.** Con la señal de transporte de §2.4 el
   riesgo baja a un caso (Kyverum señala el rechazo de propietario con un no-200 **y** cambia la
   redacción), y su desenlace es un 503 en vez de un 422: no crea filas falsas, pero le dice al
   usuario que el RUNT está caído cuando no lo está. Vale la pena una alerta de log —`{ soatId: null,
   desenlace: 'caido', httpStatus }`, sin placa ni documento— para poder medirlo en DEV.
5. **`municipio`/`departamento` como texto libre.** El AC solo pide que sean obligatorios. Sin
   catálogo DIVIPOLA, dos altas de la misma ciudad pueden escribir «Bogotá» y «BOGOTA D.C.» y el
   Excel las enseñará distintas. Es lo mismo que ya pasa con `flito_tramites.ciudad`, así que no
   empeora nada; si el PO quiere catálogo, es otra HU.
6. **`puertas` en `vehicles` sin dueño declarado en el esquema.** Nada impide que mañana el sync la
   escriba para una fila de trámite; el export no la leería (bifurca por `origen`), así que quedaría
   un dato guardado que nadie publica. Es aceptable y está escrito; la alternativa —una columna en el
   satélite del canal— separaría los datos técnicos del vehículo en dos tablas según de dónde vino el
   SOAT, que es justo el error que el ADR-0008 §1.3 evitó con `flito_compradores`.

---

## Notas operativas por agente

**backend-agent** — Orden sugerido: (1) `0172` + `schema.ts`; (2) shared-types; (3)
`flito-soat-cliente-runt.ts` (borrar el job, ampliar el extractor, `DesenlaceRunt`); (4)
`flito-soat-cliente.service.ts` + `.routes.ts`; (5) export + `cola-flito-derivados.ts`; (6) ADR-0010 y
la cabecera del 0009. La compuerta tiene que ser **una sola función** llamada por la preconsulta y por
el alta: dos copias divergen y el wizard acaba bloqueando lo que la API acepta. P6: aplicar **solo** la
`0172` dos veces sobre la BD local (puerto 5434) y avisar de que se tocó la base del usuario. `build:api`
necesita `NODE_OPTIONS=--max-old-space-size=8192`.

**frontend-agent** — No en esta HU. La #11967 consume §2: `CODIGOS_REVISE_LOS_DATOS`,
`runt_sin_vin`, `organismo.codigo` nullable, `vin` opcional en el formulario, el propietario partido y
los campos `municipio`/`departamento`. Y quita el `disabled={!runtListo}` que ya no describe la regla.

**db-review-agent** — Dispara: `schema.ts` + `migrations/0172`. Mirar: nulabilidad de las siete
columnas, el CHECK declarado en los dos sitios, la ausencia de backfill (es deliberada) y que la
0171 no se reescriba.

**security-agent** — Dispara: el alta vuelve a consultar el RUNT dentro de la petición y el Excel
gana cinco campos personales del titular. Comprobar: cero payload crudo persistido, el 422 sin el VIN
del RUNT, `registrarAccesoRuntCliente` en `POST /cliente`, `CAMPOS_PII_COLA_EXPORT` ampliado y el
párrafo de `Departamento` corregido, PII fuera de la URL (los dos endpoints siguen siendo `POST` con
cuerpo).

**qa-agent** — Los tres desenlaces se prueban por `codigo` y por HTTP, nunca por el texto del mensaje.
El caso que más fácil se cuela: RUNT caído presentado como «revise los datos» y viceversa (AC4).
