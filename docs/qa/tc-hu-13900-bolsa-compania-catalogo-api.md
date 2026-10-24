# TCs — HU #13900 · [BACKEND] – Bolsas: crear, editar, inactivar y reactivar la bolsa de una compañía

> **qa-agent modo A** · contexto `desarrollo-gate` · 2026-10-23 · Feature #13886 · HU `Active`.
> **Fuente de los AC:** AC1–AC10 que el hilo pegó textualmente desde ADO. En esta invocación no se consultó ADO
> (el hilo pidió no tocar ADO ni usar REST). Si el Gherkin de ADO #13900 cambia antes del modo B, manda ADO y esta
> matriz se ajusta.
> **Diseño:** `docs/arquitectura/feature-13886-13887-bolsa-unica.md`: «Contrato de endpoints», tipos
> `CrearBolsaDto` / `EditarBolsaDto` / `BuscarBolsasDto` / `BolsaResumenDto` / `EstadoBolsaCompaniaDto`, fila HU-B
> de «Archivos a crear/modificar», migración `0252_flito_bolsas_permisos.sql` y «Nota de verificación: rutas y
> montajes». **ADR:** `docs/adr/ADR-0029-flito-bolsa-unica-descuento-al-aplicar-comprobante.md`.
> **Implementación:** `backend-agent` en `/home/david/flit/flito-hu13900` (en paralelo). La base es la HU-A #13899
> (`8b53ff20`): `flito-bolsas.estado-compania.ts` y `flito-bolsas.libro.ts` ya existen. Este documento no escribe
> código ni ADO.
> **Alcance:** solo la API (`alcance: 'compania'`). La rama tránsito del formulario único, `bolsas.transito.inactivar`
> y las rutas `/bolsa/:bolsaId/cierres` de tránsito son de la HU-G (#13907); los TCs de tránsito se citan solo como
> borde de validación.

## Datos de prueba (sintéticos)

No se usa ningún NIT, nombre ni usuario real. Los `uuid` son fijos en la fixture.

| Dato | Valor | Uso |
|---|---|---|
| `CX` | Compañía id `9101` «Compañía Sintética Equis», NIT `900000101`, **sin** bolsa | AC1, AC3, AC8, AC9 |
| `CY` | Compañía id `9102` «Compañía Sintética Ye», NIT `900000102`. Bolsa `BY` = `22222222-…-0002`, activa, conceptos `{soat}`, saldo `150000.00` | AC4, AC5, AC6, AC9, AC10 |
| `CZ` | Compañía id `9103` «Compañía Sintética Zeta». Bolsa `BZ` = `22222222-…-0003`, **inactiva** (motivo «Inactivada para prueba», `inactivada_por_nombre` «QA Sintético»), saldo `80000.00` | AC2, AC4, AC5, AC6, AC7, AC10 |
| `CW` | Compañía id `9104`. Bolsa `BW` activa | AC7 (fila que el filtro `activa:false` debe excluir) |
| `BT` | Bolsa de tránsito activa (`alcance='transito'`, `compania_id NULL`, nombre «Bolsa Organismo Sintético») | AC7 (fila que el filtro `alcance:'compania'` debe excluir) |
| `9999` | Id de compañía inexistente | AC3 |
| `uAdmin` | Usuario sintético `id 7101` «QA Sintético», sin enlace, con las funciones nuevas | AC1–AC8, AC10 |
| `uSinFn` | Usuario sintético `id 7102`, sin enlace, **sin** `bolsas.bolsa.crear` ni `bolsas.bolsa.listar` | AC9 |
| `uEnlaceX` | Usuario sintético `id 7103` con enlace a la compañía `CX` (`9101`) y las funciones de lectura | AC9 |

Motivos: «Cliente suspende el servicio» (≥ 5) y «abc» (< 5).

## Matriz AC → TC

| AC | TC | Tipo | Archivo de test destino | Resultado |
|---|---|---|---|---|
| AC1 | TC-01, TC-02 | happy | `flito-bolsas-catalogo.test.ts`, `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC2 | TC-03, TC-04 | error / borde | `flito-bolsas-catalogo.test.ts`, `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC3 | TC-05, TC-06, TC-07 | error | `flito-bolsas-catalogo.routes.test.ts` (+ service para el 404) | pendiente |
| AC4 | TC-08, TC-09, TC-10 | happy / error | `flito-bolsas-catalogo.test.ts`, `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC5 | TC-11, TC-12, TC-13 | happy / error | `flito-bolsas-catalogo.test.ts`, `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC6 | TC-14, TC-15 | happy / error | `flito-bolsas-catalogo.test.ts` | pendiente |
| AC7 | TC-16, TC-17, TC-18 | happy / borde | `flito-bolsas-catalogo.test.ts`, `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC8 | TC-19, TC-20 | borde | `flito-bolsas-catalogo.routes.test.ts` | pendiente |
| AC9 | TC-21, TC-22, TC-23, TC-24 | seguridad | `flito-bolsas-catalogo.routes.test.ts` + test de la migración `0252` | pendiente |
| AC10 | TC-25, TC-26 | error / regresión | `flito-bolsas-catalogo.routes.test.ts`, `flito-bolsas.test.ts` | pendiente |
| Inventario de rutas | TC-27, TC-28, TC-29, TC-30, TC-31 | gate | `frontera-en-seco`, `frontera-enlace.centinela`, `permisos.paridad-reconduccion`, `permisos.reconduccion-cierre` + fixture | pendiente |

Todos `pendiente`: es el modo A; se ejecutan en el modo B, después de la impl P1. Los paths de test son relativos a
`apps/api/__tests__/services/`. Los nombres `flito-bolsas-catalogo*.test.ts` son los del diseño. Si el
`backend-agent` usa otros, los declara en su HANDOFF y el modo B usa los suyos.

---

### AC1 — `POST /api/flito/bolsas` compañía → 201, activa, saldo 0, evento «crear» con el usuario

`describe('crearBolsa — AC1: la bolsa de una compañía nace activa y en cero', …)`

**TC-01 · `it('crea la bolsa de compañía con soat e impuesto: activa, saldo 0, sin nombre, y deja el evento crear')`** (service)
- Pre: `CX` sin bolsa; `ctx = uAdmin`.
- Pasos: `crearBolsa({ alcance:'compania', companiaId:9101, conceptos:['soat','impuesto'] }, ctx)`.
- Esperado: 1 fila en `flito_bolsas_unicas` con `alcance='compania'`, `compania_id=9101`, `activa=true`,
  `saldo='0.00'`, `nombre IS NULL`, `inactivada_* NULL`. `flito_bolsas_unicas_conceptos` de esa bolsa es
  **exactamente** `{soat, impuesto}`. Hay 1 fila en `_eventos` con `accion='crear'`, `usuario_id=7101` y
  `usuario_nombre='QA Sintético'`. El `snapshot` del evento no contiene `900000101`.
- Borde: `estadoBolsaDeCompania(9101)` pasa a `{existe:true, activa:true}`.

**TC-02 · `it('POST /api/flito/bolsas → 201 con BolsaDetalleDto')`** (ruta, supertest)
- Esperado: `201`. El cuerpo tiene `alcance:'compania'`, `companiaId:9101`, `companiaNombre` no vacío, `activa:true`,
  `saldo:0`, `conceptos` igual a `['soat','impuesto']` (sin importar el orden), `inactivadaEn:null`,
  `motivoInactivacion:null` y `id` con forma de `uuid`.

### AC2 — Compañía que ya tiene bolsa (aunque inactiva) → 409 `bolsa_compania_existe` `{bolsaId, activa:false}`

**TC-03 · `it('crear la bolsa de una compañía con bolsa inactiva → 409 bolsa_compania_existe {bolsaId, activa:false}')`**
- Pre: `CZ` con `BZ` inactiva.
- Esperado (ruta): `409`, `codigo:'bolsa_compania_existe'` y un detalle con `bolsaId = BZ` y `activa:false`.
  El aserto es sobre la forma que fije el contrato: `toMatchObject` sobre las dos claves, no solo sobre el código.
- Esperado (BD): el conteo de `flito_bolsas_unicas`, `_conceptos` y `_eventos` es el mismo antes y después. `BZ`
  queda intacta (sigue inactiva y con sus conceptos).

**TC-04 · `it('con la bolsa activa también 409, con activa:true')`** (borde)
- Pre: `CY` con `BY` activa → `409 bolsa_compania_existe`, `{bolsaId: BY, activa:true}`.
- Borde de carrera (mismo `it` o uno hermano): dos `crearBolsa` concurrentes de `CX` dejan una sola fila. El
  segundo recibe `409 bolsa_compania_existe` y no un 500 por la violación de `uq_flito_bolsas_unicas_compania`.
  Hay que traducir el `23505`, no dejarlo crudo.

### AC3 — Sin conceptos o con gmf → 400 `datos_invalidos`; compañía inexistente → 404

`describe('POST /api/flito/bolsas — AC3: validación', …)`

**TC-05 · `it.each` de cuerpos inválidos → 400 `datos_invalidos`**
- `conceptos: []`
- sin la clave `conceptos`
- `conceptos: ['soat','gmf']`
- `conceptos: ['gmf']`
- `conceptos: ['soat','soat']` (duplicado). Si el diseño lo acepta deduplicando, el `backend-agent` lo declara y el
  caso pasa a «deja `{soat}`».
- `companiaId: 'abc'` o `companiaId: -1`
- Esperado: `400`, `codigo:'datos_invalidos'`, 0 filas nuevas y sin el error de Zod en crudo en el cuerpo.

**TC-06 · `it('compañía inexistente (9999) → 404 y no crea nada')`**
- Esperado: `404`. 0 filas en `flito_bolsas_unicas`, `_conceptos` y `_eventos`. El mensaje no lleva el id en forma de
  NIT.

**TC-07 · `it('el alcance es obligatorio y solo compania|transito')`** (borde)
- `alcance` ausente o `alcance:'cliente'` → `400 datos_invalidos`. Con `alcance:'compania'` y además `nombre` u
  `organismos` en el body, las claves de tránsito no llegan a la fila (`nombre` sigue `NULL`). Puede ser porque el
  esquema es `strict` o porque las ignora; el test fija lo que el impl decida y lo declara.

### AC4 — PATCH de conceptos sin tocar compañía ni alcance; evento «editar» con antes/después; inactiva → 409

`describe('editarBolsa — AC4', …)`

**TC-08 · `it('PATCH soat → soat + derecho conserva compañía y alcance y deja el evento editar con antes y después')`**
- Pre: `BY` activa con `{soat}`.
- Pasos: `PATCH /api/flito/bolsas/bolsa/BY` con `{ alcance:'compania', conceptos:['soat','derecho'] }`.
- Esperado: `200`. `_conceptos` de `BY` queda exactamente en `{soat, derecho}`. `compania_id=9102`,
  `alcance='compania'` y el saldo no cambian. Hay 1 evento `accion='editar'` cuyo snapshot contiene el antes
  (`['soat']`) y el después (`['soat','derecho']`), con el usuario.

**TC-09 · `it('el PATCH no puede cambiar la compañía ni el alcance aunque vengan en el body')`** (borde)
- Body `{ alcance:'transito', conceptos:['derecho'] }` o `{ …, companiaId: 9101 }` → `400 datos_invalidos`, o bien se
  ignoran. En los dos casos, después del PATCH `BY` sigue con `compania_id=9102` y `alcance='compania'`.
  El impl declara cuál de las dos variantes eligió.
- `conceptos: []` o `['gmf']` → `400 datos_invalidos` (la misma regla que en AC3).

**TC-10 · `it('PATCH sobre una bolsa inactiva → 409 bolsa_inactiva y no cambia nada')`**
- Pre: `BZ` inactiva.
- Esperado: `409 bolsa_inactiva`. Los conceptos de `BZ` y los eventos no cambian (no hay evento `editar`).
- `PATCH` sobre un `uuid` inexistente → `404`.

### AC5 — Inactivar guarda quién/cuándo/motivo, conserva saldo, deja evento; dos veces → 409; motivo < 5 → 400

`describe('inactivarBolsa — AC5', …)`

**TC-11 · `it('inactivar con motivo guarda quién, cuándo y el motivo, conserva el saldo y deja el evento')`**
- Pre: `BY` activa, saldo `150000.00`.
- Pasos: `POST /api/flito/bolsas/bolsa/BY/inactivar` `{ motivo:'Cliente suspende el servicio' }`.
- Esperado: `200` con `activa:false`, `inactivadaEn` no nulo (ISO), `inactivadaPorNombre:'QA Sintético'` y
  `motivoInactivacion:'Cliente suspende el servicio'`. En BD, `inactivada_por_id=7101` y `saldo='150000.00'` sin
  cambios. No hay movimientos nuevos. Hay 1 evento `accion='inactivar'` con el motivo.

**TC-12 · `it('inactivar dos veces → 409 ya_inactiva, sin segundo evento')`**
- Pre: `BZ` inactiva → `409 ya_inactiva`. El `inactivada_en` y el motivo originales no se pisan y el número de
  eventos no cambia.

**TC-13 · `it.each` de motivos inválidos → 400**
- `'abc'` (3), `'    abcd   '` (4 caracteres útiles tras `trim`; si el impl no recorta, lo declara), `''` y el
  body sin `motivo`.
- Esperado: `400 datos_invalidos` y la bolsa sigue activa.
- Borde: un motivo de exactamente 5 caracteres (`'abcde'`) → `200`. Así se fija el límite inclusivo `≥5`.

### AC6 — Reactivar deja evento; reactivar una activa → 409 `ya_activa`

`describe('reactivarBolsa — AC6', …)`

**TC-14 · `it('reactivar una bolsa inactiva la deja activa y deja el evento reactivar')`**
- Pre: `BZ` inactiva, saldo `80000.00`.
- Pasos: `POST …/bolsa/BZ/reactivar` `{ motivo:'Cliente retoma el servicio' }`.
- Esperado: `200 activa:true`. El saldo sigue en `80000.00` y hay 1 evento `accion='reactivar'` con el usuario.
  El diseño no dice si se limpian los `inactivada_*`: el test fija lo que decida el impl y el HANDOFF lo declara.
  La traza ya queda en los eventos, así que cualquiera de las dos opciones vale.
- Borde: el diseño pide `{ motivo }` también al reactivar. Un motivo < 5 → `400`, igual que en TC-13.

**TC-15 · `it('reactivar una bolsa activa → 409 ya_activa, sin evento')`**
- Pre: `BY` activa → `409 ya_activa` y el número de eventos no cambia.

### AC7 — `POST /buscar` `{alcance:'compania', activa:false}` → solo inactivas, con `companiaId` y `companiaNombre`; nada por query

`describe('POST /api/flito/bolsas/buscar — AC7', …)`

**TC-16 · `it('{alcance:compania, activa:false} trae solo BZ, con companiaId y companiaNombre')`**
- Pre: `BY` y `BW` activas, `BZ` inactiva y `BT` de tránsito.
- Esperado: `200`. El arreglo de ids es exactamente `[BZ]`. La fila tiene `alcance:'compania'`, `companiaId:9103`,
  `companiaNombre:'Compañía Sintética Zeta'` y `activa:false`.
- Debe matar el mutante MB-2.

**TC-17 · `it('sin filtros trae todas; con alcance compania nunca trae tránsito; companiaId no nulo ⇔ compania')`** (borde)
- `{}` → se incluye `BT` con `companiaId:null`.
- `{alcance:'compania'}` → no aparece `BT`.
- En todas las filas, `companiaId !== null` si y solo si `alcance === 'compania'` (contrato (c) para #13407).
- `{texto:'Zeta'}` → `[BZ]`. El texto viaja en el body.

**TC-18 · `it('los filtros por query se ignoran o se rechazan: ninguno filtra')`** (borde, PII)
- `POST /api/flito/bolsas/buscar?activa=false&texto=900000103` con body `{}`: el resultado es igual al de `{}` sin
  query, o es un `400`. En ningún caso filtra por la query.
- `GET /api/flito/bolsas/buscar` no existe como listado. Con el router actual, `/buscar` lo atraparía
  `GET /:companiaId`: el resultado esperado es `404` o `400` (id no numérico), nunca un `200` con una lista.
- Inspección del modo B: `grep -n "req.query" apps/api/src/modules/flito-bolsas/flito-bolsas.catalogo.routes.ts` → sin
  resultados.
- `{ activa:'false' }` (string) → `400 datos_invalidos`. El esquema no hace coerción de la query.

### AC8 — `GET /compania/:id/estado` → 200 `{existe:false, activa:false}`, no 404

`describe('GET /api/flito/bolsas/compania/:companiaId/estado — AC8', …)`

**TC-19 · `it('compañía sin bolsa → 200 {existe:false, activa:false}')`**
- `CX` sin bolsa → `200`, cuerpo `toEqual({ existe:false, activa:false })` estricto, sin claves extra.
- Debe matar el mutante MB-3.

**TC-20 · `it.each` de los otros dos estados y del orden del router** (borde)
- `CY` → `{existe:true, activa:true}`. `CZ` → `{existe:true, activa:false}`.
- **Orden:** la ruta va antes de `/:companiaId`. `GET /api/flito/bolsas/compania/9101/estado` no puede caer en
  `GET /:companiaId` (que daría 400 o 404 por `'compania'` no numérico). Lo cubre el propio `200` de TC-19.
- `GET /compania/abc/estado` → `400 datos_invalidos`.

### AC9 — Sin función → 403; enlace a X solo ve X, detalle de Y → 404; permisos a los roles con su par, sin `operaciones`

`describe('frontera y permisos del catálogo — AC9', …)` (con el helper `__tests__/helpers/auth.ts`, sin mocks
de `exigirFuncion`)

**TC-21 · `it.each` de las rutas nuevas con `uSinFn` → 403**
- Casos: `POST /buscar`, `POST /` (compania), `GET /bolsa/:id`, `PATCH /bolsa/:id`, `POST /bolsa/:id/inactivar`,
  `POST /bolsa/:id/reactivar`, `GET /compania/:id/estado` y `POST /bolsa/:id/recargas`.
- Esperado: `403` y 0 escrituras.

**TC-22 · `it('usuario con enlace a X: /buscar solo devuelve la bolsa de X aunque pida otra cosa en el body')`**
- Pre: `CX` con bolsa, `CY` con `BY`; el usuario es `uEnlaceX`.
- `POST /buscar {}` → solo la fila de `9101`. `{texto:'Ye'}` → `[]`. `{alcance:'transito'}` → `[]` o `403`
  (tránsito es `soloSinEnlace`); el impl declara cuál de los dos.
- `GET /compania/9102/estado` → `404`. No vale `200 {existe:…}`, porque eso filtraría la existencia de la bolsa de Y.

**TC-23 · `it('detalle, edición, inactivar, reactivar y recargas de la bolsa de Y con enlace a X → 404')`**
- `GET`, `PATCH`, `/inactivar`, `/reactivar` y `/recargas` sobre `/bolsa/BY` → `404` (la guarda `bolsaPropia`
  resuelve bolsa → compañía). No vale un `403` que confirme que existe, y `BY` no cambia.
- `GET /bolsa/BT` (tránsito) con `uEnlaceX` → `404` o `403`. Nunca `200`.
- Debe matar el mutante MB-1.

**TC-24 · `it('0252 concede cada función nueva exactamente a los roles que tienen su par, y a operaciones no')`**
(test de la migración: patrón de los tests de reparto 0235 / el «plegadas las migraciones» de `permisos.paridad-reconduccion`)
- Funciones nuevas: `bolsas.bolsa.listar`, `bolsas.bolsa.crear`, `bolsas.bolsa.editar` y `bolsas.bolsa.inactivar`
  (esta última cubre también reactivar).
- Esperado: el conjunto de roles con cada función nueva es igual al conjunto con su par. El par lo declara el
  `backend-agent` en el SQL y en el test, por ejemplo `listar ↔ bolsas.bolsa.ver` y
  `crear/editar/inactivar ↔ bolsas.transito.crear/editar` o `bolsas.recarga.registrar`. El test nombra el par.
- Ninguna fila de concesión nombra `operaciones`
  (`grep -n "operaciones" apps/api/src/db/migrations/0252_*.sql` → sin resultados).
- Correr `0252` dos veces no duplica filas (`ON CONFLICT DO NOTHING`). P6 manual, dos pasadas con `psql` sobre la BD
  local.
- Los 4 códigos están en `catalogo-operaciones.ts`, `arbol/acciones-finanzas.ts`, `inventario-guardas.ts` e
  `inventario.generado.ts`. Cualquier desfase lo detectan los tests de inventario (TC-29/TC-30).

### AC10 — `POST /bolsa/:id/recargas` sobre inactiva → 409 `bolsa_inactiva`, sin cambio de saldo

**TC-25 · `it('recargar /bolsa/BZ (inactiva) → 409 bolsa_inactiva; saldo, movimientos y soporte intactos')`**
- Pre: `BZ` inactiva, saldo `80000.00`. Multipart con un soporte PDF sintético válido.
- Esperado: `409 bolsa_inactiva`. El saldo sigue en `80000.00`, hay 0 movimientos nuevos y el soporte **no** se
  sube a MinIO ni se registra. Si el multer lo acepta antes del 409, el archivo temporal se descarta.
- Debe matar el mutante MB-1 alternativo (ver § Mutantes).

**TC-26 · `it('recargar /bolsa/BY (activa) suma al saldo igual que /:companiaId/recargas')`** (regresión)
- Esperado: `201` o el código actual de la recarga. Hay 1 movimiento `entrada` `origen='recarga'` en `BY` y el saldo
  sube en el valor. La ruta vieja `POST /:companiaId/recargas` sigue en verde con sus tests de `flito-bolsas.test.ts`
  (incluidos `bolsa_inexistente` y `bolsa_inactiva` de la HU-A).

---

## Inventario y frontera de rutas (nota de verificación del diseño)

La HU monta rutas nuevas en el router de `flito-bolsas`: un sub-router `flito-bolsas.catalogo.routes.ts` montado
**antes** de `/:companiaId`. Según el AC y el contrato, las rutas son estas:

| # | Método y ruta (bajo `/api/flito/bolsas`) | Función | Guarda de frontera |
|---|---|---|---|
| 1 | `POST /buscar` | `bolsas.bolsa.listar` | filtra (enlace implícito) |
| 2 | `POST /` | `bolsas.bolsa.crear` (compania) — tránsito sigue en `POST /transito` hasta G | `companiaPropia('escribir')` sobre `body.companiaId` o `soloSinEnlace`; el impl declara cuál |
| 3 | `GET /bolsa/:bolsaId` | `bolsas.bolsa.ver` | `bolsaPropia('leer')` |
| 4 | `PATCH /bolsa/:bolsaId` | `bolsas.bolsa.editar` | `bolsaPropia('escribir')` |
| 5 | `POST /bolsa/:bolsaId/inactivar` | `bolsas.bolsa.inactivar` | `bolsaPropia('escribir')` |
| 6 | `POST /bolsa/:bolsaId/reactivar` | `bolsas.bolsa.inactivar` | `bolsaPropia('escribir')` |
| 7 | `GET /compania/:companiaId/estado` | `bolsas.bolsa.ver` | `companiaPropia('leer')` |
| 8 | `POST /bolsa/:bolsaId/recargas` | `bolsas.recarga.registrar` | `bolsaPropia('escribir')` + `recibirSoporte` |

El contrato también lista `GET /bolsa/:bolsaId/movimientos` y `GET|POST /bolsa/:bolsaId/cierres`, pero ningún AC de
esta HU los exige. Si el diff los monta, entran en el conteo y el `backend-agent` los declara. **Delta esperado:
+8 montajes** (o +8 más los que declare).

**TC-27 · `frontera-en-seco.test.ts` (TC-09b)**
- `montajesDeAppTs` sigue viendo un único `{ prefijo:'/api/flito/bolsas', modulo:'bolsas' }`. El sub-router se monta
  dentro de `flito-bolsas.routes.ts`, no en `app.ts`, así que la lista de prefijos de `app.ts` **no cambia**. Si el
  impl monta el catálogo en `app.ts` con otro prefijo, es una desviación del diseño y hay que justificarla en el
  HANDOFF.
- El `abiertos` de `compania` sigue incluyendo `'bolsas'`. Se espera el test en verde sin editarlo. Si hubo que
  editarlo, el diff debe explicar por qué.

**TC-28 · `frontera-enlace.centinela.test.ts`**
- La tabla de decisiones (L333 y siguientes) tiene una fila por cada una de las 8 rutas nuevas, con la ruta completa
  y su decisión: `'filtra'` en las de `companiaPropia`/`bolsaPropia`/`/buscar`, y `'soloSinEnlace'` si `POST /` lo
  usa.
- El test `HU #13426 — la decisión escrita de cada ruta es la del código` pasa: si la fila dice `soloSinEnlace`, la
  ruta lleva esa guarda, y al revés.
- El test «una ruta nueva obliga a decidir» (`rutasAbiertas`) pasa con la lista actualizada.
- «Ningún prefijo le da un 2xx a un usuario de compañía fuera de lo declarado» sigue en verde.

**TC-29 · `permisos.paridad-reconduccion.test.ts` + fixture `__tests__/fixtures/permisos-rutas-reconducidas.ts`**
- El fixture gana 8 filas `{ fichero:'flito-bolsas/flito-bolsas.catalogo.routes.ts', metodo, ruta, codigo }`
  (rutas relativas al sub-router: `/buscar`, `/`, `/bolsa/:bolsaId`…), con los códigos de la tabla anterior.
- «Cada fila tiene su código montado en el fuente y ningún montaje queda fuera de la lista» pasa.
- «Cada fila está en la foto» y «el SQL sembrado conoce cada código»: las 4 funciones nuevas vienen de `0252`, no
  de `0179 ∪ 0181`. El test debe ampliar el conjunto de SQL que lee, o eximir las funciones nuevas de forma
  explícita y comentada. **No vale** borrar la aserción.
- Las filas de las rutas que no cambian (`/:companiaId/*`, `/transito/*`) siguen tal cual.

**TC-30 · `permisos.reconduccion-cierre.test.ts`**
- `DIRECTORIOS_RECONDUCIDOS` sigue en **43**: `flito-bolsas` ya está en la lista.
- `FICHEROS_DE_RUTAS` pasa de **33 → 34** con el nuevo `flito-bolsas/flito-bolsas.catalogo.routes.ts`. Si el impl
  monta las rutas en `flito-bolsas.routes.ts` sin fichero nuevo, sigue en 33 y lo declara.
- En el nuevo fichero hay cero `requireRole(`, tampoco en comentarios ni en imports.
- Conteo de montajes: el total que el test fija hoy (`montajesDeFunciones()`) **+ 8**, con su comentario
  `+8 por la HU #13900 (catálogo de bolsas: buscar, crear, ver, editar, inactivar, reactivar, estado, recargas por
  bolsa)` en la misma lista de deltas. El modo B compara la diferencia entre `git diff develop` del número y el
  número de rutas del sub-router (`grep -cE "router\.(get|post|patch)\(" …catalogo.routes.ts`). Si no coinciden,
  es BLOQUEANTE.
- La lista blanca sigue en 6: ninguna ruta nueva va sin guarda de función.

**TC-31 · Orden de declaración** (inspección del modo B)
- `grep -nE "catalogo|router\.(get|post|patch)\('/:companiaId" apps/api/src/modules/flito-bolsas/flito-bolsas.routes.ts`:
  la línea del `router.use(catalogo…)` debe ser **menor** que la del primer `/:companiaId`. Lo prueban también
  TC-19 y TC-16 (sin el orden correcto devolverían 400/404).

---

## Mutantes previstos para el modo B (tope 3, P2)

| # | Mutación (temporal, en la rama de la HU) | Debe matarlo | Comando P1 |
|---|---|---|---|
| MB-1 | Quitar `bolsaPropia('escribir')` (o hacer que devuelva `next()` siempre) en `PATCH /bolsa/:bolsaId` y `POST /bolsa/:bolsaId/inactivar` | TC-23 (Y con enlace a X → 404) | `npm test -w apps/api -- __tests__/services/flito-bolsas-catalogo.routes.test.ts` |
| MB-2 | En `buscarBolsas`, ignorar `activa` del filtro (o quitar la condición `alcance`) | TC-16 (solo `[BZ]`) y TC-17 | `npm test -w apps/api -- __tests__/services/flito-bolsas-catalogo.test.ts __tests__/services/flito-bolsas-catalogo.routes.test.ts` |
| MB-3 | En la ruta de estado, responder `404` cuando `existe:false` (lo que haría un detalle normal) | TC-19 | `npm test -w apps/api -- __tests__/services/flito-bolsas-catalogo.routes.test.ts` |

Alternativas, si el modo B prefiere otra (el tope sigue siendo 3 y se declara el cambio):
- Quitar la comprobación de `activa` en `POST /bolsa/:id/recargas`; la mata TC-25.
- Quitar la traducción del 409 `bolsa_compania_existe` en `crearBolsa`; la matan TC-03 y TC-04 (el insert caería en
  el índice parcial y daría 500).

## Comandos del modo B (P1)

```bash
# Tests de ESTE WI: lista explícita, nada de glob del directorio
npm test -w apps/api -- \
  __tests__/services/flito-bolsas-catalogo.test.ts \
  __tests__/services/flito-bolsas-catalogo.routes.test.ts \
  __tests__/services/flito-bolsas.test.ts \
  __tests__/services/frontera-en-seco.test.ts \
  __tests__/services/frontera-enlace.centinela.test.ts \
  __tests__/services/permisos.paridad-reconduccion.test.ts \
  __tests__/services/permisos.reconduccion-cierre.test.ts
# + el test de la migración 0252 si el backend-agent lo crea aparte (y el de permisos/inventario que toque)

npm run lint
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
# shared-types (CrearBolsaDto, EditarBolsaDto, BuscarBolsasDto, BolsaResumenDto, BolsaDetalleDto, EstadoBolsaCompaniaDto):
npm run build -w packages/shared-types && npm run typecheck -w apps/web   # + grep de usos (regla 7)
# P6: 0252 dos veces sobre la BD local ya migrada (psql), salida pegada
```

`migrations/0252` en el diff ⇒ `db-review-agent`. Rutas nuevas y permisos ⇒ `security-agent` diff-scoped. Ninguno
de los dos es de este gate: los lanza el hilo en paralelo.

## Riesgos / notas para la implementación

- **Hueco 0251.** El repo llega hasta `0250` y la HU-B crea `0252` (`0251` es de la HU-F, tránsito). El runner aplica
  por nombre, así que un hueco no rompe nada. Pero si `0251` se mergea **después** de `0252`, en los ambientes ya
  migrados se aplicará fuera de orden: hay que confirmar que `0252` no depende de `0251`. Para el gate es una Nota,
  salvo que exista esa dependencia.
- **`exigirFuncionSegunAlcance` en `POST /`.** Si `inventario-guardas.ts` no admite una guarda que se resuelve en
  tiempo de petición, el diseño permite dos rutas (`POST /` compania y `POST /transito`). Esta HU solo exige la de
  compañía. El impl lo declara y TC-21, TC-28 y TC-29 usan el código fijo `bolsas.bolsa.crear`.
- **Existencia por canal lateral (AC9).** Con enlace, el estado de Y y el detalle de Y tienen que dar el **mismo**
  `404` que un id inexistente. Un `403` o un `{existe:true}` confirma la existencia y es BLOQUEANTE.
- **Inversión de un contrato ajeno:** ninguna. La HU-A ya hizo el cambio `bolsa_inexistente` de `/:companiaId/recargas`.
  En `flito-bolsas.test.ts` no se espera ninguna aserción de negocio reescrita, solo casos nuevos.
- **Fixtures compartidos con la Épica #13407.** El fixture `permisos-rutas-reconducidas.ts`, el centinela y el
  conteo de `reconduccion-cierre` también los toca #13407. Si hay conflicto en el rebase, se reconcilia el número
  sumando los dos deltas, sin elegir uno.
- Datos de la fixture 100 % sintéticos. NIT `9000001xx` y nombres «Compañía Sintética …»: TC-01 comprueba que el
  NIT no aparece en el snapshot de eventos.
