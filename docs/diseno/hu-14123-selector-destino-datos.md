# Diseño slim — HU #14123 · datos del selector de destino

HEAD de referencia: `942b59c7`. Pantalla: `docs/ux/logistica-selector-destino-14123-slim.md` (no se reabre).
Este documento solo traduce los tres datos que esa spec ya fijó y que este HEAD no devuelve.
Sin ellos no se cumplen AC1, AC2 y AC4. No hay tabla nueva, no hay ruta nueva, no se toca la escritura de la HU #14122.

## Patrón reutilizado

| Dato | Patrón ya en este HEAD |
|---|---|
| Precio por LT a FLIT | `precioTrasladoDe(companiaId, 'flit' \| 'cliente', ahora)` en `apps/api/src/modules/flito-logistica/flito-logistica-precios.ts`. Facetas ya llama el de `'cliente'` y copia solo `valor` (`flito-logistica.consulta.ts`, `precioEntregaCliente`). |
| O de dos funciones en un GET | Sonda `funcionesConcedidas` (no escribe denegado) y, si nadie pasa, un solo `tieneFuncion(req, '<literal>')`. Igual que `puedeAlguno` en `apps/api/src/modules/siigo/credenciales.routes.ts`. No se crea `exigirAlgunaFuncion`. |
| `punto` y `traslado_id` | Columnas de `flito_logistica_actas` (`schema.ts`). `punto` NOT NULL, check `organismo \| flit \| cliente`. `traslado_id` uuid **nullable**. El alta del viaje (#14122) siempre lo escribe; un acta anterior al viaje lo trae null. |

## Contrato delta

Mismos paths. Nada de cédula, nombre de firmante ni trazo. `receptorNombre` del listado de actas no se toca.

### 1. `GET /flito/logistica/facetas` — AC1

`companiasCerrables[]` (`CompaniaCerrableLogistica`) gana `precioEntregaFlit: number | null`, al lado de `precioEntregaCliente`.

- Misma fecha `ahora` para los dos destinos de la misma compañía.
- `precioTrasladoDe(…, 'flit', ahora)`: `null` si no hay vigencia; si hay, se copia `valor` (un `0` configurado sigue siendo `0`).
- El DTO no lleva `vigenciaId`. El de cliente no cambia de significado ni de llamada.

### 2. `GET /flito/logistica/motivos-llegada` — AC2

Sin ruta nueva. POST y PATCH siguen con `exigirFuncion('logistica.motivos.gestionar')` en la ruta.
El servicio `listarMotivos({ soloActivos })` no se cambia: `soloActivos === true` ya filtra activos.

El query que abre el O es **exactamente** la cadena `soloActivos=true` (`req.query.soloActivos === 'true'`). `false`, ausente, `TRUE` u otro valor siguen exigiendo `gestionar`.

| Quién llama | `?soloActivos=true` | Sin ese query, o con inactivos |
|---|---|---|
| `logistica.traslado.registrar` | 200, solo activos | 403 |
| `logistica.motivos.gestionar` | 200, solo activos | 200, catálogo completo |
| Ninguna de las dos | 403 | 403 |
| Sin token | 401 | 401 |

Orden dentro del GET:

1. Sin `req.user` → 401 `{ error: 'Token requerido' }`.
2. Si el query es `soloActivos=true` y `funcionesConcedidas(req, ['logistica.traslado.registrar', 'logistica.motivos.gestionar'])` no está vacío → 200. La sonda no registra denegado.
3. Si no, un solo `tieneFuncion(req, 'logistica.motivos.gestionar')`. Si es sí → 200. Si es no → 403 con `funcion: 'logistica.motivos.gestionar'`. Esa llamada ya escribe la bitácora de denegados: no invocar `exigirFuncion` en el mismo rechazo.

El catálogo completo no se abre a quien solo registra. El código de la denegación sigue siendo `gestionar` (no se siembra función nueva).

`flito-logistica-motivos.routes.ts` está en el inventario de guardas. El lector cuenta `exigirFuncion` solo entre la ruta y el handler, y `tieneFuncion(req, '…')` en cualquier punto del fichero; `funcionesConcedidas` no cuenta. Por eso el GET **deja** de llevar `exigirFuncion` en la posición de middleware (si lo conserva, quien solo registra recibe 403 antes del O) y el literal `tieneFuncion(req, 'logistica.motivos.gestionar')` queda en el fichero. Ajuste de foto, sin función nueva y sin migración:

| Pieza | Cambio |
|---|---|
| `catalogo-operaciones.ts` | La llave del GET pasa de `` `${LOGM} GET /` `` a `` `${LOGM} GET / [listar]` ``. Mismo código `logistica.motivos.gestionar`. La descripción dice que `?soloActivos=true` también lo llama quien tiene `logistica.traslado.registrar`. |
| `inventario.generado.ts` | La fila GET de motivos gana `condicion: 'listar'`. Los `roles: ['admin']` no se tocan (es la foto histórica; la paridad de roles sigue midiendo `gestionar`). |
| `permisos-rutas-reconducidas.ts` | La fila GET gana `condicion: 'listar'`. El lector la empareja como `tieneFuncion → logistica.motivos.gestionar`. |
| `permisos.reconduccion-cierre.test.ts` | Lista blanca + `flito-logistica/flito-logistica-motivos.routes.ts GET /` (7 → 8). Montajes en línea 30 → 31. El total de montajes sigue en 660. `logistica.motivos.gestionar` sigue en 4. |

No se añade una fila de inventario para `registrar`: el O es la sonda, y el código que la foto ya conoce es `gestionar`.

### 3. Ruta, listado y detalle — AC4

La escritura no se toca: `POST /traslados` y `POST /traslados/:id/entregar` (FLIT ya exige `logistica.actas.firmar_flit` y rechaza cédula y nombre de receptor). Estas lecturas **no** filtran filas por `firmar_flit`. Quien ya puede llamarlas sigue viendo el destino; la pantalla (cuando el mockup esté aprobado) esconde la llegada a FLIT si no tiene `logistica.actas.firmar_flit`. El uuid para confirmar es el `trasladoId` de la fila, en `POST /traslados/:id/entregar`.

`trasladoId: string | null`. Null no es `''` ni se omite. Un viaje de la #14122 lo trae; un acta vieja, null. Con null no hay llamada a entregar.

| Recurso | Guarda que ya tiene (no cambia) | Campos nuevos |
|---|---|---|
| `GET /flito/logistica/mi-ruta` | `logistica.ruta.ver` | Cada `entregas[]`: `destino: 'cliente' \| 'flit'` (el `punto` del acta) y `trasladoId`. El WHERE ya excluye `organismo`; no se añade `punto` además de `destino`. |
| `GET /flito/logistica/actas` | `logistica.actas.listar` | Cada fila (`ActaFila`): `punto: 'organismo' \| 'flit' \| 'cliente'` y `trasladoId`. El WHERE que ya excluye `organismo` se queda. |
| `GET /flito/logistica/actas/:id` | `logistica.actas.ver` | `acta` es un `ActaFila`, así que gana `punto` y `trasladoId` ahí (`acta.trasladoId`). El `punto` opcional de la raíz del detalle se queda como está. |

No seleccionar `receptorDocumento`, `contactoDocumento` ni claves de firma para estos campos.

## Archivos a crear/modificar

Modificar:

- `packages/shared-types/src/flito-logistica.ts` — `precioEntregaFlit` en `CompaniaCerrableLogistica`. El comentario de null ≠ 0 aplica a los dos precios.
- `apps/api/src/modules/flito-logistica/flito-logistica.consulta.ts` — precio FLIT en `facetas` (el objeto inicial de `agruparCerrables` también lo lleva en null); `punto` y `trasladoId` en el select de `listarActas` y en el `ActaFila` que arma `actaDetalle`; `destino` y `trasladoId` en `miRuta`.
- `apps/api/src/modules/flito-logistica/flito-logistica-motivos.routes.ts` — O del GET, como arriba. El import sigue trayendo `exigirFuncion` (POST/PATCH y el aserto del inventario).
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` — llave `[listar]` y la frase del O.
- `apps/api/src/modules/permisos/inventario.generado.ts` — `condicion: 'listar'` en el GET de motivos.
- `apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts` — la misma `condicion`.
- `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` — lista blanca 8; montajes en línea 31.
- `apps/api/__tests__/services/flito-logistica.facetas-cerrables.test.ts` — ver P1.
- `apps/api/__tests__/services/flito-logistica-motivos.routes.test.ts` — ver P1.

Crear:

- `apps/api/__tests__/services/flito-logistica.destino-traslado.dto.test.ts` — proyección de los tres GET. No ampliar `flito-logistica.test.ts`.

No modificar: `flito-logistica-precios.ts`, `flito-logistica-motivos.service.ts`, `flito-logistica-traslados*.ts`, `flito-logistica.routes.ts` (las rutas de lectura ya delegan), esquema, migraciones, árbol de permisos. La pantalla del selector no es este incremento.

`ActaFila` y `RutaEntrega` viven en el servicio, no en shared-types. El web que arma un `CompaniaCerrableLogistica` literal tendrá que poner `precioEntregaFlit` cuando se typee contra el contrato; los mocks E2E sin ese tipo no compilan por este campo. No construir aquí el selector.

## ADR: no aplica

No hay tabla, contrato de módulo nuevo ni precedente de auth distinto del O que ya usa Siigo. La foto de guardas se ajusta; no se siembra función.

## Notas operativas (backend)

- Por compañía, en el mismo `Promise.all` y la misma `ahora`: primero `'cliente'`, luego `'flit'`. Índice `i * 2` y `i * 2 + 1`. No serializar más de lo que facetas ya hace.
- `miRuta`: leer `punto`, exponerlo como `destino`. No renombrar la columna.
- Tests P1 (esta lista, sin el directorio del módulo, sin mutantes):

```bash
npm test -w apps/api -- \
  __tests__/services/flito-logistica.facetas-cerrables.test.ts \
  __tests__/services/flito-logistica-motivos.routes.test.ts \
  __tests__/services/flito-logistica.destino-traslado.dto.test.ts \
  __tests__/services/permisos.reconduccion-cierre.test.ts \
  __tests__/services/permisos.paridad-reconduccion.test.ts \
  __tests__/services/permisos-catalogo.test.ts
npm run build -w packages/shared-types
```

  `paridad` y `permisos-catalogo` entran porque el GET sale de `exigirFuncion` de ruta y pasa a `tieneFuncion`; si no se actualiza la foto, esos dos quedan rojos por este cambio.

- Aserto de facetas: las dos compañías del caso null-vs-0 tienen `precioEntregaFlit` null y `0` respectivamente, sin coercer; el JSON no contiene `vigenciaId`; `precioEntregaCliente` conserva sus valores; las llamadas son `(id, 'cliente', Date)` y `(id, 'flit', Date)`.
- Aserto de motivos: token solo con `logistica.traslado.registrar` → 200 en `?soloActivos=true`, 403 en GET sin query y en `?soloActivos=false`, 403 en POST y en PATCH. Quien tiene `gestionar` sigue como los casos AC3 y AC6. Sin token, 401.
- Aserto del DTO nuevo: una fila de listado trae `punto` y `trasladoId` (incluido `null`) y el mismo `receptorNombre`; una entrega de `miRuta` trae `destino` y `trasladoId` y no trae `punto` ni cédula; `actaDetalle` trae `acta.trasladoId` y no añade firmante ni trazo.

## Notas operativas (frontend)

No implementa esta pasada. Cuando el mockup esté aprobado, la tarjeta lee `precioEntregaFlit` (null no se pinta como $0), el modal de FLIT pide `GET …/motivos-llegada?soloActivos=true` con la sesión de quien registra, y la llegada usa `trasladoId` contra `POST /traslados/:id/entregar` solo si hay uuid y `hasFuncion('logistica.actas.firmar_flit')`. Sin cédula en ese camino: el POST de FLIT ya lo rechaza.

```
HANDOFF
  Modo: slim
  Resultado: OK
  Decisión recomendada: extender facetas, el GET de motivos y los tres DTO de actas/ruta sobre el código de este HEAD
  ADR: no aplica
  Archivos: packages/shared-types/src/flito-logistica.ts; apps/api/src/modules/flito-logistica/flito-logistica.consulta.ts; apps/api/src/modules/flito-logistica/flito-logistica-motivos.routes.ts; apps/api/src/modules/permisos/catalogo-operaciones.ts; apps/api/src/modules/permisos/inventario.generado.ts; apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts; apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts; apps/api/__tests__/services/flito-logistica.facetas-cerrables.test.ts; apps/api/__tests__/services/flito-logistica-motivos.routes.test.ts; apps/api/__tests__/services/flito-logistica.destino-traslado.dto.test.ts (nuevo)
  Siguiente: backend-agent, cuando el hilo tenga el ok humano del mockup
  Pendiente humano: el ok del mockup de docs/ux/logistica-selector-destino-14123-slim.md
```
