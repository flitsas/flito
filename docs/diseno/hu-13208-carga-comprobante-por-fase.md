# Diseño slim — HU #13208 · Cargar un comprobante de liquidación o de pago desde el impuesto

Feature #12955 · Épica #12683 · módulo **`flito-impuestos`** (no el legacy `impuestos`; `flito-comprobantes` queda fuera).
Estado: **Aceptado** (P-1 resuelta el 2026-09-30). No requiere ADR. Base: `origin/develop` 2f238f06, que ya trae la compresión de la HU #13207 (se reutiliza tal cual).

Decisiones de David (2026-09-30), cerradas y fuera de discusión: una fase que ya tiene comprobante en ese impuesto es **duplicado** (no se reemplaza); una placa distinta leída **con confianza** se rechaza como `placa_no_coincide`, y si la placa sale dudosa o no se lee **manda el id**; el hash es solo del original y no hay migración; no hay permiso nuevo (`impuestos.recibos.cargar`, también para el gestor dentro de su frontera).

## Patrón reutilizado

| Pieza | Dónde está hoy | Cómo se usa aquí |
|---|---|---|
| Carga uno a uno por id, con la frontera del actor y el mismo orden «validar → OCR → archivar → tx» | `cargarReciboCaja`, `flito-recibos.service.ts:720-755` | **Vecino directo.** Se calca el esqueleto: `buscarConAcceso`, `hashReciboYaCargado`, `candidatoPorImpuestoId`, `abrirLote` + `umbralDelCandidato` + `remarcarConfiable`, `archivar`, `insertarSoporte`, `conciliar`, `aRevision` |
| Frontera (404, no 403): autogestión, `gestionOperaciones`, organismos del gestor y estados visibles (`solicitado`/`pagado`) | `buscarConAcceso`, `flito-impuestos.service.ts:556-573` | Tal cual. Da el AC6 sin código nuevo |
| Hash del original contra los tres tipos de recibo | `hashReciboYaCargado`, `flito-recibos.service.ts:349-353` | Tal cual (AC4, archivo idéntico) |
| Vigilancia del sello PAGADO frente a la fase declarada | `leerSello` y `vigilarFase`, `flito-recibos.fase.ts` | Tal cual (AC3) |
| Dedup por número de recibo en otro impuesto | Bloque en línea de `procesarRecibo`, `flito-recibos.service.ts:412-421` | Se **extrae** a `numeroReciboEnOtro(numero, impuestoId)` y lo llaman los dos caminos |
| Escritura por fase (liquidación: `marcarLiquidado`; pago: `conciliar` o `aRevision`) | Final de `procesarRecibo`, `flito-recibos.service.ts:423-450` | Se **extrae** a `escribirPorFase(...)`. La masiva le pasa el veredicto `evaluarReciboImpuesto`; la carga por id le pasa su propio veredicto (ver D-3) |
| Complemento sobre un `pagado` (la otra fase se adjunta; si esa fase ya existe no se adjunta) | `adjuntarComplemento`, `flito-recibos.service.ts:487-503` | Se **parte**: la búsqueda por placa se queda en la masiva y el núcleo pasa a `adjuntarAPagado(pagado, archivo, fase, hash, ctx)` (conteo de :491, archivar, tx, marca `liquidado_en` de :494-498). La carga por id lo llama con el candidato por id |
| Compresión al guardar (AC9) | `archivar` → `comprimirComprobante`, `flito-recibos.service.ts:611-616` | Sin tocar. Todo lo que se escribe pasa por `archivar` |
| Sub-router propio que **reutiliza** un código de función ya declarado | `flito-impuestos.analisis.routes.ts:52` (`POST /:id/reanalizar` con `impuestos.tramite.certificar`), montado en `flito-impuestos.routes.ts:53`; `authMiddleware` propio como en `flito-impuestos.direccion.routes.ts` (D5 de la #12833) | Mismo montaje: `router.use(reciboFaseRouter(contextoImpuesto))`. Ver D-1 |
| Limitador local del sub-router | `reanalizarLimiter`, `flito-impuestos.analisis.routes.ts:26-34` | Calco (`userOrIpKey` + `makeStore`) |
| multer de un archivo con `fileFilter` y motivos traducidos | `uploadReciboCaja` + `recibirReciboCaja`, `flito-impuestos.routes.ts:70-102` | Calco en el sub-router, más la comprobación de bytes reales |
| MIME real por los bytes | `clasificarBytes`, `apps/api/src/shared/soportes/soportes-zip.ts:315` | Tras multer: si los bytes no dicen PDF/JPEG/PNG, o no coinciden con lo declarado, es 400 |

## Contrato delta

```
POST /api/flito/impuestos/:id/recibos        (multipart: archivo=<1 archivo>, fase='liquidacion'|'pago')
  authMiddleware → exigirFuncion('impuestos.recibos.cargar') → reciboFaseLimiter → multer.single('archivo') → bytes reales → zod
  400 archivo_invalido     sin archivo, más de uno, campo distinto, MIME fuera de PDF/JPEG/PNG, bytes que no cuadran, > 15 MiB (AC10)
  400 fase_invalida        `fase` fuera de FASES_RECIBO (antes de resolver el contexto y del OCR)
  403                      sin la función (cuerpo de exigirFuncion) (AC7)
  404 no_encontrado        `:id` que no es uuid, no existe o está fuera de la frontera (AC6)
  409 estado_no_permitido  estado distinto de `solicitado` y de `pagado` (AC8)
  429                      limitador
  503                      el OCR no respondió; no se escribió nada
  200 { resultado: 'liquidado',  soporteId, valorLiquidado: string|null }                    (AC1)
  200 { resultado: 'pagado',     soporteId, valorPagado: string|null, marcadoPorDiferencia }  (AC2)
  200 { resultado: 'en_revision', soporteId, revisionId }                                     (AC2)
  200 { resultado: 'complemento', soporteId }                                                 (AC8, pagado sin esa fase)
  200 { resultado: 'duplicado' | 'fase_no_coincide' | 'placa_no_coincide', detalle }          (AC3/AC4/AC5; nada escrito)
```

`shared-types` (`packages/shared-types/src/flito-estados.ts`, junto a `ResultadoReciboCaja`, :377): `CodigoErrorCargaPorFase` (`archivo_invalido`, `fase_invalida`, `no_encontrado`, `estado_no_permitido`) y `RespuestaCargaPorFase` (la unión de arriba). Son tipos nuevos: el `grep` en `apps/web` va a salir vacío, y aun así hay que correrlo y pegarlo (regla 7). Esta HU no toca la web.

### Orden de decisión en `cargarReciboPorFase(impuestoId, fase, archivo, ctx)`

Cada paso corta la ejecución. Hasta el paso 9 incluido no se escribe nada ni en storage ni en base; lo único que se escribe es la auditoría de un rechazo.

1. `buscarConAcceso` → `null` = 404 `no_encontrado`.
2. `estado ∉ {solicitado, pagado}` = 409 `estado_no_permitido`.
3. `hashReciboYaCargado(sha256(original))` → `duplicado` («archivo idéntico a uno cargado antes»).
4. **La fase ya tiene comprobante en este impuesto**: hay un soporte de `TIPO_POR_FASE[fase]` en `impuestoId` con `descartado = false` (mismo conteo que `:491`) → `duplicado`. Vale para `solicitado` y para `pagado`, y va **antes del OCR**, así que no gasta lectura. Una revisión rechazada marca su soporte como `descartado` (`flito-revisiones.service.ts:306-307`), de modo que se puede volver a cargar.
5. `candidatoPorImpuestoId` → `abrirLote` → `extraerReciboImpuesto(docDe(archivo, lote.porDefecto))`. Si el OCR falla, `OcrNoDisponibleError` se propaga como 503. Después: `umbralDelCandidato` y `remarcarConfiable`.
6. **Placa (AC5):** si `extraccion.placa.confiable` y `normalizarLlave(ocr) !== normalizarLlave(cand.placa)`, el resultado es `placa_no_coincide` y se deja auditoría con `db`, como hace `:405`. Si la placa sale dudosa, no se lee o `cand.placa` es null, el proceso sigue: **manda el id**. **No** se usa `placaDesdeNombre`, porque el nombre del archivo no identifica nada cuando ya viene el id.
7. **Fase (AC3):** `vigilarFase(fase, leerSello(extraccion))`. Si hay rechazo, el resultado es `fase_no_coincide` y se deja auditoría.
8. `numeroReciboEnOtro(numero, impuestoId)` → `duplicado` (el mismo pago con el PDF reexportado).
9. Si `estado === pagado`, se llama a `adjuntarAPagado` y el resultado es `complemento`. El paso 4 ya garantizó que esa fase no existe.
10. `solicitado` + `liquidacion` → `escribirPorFase` → `marcarLiquidado` → `liquidado`. Un valor que no se leyó con confianza no se escribe, igual que en la masiva.
11. `solicitado` + `pago` → veredicto (D-3) → `conciliar(tx, cand, extraccion, soporteId, ctx)` con `pagadoEn = now`, como en la masiva → `pagado`; o `aRevision` → `en_revision`.

## Decisiones

- **D-1. Sub-router en archivo propio.** No se hace por `max-lines`: se hace por el catálogo de permisos. Medido con `npx eslint` sin blancos ni comentarios: `flito-impuestos.routes.ts` = **472**, `flito-recibos.service.ts` = **448**, `flito-estados.ts` = **342**, así que los tres tienen margen de sobra. El motivo real es otro. `flito-impuestos.routes.ts` está en `FICHEROS_EN_ALCANCE` (`permisos/inventario-guardas.ts:73`), y `catalogoDeOperaciones` exige una operación declarada **por guarda** mientras `catalogoCompleto` rechaza los códigos repetidos (`permisos/catalogo.ts:114-160`, test `permisos-catalogo.test.ts:53`). Una segunda guarda con `impuestos.recibos.cargar` dentro de ese archivo lanza `CatalogoIncoherenteError` si no se declara, y el test de «código repetido» si se declara. El precedente que resuelve esto es `POST /:id/reanalizar`, que reutiliza `impuestos.tramite.certificar` desde un sub-router **que no está** en el inventario. Por eso:
  - el nuevo `flito-impuestos.recibo-fase.routes.ts` **no** se añade a `FICHEROS_EN_ALCANCE`, ni a `catalogo-operaciones.ts`, ni a `inventario.generado.ts`, ni a `permisos-rutas-reconducidas.ts`;
  - lleva `router.use(authMiddleware)` propio, que es redundante e inocuo, igual que en `direccion`.
- **D-2. Resultados «sin escritura» como 200 + `resultado`, no como 409.** Los AC distinguen de forma sistemática entre «el resultado es X» (AC1-AC5) y «recibo 4xx» (AC6-AC8, AC10). El recibo de caja responde `duplicado` con 409 (`:732`), y aquí se sigue el texto de la HU, que coincide con la masiva (duplicado, fase no coincide y demás son renglones de un 200). `detalle` es copy de negocio y no repite la placa leída ni el nombre del archivo.
- **D-3. Veredicto del pago por id (es la pregunta P-1).** La masiva paga con `evaluarReciboImpuesto`, que exige placa y valor con confianza, y con el sello dudoso respeta lo declarado. Aquí la placa ya no es la llave (manda el id), así que ese veredicto no sirve: una placa dudosa mandaría a revisión, y eso contradice el AC5. La base propuesta es `evaluarReciboCaja` (`:127`, exige solo el valor total con confianza, que es lo que `conciliar` escribe). Lo que falta decidir es si se exige **además** `leerSello(extraccion) === true`. Ver P-1.
- **D-4. `pagadoEn` = momento de la carga,** como en la masiva. La fecha leída del recibo la usa solo el recibo de caja (`fechaDelRecibo`), y ningún AC de esta HU la pide.
- **D-5. Limitador propio** (`reciboFaseLimiter`: 60 peticiones cada 15 min por usuario, llave `flito-impuestos-recibo-fase`), puesto **delante** de multer. No se comparte `comprobantesCargaLimiter`, porque su cubo es el de la puerta universal de comprobantes (5 archivos por petición), y compartirlo haría que una carga frenara a la otra.
- **D-6. MIME real.** El `fileFilter` deja pasar solo lo que el cliente declara como `application/pdf`, `image/jpeg` o `image/png` (sin ZIP). Después de multer, `clasificarBytes(buffer)` tiene que devolver el mismo tipo; si no, 400 `archivo_invalido`. En `flito_soportes` se guarda el MIME que dicen los bytes, no el declarado (cierra el XSS almacenado que anota `routes.ts:76-77`). Límites de multer: `fileSize: CARGA_MASIVA_MAX_BYTES_ARCHIVO` (15 MiB), `files: 1`, `fields: 2`. `:id` que no es uuid → 404 (precedente: `exigirIdUuid` de `flito-comprobantes.routes.ts`); así no se cae en un 22P02 que acabe en 500.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/modules/flito-impuestos/flito-impuestos.recibo-fase.routes.ts` | **Nuevo.** `export default function reciboFaseRouter(contextoImpuesto)`. Contiene: `authMiddleware`, limitador, multer, comprobación de bytes, zod `{ fase: z.enum(FASES_RECIBO) }`, `audit(req, { action: 'upload', resource: 'flito_impuesto', resourceId, detail: 'Carga por fase (<fase>): <resultado>. Soporte <id>.' })` y traducción de `CargaPorFaseError` y `OcrNoDisponibleError`. El resto va a `next(e)` |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` | +2 líneas: import y `router.use(reciboFaseRouter(contextoImpuesto))` después de `:54` |
| `apps/api/src/modules/flito-impuestos/flito-recibos.service.ts` | `cargarReciboPorFase` + `CargaPorFaseError`; extracciones `numeroReciboEnOtro`, `escribirPorFase` y `adjuntarAPagado`, y `procesarRecibo` y `adjuntarComplemento` pasan a llamarlas **sin cambiar su comportamiento**; comentario de cabecera `── Carga por fase desde el impuesto (HU #13208)`. Se estima que llega a unas 530 líneas efectivas |
| `packages/shared-types/src/flito-estados.ts` | `CodigoErrorCargaPorFase`, `RespuestaCargaPorFase` |
| `apps/api/__tests__/services/flito-recibos.carga-por-fase.test.ts` | **Nuevo.** AC1-AC5, AC8 y AC9 (se espía `comprimirComprobante` y se comprueba que `tamanoBytes` es el del comprimido); el orden «nada escrito» (ni `uploadEntityDocument` ni `transaction` en los resultados sin escritura); la placa dudosa sigue adelante |
| `apps/api/__tests__/services/flito-recibos.carga-por-fase.routes.test.ts` | **Nuevo.** AC6 (404 fuera de frontera y gestor de su organismo en 200), AC7 (403), AC10 (dos archivos, `.html` renombrado a `.pdf` por bytes, > 15 MiB, campo equivocado; el cuerpo trae el `codigo` sin el `MulterError` crudo), `fase` inválida, uuid inválido, 503 del OCR |

**P1 (lista explícita):** los dos tests nuevos. Como se tocan `procesarRecibo` y `adjuntarComplemento`, también `flito-recibos.test.ts`, `flito-recibos.fases.test.ts` y `flito-recibos.sello.test.ts`. Como hay una guarda nueva fuera del inventario, `permisos-catalogo.test.ts` y `permisos.reconduccion-cierre.test.ts`, para probar que el catálogo sigue coherente. Además: `npm run build -w packages/shared-types`, `build:api` con `NODE_OPTIONS=--max-old-space-size=8192` y el `grep` de los tipos nuevos en `apps/web`.

## ADR: no aplica

Extiende un patrón que ya existe (`cargarReciboCaja` y el sub-router de `reanalizar`). Sin tabla, sin migración, sin permiso nuevo y sin dependencias.

## Notas operativas

**backend-agent**
- Las tres extracciones son refactor puro de la masiva. Antes de escribir la función nueva, los tests de la masiva de P1 tienen que seguir en verde sin tocar un solo aserto.
- `escribirPorFase` recibe el veredicto ya calculado y devuelve un resultado discriminado. La masiva lo traduce a su renglón `ItemRecibo` y la carga por id lo traduce a `RespuestaCargaPorFase`. **No** debe empujar a `res` desde dentro.
- Hay rechazos que no abren transacción (placa y fase). En esos casos la auditoría va con `auditEnTx(db, …)`, como en `:405`. En `audit_logs` la placa sí puede ir (la masiva ya la escribe ahí); en el logger de pino, nunca.
- Mock `chain`: devuelve la fila entera aunque el select pida menos, e ignora `orderBy`. El conteo del paso 4 hay que asertarlo sobre la condición leída (`tipo` + `impuestoId` + `descartado`), no solo sobre el resultado.
- No se añade la ruta a `catalogo-operaciones.ts` ni a las fotos del inventario (D-1). Si `permisos-catalogo.test.ts` se pone rojo, el montaje está mal: lo más probable es que el archivo haya acabado en `FICHEROS_EN_ALCANCE` o que la ruta se haya escrito en `flito-impuestos.routes.ts`.

**frontend-agent:** no aplica en esta HU. Si hay una HU FRONTEND hermana, que consuma `RespuestaCargaPorFase` y `CodigoErrorCargaPorFase` desde `@operaciones/shared-types`.

**security-agent (diff-scoped):** multer con `fileFilter`, `limits` y bytes reales; limitador; `authMiddleware` + `exigirFuncion`; frontera 404; id opaco en el path y sin PII en la URL; `detalle` sin eco de lo que mandó el cliente.

## Riesgos abiertos

- **P-1 — RESUELTA por David (2026-09-30): `en_revision`.** Con fase `pago`, el valor leído con confianza y el sello PAGADO dudoso (o no leído), el resultado es `en_revision`, no `pagado`. `pagado` exige el sello leído con confianza (`leerSello(extraccion) === true`) además del valor total. Motivo: en la carga por id la placa ya no confirma el documento, así que un solo campo confiable no basta. Implementado en `evaluarPagoPorFase` (`flito-recibos.service.ts`) y cubierto por el test «P-1 (decisión 2026-09-30) — sello PAGADO dudoso y valor confiable → en_revision, NO pagado» de `flito-recibos.carga-por-fase.test.ts`. La masiva no cambia (sigue respetando lo declarado ante la duda, HU #12614 AC4).
- **R-1 — mitigada.** Dentro de la transacción, `recomprobarDentro` relee el `estado` de `flito_impuestos` con `.for('update')` y vuelve a contar la fase; si el estado cambió o la fase ya está ocupada, no escribe nada y responde `duplicado`. Solo en la carga por id (la masiva no pasa `recomprobar`, así que su comportamiento y sus mocks no cambian). El stub de transacción no se tocó: el de los tests nuevos es propio y el `keyed-db` ya admite `.for`. Lo ya archivado en storage en la carga perdedora queda huérfano, igual que en la masiva (Nota).
- **R-2 (Nota).** El texto de la función `impuestos.recibos.cargar` en el panel («Subir los recibos de pago y repartirlos por trámite») no menciona la carga por id. Cambiarlo exige una migración sobre `permisos_funciones`, así que queda fuera del alcance acordado («sin migración»).
