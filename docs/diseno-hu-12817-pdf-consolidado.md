# Diseño slim — HU #12817: un PDF consolidado por registro, con nombre `PLACA.pdf`

Feature #12814 · módulos FLITO `flito-tramites` y `flito-impuestos` más el transversal
`apps/api/src/shared/soportes/soportes-zip.ts`. No toca módulos legacy (`tramites`, `soat`, `impuestos` sin prefijo).
Sin dependencia nueva (`pdf-lib` ya está en `apps/api`), sin migración y sin endpoint nuevo.

## Patrón reutilizado

- `apps/api/src/shared/soportes/soportes-zip.ts`: se conserva la frontera por módulo (`RegistroZip[]`) y el
  orden «resolver → 409/422 → rastro PII → cabeceras → archivo». `resolverEntradasZip` **no cambia de
  contrato**: sigue devolviendo una entrada por documento, ya ordenada (registro por `createdAt, id`, tipo por
  `ORDEN_TIPOS_SOPORTE_ZIP`, soportes por `subidoEn, id`) y con el presupuesto de bytes comprobado
  sobre los documentos fuente (AC8).
- `pdf-lib`: mismo uso que `apps/api/src/modules/rndc/pdf.service.ts` (crear, `copyPages`, `save`).
- Archivo temporal por petición: patrón existente en `apps/api/src/modules/flito-ocr/flito-ocr-local.ts:71`
  (`path.join(os.tmpdir(), \`…-${randomUUID()}\`)`).

## Decisión 1 — dónde y cuándo se consolida

Hay tres restricciones medidas en el repo que descartan las opciones (a) y (b) del pedido:

| Dato | Fuente |
|---|---|
| `FLITO_ZIP_SOPORTES_MAX_BYTES` por defecto = 1 GiB | `apps/api/src/config/env.ts:213` |
| Peor caso legal = 300 registros × ~3 MiB ≈ 900 MB | cabecera de `__tests__/services/flito-soportes-zip-coste.test.ts` |
| Techo del proceso: PM2 `max_memory_restart: '512M'`; presupuesto para el ZIP = 262 MB | `ecosystem.config.cjs:22`, `helpers/export-coste.js` |

- **(a) Todo en memoria antes del primer byte:** el pico se acerca al presupuesto de bytes (≈ 900 MB en el
  peor caso legal). Los `Buffer` viven fuera del heap de V8, así que `--max-old-space-size` no los frena, pero
  el RSS sí cuenta: PM2 reinicia el proceso a los 512 MB. **Descartada.**
- **(b) Conservar los `PDFDocument` o buffers ya validados y consolidar al emitir:** retiene lo mismo que (a),
  y además el grafo de objetos de pdf-lib ocupa el heap. **Descartada.**
- **(c) RECOMENDADA — consolidar registro por registro antes del primer byte y volcar a disco:**
  1. Se leen los documentos del registro (MinIO en stream, o `fetch` a FLIT), cada uno a un `Buffer`.
  2. Se clasifica cada documento: PDF, JPEG, PNG o ilegible.
  3. Se arma un `PDFDocument` con todas las páginas y se guarda en `<tmp>/flito-zip-<uuid>/<n>.pdf`.
  4. Se sueltan los buffers y el documento de pdf-lib antes de pasar al siguiente registro.
  5. Se conserva solo `{ ruta, bytes, nombre }` de cada PDF y la cuenta de `omitidos`.
  6. Si no queda ningún PDF → `ZipSinSoportesError` (el mismo 409).
  7. Rastro PII y cabeceras, que ya incluyen `X-Soportes-Omitidos`.
  8. `archiver` recibe `fs.createReadStream(ruta)` de cada PDF.
  9. `finally` → `fs.rm(dir, { recursive: true, force: true })`.

  - **Pico de memoria (estimación que hay que medir):** documentos de un registro (≤ 3 × cupo, unos 15 MB)
    más el grafo de pdf-lib (2–3 veces esa cifra), multiplicado por la concurrencia. Con **concurrencia 2**
    da unos 60–100 MB, dentro de los 262 MB. No crece con el tamaño del lote.
  - **Disco:** como mucho `FLITO_ZIP_SOPORTES_MAX_BYTES` por petición en curso. El limitador es 5 por
    minuto por usuario.
  - **Cabeceras exactas:** todo lo que se cuenta en `X-Soportes-*` ya está escrito en disco antes del
    primer byte. En la emisión solo se leen archivos locales, así que el `catch` de «documento omitido»
    de `emitirZipSoportes` deja de ser un camino normal en las superficies que consolidan.

Encaje con el orden de las rutas (Trámites e Impuestos):

```
Validar (Zod) → comprobarTopeRegistrosZip → frontera (registrosZip*) → resolverEntradasZip (409 sin nada / 422 presupuesto fuente)
  → consolidarPorRegistro (lee + valida + vuelca; 409 si nada legible; 422 si los bytes REALES leídos superan el tope)
  → rastro PII (filas = PDFs consolidados) + audit → emitirZipSoportes(…, { omitidos }) → finally: limpiar tmp
```

El 422 por bytes reales es una guarda nueva. Hoy la factura de FLIT cuenta con su cupo declarado y su
tamaño real puede ser mayor. Al leerla entera, el total real se suma y se corta en el mismo tope. El
límite no cambia (AC8). Solo deja de poder sobrepasarse sin que nadie lo vea.

**Qué superficie consolida:** se decide por superficie y no por el número de `tipos` pedidos. Trámites e
Impuestos consolidan siempre, aunque se pida un solo tipo: el nombre `PLACA.pdf` y la cuenta de ilegibles
se comportan igual pase lo que pase. SOAT no consolida y su ruta queda igual, salvo el nombre (AC6).
Si el PO quiere que un pedido de un solo tipo en Impuestos no consolide, basta un `if` en la ruta;
queda como pregunta abierta, no bloquea.

## Decisión 2 — la forma del API interno

Va en un **archivo nuevo**, `apps/api/src/shared/soportes/soportes-zip-consolidar.ts`, que depende de
`soportes-zip.ts` y nunca al revés. Así pdf-lib no entra en la ruta de SOAT y se puede probar sin HTTP.

```ts
// soportes-zip.ts — cambios en lo que ya existe
export interface EntradaZip {
  nombreBase: string;          // se conserva (lo usa SOAT)
  nombreRegistro: string;      // NUEVO: la placa normalizada SIN sufijo; es la clave para volver a nombrar al consolidar
  tipo: TipoSoporteZip | 'consolidado';   // 'consolidado' solo para el log de la emisión
  registroId: string;
  bytes: number;
  abrir: () => Promise<{ stream: Readable; extension: string }>;
}
export function nombrePorPlaca(placa: string | null): string;       // sustituye a nombrePlacaOrganismo (AC6)
export function clasificarBytes(buf: Buffer): 'pdf' | 'jpg' | 'png' | null;  // SIN la caída a pdf de tipoPorBytes
export async function emitirZipSoportes(
  res: Response, entradas: EntradaZip[], ahora?: Date, aviso?: { incluidos: number; omitidos: number },
): Promise<number>;           // con aviso: Incluidos = aviso.incluidos (y no entradas.length) + Omitidos = aviso.omitidos

// soportes-zip-consolidar.ts
export interface ZipConsolidado {
  entradas: EntradaZip[];   // una por registro: nombreBase = nombrePorPlaca + desempate -2/-3, abrir = createReadStream
  incluidos: number;        // documentos legibles consolidados → X-Soportes-Incluidos
  omitidos: number;         // documentos ilegibles o que fallaron al leerse (FLIT caído, MinIO) → X-Soportes-Omitidos
  limpiar: () => Promise<void>;
}
export async function consolidarPorRegistro(entradas: EntradaZip[]): Promise<ZipConsolidado>;
/** Pura, sin E/S: la parte que prueba el AC1–AC5 sin HTTP. */
export async function consolidarPdf(docs: Buffer[]): Promise<{ pdf: Uint8Array | null; omitidos: number }>;
```

- **Agrupar:** la entrada ya viene ordenada, así que se agrupa por `registroId` de forma consecutiva y no hace falta reordenar.
- **Nombrar:** se reutiliza el mismo mecanismo de `nombrar()` (hoy es un cierre dentro de `resolverEntradasZip`).
  Se saca a una función exportada `desempatador()` para que lo usen los dos archivos. El orden del desempate es
  el de los registros, así que dos trámites con la misma placa dan `ABC123.pdf` y `ABC123-2.pdf`, siempre igual.
  `SIN-PLACA` se conserva.
- **`consolidarPdf`:**
  - Un PDF se carga con `PDFDocument.load(buf)` **sin** `ignoreEncryption`, porque un PDF cifrado copiado
    sale en blanco. Luego `copyPages(src, src.getPageIndices())`.
  - JPEG o PNG va con `embedJpg`/`embedPng` en **una página A4 con la orientación de la imagen**, escalada
    para caber sin deformarse y centrada (AC4).
  - Si `load` lanza, si `clasificarBytes` da `null` o si el PDF tiene 0 páginas: `omitidos += 1` y no se
    añade página (AC3/AC5).
  - Si al final hay 0 páginas → `pdf: null`, y el registro no aporta entrada.
- **Concurrencia 2** sobre registros, con un pool escrito a mano de unas 15 líneas (sin `p-limit`). Los
  resultados se guardan por índice para que el nombre no dependa de quién termina antes. Entre documentos
  va un `await new Promise(setImmediate)`, porque pdf-lib es síncrono y bloquea el event loop mientras
  carga (lo mide la suite de coste).
- **Si todo falla:** `entradas` vacío tras consolidar → `limpiar()` y `throw new ZipSinSoportesError()`.
- **Cabeceras:**
  - `CABECERAS_ZIP_SOPORTES` hoy solo tiene `incluidos` (documentos) y `registros`. **No existe un
    «aviso parcial» de omitidos**, así que se crea: `omitidos: 'X-Soportes-Omitidos'` en
    `packages/shared-types/src/flito-estados.ts:470`.
  - Se añade a `exposedHeaders` en `apps/api/src/app.ts:187`. Sin eso el navegador no la ve.
  - `incluidos` **conserva su significado de hoy**: cuántos DOCUMENTOS lleva el archivo. En las superficies
    que consolidan cuenta los documentos **legibles metidos dentro** de los PDFs, y ya no las entradas del ZIP.
    Así no iguala a `registros` y la semántica del JSDoc aguanta sin cambios. Además la cifra ya no sale
    inflada: hoy se fija antes de abrir nada y los fallos del streaming se omiten después (defecto visto por QA).
  - `registros` sigue siendo el número de registros que aportaron algo.

## Decisión 3 — la factura de venta de FLIT

Hoy `abrirFacturaFlit()` hace `getFlitAdapter().obtenerUrlFactura(id)` y luego `fetch(url)`, en **stream**
y **durante la emisión**, después del primer byte. Mira los primeros bytes (`asomarse`) solo para sacar la
extensión. Con la consolidación:

- Se lee **entera y antes del primer byte**, a través del mismo `abrir()`. Después
  `consolidarPorRegistro` junta el stream en un `Buffer`, con tope por documento = `FLITO_ZIP_FACTURA_CUPO_BYTES`
  × 2 como defensa. Si FLIT falla (`url` nula, `!r.ok`, red), cuenta como `omitido` en la cabecera.
  Hoy ese fallo solo deja una línea de log después de las cabeceras.
- **Coste:** todas las llamadas a FLIT pasan antes del primer byte, así que el TTFB crece con el lote.
  El cliente web tiene 90 s por defecto (`apps/web/src/lib/api.ts:15`) y nginx está en 900 s. Ver Riesgos R2.
- El ZIP de SOAT no llama a FLIT y no cambia.

## Contrato delta

- `POST /api/flito/tramites/soportes/zip` y `POST /api/flito/impuestos/soportes/zip`: el cuerpo no cambia.
  El ZIP lleva una entrada `PLACA[-n].pdf` por registro. `X-Soportes-Incluidos` cuenta los documentos
  legibles consolidados. Cabecera nueva `X-Soportes-Omitidos: <n>`, que siempre va presente en estas dos
  rutas y vale `0` si no se omitió nada. Los mismos 400, 409 y 422 con su `codigo`.
- `POST /api/flito/soat/soportes/zip`: igual que hoy, salvo que las entradas se llaman `PLACA[-n].<ext>`, sin organismo.
- `GET …/impuestos/…/factura-venta` (individual, `flito-impuestos.routes.ts:160`): `filename="PLACA.<ext>"`.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/shared/soportes/soportes-zip-consolidar.ts` | **Nuevo**: `consolidarPorRegistro`, `consolidarPdf`, pool, volcado a tmp y `limpiar` |
| `apps/api/src/shared/soportes/soportes-zip.ts` | `nombrePorPlaca` (quita el import de `organismoParaExport`, que ya no se usa); `nombreRegistro` en `EntradaZip`; `desempatador()` exportado; `clasificarBytes`; `aviso` en `emitirZipSoportes`; cabecera del archivo con el nuevo paso del orden |
| `apps/api/src/modules/flito-tramites/flito-tramites.routes.ts` (~l.130) | Insertar `consolidarPorRegistro`, `try/finally limpiar`, `filas` = PDFs, pasar `{ omitidos }` |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` (~l.160 y ~l.200) | Lo mismo; y en la factura individual, `nombrePorPlaca(factura.placa)` |
| `apps/api/src/modules/flito-soat/flito-soat.routes.ts` | Nada, salvo que importe `nombrePlacaOrganismo` (hoy no lo importa; comprobar con grep) |
| `apps/api/src/app.ts:187` | `exposedHeaders` + `CABECERAS_ZIP_SOPORTES.omitidos` |
| `packages/shared-types/src/flito-estados.ts:470` | `omitidos: 'X-Soportes-Omitidos'`; JSDoc de `incluidos`. Cambio aditivo; grep obligatorio en `apps/web` (regla 7) |
| `apps/web/src/components/flito/DescargarSoportesZip.tsx` (~l.170) | **frontend-agent**: leer `omitidos` y añadir la frase al aviso parcial («N documentos no se pudieron leer y quedaron fuera») |

`soportes-zip.ts` mide hoy **324 líneas de código** (`eslint` sin líneas en blanco ni comentarios, medido en
el worktree), lejos de 800. No hace falta partirlo por tamaño: el archivo nuevo se justifica por cohesión,
para que pdf-lib quede fuera de SOAT y se pueda probar la función pura.

### Tests P1

- **Nuevo** `apps/api/__tests__/services/flito-soportes-zip-consolidar.test.ts`, que prueba `consolidarPdf` sin mocks de pdf-lib:
  - Fixtures reales generados en el test con `PDFDocument.create()`. Cada tipo lleva un **tamaño de página
    distinto** que funciona como marca: factura de 3 páginas de 100×100, recibo de 1 página de 200×200, SOAT de
    2 páginas de 300×300. Para las imágenes, constantes base64 de un PNG y un JPEG de 1×1.
  - AC1/AC2: `PDFDocument.load(resultado).getPages().map(p => p.getSize().width)` debe ser igual a
    `[100,100,100,200,300,300]`. El orden y el número de páginas se leen del PDF real.
  - AC3: sin recibo da `[100,100,100,300,300]`, sin ninguna página de más.
  - AC4: PNG da 1 página A4.
  - AC5: `Buffer.from('basura')` y un `%PDF-` truncado dan `omitidos: 2` y el resto consolidado. Si todo es ilegible → `pdf: null`.
- **Extender** `apps/api/__tests__/services/flito-soportes-zip.test.ts` (sin límite de líneas):
  - `respuestaFlit()` (l.151) y los contenidos de `getEntityDocumentStream` pasan a **PDFs reales**. Con el
    texto falso actual `'%PDF-1.4 factura de venta'` todo saldría como ilegible y el AC4 de Trámites daría 409.
  - Reescribir el bloque AC4 de Trámites (l.517 «`-2` y `-3`» → una sola entrada `PLACA.pdf` de 6 páginas, leída con JSZip y pdf-lib).
  - Reescribir el bloque AC5 de nombres (l.574–620 → `PLACA.pdf`). El test de l.609 sobre `organismoParaExport` pasa a decir que ya no se importa.
  - Reescribir el desempate (l.622–750): `-2` entre **registros** con la misma placa en Trámites; entre documentos solo en SOAT.
  - **Retirar a propósito** el test de l.556 («la factura de FLIT viaja en STREAMING»), porque contradice el
    AC5 en estas superficies. Se sustituye por uno nuevo: «FLIT caído → `X-Soportes-Omitidos: 1` y el resto se
    entrega», que comprueba que la cabecera está puesta antes del cuerpo.
  - Nuevos:
    - Todo ilegible → 409 sin `Content-Disposition`, sin `archiver` y sin rastro PII.
    - SOAT no consolida: dos `factura_soat` → dos entradas.
    - El directorio tmp queda borrado tras el 200 y tras el 409.
    - 422 cuando los bytes **reales** de FLIT superan el tope.
- `apps/api/__tests__/services/flito-factura-venta.test.ts`: el `filename` de la factura individual pasa a `PLACA.<ext>`.
- `apps/api/__tests__/services/flito-soportes-zip-coste.test.ts`: **no** es P1 por defecto porque es lento.
  Ver R1: el hilo decide si se corre una vez con la ruta consolidada.

## ADR: no aplica

Extiende el módulo transversal existente sin tabla, sin contrato público nuevo más allá de una cabecera
aditiva, y sin dependencia. El volcado a `os.tmpdir()` ya tiene precedente en `flito-ocr-local.ts`.

## Riesgos y lo que queda por decidir

- **R1 — memoria y event loop (a medir):** la estimación de 60–100 MB con concurrencia 2 no está medida.
  Se recomienda correr una vez `flito-soportes-zip-coste.test.ts` con el peor caso contra la ruta de
  Trámites consolidada, en el gate B o en el backend, y declarar RSS, lag y TTFB. Si el RSS pasa de 262 MB,
  se baja la concurrencia a 1.
- **R2 — TTFB:** el trabajo de FLIT, MinIO y pdf-lib pasa entero antes del primer byte. El peor caso legal
  (≈900 MB y 300 llamadas a FLIT) puede pasar de los 90 s del cliente web.
  - **frontend-agent** comprueba qué `timeoutMs` usa `downloadPostNamed`. Si usa el de defecto, lo sube
    para el ZIP igual que `postConTimeout`, por debajo de los 900 s de nginx.
  - Si la medida de R1 da un TTFB inaceptable, el remedio es de producto: un tope menor para las
    superficies que consolidan, o un ZIP asíncrono. **Decisión humana**, fuera de esta HU.
- **R3 — PDFs cifrados:** muchos recibos oficiales vienen con contraseña de propietario, solo con permisos.
  pdf-lib sin `ignoreEncryption` los rechaza, así que saldrían como **omitidos** aunque se ven bien en
  cualquier lector.
  - **Pregunta al PO/QA:** ¿se acepta la omisión avisada, o hay que incluirlos igual? Incluirlos exigiría
    otra librería o un paso de descifrado, que sería una dependencia nueva y no se propone aquí.
  - El backend debe contar los cifrados aparte en el log, sin PII, para tener la cifra real en DEV.
- **R4 — disco:** una petición en curso ocupa hasta 1 GiB en el `/tmp` del contenedor. El `finally` y un
  `res.on('close')` cubren el aborto del cliente. **devops-agent** comprueba el espacio libre del volumen
  de la api en DEV y PDN.
- **R5 — `X-Soportes-Incluidos` en SOAT, que sigue inflada:** SOAT no consolida, así que allí la cifra se
  sigue fijando antes de abrir y un fallo de MinIO durante el streaming no la corrige. Es deuda que ya existía.
  Va como **Nota**, fuera de esta HU (P9): la web no lee esa cabecera.

## Notas operativas

- **backend-agent:**
  - Nada de `ignoreEncryption: true`.
  - No reutilizar `tipoPorBytes` para clasificar, porque su caída a `pdf` convertiría basura en «PDF» y la
    omitiría tarde en `load`. El resultado sería el mismo, pero es menos legible.
  - La cuenta de omitidos se loguea sin placa: solo `{ omitidos, registros }`.
  - Tests P1: los tres archivos de arriba.
- **frontend-agent:**
  - Una cabecera más en el lector de `descargarSoportes` y la frase en el aviso parcial.
  - Los 4 estados ya existen.
  - Comprobar el timeout de `downloadPostNamed` (R2).
  - Ficha de ayuda: `flit-ayuda-flito` si Trámites o Impuestos tienen ficha.

## Respuestas a las preguntas de QA (TCs en el scratchpad del hilo, `tcs-12817.md`)

- **Q1 — un registro con UN solo documento (p. ej. la factura en JPEG):** **sí**, sale como `PLACA.pdf`
  con la imagen convertida a una página A4. La razón es que la consolidación se decide por superficie
  (Trámites e Impuestos) y no por el número de documentos. Una excepción «si hay uno, déjalo como venga»
  tendría estos costes:
  - devolvería `PLACA.jpg` y rompería el AC6, que pide el mismo nombre y el mismo formato para todos;
  - obligaría a validar ese documento por otro camino, y el AC5 exige que cada documento pase por la misma
    detección de ilegibles antes de contarlo;
  - añadiría una rama que el test tendría que cubrir aparte.
- **Q2 — cómo se avisa del omitido:**
  - Se **reutiliza** `X-Soportes-Incluidos` sin cambiar su significado («cuántos DOCUMENTOS lleva el
    archivo»): cuenta los documentos legibles dentro de los PDFs, así que no iguala a `registros`.
  - **Esa cabecera no basta para avisar.** La web no sabe cuántos documentos se pidieron: un registro puede
    tener 0, 1, 2 o más recibos o comprobantes, así que no puede restar. Tampoco sirve `registros`, porque un
    registro que pierde uno de sus tres documentos sigue aportando y el omitido no se vería.
  - Por eso se añade **`X-Soportes-Omitidos`**: una clave aditiva en `CABECERAS_ZIP_SOPORTES` más la entrada
    en `exposedHeaders` de `app.ts:187`. Sin la entrada en `exposedHeaders`, el navegador la oculta.
  - Es el mínimo que permite cumplir el AC5 sin que la web adivine.
- **Q3 — validar antes del primer byte sin romper el test de streaming ni el presupuesto del Bug #12644:**
  - **El presupuesto de memoria se respeta** con la opción (c): se consolida registro a registro y se vuelca
    a `os.tmpdir()`. El pico está acotado por la concurrencia (≈ 60–100 MB estimados, a medir, ver R1), no
    por el lote. Las opciones (a) y (b) llegarían a unos 900 MB contra un techo de PM2 de 512 MB.
  - **El test de l.556 NO se puede conservar tal cual** en Trámites e Impuestos, porque pide justo lo que
    el AC5 prohíbe: sacar la factura de FLIT después del primer byte sin saber si es legible.
  - Lo que ese test protegía era que no se bufferizara todo el lote en memoria, y eso sigue garantizado por
    otra vía: el buffer es por documento y dura lo que tarda en consolidarse su registro.
  - Se retira con un comentario que cita esta HU y se sustituye por dos tests:
    - FLIT caído → `X-Soportes-Omitidos: 1`, puesta antes del cuerpo;
    - un espía de `consolidarPdf` demuestra que no hay más de 2 registros a la vez en memoria (el contador
      del pool).
  - La lectura de FLIT se hace con `fetch` + stream juntado a `Buffer` con tope por documento, sin
    `arrayBuffer()` sin límite.
- **Q4 — un PDF cifrado ¿cuenta como dañado?** **Sí: es un omitido avisado.** `PDFDocument.load` sin
  `ignoreEncryption` lanza `EncryptedPDFError`. Con `ignoreEncryption: true` las páginas copiadas salen en
  blanco o ilegibles, y eso sería la «página vacía» que el AC3 prohíbe, peor que avisar. Queda la pregunta de
  producto del R3: si los recibos oficiales con contraseña de propietario son frecuentes, el PO puede pedir
  incluirlos, y eso requiere una dependencia nueva con su propio diseño.
- **Defecto de la cifra inflada (visto por QA):** **queda corregido en Trámites e Impuestos**. Las dos
  cabeceras salen de `consolidarPorRegistro`, que ya leyó y validó todo. En la emisión solo se leen archivos
  locales ya escritos, así que el `catch` de omitir durante el streaming deja de ser un camino normal.
  En SOAT sigue igual (Nota R5).
- **Fixtures:** confirmado. `respuestaFlit()` (l.151) y los contenidos del mock de
  `getEntityDocumentStream` (texto `'%PDF-1.4 …'`) pasan a ser **PDFs reales** generados con
  `PDFDocument.create()`, con el tamaño de página como marca de cada tipo. Si no se cambian, todos los
  tests de Trámites e Impuestos darían 409 por ilegibles.
