# Diseño slim — HU #13207 · Comprimir al cargar los comprobantes PDF de más de 1 MB

Feature #12955 · Épica #12683 · módulo **`flito-impuestos`** (no el legacy `impuestos`; `flito-comprobantes` queda fuera).
Estado: **Propuesto** (diseño; no requiere ADR). Decisión de producto de David (2026-09-30): escalones 0, 1 y 3; sin qpdf, sin Ghostscript, sin dependencias nuevas.

## Patrón reutilizado

- **Binarios de poppler con `spawn` + tiempo límite + temporal en `finally`:** `apps/api/src/modules/flito-ocr/flito-ocr-local.ts` (`ejecutar()` :29, `pdfEscaneadoAImagen()` :78). Se exporta `ejecutar` (renombrado `ejecutarBinario`, misma firma `(cmd, args, input?, timeoutMs)`), no se duplica.
- **Umbral de «tiene capa de texto»:** el mismo de `textoDocumento()` en ese archivo: `texto.replace(/\s/g, '').length >= 40`. **No** se reutiliza `textoPdf()`: se traga el error y devuelve `''`, y aquí un `''` por fallo de `pdftotext` clasificaría como escaneo un PDF con texto y lo rasterizaría. La compresión necesita distinguir «vacío» de «falló».
- **pdf-lib ^1.17.1** ya es dependencia de `apps/api` (confirmado en `apps/api/package.json:46`; lo usan `certificado-pdf.ts`, `flito-logistica.service.ts`, `laft/…`). poppler ya está en la imagen (`apps/api/Dockerfile:49-52`).
- **Punto de inyección:** `archivar()` de `flito-recibos.service.ts:601`, que ya es el único camino a storage de las 4 escrituras de la vía masiva (liquidación :421, pago :435, complemento :490) y del recibo de caja (:732).

## Contrato delta

Sin cambios de endpoint, de respuesta ni de esquema. Sin migración. `shared-types` sin cambios.

```ts
// apps/api/src/modules/flito-impuestos/flito-recibos.compresion.ts
export const META_BYTES = 1024 * 1024;           // 1 MB
export type Escalon = 0 | 1 | 3;
export type MotivoCompresion =
  | 'NO_PDF' | 'BAJO_META' | 'FIRMADO' | 'CIFRADO'        // escalón 0 por regla
  | 'META_ALCANZADA' | 'MAS_LIVIANO' | 'SIN_MEJORA'        // resultado normal
  | 'SIN_POPPLER' | 'ERROR' | 'TIEMPO' | 'VERIFICACION' | 'LIMITE_PAGINAS'; // se guarda el original
export interface ResultadoCompresion {
  buffer: Buffer; escalon: Escalon; bytesAntes: number; bytesDespues: number; motivo: MotivoCompresion;
}
export async function comprimirComprobante(
  entrada: { buffer: Buffer; mimetype: string },
  deps?: Partial<DepsCompresion>,   // solo tests: { ejecutar, ahora, tiempoLimiteMs }
): Promise<ResultadoCompresion>;     // NUNCA lanza: ante cualquier fallo devuelve el original (escalón 0)
```

Delta interno del servicio (no exportado): `archivar(cand, archivo)` pasa de `Promise<string>` a `Promise<Guardado>` con `Guardado = { storageKey: string; tamanoBytes: number }`; `insertarSoporte(tx, impuestoId, archivo, tipo, ctx, guardado, hash)` escribe `storageKey: guardado.storageKey, tamanoBytes: guardado.tamanoBytes`. El `hash` sigue llegando del sha256 del **original** (:208 y :718), sin tocar.

## Algoritmo (orden exacto)

1. **Escalón 0 por regla** (sin CPU, sin spawn), en este orden:
   - no empieza por los bytes `%PDF-` (MIME real, no el `mimetype` declarado ni la extensión — cubre también las entradas del ZIP) → `NO_PDF`. JPEG/PNG caen aquí.
   - `buffer.length <= META_BYTES` → `BAJO_META`.
   - escaneo `latin1` del buffer: contiene `/ByteRange` o `/Sig` → `FIRMADO` (conservador: `/SigFlags` también cuenta, está bien).
   - contiene `/Encrypt` → `CIFRADO` (el diccionario del trailer / xref stream no va comprimido, se ve en claro).
2. **Cargar con pdf-lib** `PDFDocument.load(buf, { updateMetadata: false })` (sin `ignoreEncryption`: si pdf-lib detecta cifrado, lanza → `CIFRADO`). Segunda red de firma tras cargar: `catalog` con `/AcroForm` que tenga `/SigFlags`, o `/Perms` → `FIRMADO` (cubre firmas cuyo diccionario viaje dentro de un object stream y no se vea en el escaneo crudo). **No** llamar `doc.getForm()`: crea un AcroForm si no existe.
3. **Límite de páginas** (defensa contra bombas): `doc.getPageCount() > MAX_PAGINAS (50)` → `LIMITE_PAGINAS`. Y para el escalón 3, cualquier página con lado > `MAX_LADO_PT (2000 pt ≈ 70 cm)` salta el escalón 3 (una MediaBox gigante a 150 dpi es la bomba real de `pdftoppm`).
4. **Texto del original:** `pdftotext -layout - -` vía `ejecutarBinario`. Si falla con `ENOENT` → `SIN_POPPLER`; otro fallo → `ERROR`; en ambos casos se devuelve el original (no se puede verificar el escalón 1 ni decidir el 3). `tieneTexto = texto.replace(/\s/g,'').length >= UMBRAL_TEXTO_CHARS (40)` — umbral sobre el documento entero: un PDF mixto (una página con texto) cuenta como «con texto» y **nunca** se rasteriza.
5. **Escalón 1 (sin pérdida):** `doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false })`. Autoverificación: recargar con pdf-lib → mismo `getPageCount()`; y `pdftotext -layout` del resultado **idéntico byte a byte** al del original. Si no cuadra → descartar el candidato (`VERIFICACION`, se sigue). Se acepta si `< bytesAntes`. Si ya `<= META_BYTES` → devolver (`META_ALCANZADA`).
6. **Escalón 3 (solo `!tieneTexto`)**, sobre el **original** (no sobre la salida del 1):
   - `dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flito-comp-'))`; `pdftoppm -jpeg -jpegopt quality=75 -r 150 -f 1 -l <páginas> - <dir>/p` (stdin = buffer; el directorio temporal evita adivinar el relleno `p-1`/`p-01`/`p-001`).
   - `readdir` ordenado por el número de sufijo; exigir `n.º de JPEG === páginas` (si no, `VERIFICACION`).
   - `PDFDocument.create()`; por página i: `embedJpg`, `addPage([w, h])` con el tamaño del original (`getSize()`; si `getRotation().angle` es 90/270, intercambiar w y h, porque `pdftoppm` ya aplica la rotación), `drawImage` a página completa.
   - Autoverificación: recargar → mismo número de páginas.
   - `finally { await fs.rm(dir, { recursive: true, force: true }) }` — **siempre**, también por timeout/error: los JPEG son el comprobante del contribuyente (PII).
7. **Elección final:** el primer escalón que quede `<= META_BYTES`; si ninguno, el candidato **más liviano** entre {original, 1, 3} (`MAS_LIVIANO`); si ninguno es más liviano que el original → original (`SIN_MEJORA`). Nunca se rechaza la carga por no llegar a la meta.
8. **Tiempo límite por archivo:** `TIEMPO_LIMITE_MS = 20_000` como presupuesto total. Cada `spawn` recibe `restante = limite - (ahora() - inicio)` como su `timeoutMs` (el `SIGKILL` ya lo hace `ejecutar`); entre pasos, si `restante <= 0` → `TIEMPO`. Las operaciones de pdf-lib son CPU en el hilo principal y no se pueden interrumpir; con el tope de 15 MB por archivo y 50 páginas quedan acotadas (se declara abajo como riesgo).
9. **Todo envuelto en `try/catch`** → cualquier excepción devuelve el original con `ERROR`. La función **no lanza jamás**: la carga sigue su resultado normal.
10. **Log:** un `log.info`/`log.warn` por archivo con `{ escalon, motivo, bytesAntes, bytesDespues, ms }`. **Prohibido** loguear `originalname` (suele llevar la placa), texto extraído o stderr de poppler más allá del mensaje recortado que ya da `ejecutar` (no incluye rutas: la entrada va por stdin y el temporal es un uuid).

## Concurrencia (2)

Semáforo **de módulo** dentro de `flito-recibos.compresion.ts` (≈15 líneas, `Promise` + cola; sin dependencia): `MAX_COMPRESIONES_SIMULTANEAS = 2`. Acota el proceso entero —dos cargas masivas en paralelo o una masiva y un recibo de caja— y no solo un lote. La vía masiva no se paraleliza: `procesarRecibo` sigue en el `for` secuencial de :238 (el orden «liquidación primero» depende de él), así que en un lote la compresión corre de a una y el semáforo solo muerde entre peticiones. `conConcurrencia` (`shared/utils/con-concurrencia.ts`) no sirve aquí: reparte un arreglo conocido, no limita entre llamadas.

## Inyección en el servicio (sin cambiar el hash)

```ts
async function archivar(cand: Candidato, archivo: ArchivoSubido): Promise<Guardado> {
  const carpeta = carpetaDe({ id: cand.companiaId, flitoCarpetaStorage: cand.carpeta }, 'impuestos/recibos');
  const c = await comprimirComprobante({ buffer: archivo.buffer, mimetype: archivo.mimetype });
  const storageKey = await uploadEntityDocument(carpeta, cand.impuestoId, archivo.originalname, c.buffer, archivo.mimetype);
  return { storageKey, tamanoBytes: c.buffer.length };
}
```

- Sitio correcto por construcción: `archivar` solo se llama **después** del hash, del OCR (`docDe` usa `archivo.buffer` original), de la vigilancia de fase y del dedupe por número de recibo → rechazados y duplicados no gastan CPU.
- `archivo` **no se muta** (no reasignar `archivo.buffer`): el hash (:208/:718) y el OCR ya corrieron sobre el original y ningún paso posterior debe ver otro buffer.
- `contentType` del soporte sigue `archivo.mimetype` (el resultado es PDF siempre que la entrada lo era). `nombreArchivo` sin cambio.
- Hueco aceptado por David: `hashReciboYaCargado` compara el sha256 del original contra el guardado (que es del original), así que el dedupe por hash sigue funcionando; lo que no hay es hash del archivo comprimido almacenado (sin migración).
- HU #13208 (carga individual) importará `comprimirComprobante` directamente.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/modules/flito-impuestos/flito-recibos.compresion.ts` | **Nuevo**: `comprimirComprobante`, helpers `esPdf`, `pareceFirmado`, `pareceCifrado`, `firmaEnCatalogo`, `tieneCapaDeTexto`, `rasterizar`, semáforo, constantes (`META_BYTES`, `UMBRAL_TEXTO_CHARS`, `MAX_PAGINAS`, `MAX_LADO_PT`, `TIEMPO_LIMITE_MS`, `MAX_COMPRESIONES_SIMULTANEAS`). Cabecera con las reglas (RN) de este diseño |
| `apps/api/src/modules/flito-ocr/flito-ocr-local.ts` | `export` de `ejecutar` como `ejecutarBinario` (sin cambio de comportamiento) |
| `apps/api/src/modules/flito-impuestos/flito-recibos.service.ts` | `archivar` → `Guardado`; `insertarSoporte` recibe `guardado`; 4 sitios de llamada (:421, :435, :490, :732) pasan `guardado`; nota en la cabecera. Hoy 746 líneas brutas: el delta es ~+8, lejos de 800 netas |
| `.github/workflows/ci.yml` | Paso antes de «Test API (vitest)»: `sudo apt-get update && sudo apt-get install -y --no-install-recommends poppler-utils` (ver riesgo de CI) |
| `apps/api/__tests__/services/flito-recibos.compresion.test.ts` | **Nuevo** (unit + integración con poppler real) |
| `apps/api/__tests__/services/flito-recibos.test.ts` y `apps/api/__tests__/services/flito-recibo-caja.test.ts` | Un caso cada uno: con `comprimirComprobante` mockeado (`vi.mock` del módulo nuevo devolviendo un buffer menor), `uploadEntityDocument` recibe el buffer comprimido, el insert de `flito_soportes` lleva `hash = sha256(original)` y `tamanoBytes = comprimido.length` |

## Tests P1

Comando: `npm test -w apps/api -- __tests__/services/flito-recibos.compresion.test.ts __tests__/services/flito-recibos.test.ts __tests__/services/flito-recibo-caja.test.ts`

Fixtures **generados con pdf-lib en el propio test** (nada binario en el repo):
- **F-texto-grande:** 1 página con `drawText` (StandardFonts, ≥ 200 caracteres) **+** una imagen de ruido grande, guardado con `useObjectStreams: false` → > 1 MB y el escalón 1 no puede llegar a la meta. Es el fixture que prueba «un PDF con texto nunca se rasteriza».
- **F-texto-objetos:** 1 página de texto + ~20 000 objetos indirectos pequeños referenciados desde un arreglo del catálogo, `useObjectStreams: false` → > 1 MB; el escalón 1 lo baja (object streams).
- **F-escaneo:** página pequeña (p. ej. 300×300 pt) con un XObject de imagen `DeviceGray` 8 bpc de 1200×1200 px de `crypto.randomBytes`, sin texto. La imagen se arma a bajo nivel (`doc.context.stream(bytes, { Type: 'XObject', Subtype: 'Image', Width, Height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })` + `page.node.setXObject` + `pushOperators(pushGraphicsState(), concatTransformationMatrix(...), drawObject(name), popGraphicsState())`), porque pdf-lib no codifica PNG y no hay encoder en el repo. ~1,4 MB; a 150 dpi queda en ~625×625 px JPEG → muy por debajo de 1 MB.
- **F-firmado:** F-escaneo con `/ByteRange [0 0 0 0]` en un diccionario `/Sig` añadido al contexto. **F-cifrado:** buffer con `/Encrypt` inyectado en el trailer (basta el escaneo crudo).

Casos (unit, sin poppler, con `deps.ejecutar` inyectado):
1. `NO_PDF` (JPEG/PNG por magic bytes aunque el `mimetype` diga pdf) y `BAJO_META` → mismo `Buffer` (`equals`), `ejecutar` nunca llamado.
2. `FIRMADO` / `CIFRADO` > 1 MB → mismo buffer byte a byte, `ejecutar` nunca llamado.
3. `pdftotext` falla (`ENOENT` y exit ≠ 0) → original, `SIN_POPPLER`/`ERROR`, **nunca** escalón 3.
4. `ejecutar` que no resuelve + `tiempoLimiteMs` pequeño → original, `TIEMPO`.
5. Escalón 1 con texto distinto (ejecutar devuelve otro texto la segunda vez) → candidato descartado, `VERIFICACION` o `SIN_MEJORA`, nunca devuelve el reescrito.
6. Más de `MAX_PAGINAS` → `LIMITE_PAGINAS`.

Casos (integración, poppler real):
7. F-texto-grande → `escalon !== 3`, `bytesDespues <= bytesAntes`, y `pdftotext` del resultado idéntico al del original.
8. F-texto-objetos → `escalon === 1`, `bytesDespues < bytesAntes`, texto idéntico, mismas páginas.
9. F-escaneo → `escalon === 3`, `bytesDespues <= META_BYTES`, mismas páginas y mismo tamaño de página.
10. Temporales: tras 9 y tras un fallo forzado de `pdftoppm`, no queda ningún `flito-comp-*` en `os.tmpdir()`.
11. Semáforo: 4 llamadas simultáneas con un `ejecutar` que cuenta activos → máximo observado = 2.

Gating de la integración: `const hayPoppler = spawnSync('pdftotext', ['-v']).status === 0`. `describe.skipIf(!hayPoppler)` **solo fuera de CI**; con `process.env.CI` y sin poppler el test **falla** (no se salta en verde — ver la lección de los tests de base que se saltan en CI).

### Mutantes para `qa-agent` B (tope 3, comando P1)

| # | Mutación | Debe matarla |
|---|---|---|
| M1 | En `comprimirComprobante`, quitar la condición `!tieneTexto` antes del escalón 3 | Caso 7 (F-texto-grande saldría con `escalon === 3`) |
| M2 | En `pareceFirmado`, dejar solo `/Sig` fuera o devolver `false` (quitar el chequeo `/ByteRange`) | Caso 2 con F-firmado (el buffer dejaría de ser idéntico) |
| M3 | En `archivar`, devolver `tamanoBytes: archivo.size` (o calcular el hash del buffer comprimido) | Caso de `flito-recibos.test.ts` / `flito-recibo-caja.test.ts` que aserta `tamanoBytes` y `hash` |

## ADR: no aplica

Extiende `flito-impuestos` con un helper interno, reutiliza poppler y pdf-lib ya presentes, sin tabla, sin endpoint, sin contrato en `shared-types`. La decisión de producto (escalones, sin qpdf/Ghostscript) ya la tomó David.

## Riesgo de CI

`.github/workflows/ci.yml` corre en `ubuntu-latest` y **no instala poppler** en ningún paso (los tests actuales mockean todo). No verifiqué si la imagen del runner lo trae de serie, y el diseño no debe apoyarse en eso. Por eso: paso explícito `apt-get install poppler-utils` en el job `build + test` (~10-20 s) y, en el test, fallo duro si `CI` y no hay binarios. Alternativa si se rechaza tocar `ci.yml` en una HU: dejar solo los unit (1-6, 11) en CI, y los de integración como `skipIf` con la cobertura declarada en el PR. **No recomendada**: M1 solo muere en la integración.

## Notas operativas

**backend-agent**
- No reutilices `textoPdf()` para decidir el escalón 3 (se traga el error). Llama a `ejecutarBinario` y distingue `ENOENT` del resto.
- Antes de exportar `ejecutar`, busca `vi.mock(` sobre `flito-ocr-local` en `__tests__` (solo en los tests de recibos/recibo-caja que vas a correr): un mock de fábrica sin `ejecutarBinario` rompería el import del módulo nuevo. Si existe, amplía la fábrica o mockea `flito-recibos.compresion.js` en esos specs.
- pdf-lib bloquea el event loop mientras carga/guarda (cientos de ms con 15 MB). Está aceptado, con el semáforo en 2; no lo muevas a `worker_threads` en esta HU.
- `db-review-agent`: no aplica (sin `schema.ts` ni migración). `security-agent`: aplica en diff-scoped (spawn de binarios con entrada del usuario, temporales con PII, `ci.yml`).
- Presupuesto P8: el prompt trae paths y líneas; no hace falta explorar más allá de los 3 archivos de producción y los 2 specs.

**frontend-agent:** no aplica (sin cambio visible; el tamaño que muestra el detalle, si lo hay, pasa a ser el del archivo guardado).

**Riesgos abiertos**
- Un PDF firmado cuya firma solo aparezca dentro de un object stream y **sin** `/AcroForm /SigFlags` pasaría como no firmado. Es un caso degenerado (un firmador real deja `SigFlags`); se acepta.
- El escalón 3 pierde calidad visual (JPEG q75 a 150 dpi) sobre un escaneo que ya no tenía texto. Sin impacto en OCR ni en el hash: los dos corrieron sobre el original.
