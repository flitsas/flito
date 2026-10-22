# Diseño slim — HU #13205 · ZIP de certificados RUNT con listado de omitidos

Feature #12954 · Épica #12683 · módulo **`flito-impuestos`** (no el legacy `liquidacion`/`soat`).
Estado: **Propuesto** (diseño slim, sin ADR). Base: rama apilada sobre la HU #13204 (`0fc7a4eb`),
que ya trae `extraerRegistroRunt`, `CertificacionConRegistro`, `CAMPOS_PII_CERTIFICADO` y
`construirCertificadoPdf({ registroRunt })` (diseño: `docs/diseno/hu-13204-certificado-runt-datos-registro.md`).

## Patrón reutilizado

| Pieza | Vecino |
|---|---|
| Tope 300 antes de tocar la base (400 con `codigo`) | `apps/api/src/shared/soportes/soportes-zip.ts` — `comprobarTopeRegistrosZip`, `ZipDemasiadosRegistrosError`, `ZIP_SOPORTES_MAX_REGISTROS` (`shared-types/flito-estados.ts:504`) |
| Nombre por placa y desempate `-2`/`-3` | `soportes-zip.ts` — `nombrePorPlaca`, `desempatador()` (una instancia por archivo, orden de servidor) |
| Familia de errores del ZIP (`status` + `codigo` del error, un solo `instanceof`) | `soportes-zip.ts` — `ZipError` |
| Frontera en LOTE (una consulta, sin N+1) | `flito-impuestos.service.ts:340` — `registrosZipImpuestos` (`condicionesColaImpuestos(ctx, { estados: ESTADOS_IMPUESTO_TODOS })` + `conJoinsColaImpuestos` + `inArray`; `conds === null` → nada) |
| Mapeo fila → `CertificacionConRegistro` | `certificacion.service.ts:445` — `certificacionVigente()` |
| Orden «resolver → 409 → PII + audit → cabeceras + pipe» | `POST /soportes/zip` en `flito-impuestos.routes.ts:206-245` |
| Sub-router con `contextoImpuesto` inyectado | `flito-impuestos.analisis.routes.ts` / `flito-impuestos.direccion.routes.ts`, montados en `routes.ts:53-54` |
| Registro PII de un archivo | `flito-impuestos.pii.ts` — `registrarAccesoImpuesto` con `archivo` + `campos` |

Sin tabla, sin migración, sin dependencia nueva (`archiver`, `express-rate-limit`, `pdf-lib` ya están).

## Contrato delta

```
POST /api/flito/impuestos/certificados/zip        authMiddleware (heredado) · exigirFuncion('impuestos.certificado.descargar') · zipCertificadosLimiter
Body  { ids: uuid[] }  (.strict(), min 1, SIN .max() — el tope lo dice comprobarTopeRegistrosZip con codigo)
200   application/zip  certificados-runt_YYYYMMDD-HHmm.zip (sin placa en el nombre externo)
        <PLACA>.pdf | <PLACA>-2.pdf | SIN-PLACA-<idFlit>.pdf  (+ omitidos.csv si hay omitidos)
        X-Certificados-Omitidos: <n>   (siempre, también 0)
400   { error: 'Datos inválidos', details }            cuerpo mal formado (Zod)
400   { error: 'Solo se pueden descargar … de 300 registros …', codigo: 'zip_demasiados_registros' }  antes de ctx y de la base
403   cuerpo de exigirFuncion
409   { error, codigo: 'zip_sin_certificados', omitidos: CertificadoOmitido[] }   todos omitidos; sin ZIP
429   { error: 'Demasiadas descargas seguidas, espera 1 minuto' }
CertificadoOmitido = { identificador: string; causa: 'sin_certificacion_vigente' | 'no_disponible' }
```

`codigo` (no `code`) porque es la familia ZIP; el GET individual (`code: 'sin_certificacion'`) no se toca.

## Decisiones

**D1 · Lectura en lote con frontera — 2 consultas, cero N+1.** Nueva
`certificacionesVigentesLoteConAcceso(ids, ctx)` en `certificacion.service.ts`:
1. Frontera: exactamente el `where` de `registrosZipImpuestos` (`conds` + `inArray(flitoImpuestos.id, idsUnicos)`), proyectando `id`, `createdAt`, `placa: vehicles.plate`, `idFlit: flitoTramites.idFlit`. `conds === null` → `[]` **sin consultar**. Si `condicionesColaImpuestos` / `conJoinsColaImpuestos` no están exportadas, exportarlas (no copiar la frontera: es la vía por la que un gestor descarga lo de otro).
2. Solo si hay autorizados: `db.select().from(flitoImpuestoCertificaciones).where(and(inArray(impuestoId, autorizados), eq(vigente, true)))` — el índice único parcial garantiza ≤1 por impuesto.
El mapeo fila → `CertificacionConRegistro` se extrae a una función privada `aCertificacion(row)` que usan `certificacionVigente()` y el lote (una sola lista blanca; el `snapshot_runt` crudo no sale del servicio). Devuelve `{ impuestoId, placa, idFlit, createdAt, cert | null }[]` solo de los autorizados; «no disponible» = pedidos − devueltos, calculado fuera. **El orden se hace en JS** (`createdAt ASC, impuestoId ASC`), no con `orderBy`: el mock de tests ignora `orderBy` y el desempate tiene que ser comprobable.

**D2 · PDFs secuenciales, todos antes del primer byte.** pdf-lib es CPU en el hilo principal: `conConcurrencia` no paraleliza nada y solo sube el pico de heap. Bucle secuencial con `await setImmediate()` (`node:timers/promises`) entre PDF para ceder el event loop. Se generan TODOS a `Buffer` antes de cabeceras porque AC8 exige `filas = incluidos` antes del primer byte: si se generaran en streaming, un fallo a mitad dejaría el registro PII mintiendo. Un `construirCertificadoPdf` que lance → la petición entera cae en `handleError` (500) **sin haber emitido nada**; no se inventa una cuarta causa. `generadoEn` = un único `new Date()` para todo el lote. Nada a disco (a diferencia de `soportes-zip-consolidar.ts`): AC4 «sin guardar nada».

**D3 · Constructor del ZIP: módulo propio, `soportes-zip` casi intacto.** `emitirZipSoportes` está atado a `EntradaZip` (apertura en streaming, `CABECERAS_ZIP_SOPORTES`, nombre `soportes_…`); forzarlo a buffers en memoria + CSV lo complicaría para tres superficies. Nuevo `apps/api/src/modules/flito-impuestos/certificados-zip.ts` con `archiver('zip', { zlib: { level: 0 } })`, `archive.append(buffer, { name })` por PDF + CSV, `finalize()`. Único cambio en `soportes-zip.ts`: `nombreArchivoZipSoportes(ahora, prefijo = 'soportes')` (parámetro con default → cero cambio para los llamadores actuales) para reutilizar el sello en hora de Colombia: `certificados-runt_YYYYMMDD-HHmm.zip`.
Nombres: `base = nombrePorPlaca(placa)`; si da `'SIN-PLACA'` → `` `SIN-PLACA-${idFlitSeguro}` `` con `idFlitSeguro = idFlit.replace(/[^A-Za-z0-9_-]/g, '')` (va a un nombre de fichero). Todo pasa por UN `desempatador()` en orden de servidor, luego `+ '.pdf'`. Una placa normalizada nunca lleva `-`, así que `SIN-PLACA-…` no colisiona con una placa real. La placa del nombre es `vehicles.plate` (dato actual de FLITO, mismo nombre que el ZIP de soportes con el que Operaciones concilia), no `placaConsultada`.

**D4 · CSV `omitidos.csv`.** UTF-8 **con BOM** (`﻿`, Excel lo abre con tildes), separador `;` (Excel es-CO usa `;` como separador de lista), fin de línea `\r\n`. Cabecera `Identificador;Causa`. Escape RFC 4180: si el valor contiene `;`, `"`, `\r` o `\n` → entre comillas con `"` duplicadas. Anti inyección de fórmulas (OWASP CSV injection): si empieza por `= + - @ \t \r` → prefijo `'`. Textos de causa: «sin certificación vigente», «no disponible» (literales de UI en el backend, mapeados desde el código). Identificador: placa (`vehicles.plate`) o, sin placa, el `idFlit` para «sin certificación vigente»; **el uuid enviado** para «no disponible» (ver R1). Orden: primero los autorizados en orden de servidor, luego los no disponibles por uuid ASC (determinista). Sin omitidos → no se incluye el CSV.

**D5 · Limitador propio.** `zipCertificadosLimiter` = `rateLimit({ windowMs: 60_000, max: 5, keyGenerator: userOrIpKey('flito-certificados-zip'), store: makeStore('rl:flito-certificados-zip:'), standardHeaders: true, legacyHeaders: false, message })`, UNA instancia de módulo en el archivo de rutas nuevo. No `zipSoportesLimiter`: raciona otro recurso (CPU de pdf-lib vs I/O de MinIO/FLIT) y compartir bolsa haría que descargar certificados gastara la cuota de soportes. Orden de middlewares: `exigirFuncion` → limiter (un 403 no consume cuota, igual que soportes).

**D6 · PII y auditoría.** En `flito-impuestos.pii.ts`: `export const CAMPOS_PII_ZIP_CERTIFICADOS = CAMPOS_PII_CERTIFICADO;` (el ZIP son N certificados + placas en nombres/CSV, `placa` ya está en la lista) y `archivo?: 'zip_soportes' | 'certificado_runt' | 'zip_certificados_runt'` (actualizar el JSDoc). Tras generar los PDF y antes de cualquier `setHeader`:
`registrarAccesoImpuesto(req, { accion: 'export', archivo: 'zip_certificados_runt', filas: incluidos, campos: CAMPOS_PII_ZIP_CERTIFICADOS })` y
`audit(req, { action: 'export', resource: 'flito_impuesto', detail: 'Descarga ZIP de certificados RUNT: <i> incluido(s), <o> omitido(s) (sin certificación vigente: <a>, no disponible: <b>)' })` — **sin placas ni ids** en el detalle (son hasta 300; el GET individual sí pone la placa, aquí no).
En el **409** también se devuelven placas de impuestos visibles: registrar `registrarAccesoImpuesto(req, { accion: 'export', archivo: 'zip_certificados_runt', resultado: 'todos_omitidos', filas: 0, campos: ['placa'] })` antes del `res.json`. No se registra en 400/403/429.

**D7 · shared-types (para la HU #13206).** Sí se toca, en `packages/shared-types/src/flito-estados.ts` junto a las constantes del ZIP:
```ts
export const CABECERA_CERTIFICADOS_OMITIDOS = 'X-Certificados-Omitidos';
export const CODIGO_ZIP_SIN_CERTIFICADOS = 'zip_sin_certificados';
export const CausaCertificadoOmitido = { SIN_CERTIFICACION_VIGENTE: 'sin_certificacion_vigente', NO_DISPONIBLE: 'no_disponible' } as const;
export type CausaCertificadoOmitido = typeof CausaCertificadoOmitido[keyof typeof CausaCertificadoOmitido];
export interface CertificadoOmitido { identificador: string; causa: CausaCertificadoOmitido }
export interface ZipSinCertificadosRespuesta { error: string; codigo: typeof CODIGO_ZIP_SIN_CERTIFICADOS; omitidos: CertificadoOmitido[] }
```
El tope se reutiliza (`ZIP_SOPORTES_MAX_REGISTROS`, `CODIGO_ZIP_DEMASIADOS_REGISTROS`). La cabecera se añade a `exposedHeaders` de `apps/api/src/app.ts:189` (si no, el front cross-origin no la lee). Grep obligatorio (regla 7) — símbolos nuevos, se espera 0:
`grep -rn "CABECERA_CERTIFICADOS_OMITIDOS\|CODIGO_ZIP_SIN_CERTIFICADOS\|CausaCertificadoOmitido\|CertificadoOmitido\|ZipSinCertificadosRespuesta" apps/web/src packages/shared-types/src`

**D8 · Ruta en archivo aparte.** `flito-impuestos.certificados.routes.ts` exporta `certificadosRouter(contextoImpuesto)` y se monta con `router.use(certificadosRouter(contextoImpuesto))` junto a los otros dos (`routes.ts:53-54`), antes de cualquier `/:id/...` — evita el conflicto con `POST /:id/recibos` de la HU #13208. Flujo del handler:
1. `safeParse` → 400; 2. `comprobarTopeRegistrosZip(ids)` → 400 **antes** de `contextoImpuesto` (que puede consultar la base) y del lote (AC5);
3. `ctx`; 4. lote (D1); 5. `planificarZipCertificados` (puro) → `{ incluidos, omitidos }`; si `incluidos.length === 0` → PII 409 + `ZipSinCertificadosError` (extends `ZipError`, status 409, lleva `omitidos`);
6. PDFs (D2); 7. PII + audit (D6); 8. cabeceras + ZIP.
`catch`: `if (res.headersSent) throw e;` `ZipSinCertificadosError` → `{ error, codigo, omitidos }`; otro `ZipError` → `{ error, codigo }`; resto `handleError` (importarlo del mismo sitio que `routes.ts`).
Sin RUNT, sin `flito_soportes`, sin S3, sin disco temporal (AC4, RN-11).

## Archivos a crear/modificar

Crear:
1. `apps/api/src/modules/flito-impuestos/flito-impuestos.certificados.routes.ts` — schema, `zipCertificadosLimiter`, handler.
2. `apps/api/src/modules/flito-impuestos/certificados-zip.ts` — `planificarZipCertificados` (puro), `csvOmitidos` (puro, Buffer con BOM), `generarPdfsCertificados` (secuencial + ceder), `emitirZipCertificados(res, pdfs, csv, omitidos, ahora)`, `ZipSinCertificadosError`, `CAUSA_TEXTO`.

Modificar:
3. `apps/api/src/modules/flito-impuestos/certificacion.service.ts` — `certificacionesVigentesLoteConAcceso`, `aCertificacion(row)` compartido.
4. `apps/api/src/modules/flito-impuestos/flito-impuestos.service.ts` — solo `export` de `condicionesColaImpuestos`/`conJoinsColaImpuestos` si no lo están.
5. `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` — import + `router.use(certificadosRouter(contextoImpuesto))` (2 líneas; `npx eslint` del archivo: 830 líneas brutas, mirar el techo de max-lines).
6. `apps/api/src/modules/flito-impuestos/flito-impuestos.pii.ts` — `CAMPOS_PII_ZIP_CERTIFICADOS`, `archivo` ampliado.
7. `apps/api/src/shared/soportes/soportes-zip.ts` — `prefijo` con default en `nombreArchivoZipSoportes`.
8. `apps/api/src/app.ts` — `exposedHeaders` + `CABECERA_CERTIFICADOS_OMITIDOS`.
9. `packages/shared-types/src/flito-estados.ts` — D7 (y el índice si re-exporta explícito).

Tests P1:
- **Crear** `apps/api/__tests__/services/flito-impuestos.certificados-zip.test.ts` (puro): dos `ABC123` → `ABC123.pdf`, `ABC123-2.pdf`, tres → `-3`; mismo lote en otro orden de entrada → mismos nombres; placa `null` → `SIN-PLACA-<idFlit>.pdf`; idFlit con `/` o `..` sale limpio; causas: autorizado sin cert → `sin_certificacion_vigente` con placa (o idFlit sin placa); no devuelto → `no_disponible` con el uuid; ids duplicados cuentan una vez; CSV empieza por `EF BB BF`, `\r\n`, valor con `;` y `"` entrecomillado y duplicado, valor `=CMD` → `'=CMD`.
- **Crear** `apps/api/__tests__/services/flito-impuestos.certificados-zip.routes.test.ts` (supertest; leer el ZIP con la misma utilidad que usa el test de `POST /soportes/zip`): 200 con los nombres esperados y `omitidos.csv` + `X-Certificados-Omitidos`; 0 omitidos → sin CSV y cabecera `0`; todos omitidos → 409 con `codigo` y `omitidos`, sin `Content-Type: application/zip`; 301 ids → 400 con `300` en el mensaje y **ni** `contextoImpuesto` **ni** `db.select` llamados; sin función → 403; 6.ª petición en el minuto → 429; `logPiiAccess` una vez con `accion: 'export'`, `camposAccedidos = CAMPOS_PII_ZIP_CERTIFICADOS`, motivo con `archivo=zip_certificados_runt` y `filas=<incluidos>`, llamado antes del primer `res.write`/`setHeader` (orden de llamadas del mock); `audit` con los conteos y sin placas; módulo RUNT (`flito-impuestos.runt-consulta.js`) mockeado y no llamado; `db.insert`/`db.update` no llamados.
- **Modificar** `apps/api/__tests__/services/flito-impuestos.certificacion.service.test.ts` — lote: `conds === null` → `[]` sin consulta; sin autorizados → no se lanza la segunda consulta; resultado sin `snapshotRunt` (centinelas de `snapshot_runt.vehiculo.direccion` ausentes en `JSON.stringify`).

Comando P1: `npm test -w apps/api -- __tests__/services/flito-impuestos.certificados-zip.test.ts __tests__/services/flito-impuestos.certificados-zip.routes.test.ts __tests__/services/flito-impuestos.certificacion.service.test.ts` + `npm run build -w packages/shared-types` + `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` + `npx eslint` de los archivos tocados. Si el test del `POST /soportes/zip` afirma el nombre `soportes_…`, añadirlo al P1 (toca `soportes-zip.ts`).

### Mutantes para QA B (tope 3, P2)

| # | Mutación | Aserto que debe matarla |
|---|---|---|
| M1 | En `planificarZipCertificados` usar `base` sin pasar por `desempatador()` | puro: dos `ABC123` → `ABC123.pdf` y `ABC123-2.pdf` |
| M2 | En la ruta mover `comprobarTopeRegistrosZip` después de `contextoImpuesto`/el lote | routes: 301 ids → 400 y `db.select`/`contextoImpuesto` con 0 llamadas |
| M3 | `filas: ids.length` en vez de `incluidos` (o mover `registrarAccesoImpuesto` tras `emitirZipCertificados`) | routes: motivo con `filas=<incluidos>` y `logPiiAccess` antes del primer `setHeader` |

Alternativo: quitar el entrecomillado de `csvOmitidos` → muere con el valor con `;`.

## ADR: no aplica

Extiende el patrón del ZIP de soportes y el registro PII del certificado; sin tabla, sin dependencia, sin precedente nuevo (el contrato nuevo es un endpoint más de la familia ZIP, documentado aquí y en shared-types).

## Notas operativas

**backend-agent**
- La frontera no se reimplementa: se reutilizan `condicionesColaImpuestos` + `conJoinsColaImpuestos`. «No existe» y «no es tuyo» son la misma causa.
- Sin `console.log`/`log` con placa, idFlit ni uuids; el log de fallo lleva solo el mensaje.
- `certificacionesVigentesLoteConAcceso` no sirve JSON: solo la consume esta ruta, que registra PII.
- `security-agent`: **aplica** (ruta nueva, PII, CSV descargable) en modo diff-scoped. `db-review-agent`: no aplica. `flit-ayuda-flito`: N/A (BACKEND-only; la #13206 lleva la ficha).

**frontend-agent (HU #13206):** consumir `CABECERA_CERTIFICADOS_OMITIDOS` y `ZipSinCertificadosRespuesta` de shared-types; el tope `ZIP_SOPORTES_MAX_REGISTROS` para avisar antes de enviar; `ids` en body (nunca en query).

## Riesgos abiertos y qué falta decidir

- **R0 — la causa «sin placa» del AC2 (pendiente humano).** El AC1 manda **incluir** el certificado sin placa como `SIN-PLACA-<idFlit>.pdf`, y el AC2 lista «sin placa» como causa de **omisión**. Un mismo impuesto no puede estar en los dos lados, y `placa_consultada` es `NOT NULL`, así que un certificado vigente siempre se puede generar. Por defecto el diseño cumple el AC1 (se incluye) y el CSV lleva solo dos causas: la tercera no se emite. Si el PO quiere que «sin placa» figure en el CSV como aviso de un certificado *incluido*, el cambio es pequeño: `CausaCertificadoOmitido.SIN_PLACA`, una fila más y el conteo de la cabecera cambia de sentido. Hay que cerrarlo antes de escribir los tests del AC2.
- **R1 — identificador de «no disponible».** Es el uuid que mandó el cliente, no la placa ni el idFlit: publicar cualquiera de los dos de un impuesto fuera del alcance lo convierte en un oráculo de pertenencia. El AC dice «placa o id FLIT»; esta excepción se hace por Ley 1581 y hay que confirmarla con security.
- **R2 — CPU/heap.** 300 PDFs secuenciales pueden tardar varios segundos en el hilo principal. Se mitiga cediendo el event loop entre PDF y con 5 peticiones/min por usuario. El heap está acotado a 300 × tamaño del PDF (se espera del orden de KB). Si en DEV el lote de 300 pasa de ~10 s, se evalúa bajar el tope propio de esta ruta (nunca subirlo).
- **R3 — separador `;`.** Se eligió pensando en Excel es-CO. Si Operaciones abre el archivo con otra herramienta que espera `,`, se cambia una constante.
