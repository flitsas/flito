# Diseño slim: Feature #13834, consultas de gestión en Dr. Flit (sin IA)

> `architecture-agent` en modo **slim**, 2026-10-22. Estado: **Propuesto**.
> Insumos: `docs/ado-drafts/epic-12756-12757/HUS-F6-13834.md` (AC de G1 #13836, G2 #13837, G3 #13838) y P9 de `CAMBIO-F4-13696.md`. Hoy se sumaron P9-A (un módulo con 0 resultados se oculta; con id FLIT no se consulta SOAT), P9-C (F6 no expone la búsqueda por cédula ni por nombre) y P9-D («ver más» abre el módulo sin filtro).
> Habla con los módulos **FLITO** (`flito-tramites`, `flito-soat`, `flito-impuestos`, `flito-derechos`). No toca los módulos legacy `tramites`, `soat` ni `liquidacion`.

## Patrón reutilizado

- **Ruta:** `POST /novedades/buscar` en `apps/api/src/modules/flito-tramites/flito-tramites.routes.ts:89` (HU #13684). Lleva `exigirFuncion(<cola.ver>)` y después el limiter, valida el body con Zod, llama al **mismo servicio que el GET** con `buscar` en el body y responde con `Cache-Control: no-store`.
- **Rastro de PII:** el `GET /` de SOAT (`registrarAccesoSoat(req, { accion: 'search', filas })`) y el de impuestos (`registrarAccesoImpuesto(req, { filas })`). Los dos escriben con `await` **después** de la consulta.
- **Limiter:** `novedadesTramitesLimiter` en `apps/api/src/shared/middleware/rateLimiter.ts:499`. Usa `userOrIpKey` + `makeStore` + `frenoConRastro`, y `frenoConRastro` ya registra la ruta sin la query string.
- No hace falta ADR: es una extensión del patrón sin tabla nueva ni dependencia nueva. El único tradeoff que apareció (P9-B, id FLIT) se resuelve sin ADR; está explicado abajo.

## Verificaciones hechas (base de las decisiones)

| Punto | Qué encontré |
|---|---|
| Auth | Los 4 routers declaran `router.use(authMiddleware)` en su cabecera (tramites:32, soat:41, impuestos:56, derechos:26). En `app.ts:270-280` se montan con `conAlcance('<modulo>', …)`. Las rutas nuevas heredan las dos cosas y **no** repiten `authMiddleware`. |
| `pageSize: 5` y `total` | `listar` (tramites:631), `cola` (soat:668), `colaImpuestos` (impuestos:376) y `listarDerechos` (derechos:702) acotan `pageSize` con `Math.min(200, Math.max(1, …))` y devuelven `{ items, total, page, pageSize }`, con `total` de un `count(*)` que no depende de la página. Con `pageSize: 5` llegan 5 filas y el total real, sin cambiar ningún servicio. |
| Choque de rutas | Ninguno de los 4 módulos tiene `post('/:param', …)` de un solo segmento (grep sobre los directorios completos, incluidos los routers montados antes en `/api/flito/soat` y los sub-routers de impuestos). Un `POST /buscar` no choca con los `GET /:id` ni con los `POST /:id/<accion>`. |
| Frontera | `conAlcance` solo marca `req.fronteraModulo`. La ruta nueva **no** lleva `soloSinEnlace`, porque quien tiene enlace (empresa u organismo) también consulta con su alcance, y se acota por `alcanceDe`/`contexto*`, igual que el GET. |
| Tamaño | Líneas efectivas, sin blancos ni comentarios: soat.routes **326**, impuestos.routes **498**, tramites.routes **232**, derechos.routes **130**. Ninguno figura en el techo congelado de `eslint.config.mjs`. El conteo de 687 líneas de SOAT incluye comentarios, así que el límite de 800 no corre riesgo. **No hace falta `flito-soat-buscar.routes.ts`.** |
| `logPiiAccess` | La firma es `logPiiAccess(req, { resourceTipo, resourceId?, accion: 'read'\|'export'\|'decrypt'\|'search', camposAccedidos, motivo? })` (`shared/pii-audit.ts:42`). Es best-effort (try/catch) y saca la IP de `req.ip`. Tramites y derechos **no** tienen helper propio: hoy sus GET no escriben rastro. |
| Id FLIT (P9-B) | **No tiene formato fijo en el código.** `flito_tramites.id_flit` es un `varchar(60)` libre (`schema.ts:3067`). Se llena con `it.Id: string` de FLIT 1 (`flit-http.adapter.ts:108`) o con el `radicado` de FLIT 2 (`flit2-lectura.service.ts:297`), y en la demo con `DEMO-<placa>` (`flito-tramites.service.ts:179`). No hay regex en ningún lado. Las fixtures de los tests no son homogéneas (`FLIT-0001`, `FT1-0005555`, `F1`, `FLIT-ARHZZ1`). No pude ver datos reales porque `flito-postgres` no está levantado. |
| Funciones en web | `hasFuncion('<codigo>')`, el mismo hook que usan `Dashboard.tsx:92` y `DriverDetail.tsx:40`, más `hasPage(user, slug)` de `lib/permissions.ts:58`. |
| Persistencia | `serializar()` (`lib/drFlitConversacion.ts:87`) guarda **todos** los mensajes, **incluido el texto del mensaje del usuario** (`tipo: 'pregunta'`). Ver el riesgo R1. |

## Contrato delta

**`packages/shared-types/src/flito-dr-flit-gestion.ts`** (archivo nuevo, se re-exporta desde el `index`):

```ts
export const MAX_VALOR_GESTION = 100;
export const TARJETAS_POR_MODULO = 5;
export const MODULOS_GESTION = ['tramites', 'soat', 'impuestos', 'derechos'] as const;
export type ModuloGestion = (typeof MODULOS_GESTION)[number];
export interface BusquedaGestionRequest { valor: string }              // trim, 1..100
export interface ResultadoGestion<T> { total: number; items: T[] }     // items.length <= 5
export interface TarjetaTramite  { id: string; /* a fijar por ux */ }   // G1
export interface TarjetaSoat     { id: string; /* G2 */ }
export interface TarjetaImpuesto { id: string; /* G3 */ }
export interface TarjetaDerecho  { id: string; /* G3 */ }
```

DTO de cada tarjeta. Los campos salen solo de la fila de la cola (P9-1); `ux-agent` elige el subconjunto y `backend-agent` copia los nombres exactos del tipo del servicio. **Nunca** viajan `compradorNombre`, `compradorDocumento`, `compradorTipoDocumento`, `vin` (salvo que ux lo pida y la fila lo muestre), `documentos`, `certificacion` ni `motivoRechazo`.

| DTO | Fuente | Candidatos (verificados en el tipo) |
|---|---|---|
| `TarjetaSoat` | `SoatColaItemSalida` (unión interno \| cliente) | `id`, `placa`, `marca`, `linea`, `estado`, `companiaNombre`, `organismoNombre`. **Por confirmar** contra `SoatColaItem`: «Gestiona», «Solicitado», «Valor» y «Pagado» (nombres exactos). Solo se usan campos que existen en **las dos** ramas de la unión, nunca uno de `CAMPOS_SOLO_INTERNOS` como `proveedorSoatId`. |
| `TarjetaImpuesto` | `ImpuestoColaItem` | `id`, `placa`, `estado`, `companiaNombre`, `organismoNombre`, `gestionOperaciones` («Gestiona»), `creadoEn` («Solicitado»), `pagadoEn`, `valorLiquidado`, `valorPagado` |
| `TarjetaDerecho` | fila de `listarDerechos` | **A fijar por ux.** Candidatos: `id`, `placa`, trámite, `valor`, `detalle`/advertencias, `createdAt` (confirmar que la tabla de la línea 503 de `FlitoDerechos.tsx` es la cola) |
| `TarjetaTramite` | `TramiteFila` (`ListadoTramites.items`) | **A fijar por ux.** Candidatos: `id`, `idFlit`, `placa`, estado, tipo de trámite, tránsito, ciudad, empresa, estado SOAT, estado impuesto, fecha de creación o aprobación. `marca` del listado **no** se expone. |

En la API, el Zod del body vive en `apps/api/src/shared/dr-flit-gestion.ts` (nuevo), que comparten las 4 rutas:
`busquedaGestionSchema = z.object({ valor: z.string().trim().min(1).max(MAX_VALOR_GESTION) }).strict()` y `PAGINA_GESTION = { page: 1, pageSize: TARJETAS_POR_MODULO }`. Un `valor` vacío o que falta responde **400 `{ error: 'Datos inválidos' }`** antes de tocar el servicio, así que no queda rastro.

## Rutas por módulo

En los cuatro: `router.post('/buscar', exigirFuncion(F), drFlitGestionLimiter, handler)`, declarada **antes** de las rutas `/:id`. La auth ya la puso el router, y quien no tiene la función no gasta cupo del limiter. El handler sigue este orden: parse → 400 si no valida → servicio(`{ buscar: valor, ...PAGINA_GESTION }`, alcance) → `await` del rastro PII → `Cache-Control: no-store` → `res.json({ total, items: items.map(aTarjetaX) })`.

| HU | Ruta | F | Servicio y alcance | Rastro |
|---|---|---|---|---|
| G1 | `POST /api/flito/tramites/buscar` | `tramites.cola.ver` | `listar({ buscar, page, pageSize }, await alcanceDe(req))` | `logPiiAccess(req, { resourceTipo: 'flito_tramites', accion: 'search', camposAccedidos: <campos PII del DTO, p. ej. ['placa','id_flit']>, motivo: \`Dr. Flit gestión — filas=${items.length}\` })` |
| G2 | `POST /api/flito/soat/buscar` (en `flito-soat.routes.ts`) | `soat.cola.ver` | `cola(await contextoSoat(req.user!), { buscar, page, pageSize })` | `registrarAccesoSoat(req, { accion: 'search', filas, campos: <campos del DTO> })` |
| G3 | `POST /api/flito/impuestos/buscar` | `impuestos.cola.ver` | `colaImpuestos(await contextoImpuesto(req.user!), { buscar, page, pageSize })` | `registrarAccesoImpuesto(req, { filas })`. Si el helper admite indicar campos, se pasan los del DTO. |
| G3 | `POST /api/flito/derechos/buscar` | `derechos.cola.ver` | `listarDerechos({ buscar, page, pageSize }, await alcanceDe(req))` | `logPiiAccess(req, { resourceTipo: 'flito_derechos', accion: 'search', camposAccedidos: ['placa'], motivo: \`Dr. Flit gestión — filas=${n}\` })` |

Reglas del rastro:
- Se escribe con 200 aunque haya 0 filas (`filas=0`), igual que el GET de SOAT. Con 400 o 403 no se escribe.
- **El `valor` buscado nunca entra** en `motivo`, en el `logger` ni en `audit`.
- El limiter, cuando frena, registra la ruta sin el body.
- No se agrega `log.info` con el body. Los mapeadores `aTarjetaX` son funciones locales del routes file, de unas 10 líneas cada una.

## Limiter `drFlitGestionLimiter` (en `shared/middleware/rateLimiter.ts`, G1)

```
windowMs: 60_000 · max: 40 · keyGenerator: userOrIpKey('drflit-gestion:')
handler: frenoConRastro('drflit-gestion') · store: makeStore('rl:drflit-gestion:')
message: { error: 'Hizo muchas consultas seguidas; intente en un momento' }
```

- Las cuatro rutas usan **una sola bolsa por usuario**, porque comparten la key.
- Una consulta completa son hasta 4 POST, así que 40 por minuto equivalen a **10 consultas por minuto** con los 4 módulos. Con menos módulos alcanzan para más consultas.
- El «Reintentar» de un solo módulo gasta 1.
- Es una cota revisable, sin telemetría previa, igual que la de novedades. No comparte bolsa con `drflit-casos` (soporte) ni con el cupo de IA (P9-9).
- El panel convierte el 429 en el copy de AC5 con «Reintentar» **por grupo**, nunca en el error crudo.

## Web

- **`apps/web/src/lib/drFlitGestion.ts`** (nuevo, puro y sin React). Exporta:
  - `detectarValorGestion(texto) → { tipo: 'placa' | 'vin' | 'idFlit', valor } | null`. Separa el texto en tokens por lo que no es alfanumérico y los pasa a mayúsculas.
    - Placa de carro: `^[A-Z]{3}\d{3}$`. Placa de moto: `^[A-Z]{3}\d{2}[A-Z]$`.
    - VIN: `^[A-HJ-NPR-Z0-9]{17}$` **con al menos una letra y al menos un dígito**, para que 17 dígitos sueltos no disparen (AC2).
    - **Id FLIT: desactivado en F6.** Queda `PATRON_ID_FLIT: RegExp | null = null`; ver P9-B.
    - Si hay más de un valor distinto en el mensaje, ver la pregunta Q2.
  - `modulosAConsultar(tipo, permite)`. Recibe `permite(m)`, que hace `hasPage(user, 'flito_<m>') && hasFuncion('<m>.cola.ver')`. Matriz de consulta:

    | tipo | tramites | soat | impuestos | derechos |
    |---|---|---|---|---|
    | placa | sí | sí | sí | sí |
    | vin | sí | sí | sí | **no** (P9-2) |
    | idFlit (si un día se activa) | sí | **no** (P9-A) | sí | sí |

  - `consultarGestion(valor, modulos) → Promise<Record<ModuloGestion, { ok: true; datos: ResultadoGestion<…> } | { ok: false; status }>>`. Lanza un `api.post('/flito/<m>/buscar', { valor })` por módulo con `Promise.allSettled`, de modo que la falla de uno queda aislada (AC7 de G2). Las llamadas pasan por `lib/api.ts`, nunca por `fetch`.
  - **El punto de entrada para F4** es `consultarGestion` (más `modulosAConsultar`). F4 llega con el valor ya extraído por su intent `gestion` y con el tipo, y no pasa por el detector.
  - Un registro `MODULOS_GESTION_WEB` con `{ modulo, page, funcion, acepta: tipo[], etiqueta, rutaVerMas }`. G2 y G3 agregan cada uno su entrada, sin tocar la lógica.
- **Componentes** en `apps/web/src/components/drflit/gestion/`:
  - `ResultadoGestion.tsx`: un grupo por módulo con 4 estados (cargando, error con Reintentar del grupo, vacío y lleno). Un grupo con 0 se **oculta** (P9-A). Si todos los grupos quedan en 0, o no hay módulos, muestra «No encontré resultados en sus módulos».
  - Una `Tarjeta<Modulo>.tsx` por módulo. «Ver más en la pantalla» abre la ruta del módulo **sin query** (P9-D, P9-6).
- **Mensajes** (`lib/drFlitConversacion.ts`): tipos nuevos `gestionOferta` (con valor), `gestionResultado` (con valor y datos) y `gestionCaducada` (sin datos).
  - `serializar()` **excluye** los dos primeros y el mensaje del usuario que los originó (R1), y en su lugar escribe **un** `gestionCaducada`.
  - `mensajeValido` acepta `gestionCaducada` y descarta cualquier otro `gestion*`.
  - No hace falta tocar `lib/drFlitAlmacen.ts`, porque recibe lo que serializa `drFlitConversacion`. La exclusión va en `serializar`, que es el único punto por donde pasa todo lo que se guarda.
- **`DrFlitPanel.tsx`** (420 líneas): al enviar, `detectarValorGestion` corre **antes** del flujo actual. Si hay coincidencia, el panel ofrece «Consultar <valor> en sus módulos» y espera confirmación; si no, sigue el flujo de siempre. La UI de resultados va en sus componentes para que el panel no crezca más de unas 30 líneas.

## Archivos a crear/modificar

**G1 #13836 (contrato, limiter, detector, despachador, trámites)**
- crear `packages/shared-types/src/flito-dr-flit-gestion.ts` · modificar `packages/shared-types/src/index.ts`
- crear `apps/api/src/shared/dr-flit-gestion.ts`
- modificar `apps/api/src/shared/middleware/rateLimiter.ts` (`drFlitGestionLimiter`)
- modificar `apps/api/src/modules/flito-tramites/flito-tramites.routes.ts` (`POST /buscar` + `aTarjetaTramite`)
- crear `apps/api/__tests__/services/flito-tramites-buscar.test.ts`
- crear `apps/web/src/lib/drFlitGestion.ts` + `apps/web/src/lib/drFlitGestion.test.ts` (`node --test`, como `permissions-funciones.test.ts`)
- modificar `apps/web/src/lib/drFlitConversacion.ts` (tipos y exclusión en `serializar`)
- crear `apps/web/src/components/drflit/gestion/ResultadoGestion.tsx`, `TarjetaTramite.tsx`
- modificar `apps/web/src/components/drflit/DrFlitPanel.tsx`
- crear `apps/web/e2e/tests/dr-flit-gestion.spec.ts`

**G2 #13837 (SOAT)**
- modificar `flito-dr-flit-gestion.ts` (`TarjetaSoat`)
- modificar `apps/api/src/modules/flito-soat/flito-soat.routes.ts` (no hace falta archivo aparte)
- crear `apps/api/__tests__/services/flito-soat-buscar.test.ts`
- crear `apps/web/src/components/drflit/gestion/TarjetaSoat.tsx` · modificar `lib/drFlitGestion.ts` (entrada del registro) · modificar `dr-flit-gestion.spec.ts`

**G3 #13838 (impuestos y derechos)**
- modificar `flito-dr-flit-gestion.ts` (`TarjetaImpuesto`, `TarjetaDerecho`)
- modificar `flito-impuestos.routes.ts`, `flito-derechos.routes.ts`
- crear `apps/api/__tests__/services/flito-impuestos-buscar.test.ts`, `flito-derechos-buscar.test.ts`
- crear `TarjetaImpuesto.tsx`, `TarjetaDerecho.tsx` · modificar `lib/drFlitGestion.ts` · modificar `dr-flit-gestion.spec.ts`

## Tests P1 por HU

- **G1:**
  - `npm test -w apps/api -- __tests__/services/flito-tramites-buscar.test.ts __tests__/services/frontera-por-enlace.test.ts`. La segunda es el centinela de la frontera, porque se agrega una ruta a un router con `conAlcance`.
  - Casos: 200 con alcance (empresa enlazada que no ve los trámites de otra), `items.length ≤ 5` con `total` real, 403 sin función y sin gastar cupo, 400 con `valor` vacío o que falta y sin rastro, `pii_access_log` sin el valor en `motivo`, 429 al pasar el máximo, DTO sin campos de más.
  - `npm run build -w packages/shared-types` · `node --experimental-strip-types --test apps/web/src/lib/drFlitGestion.test.ts` (detector, matriz de despacho y serializar sin valor) · `npm run typecheck -w apps/web` · `npx playwright test e2e/tests/dr-flit-gestion.spec.ts`.
- **G2:**
  - `npm test -w apps/api -- __tests__/services/flito-soat-buscar.test.ts __tests__/services/frontera-por-enlace.test.ts`. Casos: 200 con alcance de compañía o proveedor, DTO del rol cliente sin campos internos, 403, 400 sin rastro, rastro con 200.
  - Más el caso SOAT del spec E2E (falla aislada de un grupo).
- **G3:**
  - `npm test -w apps/api -- __tests__/services/flito-impuestos-buscar.test.ts __tests__/services/flito-derechos-buscar.test.ts __tests__/services/frontera-por-enlace.test.ts`. En derechos se cubre el alcance por organismos.
  - Más los casos del spec: con un VIN no se llama a derechos, y con derechos sin impuestos solo aparece un grupo.

## ADR: no aplica

Es una extensión del patrón de #13684. No hay tabla, dependencia ni excepción GET+query: todo viaja en el body, que es el default de §14.

## Notas operativas

**backend-agent**
- `exigirFuncion` va antes del limiter y `/buscar` antes de `/:id`.
- No se toca ningún servicio. No se loguea el body. Se responde con `no-store`.
- Al hacer `grep` de usos en `apps/web` (regla 7), el resultado es 0, porque el archivo de shared-types es nuevo.
- Los nombres exactos de los campos del DTO salen de los tipos de servicio citados arriba, y el subconjunto lo fija ux.

**frontend-agent**
- La UI tiene los 4 estados por grupo, copy pulido para 429 y 5xx, y tarjetas y enlaces operables con teclado.
- **Prohibido** poner la placa, el VIN o el documento en la URL de «ver más» o de la tarjeta. El enlace a un registro concreto solo existe si la pantalla abre por `uuid`; si no, se abre el módulo.
- Nada de `fetch` suelto.

**security-agent:** aplica (4 rutas nuevas con PII), en modo diff-scoped. **db-review:** no aplica.

## Riesgos

- **R1 (alto, afecta el AC8 de G1):** hoy `serializar()` guarda el texto del mensaje del usuario. Si el usuario escribe «estado de ABC123», la placa queda en `sessionStorage` aunque se excluyan las tarjetas. El diseño excluye también ese mensaje (ver Q1).
- **R2:** el formato del id FLIT no se puede distinguir en el código, así que F6 no lo detecta.
- **R3:** la cota de 40 por minuto es una estimación, sin telemetría.
- **R4:** `TarjetaSoat` tiene que funcionar con las dos ramas de `SoatColaItemSalida`. Un campo que solo existe en el interno rompe la vista del cliente.

## Preguntas abiertas (cambian comportamiento)

- **Q1 (AC8 de G1).** El AC dice «Vuelve a consultar con la opción de repetir la consulta», pero para repetir hace falta el valor, y guardarlo viola «el almacén no contiene placas». *Propuesta:* el marcador `gestionCaducada` se guarda sin valor. El botón «Vuelve a consultar» lleva el foco al campo de texto y el usuario reescribe la placa. El mensaje del usuario que disparó la consulta tampoco se guarda (R1).
- **Q2.** Si un mensaje trae **dos** valores (dos placas, o una placa y un VIN), ¿qué se hace? *Propuesta:* se ofrece consultar solo el primero que aparezca.
- **Q3 (P9-B).** ¿El PO o FLIT 1/2 pueden dar un formato canónico del id FLIT (prefijo fijo)? Sin él, el id FLIT queda fuera de la detección de F6. Los POST lo siguen aceptando por `buscar` y F4 puede enviarlo por intent. Si aparece el formato, basta con poner un valor en `PATRON_ID_FLIT` y cubrirlo con un test.
- **Q4.** ¿Se aceptan 40 POST por minuto por usuario (10 consultas completas)?

## Decisiones humanas de cierre (2026-10-22, David Chica)

| Pregunta | Decisión |
|---|---|
| Q3 / P9-B — formato del id FLIT | FLIT 1: `FLIT-0132456`; FLIT 2: `FT2-0000180`. Detector: `^(FLIT|FT2)-\d+$` (sin distinguir mayúsculas). Sustituye `PATRON_ID_FLIT = null`. |
| Q1 — recarga | Marcador sin valor «Consulta anterior» + «Volver a consultar» que lleva el foco a la caja. Ni las tarjetas ni el mensaje del usuario que disparó la consulta se guardan (R1). |
| Usuario sin módulos de consulta | **No** se ofrece la consulta; el mensaje sigue el flujo normal del panel. |
| Q4 — límite | 40 peticiones / 60 s por usuario, compartido por los 4 POST. |
| Q2 — varios valores | Se ofrece el primero (default de diseño, aceptado). |
| Tarjetas | No clicables; un enlace por grupo a la cola sin filtro (ux F6). |
