# Diseño slim — HU #12092 · FLITO OCR lee el COMPRADOR de la factura de venta (natural o jurídica)

Feature #12073. Backend. Worktree `flito-hu12092`, rama `HU/12092-davidchica-ocr-comprador-factura`.

Extiende dos módulos que ya existen (`flito-ocr` y el canal Cliente de `flito-soat`). **No hay tabla
nueva, ni columna, ni migración**: este endpoint LEE y devuelve; la persistencia de la procedencia es
la HU #12093. **ADR: no aplica** — no se contradice el ADR-0008 ni el ADR-0010; se añade una ruta al
canal que aquellos describen, con su entrada en la allowlist y su `porque`.

---

## Patrón reutilizado

| Qué | De dónde se calca | Path |
|---|---|---|
| Extractor OCR (doble pasada Haiku→Sonnet, umbral, normalizadores) | `extraerDerechoTramite` | `apps/api/src/modules/flito-ocr/flito-ocr.service.ts` |
| Ruta multipart del canal, en ese orden exacto | `POST /cliente` (línea 277) y `PATCH /:id/solicitud` (línea 473) | `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` |
| Verificación del PDF por bytes | `verificarPdfReal` (línea 350, **privada**) | `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` |
| 503 del OCR sin convertirlo en 500 | `handleError` de derechos (línea 54) y `flito-soat.routes.ts:80` | `apps/api/src/modules/flito-derechos/flito-derechos.routes.ts` |
| Rastro de PII de una lectura del canal | `registrarAccesoRuntCliente` | `apps/api/src/modules/flito-soat/flito-soat.pii.ts` |
| Excluyencia natural/jurídica | `refinarTitular` + CHECK `flito_compradores_titular_chk` | `flito-soat-cliente.routes.ts:238` |

---

## Las 6 decisiones

### 1. La extracción se amplía DENTRO de `PROMPT_FACTURA_VENTA` (no hay plantilla aparte)

Lo ordena el AC1 y además es gratis: **`PROMPT_FACTURA_VENTA` no tiene hoy ningún consumidor vivo**.
El extractor que lo usaba (`extraerFacturaVenta`) se retiró con la integración FLIT —lo dice el
comentario final de `flito-ocr.service.ts`— y la constante quedó como **import muerto** en la línea
20 de ese archivo. Ampliarla no cambia el contrato de nadie.

Una plantilla aparte del comprador costaría **dos llamadas al modelo por PDF** (doble coste, doble
latencia) y abriría la puerta a que las dos lecturas del MISMO documento se contradigan. Se descarta.

Quien la consume vuelve a ser un `extraerFacturaVenta(doc)` reinstaurado en `flito-ocr.service.ts`,
con **un solo llamador**: el servicio del canal Cliente. **No se enchufa al flujo de impuestos/FLIT**
—ahí la factura sigue llegando de FLIT y no se analiza—; hay que reescribir el comentario final del
service para que no siga afirmando que el extractor no existe.

El prompt gana un bloque `COMPRADOR / ADQUIRIENTE` con las 9 claves y estas instrucciones:

- **Quién es el comprador**: la sección "COMPRADOR", "ADQUIRIENTE" o "CLIENTE". Explícitamente **NO**
  el emisor/concesionario (que es el que lleva el NIT grande del encabezado y el logo). Es el error
  caro de esta plantilla, equivalente al `VALOR ASEGURADO` del SOAT.
- **Excluyencia (AC2)**: si el comprador es una empresa → `razonSocial` con valor y `nombres` y
  `apellidos` en `null`; si es persona natural → al revés. Nunca los dos juegos.
- **`tipoDocumento`**: uno de `CC`, `CE`, `TI`, `PAS`, `PPT`, `NIT`, `RC`, `PT`. Si el documento no
  lo dice, `null` — **no** deducirlo de que haya razón social.
- El JSON de salida pasa de 5 a **14 claves**: `placa`, `vin`, `numeroFactura`, `fechaFactura`,
  `valorVehiculo`, `nombres`, `apellidos`, `razonSocial`, `tipoDocumento`, `numeroDocumento`,
  `direccion`, `municipio`, `departamento`, `celular`.

`PROMPT_FACTURA_SOAT`, `PROMPT_RECIBO_IMPUESTO` y `PROMPT_DERECHO_TRAMITE` **no se tocan** (AC1).

**Escalación a Sonnet**: `numeroDocumento`, `tipoDocumento`, `nombres`, `apellidos`, `razonSocial`.
Son los que acaban siendo el titular legal de la solicitud; placa/VIN/valor siguen escalando como
antes. Con 14 campos la escalación se disparará casi siempre — es UNA llamada extra, aceptable en un
endpoint que el rate limit acota a 20 por ventana, y es lo que el AC3 compra (no inventar).
`max_tokens: 1500` sigue sobrando para 14 claves.

### 2. `shared-types`: se amplía `CampoFacturaVenta`; `CampoExtraido` NO se toca

`CampoExtraido` ya es exactamente `{ valor, confianza, confiable }` (+ `confirmadoPor/En`
opcionales): el AC4 se cumple sin editar el tipo. `ExtraccionFacturaVenta` es
`Partial<Record<CampoFacturaVenta, CampoExtraido>>` y se amplía sola al ampliar el enum.

Se añaden en `packages/shared-types/src/flito-ocr.ts`:

- 9 claves nuevas en `CampoFacturaVenta`.
- 9 etiquetas en `CAMPO_FACTURA_VENTA_LABEL` — es un `Record<CampoFacturaVenta, string>` **exhaustivo**:
  si faltan, el build de shared-types es rojo. Ese es el "typecheck obliga" del AC4.
- `CAMPOS_COMPRADOR_FACTURA` (las 9) — para que back y front no repitan la lista a mano.
- `CAMPOS_REVISION_FACTURA_VENTA` (las 5 documentales) — ver el punto siguiente.

**Grep obligatorio (AGENTS.md regla 7).** `CampoFacturaVenta`, `ExtraccionFacturaVenta`,
`CAMPO_FACTURA_VENTA_LABEL` y `CampoExtraido` en `apps/web`: **un solo consumidor**,
`apps/web/src/pages/FlitoRevisiones.tsx` (líneas 7, 20 y 39). No hay que editarlo: `labelCampo` hace
lookup con fallback (`?? clave`) y su `CampoExtraido` es un tipo local estructural. `FlitoTramites.tsx:45`
consume `coincidenciaFacturaVenta`, que es un número derivado, no el tipo.

**La rotura que el typecheck NO ve (trampa principal de esta HU).**
`camposEsperados()` (`flito-revisiones.service.ts:109`) hace `Object.values(CampoFacturaVenta)` y su
resultado lo sirve `GET /flito/revisiones/campos/:modulo` a la pantalla de revisión de Operaciones.
Ampliar el enum convertiría, en silencio y con el build verde, la cola de revisión de `factura_venta`
en **un formulario de 14 campos con 9 casillas de PII del comprador** que un admin podría teclear a
mano sobre una fila que no es del canal. Hay que **fijar** esa rama a `CAMPOS_REVISION_FACTURA_VENTA`
(las 5 de siempre). Las otras tres ramas se quedan con `Object.values`.

### 3. El endpoint vive en `flito-soat-cliente.routes.ts`, no en un router de `flito-ocr`

`RUTAS_PERMITIDAS_CLIENTE` casa **patrones absolutos** y el guarda corre al final de `authMiddleware`:
un router propio de `flito-ocr` tendría que montarse en `app.ts`, montar su `authMiddleware`, su
`requireRole('cliente')` y su limitador, **y aun así** escribir la misma entrada en la allowlist —
mismo coste de exposición, y el ciclo del canal dejaría de leerse en un archivo, que es justo el
argumento con el que ese archivo existe. Además la ruta que pide el AC6 cuelga literalmente de la
base `/api/flito/soat` que este router ya sirve.

**Sin colisión de rutas**: `/cliente/factura/lectura` tiene 3 segmentos y todos los patrones vecinos
de segundo nivel tienen 2 (`/:id/validar`, `/:id/factura`, `/:id/rechazar`…). El router del canal se
monta ANTES que el del módulo en `app.ts` (líneas 249–250), así que aunque un día apareciera un
patrón que casara, gana este.

### 4. Multipart: el orden ya es el que pide el AC6 — no hay que reordenar nada

Orden exacto de la ruta nueva, calcado de `POST /cliente`:

```
CANAL_CLIENTE, soatClienteLimiter, upload.single('facturaVenta')
```

El limitador **ya va delante de multer** en las tres rutas con adjunto del canal (277, 473). El AC6
se cumple copiando el patrón; lo que hay que hacer es **no** meter `upload` antes por comodidad.

`verificarPdfReal` es **privada** de `flito-soat-cliente.service.ts`. **No se exporta**: la función
pública nueva —`leerFacturaVenta(archivo, ctx, solicitudId?)`— vive en ESE servicio y la llama desde
dentro. La ruta no toca el buffer más que para armar el `ArchivoSolicitud`.

**No se sube nada a MinIO, no se escribe en ninguna tabla, no se crea soporte** (AC6). El buffer
muere con la petición.

**Presupuesto del limitador — decisión para el Líder Técnico.** `soatClienteLimiter` es 20/15 min con
llave compartida (`soat-cliente:<sub>`). El flujo real pasa de 2 peticiones por solicitud
(preconsulta + alta) a 3 (+ lectura): de ~10 solicitudes por ventana a ~6, y menos si el usuario
reintenta la lectura. **Recomendación: dejar 20 y medirlo**; subirlo es una línea, pero es una
decisión de exposición del canal y no la toma esta HU.

### 5. El umbral lo pone quien llama: `umbralPara(null)` → `OCR_UMBRAL_DEFECTO` (0.85)

El motor **no** decide `confiable`: `aCampoExtraido` compara contra `doc.umbral`, que llega en
`DocumentoAAnalizar`. Eso es lo que el AC4 llama "el umbral que decide quien llama", y ya está así.

**No se usa `flito_proveedores_soat.umbral_ocr`** por dos razones: (a) en el momento de la lectura la
solicitud todavía no existe —o está en `pendiente_revision`— y el proveedor se elige después, en
`POST /:id/validar`; (b) ese umbral califica la lectura de la **póliza** que emite ese proveedor, no
la de una factura de concesionario. Se usa `umbralPara(null)` para que la ruta pase por la misma
función que el resto del repo en vez de leer `env` a pelo.

### 6. Motor y modo degradado: el 503 ya existe, lo que falta es no tragárselo

`extraer()` → `pasada()` → `anthropicMessages(payload, 'ocr')`. Ese cliente devuelve **siempre
`status: 503`** en sus cuatro caminos de fallo (sin API key, no-200, payload de error, timeout/red),
y `pasada` lo lanza como `OcrNoDisponibleError(503, …)`. Tesseract **no es el motor**: es un fallback
local que solo se activa con `!ANTHROPIC_API_KEY && OCR_LOCAL=1`.

**Trampa**: `manejarError()` de `flito-soat-cliente.routes.ts` re-lanza todo lo que no sea
`SolicitudSoatError`, así que hoy un OCR caído saldría como **500** por el handler global. Hay que
añadirle la rama de `OcrNoDisponibleError` (una línea, idéntica a `flito-derechos.routes.ts:54`).

**Segunda trampa, benigna**: con el fallback local activo no se lanza nada — `camposDesdeTexto`
devuelve `{valor:null, confianza:null}` para los 9 campos del comprador (su `switch` no los conoce) y
la respuesta es un 200 con todo vacío. Eso es exactamente el AC3 + "el formulario sigue a mano", no un
fallo. No hay que añadir patrones locales para el comprador.

---

## Contrato delta

```
POST /api/flito/soat/cliente/factura/lectura
  authMiddleware (router) → guardiaCanalCliente (allowlist) → CANAL_CLIENTE → soatClienteLimiter → upload.single('facturaVenta')
  multipart/form-data:
    facturaVenta : PDF, ≤15 MB, 1 archivo (mime real verificado por bytes)
    solicitudId  : uuid, OPCIONAL (subsanación). Nunca en la URL.
  200 { extraccion: ExtraccionFacturaVenta }   // 14 claves, cada una { valor, confianza, confiable }
  400 { error }                                 // sin archivo | solicitudId no uuid
  400 { error, codigo: 'archivo_no_pdf' }       // verificarPdfReal
  403 { error: 'Sin permisos' }                 // rol ≠ cliente, o ruta fuera de la allowlist
  404 { error }                                 // solicitudId que no es de su compañía (404-no-403)
  413/429/503                                   // multer | rate limit | OcrNoDisponibleError
```

Respuesta **envuelta** en `{ extraccion }` y no plana: deja sitio para metadatos (p. ej. el umbral
aplicado) sin romper al front.

**Normalizadores nuevos** (AC5), en `flito-ocr.service.ts` junto a `placaN`/`vinN`:

| Campo | Regla | Cota destino |
|---|---|---|
| `numeroDocumento` | quita puntos, comas y espacios; mayúsculas. **Conserva letras** (PAS/CE) y el guion del DV del NIT — el AC5 dice puntos y comas, y quitar el guion sería inventar | 30 |
| `celular` | solo dígitos | 30 |
| `tipoDocumento` | mayúsculas y contra `TIPOS_DOCUMENTO_RUNT`; **si no cruza, `null`** — nunca un valor inventado | — |
| `nombres`, `apellidos`, `razonSocial`, `direccion`, `municipio`, `departamento` | `trimN` (**no** `textoExactoN`: no se fuerza mayúsculas, el valor va a un formulario que la persona lee y edita) | 200/200/200/300/100/100 |

**Cota de columna → `null`, no truncar.** Si el valor leído no cabe en la columna a la que el alta lo
va a mandar, el normalizador devuelve `null`. Es el mecanismo que ya usa `normalizarPesos`
(`aCampoExtraido` lo pasa a `confianza: 0, confiable: false`) y evita prellenar el formulario con algo
que `altaSchema` va a rechazar con un 400 sobre un campo que el usuario no escribió.

**PII (AC7).** Una línea en `pii_access_log` vía un helper nuevo en `flito-soat.pii.ts`
(`registrarLecturaFacturaCliente`), con `accion: 'read'`, `resourceTipo: RECURSO_SOAT` y
`camposAccedidos` = la lista de los 9 campos personales **con nombre de columna** (`nombres`,
`apellidos`, `razon_social`, `tipo_documento`, `numero_documento`, `direccion`, `municipio`,
`departamento`, `celular`) — lista **propia**, no una ampliación de `CAMPOS_PII_SOAT`, por el criterio
que ese archivo se aplica desde su cabecera. `resourceId` de `pii_access_log` es **numérico** y el id
del SOAT es uuid: el "sobre qué solicitud" del AC7 va en `motivo` (varchar 200, el uuid es opaco y
AGENTS.md §14 lo permite), con un texto distinto según venga o no `solicitudId`.
**No se llama a `audit()`**: en este módulo `audit()` es "quién CAMBIÓ" y esto no cambia nada.

Si viene `solicitudId`, se valida con `buscarConAcceso(id, ctx)` (404-no-403) **antes** de llamar al
OCR: si no, cualquier cliente podría estampar en el registro del art. 17 el uuid de una solicitud
ajena.

---

## Archivos a crear/modificar

**Modificar (8):**

1. `packages/shared-types/src/flito-ocr.ts` — 9 claves en `CampoFacturaVenta`, 9 etiquetas en
   `CAMPO_FACTURA_VENTA_LABEL`, `CAMPOS_COMPRADOR_FACTURA`, `CAMPOS_REVISION_FACTURA_VENTA`.
2. `apps/api/src/modules/flito-ocr/flito-ocr.prompts.ts` — bloque COMPRADOR en `PROMPT_FACTURA_VENTA`
   y JSON de salida de 14 claves. Las otras tres plantillas, intactas.
3. `apps/api/src/modules/flito-ocr/flito-ocr.service.ts` — `extraerFacturaVenta(doc)` reinstaurado,
   normalizadores nuevos, y el comentario final reescrito (hoy afirma que ese extractor no existe).
4. `apps/api/src/modules/flito-soat/flito-soat-cliente.service.ts` — `leerFacturaVenta(...)`:
   `verificarPdfReal` → `umbralPara(null)` → `extraerFacturaVenta`. Sin storage ni escritura.
5. `apps/api/src/modules/flito-soat/flito-soat-cliente.routes.ts` — ruta nueva + rama
   `OcrNoDisponibleError` en `manejarError`.
6. `apps/api/src/shared/middleware/canal-cliente.ts` — entrada en `RUTAS_PERMITIDAS_CLIENTE`
   (`POST /api/flito/soat/cliente/factura/lectura`) con su `porque`.
7. `apps/api/src/modules/flito-revisiones/flito-revisiones.service.ts` — `camposEsperados` fijado a
   `CAMPOS_REVISION_FACTURA_VENTA` en la rama `FACTURA_VENTA`.
8. `apps/api/src/modules/flito-soat/flito-soat.pii.ts` — `CAMPOS_PII_LECTURA_FACTURA` +
   `registrarLecturaFacturaCliente`.

**Crear (2 de prueba):**

9. `apps/api/__tests__/services/flito-soat.cliente-lectura-factura.test.ts` — ruta: orden de
   middlewares (el limitador dispara **sin** que multer haya cargado el archivo), 403 fuera de la
   allowlist, 403 con rol ≠ cliente, 400 sin PDF real, **503** con `OcrNoDisponibleError` (mutar a
   500 para comprobar que el aserto cae), 404 con `solicitudId` ajeno, y que la respuesta 200 **no**
   deja ninguna fila nueva en soportes/storage.
10. `apps/api/__tests__/services/flito-ocr.factura-venta-comprador.test.ts` — excluyencia
    natural/jurídica sobre respuesta simulada del modelo, `tipoDocumento` fuera de
    `TIPOS_DOCUMENTO_RUNT` → `null`, normalización de `numeroDocumento`/`celular`, valor que excede la
    cota → `null` + `confiable: false`, y que un campo sin leer sale `{valor:null, confianza:0,
    confiable:false}`.

**No se toca**: `apps/web/**` (esta HU es backend; `FlitoRevisiones.tsx` compila igual),
`schema.ts`, `migrations/`.

---

## Trampas que el backend-agent no vería solo

1. **`camposEsperados` crece en silencio** y convierte la cola de revisión de Operaciones en un
   editor de PII del comprador. El build sigue verde. Punto 2.
2. **`manejarError` re-lanza**: sin la rama de `OcrNoDisponibleError`, el AC6 devuelve 500, no 503.
3. **`verificarPdfReal` no está exportada.** Exportarla para llamarla desde la ruta es la salida
   tentadora; la correcta es que la lógica viva en el servicio del canal.
4. **`coincidenciaDe` (`flito-tramites.service.ts:354`)** hace `Math.min` sobre TODAS las claves de la
   extracción. Esta HU no persiste nada, así que hoy no le llega — pero el día que la #12093 escriba
   la extracción ampliada en `flito_impuestos.extraccion_factura_venta`, los 9 campos nuevos en 0
   hundirían el semáforo `coincidenciaFacturaVenta` del tablero. **Dejar dicho en el handoff a la
   #12093**, no arreglar aquí.
5. **El comentario final de `flito-ocr.service.ts` miente en cuanto se toque**: dice que
   `extraerFacturaVenta` se retiró porque la factura viene de FLIT. Sigue siendo cierto **para el
   flujo de impuestos**; hay que acotarlo, no borrarlo.
6. **El fileFilter de multer y `LIMIT_FILE_SIZE`**: este router no maneja `MulterError` (a diferencia
   de `soat.routes.ts:203` o `flito-conciliacion`), así que un archivo de 16 MB cae en el handler
   global. Es **deuda preexistente del canal**, no de esta HU: calcar el patrón significa heredarla.
   No inventar aquí un manejo distinto al de `POST /cliente`.
7. **Ningún valor leído en los logs (AC7)**: el `log.warn` de `pasada` solo lleva `modelo`, y el
   `log.info` del fallback solo cuenta caracteres. No añadir un `log.debug` con el JSON parseado
   "para depurar" — es PII del comprador en el log de la aplicación.
8. **Nada de PII en la URL**: `solicitudId` va en el cuerpo del multipart, no como `:id` ni como query.

---

## Verificación (AGENTS.md §gates)

```
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
npm run build -w packages/shared-types && npm run test:shared-types
npm run test:api -- flito-soat.cliente-lectura-factura flito-ocr.factura-venta-comprador flito-revisiones
npm run typecheck -w apps/web        # el grep dice que no cambia; que lo confirme el compilador
```

Cada aserto del gate se comprueba **mutando**: 503→500 en `manejarError`, `CAMPOS_REVISION_FACTURA_VENTA`
→ `Object.values`, y quitar la excluyencia del prompt debe dejar rojo al menos un test.
