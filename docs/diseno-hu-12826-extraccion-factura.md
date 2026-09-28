# Diseño slim — HU #12826 · Impuestos: extraer datos vehiculares de la factura FLIT

Épica #12809 · Feature #12821 · Módulo **FLITO** `flito-impuestos` + `flito-ocr` (no el legacy `liquidacion`).
Estado: **Propuesto** (diseño slim, sin ADR). Rama apilada sobre la HU 12825 (`390a9e38`).

Alcance: el **primer paso** del análisis post-envío (`registrarPasoAnalisis('extraccion', …)`): descargar la
factura de venta desde FLIT, extraer con un parser determinístico sobre el bloque «Notas Finales» y el bloque
del Adquiriente, recurrir al OCR si no hay bloque, y persistir en `flito_impuestos.extraccion_factura_venta`.
**Fuera:** semáforo y comparación contra el RUNT (12827), autocertificación (12828), columnas de dirección (12833), UI (12830).

> Formato inferido de las 6 muestras sin versionar de `docs/facturas-venta/` (checkout principal). **Todos los
> valores de este documento son inventados**: no se copió ningún dato real.

## Patrón reutilizado

| Pieza | Vecino que se copia / reusa |
|---|---|
| Punto de extensión | `registrarPasoAnalisis` / `PasoAnalisis` en `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.service.ts` (HU 12825). El paso lanza para marcar `error_analisis` |
| Obtener la factura de FLIT | Las 3 líneas de `GET /:id/factura-venta` (`flito-impuestos.routes.ts:147-156`): `getFlitAdapter().obtenerUrlFactura(facturaId)` + `fetch(url)` + `Buffer.from(arrayBuffer)` + `tipoPorBytes(cuerpo)` |
| Id de la factura | La misma consulta que `facturaVentaFlitConAcceso` (`flito-impuestos.service.ts:561`): `flitoTramites.facturaVentaFlitId` por `imp.tramiteId`, pero **sin** frontera `ctx` (el job es del sistema) |
| Texto del PDF | `pdftotext -layout` que ya invoca `flito-ocr-local.ts:64` (`pdfATexto`). `poppler-utils` ya está en `apps/api/Dockerfile:49-53` |
| Motor OCR | `extraer(doc, prompt, campos, escalacion, normalizadores)` de `flito-ocr.service.ts:189` (Haiku → Sonnet, `OcrNoDisponibleError`), igual que `extraerFacturaVenta` (`:432`) |
| Normalizadores | `vinN`, `textoTitularN(n)` de `flito-ocr.service.ts` (exportarlos si no lo están; no duplicarlos) |
| Contrato de campo | `CampoExtraido { valor, confianza, confiable }` (`packages/shared-types/src/flito-ocr.ts:177`) |

**Dependencias nuevas: ninguna.** El repo no tiene `pdf-parse`, y `pdfjs-dist` solo está en `apps/web`. El
binario `pdftotext` ya se usa y ya está en la imagen, así que no se toca `package.json`.

## Decisiones

### D1. Descarga del PDF (sin pasar por HTTP)
- Archivo nuevo `flito-impuestos.extraccion.ts`, con una función interna `descargarFacturaDeImpuesto(impuestoId): Promise<{ bytes: Buffer; contentType: string }>`:
  1. Hace `select facturaVentaFlitId from flito_impuestos join flito_tramites` por `impuestoId`. Es del sistema y no pasa por `buscarConAcceso`. **No** se toca `flito-impuestos.service.ts`, que ya tiene 786 líneas.
  2. `getFlitAdapter().obtenerUrlFactura(id)` → `fetch(url, { signal: AbortSignal.timeout(30_000) })`. Se añade un **tope de tamaño** de 15 MB (se lee `content-length` y se comprueba `buffer.length`). La ruta no tiene ninguno de los dos y el job corre sin supervisión.
  3. `tipoPorBytes(bytes)`: se importa del mismo módulo del que lo importa la ruta.
- **Si el impuesto no tiene factura** (`facturaVentaFlitId` null), o la URL sale null, o el `fetch` falla o no es `ok`, o se pasa del tope: se lanza `FacturaNoDisponibleError` y el estado queda en **`error_analisis`**. No se escribe nada en `extraccion_factura_venta`.
  - Por qué no queda `completado`: dejaría `analizado_en` escrito, y entonces la 12827 calcularía un semáforo sin datos. Además, el AC2 de la 12825 impediría reanalizarlo solo.
  - Con `error_analisis`, «Reintentar validación» (AC5 de la 12825) sirve para cuando FLIT publique la factura.
  - El log es `log.warn({ impuestoId, motivo: 'sin_factura' | 'url_nula' | 'http_<status>' | 'tope' })`, sin la URL presignada (lleva firma) ni ningún byte.

### D2. Texto del PDF
- Se exporta desde `flito-ocr-local.ts` la función que ya existe, `pdfATexto`, renombrada `textoPdf(buf): Promise<string>`. Es solo `pdftotext -layout`: **sin** Tesseract, porque rasterizar para después aplicar el parser no sirve. Un PDF escaneado da `''` y cae al OCR.
- Si `tipoPorBytes` dice que es imagen, **no hay parser**: se va directo al OCR (D4).
- Se usa `-layout` porque el bloque del Adquiriente está a **dos columnas** y hace falta conservar la alineación. Para Notas Finales da igual el modo, porque el PDF ya trae los saltos de línea.

### D3. Gramática del parser (`flito-ocr/flito-ocr-factura-flit.ts`, funciones puras sobre texto)

**Bloque «Notas Finales»**. Empieza en la línea `Notas Finales` y termina en la siguiente línea `Datos Totales` (o al final del texto). Así se ve, con valores inventados:

```
Notas Finales

Responsables de IVA|Tarifa ICA Ciudad 9.9 /1000|Numerodecontacto1:3000000000|AñoVehículo:2026|Cilindrada:1598|Color:Blanco
Perla|Marca:MarcaX|Potencia:90
kW|Combustible:Gasolina|Tracción:Delantera|Clase:Automóvil|Transmisión:Manual|VIN:9ABCD1234EF56789
0|Motor:XX000000|CIT:AB00
00|Peso:1100 kg|Puertas:5|Asientos:5|Carga:400 kg|Cilindros:4|Servicio Particular
Datos Totales
```

Reglas:
1. Las líneas del bloque se **unen con un espacio** y se colapsan los espacios. Después se parte por `|`.
   - Un segmento sin `:` («Responsables de IVA», «Servicio Particular») se ignora.
   - Un segmento con `:` se parte en el **primer** `:`.
2. **Clave normalizada:** NFD, sin diacríticos, en minúsculas, sin nada que no sea alfanumérico. Por ejemplo, `AñoVehículo` queda `anovehiculo` y `Línea` queda `linea`. Así cubre «AñoVehiculo» con y sin tilde, que es lo que dice el AC y lo que traen las muestras (con tilde en la í).
3. Tabla cerrada de claves (cualquier otra clave se **descarta y no se persiste**; en particular `Numerodecontacto1`, que es un teléfono y por tanto PII, y `Motor`/`CIT`):

   | Clave normalizada | Campo | Validación → `confiable` |
   |---|---|---|
   | `vin` | `vin` | se quitan **todos** los espacios, porque un salto de línea puede partir el VIN (ver el ejemplo), y se pasa a mayúsculas. `^[A-HJ-NPR-Z0-9]{17}$` |
   | `marca` | `marca` | 1–60 caracteres |
   | `modelo`, `linea` | `linea` | 1–100 caracteres. Si el valor es `^\d{4}$` (parece un año), `confiable=false` |
   | `anovehiculo`, `aniovehiculo` | `anioVehiculo` | `^\d{4}$`, entre 1950 y el año actual + 2 |
   | `color` | `color` | 1–60 caracteres. El salto de línea parte colores de dos palabras («Blanco Perla»), y unir con espacio lo resuelve |
   | `cilindrada` | `cilindrada` | se queda solo con los dígitos (acepta «1.598», «1598 cc»). `^\d{1,5}$`. **`0` es válido** (eléctrico) |
   | `clase` | `clase` | 1–60 caracteres |

4. **Confianza del parser.** Valor válido: `{ valor, confianza: 1, confiable: true }`. Presente pero inválido: `{ valor: <crudo recortado a 100>, confianza: 0.5, confiable: false }`. Ausente: `{ valor: null, confianza: 0, confiable: false }`. Si una clave aparece dos veces con valores distintos: `confiable: false`, `confianza: 0.5`.
5. **«Bloque encontrado»** significa que existe la cabecera `Notas Finales` **y** que se parseó al menos una de las 7 claves. En cualquier otro caso se usa el fallback OCR (D4). Si el bloque está pero incompleto, **no** se llama al OCR: los faltantes quedan `confiable:false` y los resuelve la 12827 o una persona.

**Bloque del Adquiriente** (región desde `Datos del Adquiriente` hasta `Detalles de Productos`). Hay que acotarlo así porque el bloque del **Emisor**, que va antes, usa las mismas etiquetas. Las etiquetas del comprador están en la columna derecha, y así se ven con valores inventados:

```
Datos del Adquiriente        No. Documento de Adquiriente     Razón Social  EMPRESA EJEMPLO SAS
Tipo de Documento            NIT                              Dirección     CL 1 # 2-3 OF 4
Nombre Comercial             EMPRESA EJEMPLO SAS              Ciudad        CIUDADX
Tipo de Contribuyente        Persona Jurídica                 Departamento  DPX
```

- Se busca por línea con `/(?:^|\s{2,})Direcci[oó]n\s{2,}(.+?)\s*$/` (y lo mismo para `Ciudad` → `municipio` y para `Departamento` → `departamento`). **Gana la primera coincidencia** dentro de la región.
- Los valores pasan por `textoTitularN(300)` (dirección) y `textoTitularN(100)` (los otros dos). `confianza: 0.9` (heurística de columnas, no una etiqueta con `:`), y `confiable` es `true` solo si el normalizador devuelve un valor.
- El departamento puede venir **abreviado** (código de 3 letras) y se guarda tal cual. Normalizarlo es de la 12833.
- **No** se extraen nombre, documento, correo ni teléfono del comprador: no los pide el AC (minimización, Ley 1581).
- Si no hay región del Adquiriente pero sí Notas Finales, los tres campos quedan en `null` / `0` / `false` y **no** se llama al OCR solo por la dirección.

API del parser:

```ts
export function parsearNotasFinales(texto: string): ExtraccionVehiculoFactura | null; // null = sin bloque
export function parsearAdquiriente(texto: string): Pick<ExtraccionFacturaVenta, 'direccion' | 'municipio' | 'departamento'>;
```

### D4. Fallback OCR
- Función nueva en `flito-ocr.service.ts`: `extraerVehiculoFacturaVenta(doc: DocumentoAAnalizar): Promise<ExtraccionFacturaVenta>`. Llama al **motor existente** `extraer(...)` con un prompt nuevo, `PROMPT_FACTURA_VENTA_VEHICULO` en `flito-ocr.prompts.ts`, que reusa `SISTEMA_OCR` y las reglas de «no inventar» de `PROMPT_FACTURA_VENTA`.
  - **Campos pedidos:** los 7 vehiculares más `direccion`, `municipio` y `departamento`. Nada del comprador más allá de eso.
  - **Escalación a Sonnet:** `vin`, `anioVehiculo`, `marca`.
  - **Normalizadores:** `vinN`, el de año y cilindrada de D3 (exportados del parser), y `textoTitularN` para el resto.
  - **Umbral:** el mismo que usa el canal SOAT al llamar `extraerFacturaVenta` (`flito-soat-cliente.service.ts:~1298`).
- **Por qué no se amplía `extraerFacturaVenta`:** la usa el canal Cliente de SOAT (HU #12092). Añadirle 6 campos le cambiaría el costo y la escalación a ese flujo sin que ninguna HU lo pida. «Prompt OCR existente» del AC2 se interpreta como «el motor y las reglas del prompt existente» (ver «Pendiente humano» P2).
- **Desenlace:**
  - `OcrNoDisponibleError` → se relanza → `error_analisis`.
  - El OCR responde (aunque los campos vengan con baja confianza o en `null`) → se persiste con `fuente:'ocr'` → `completado`. El semáforo de la 12827 se encarga de los datos insuficientes. `error_analisis` queda **solo para fallos técnicos**.
  - Con `OCR_LOCAL=1` sin API key, `camposDesdeTexto` no conoce las claves nuevas y devuelve `null`. Es aceptable, porque es un modo de desarrollo.
- **Security:** en el fallback la factura sale al motor Anthropic. El flujo ya existe (canal SOAT) y aquí pide menos datos personales. Queda declarado para `security-agent`.

### D5. Forma del jsonb (`packages/shared-types/src/flito-ocr.ts`)
- Se amplía `CampoFacturaVenta` con `MARCA:'marca'`, `LINEA:'linea'`, `ANIO_VEHICULO:'anioVehiculo'`, `COLOR:'color'`, `CILINDRADA:'cilindrada'` y `CLASE:'clase'`. `vin`, `direccion`, `municipio` y `departamento` ya existen.
- `CAMPO_FACTURA_VENTA_LABEL` (un `Record` exhaustivo) recibe las 6 etiquetas nuevas, porque si no el build da rojo. Esa es la intención (AC4 #12092).
- `CAMPOS_REVISION_FACTURA_VENTA` **no cambia**, así que el formulario de revisión no crece.
- Tipo nuevo:
  ```ts
  export type FuenteExtraccionFactura = 'notas_finales' | 'ocr';
  export type ExtraccionFacturaVentaImpuesto = ExtraccionFacturaVenta & { fuente?: FuenteExtraccionFactura };
  ```
  - `fuente` es **opcional** porque las filas históricas no la traen.
  - Es un **tipo aparte**: `ExtraccionFacturaVenta` sigue siendo el del canal SOAT (`soatCliente.ts:764`, `FlitoSoatSolicitud.tsx:453`), y así esos consumidores no ven una clave que no es un `CampoExtraido`.
  - **Regla:** quien lea el jsonb itera sobre listas de campos (constantes), **nunca** sobre `Object.values`.
- `schema.ts:3128`: `$type<ExtraccionFacturaVenta>()` pasa a `$type<ExtraccionFacturaVentaImpuesto>()`. Es un cambio **solo de tipo**, sin DDL ni migración. Lectores actuales: `flito-impuestos.service.ts:589/602`, que lo pasa como `unknown` y no se rompe. `apps/web` no lee `extraccionFacturaVenta`, aunque el backend lo tiene que confirmar con grep.
- Con fuente `notas_finales`, el jsonb persistido lleva los 7 vehiculares y los 3 de dirección. Con fuente `ocr`, los mismos 10. Siempre las 10 claves, en `null` si faltan.

### D6. Registro del paso y orden
- `flito-impuestos.extraccion.ts` exporta `pasoExtraccion: PasoAnalisis`. **No** se registra a sí mismo al importarse, porque un efecto secundario de import depende del orden de los imports y `__resetColaAnalisis()` lo borra en los tests.
- Archivo nuevo `flito-impuestos.analisis.pasos.ts`:
  ```ts
  export function registrarPasosAnalisisImpuestos(): void {
    registrarPasoAnalisis('extraccion', pasoExtraccion);   // 12826 — primero: 12827 compara lo extraído con el RUNT
    // 12827: registrarPasoAnalisis('comparacion', …)
    // 12828: registrarPasoAnalisis('autocertificacion', …)
  }
  ```
  - El **orden explícito** vive en un solo archivo, y `Map.set` lo hace idempotente.
- Se llama en `apps/api/src/server.ts` **fuera** del bloque `production` (un envío en DEV o local también encola) y antes de `listen`/`startImpuestosAnalisisCron`.
- El paso **no** usa `runt` (no consulta el RUNT).
- **Persistencia:** `UPDATE flito_impuestos SET extraccion_factura_venta=$json WHERE id=$1 AND analisis_estado='en_curso'`. Así no pisa una fila que se reseteó mientras tanto. En un reanálisis se sobrescribe.

### D7. PII
- Después de persistir se llama `logPiiAccess` con `camposAccedidos: ['direccion','municipio','departamento','vin']` y `motivo: 'analisis_post_envio'`, con `entidadId = impuestoId`.
- `logPiiAccess(req, opts)` exige `req`. El job no tiene petición, y la cabecera de `pii-audit.ts:99-103` contempla «un cron que fabrica una petición».
  - El backend usa el mecanismo de actor-sistema que ya exista en el repo, **o** fabrica un `req` mínimo sin IP ni `request_id` y con actor sistema.
  - Si `PiiAuditOpts` exige un `userId` que no se puede representar, **se para y se pregunta** (P9). No se inventa un usuario.
- **Logs sin valores:** solo `{ impuestoId, fuente, camposConfiables: n, motivo }`. Nunca texto del PDF, VIN, dirección ni la URL presignada.
- Minimización: `Numerodecontacto1` (teléfono), nombre y documento del comprador **no** se persisten.

## Contrato delta
- **Sin endpoints nuevos.** `GET /api/flito/impuestos/:id` (o la cola) ya devuelve `extraccionFacturaVenta`, que ahora viene poblado y con `fuente`.
- shared-types: 6 claves en `CampoFacturaVenta`, 6 etiquetas, más `FuenteExtraccionFactura` y `ExtraccionFacturaVentaImpuesto`.
- Estado: parser u OCR ok → `completado` + `analizado_en`. Sin factura, descarga fallida u OCR caído → `error_analisis`.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `packages/shared-types/src/flito-ocr.ts` | +6 claves en `CampoFacturaVenta`, +6 etiquetas, +`FuenteExtraccionFactura`, +`ExtraccionFacturaVentaImpuesto` |
| `apps/api/src/db/schema.ts` (l.3128) | solo `$type<ExtraccionFacturaVentaImpuesto>()` y su import. **Sin migración** |
| `apps/api/src/modules/flito-ocr/flito-ocr-factura-flit.ts` | **nuevo**: `parsearNotasFinales`, `parsearAdquiriente`, normalizadores de año y cilindrada |
| `apps/api/src/modules/flito-ocr/flito-ocr-local.ts` | exporta `textoPdf` (renombra `pdfATexto`, sin cambio de lógica) |
| `apps/api/src/modules/flito-ocr/flito-ocr.prompts.ts` | +`PROMPT_FACTURA_VENTA_VEHICULO` |
| `apps/api/src/modules/flito-ocr/flito-ocr.service.ts` (500 l.) | +`extraerVehiculoFacturaVenta` y exporta `vinN`/`textoTitularN` si hace falta |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.extraccion.ts` | **nuevo**: `descargarFacturaDeImpuesto`, `FacturaNoDisponibleError`, `pasoExtraccion` |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.pasos.ts` | **nuevo**: `registrarPasosAnalisisImpuestos()` |
| `apps/api/src/server.ts` | import + llamada a `registrarPasosAnalisisImpuestos()` |
| `apps/api/__tests__/fixtures/factura-flit-notas-finales.txt` | **nuevo**: texto `-layout` **inventado**, con cortes de línea dentro de VIN y de color, «AñoVehículo» con tilde, bloque Emisor antes del Adquiriente con las mismas etiquetas y `Numerodecontacto1` |
| `apps/api/__tests__/…/flito-ocr-factura-flit.test.ts` | **nuevo** (en el directorio de tests de `flito-ocr`, junto a sus vecinos) |
| `apps/api/__tests__/…/flito-impuestos.extraccion.test.ts` | **nuevo** (junto al test de la cola de la 12825) |

**No se tocan** `flito-impuestos.service.ts` (786 l.) ni `flito-impuestos.routes.ts`.

**Tests P1** (`TZ=UTC npm test -w apps/api -- <los 2 archivos>`):
- **Parser:**
  - El fixture da los 7 campos con `confianza 1` y el VIN reconstruido a pesar del corte.
  - `Modelo:` se guarda en `linea`.
  - `AñoVehiculo` y `AñoVehículo` dan lo mismo.
  - La dirección, la ciudad y el departamento salen del **Adquiriente**, no del Emisor.
  - Ni `Numerodecontacto1` ni el teléfono aparecen en la salida (aserto sobre las claves).
  - Un VIN de 16 da `confiable:false`.
  - `Cilindrada:0` da `confiable:true`.
  - Sin cabecera, el resultado es `null`.
- **Paso:**
  - Con el adapter FLIT, `fetch`, `textoPdf` y OCR mockeados, bloque presente: `fuente:'notas_finales'` y **no** se llama al OCR (espía).
  - Bloque ausente: se llama al OCR y queda `fuente:'ocr'`.
  - Sin factura: lanza (y la cola marca `error_analisis`).
  - `OcrNoDisponibleError`: lanza.
  - El `UPDATE` lleva `analisis_estado='en_curso'`, verificado sobre las condiciones capturadas y no sobre la fila del mock.
  - Se llama a `logPiiAccess` con los campos y sin valores.

## ADR: no aplica
Es una extensión del punto de extensión de la 12825 con motor, binario y flujo de datos personales que ya existen. No añade dependencias, tablas ni endpoints.

## Notas operativas
- **backend-agent:**
  - Antes de ampliar `CampoFacturaVenta`, correr `grep -rn "CampoFacturaVenta\|CAMPO_FACTURA_VENTA_LABEL\|ExtraccionFacturaVenta\|extraccionFacturaVenta" apps/web/src apps/api/src` (regla 7) y `npm run build -w packages/shared-types`.
  - El test del parser no debe depender de `pdftotext`: el CI puede no tenerlo, y se prueba sobre texto.
  - `npx eslint` sobre `flito-ocr.service.ts` tras el cambio (max-lines).
- **Gates:**
  - `security-agent` **aplica**: PII (dirección del comprador), salida a Anthropic en el fallback, `fetch` a una URL externa con tope.
  - `db-review-agent`: `schema.ts` cambia **solo el `$type`**. El disparador formal se cumple; el hilo decide si lo declara «no aplica: sin DDL».
  - `ux`: omit (BACKEND-only).
- **frontend:** nada en esta HU (UI en la 12830).

## Pendiente humano (P9 — conviene cerrarlo antes de codear)
- **P1 (bloquea en parte el AC1, campo `linea`):** ninguna de las 6 muestras reales trae una etiqueta `Modelo:` ni `Línea:` en «Notas Finales». Traen `AñoVehículo`, `Marca`, `Color`, `Cilindrada`, `Clase` y `VIN`, entre otras. El modelo o la línea solo parece estar en la columna «Descripción» de «Detalles de Productos», que es texto libre.
  - Hay que decidir:
    - (a) `linea` queda en `null` con `confiable:false` cuando no hay etiqueta (este diseño, sin OCR extra);
    - (b) se lee la «Descripción» del producto con una heurística (frágil);
    - (c) se pide solo `linea` al OCR (cada análisis manda la factura a Anthropic).
  - Recomendación: **(a)**, y que FLIT añada `Linea:` a las Notas Finales.
  - Ojo: en Colombia «modelo» suele significar el **año** del vehículo. Por eso el parser marca `confiable:false` si `Modelo:` trae 4 dígitos.
- **P2:** confirmar que «prompt OCR existente» (AC2) se cumple con el motor y las reglas existentes más un prompt nuevo de 10 campos (D4), en lugar de ampliar `PROMPT_FACTURA_VENTA` del canal SOAT.
