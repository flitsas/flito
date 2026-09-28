# Diseño slim — HU #12825 · Impuestos: encolar el análisis post-envío

Épica #12809 · Feature #12821 · Módulo **FLITO** `flito-impuestos` (`/api/flito/impuestos`), no el legacy `liquidacion`.
Estado: **Propuesto** (diseño slim, sin ADR).

> Ubicación: el repo guarda los diseños por HU en `docs/diseno-hu-<id>-<slug>.md` (hay 20+), no en `docs/diseno/`. Se sigue esa convención.

Alcance: columnas de estado del análisis, cola en memoria, limitador global de RUNT, recuperación y ruta de reintento.
**Fuera** (HUs siguientes): extracción de la factura (12826), semáforo + `comparacion_factura_runt` (12827), autocertificación (12828), dirección (12833), UI (12830). Aquí el trabajo del job es un **punto de extensión**, es decir, pasos que se registran desde fuera.

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Enum de estado en PG | `flitoImpuestoEstadoEnum` / `flitoComparendosSyncEstadoEnum` (`apps/api/src/db/schema.ts:2640`, `:4886`): el esquema FLITO usa **`pgEnum`**, no varchar con CHECK |
| Pool de concurrencia | `apps/api/src/shared/utils/con-concurrencia.ts` (sin dependencias, pool de obreros) |
| Barrido periódico con start/stop | `apps/api/src/modules/tramites/validacion-stale.cron.ts` (recupera `en_proceso` huérfanos, flag `*_ENABLED=0`, `setTimeout` inicial + `setInterval`) |
| Registro del cron | `apps/api/src/server.ts` (import + `start*` dentro del bloque `NODE_ENV === 'production'` + `stop*` en el apagado) |
| Ruta por id con guarda de función | `POST /:id/certificar` (`flito-impuestos.routes.ts:532`): `exigirFuncion` + `contextoImpuesto` + `switch` sobre el resultado + `audit(req)` |
| Catálogo de operaciones | `apps/api/src/modules/permisos/catalogo-operaciones.ts:98` (una `op(...)` por ruta) |
| Constante compartida web/API | `CONCURRENCIA_CERTIFICACION = 2` en `packages/shared-types/src/flito-certificacion.ts:156` |

No hace falta ninguna dependencia nueva: nada de BullMQ ni de Redis para la cola.

**Cuántas instancias corren (verificado).** La API corre en **un solo proceso**, lo que confirman tres fuentes:
- `apps/api/Dockerfile:86` arranca con `CMD ["node", "dist/server.js"]`, sin PM2 ni cluster.
- En `docker-compose.prod.yml`, el servicio `api` no tiene `deploy.replicas` ni `scale`.
- `ecosystem.config.cjs` tiene una sola app (`operaciones-system`) sin `instances` ni `exec_mode`, y PM2 por defecto corre en modo fork con 1 instancia.

Por eso un semáforo en memoria cumple «2 en vuelo en todo el proceso de la API». Descarté el semáforo distribuido en Redis (`src/shared/redis.ts`), por tres motivos:
- añade latencia y un modo de fallo (Redis caído bloquearía la certificación manual);
- exige un TTL o *lease* para los cupos huérfanos;
- no compra nada con una sola instancia.

La instancia única queda como **supuesto declarado**. Si se escala a más réplicas, el límite pasa a ser por instancia (N×2) y hará falta un ADR para moverlo a Redis (ver «ADR: no aplica»).

## 1. Modelo de datos: migración `0206_flito_impuestos_analisis.sql`

**Número esperado: `0206`** (el último en origin/develop es `0205_permisos_reagrupar_modulos.sql`). El backend lo confirma con `ls apps/api/src/db/migrations | tail -3` justo antes de crear el archivo, porque hay otra sesión en paralelo. SQL a mano e idempotente, y se comprueba aplicando ese archivo dos veces (P6).

```sql
DO $$ BEGIN
  CREATE TYPE flito_impuesto_analisis_estado AS ENUM ('en_curso', 'completado', 'error_analisis');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS analisis_estado       flito_impuesto_analisis_estado,          -- NULL = nunca encolado (histórico)
  ADD COLUMN IF NOT EXISTS analisis_encolado_en  timestamptz,
  ADD COLUMN IF NOT EXISTS analisis_reencolados  smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analizado_en          timestamptz;

CREATE INDEX IF NOT EXISTS idx_flito_impuestos_analisis_en_curso
  ON flito_impuestos (analisis_encolado_en) WHERE analisis_estado = 'en_curso';
```

- Espejo en `schema.ts`: `flitoImpuestoAnalisisEstadoEnum` junto a la línea 2640, las 4 columnas en `flitoImpuestos` (~3115-3150) y el índice parcial en el bloque de índices (`.where(sql\`…\`)`).
- **Sin backfill**: las filas históricas quedan en `NULL` y no se analizan solas.
- **No se toca `extraccion_factura_venta`** (jsonb, ya existe): ahí la 12826 guardará lo extraído, incluida la dirección con su confianza. Las columnas de dirección son de la 12833, en una migración aparte.
- **`semaforo` y `comparacion_factura_runt` se dejan para la 12827**, con su propia migración. Si se crean aquí se fija el contrato de una HU que aún no se diseñó (valores del semáforo, forma del jsonb) y la 12827 tendría que corregirlo con otra migración. Con una migración por HU basta.
- Antes de implementar hay que comprobar con `grep` contra `schema.ts` que ninguna de las 4 columnas exista ya. Un `ADD COLUMN IF NOT EXISTS` sobre una columna existente no hace nada y no avisa.

## 2. Cola en memoria: `flito-impuestos.analisis.service.ts` (archivo nuevo del módulo)

API exportada (firmas del contrato interno):

```ts
export type PasoAnalisis = (c: { impuestoId: string; runt: LimitadorRunt }) => Promise<void>;
export function registrarPasoAnalisis(nombre: string, paso: PasoAnalisis): void; // 12826/12827/12828 se enganchan aquí
export function encolarAnalisis(ids: string[]): void;                         // síncrona, no bloquea
export async function ejecutarAnalisis(id: string): Promise<'completado' | 'error_analisis' | 'omitido'>;
export async function barrerAnalisisHuerfanos(ahora = new Date()): Promise<{ reencolados: number; fallidos: number }>;
export async function reanalizarImpuesto(id: string, ctx: ImpuestoCtx): Promise<ResultadoReanalisis>;
export function __resetColaAnalisis(): void; // solo tests
```

- **Estado en memoria:** un `pendientes: string[]` en orden FIFO y un `enCola: Set<string>`. `encolarAnalisis` descarta los ids que ya están en `enCola`, así que **un id nunca tiene dos jobs** en el proceso. Después programa el drenado con `setImmediate`. El drenado usa como mucho `CONCURRENCIA_CERTIFICACION` obreros, con el mismo esquema que `conConcurrencia`. Las consultas al RUNT van además por el limitador global de la sección 3. El id sale de `enCola` en el `finally` del job.
- **`ejecutarAnalisis(id)`:**
  1. Lee `analisis_estado`, `analisis_encolado_en` y `analizado_en`. Si la fila no está `en_curso`, devuelve `omitido`.
  2. **Idempotencia (AC2):** si `analizado_en IS NOT NULL AND analizado_en >= analisis_encolado_en`, devuelve `omitido` y no ejecuta ningún paso, ni OCR ni RUNT. Esto cubre el job duplicado. El reintento manual y la recuperación mueven `analisis_encolado_en` a `ahora`, así que ese job sí corre. Resultado: **no hace falta una columna `forzar`**.
  3. Ejecuta los pasos registrados en orden. Si todos terminan bien: `UPDATE … SET analisis_estado='completado', analizado_en = <ahora solo si corrió ≥1 paso> WHERE id=$1 AND analisis_estado='en_curso'`. Si la lista de pasos está vacía (caso de esta HU), **`analizado_en` no se toca**. Así, los impuestos enviados entre el deploy de la 12825 y el de la 12826 no quedan marcados como «ya analizados» sin haberlo sido.
  4. Si algún paso falla: `SET analisis_estado='error_analisis' WHERE … AND analisis_estado='en_curso'`, `log.warn({ impuestoId, err })` **sin PII** (ni placa, ni documento, ni payload) y el job sale sin relanzar. Ningún fallo sale del obrero, así que **los demás jobs siguen (AC3)**.
- **Enganche después del commit** (`enviarAlGestor`, `flito-impuestos.service.ts:618`):
  - El `SELECT … FOR UPDATE SKIP LOCKED` pide también `analizadoEn`. Dentro de la **misma** transacción, `marcarEnCursoEnTx(tx, filas)` (exportada desde `flito-impuestos.analisis.service.ts` para no hacer crecer el service) ejecuta un segundo `UPDATE` que pone `analisis_estado='en_curso', analisis_encolado_en=ahora, analisis_reencolados=0` **solo** en los ids que tienen `analizado_en IS NULL`. A los ya analizados (reenvío tras reversa o reactivación) no se les toca ni el estado ni el semáforo (AC2).
  - El callback devuelve `{ idsEnviados, porAnalizar }`, y `encolarAnalisis(porAnalizar)` se llama **después** de que `db.transaction` resuelve, fuera del callback. Si la transacción lanza, no se encola nada.
  - La respuesta HTTP no cambia: sigue siendo `{ enviados, yaEnviados }`.
  - Costo en líneas del service: 4 o menos.

## 3. Limitador global de RUNT

- **Genérico** en `apps/api/src/shared/utils/limitador.ts`: `crearLimitador(max)` devuelve `{ ejecutar<T>(fn): Promise<T>; enVuelo(): number }`. Es un semáforo FIFO que libera en `finally` y deja pasar el error a quien llamó. Va al lado de `con-concurrencia.ts` y tampoco tiene dependencias.
- **Instancia única** en `apps/api/src/modules/flito-impuestos/runt-limitador.ts`: `export const limitadorRunt = crearLimitador(CONCURRENCIA_CERTIFICACION)` y el tipo `LimitadorRunt`. Vive en el módulo porque la AC3 habla de impuestos (cola + certificación manual y por lote).
- **Consumo:** en `certificarImpuesto` (`certificacion.service.ts:~193-206`) la llamada `consultarVehiculoRunt(...)` pasa a `limitadorRunt.ejecutar(() => consultarVehiculoRunt(...))`. **Se envuelve solo la llamada al RUNT**, no la certificación entera. Los pasos de la cola reciben `runt` por parámetro, y la 12827 lo usa con `runt.ejecutar(...)`.
- **`conConcurrencia` en `certificarLote` no cambia.** Sigue limitando el trabajo del lote (BD, PDF). El tope real del RUNT lo pone ahora el limitador, que el lote comparte con la cola. Con un lote y la cola a la vez, lo que se ve es que el lote espera: es la intención de la AC3.
- **Regla para la 12828:** la autocertificación reutiliza la respuesta del RUNT de la 12827. **No** debe llamar a `certificarImpuesto` desde un paso mientras tenga ocupado el limitador, porque ahí se bloquearía.

## 4. Recuperación (AC4): `flito-impuestos-analisis.cron.ts`

- Copia de `validacion-stale.cron.ts`: `startImpuestosAnalisisCron` y `stopImpuestosAnalisisCron`. Se apaga con `IMPUESTOS_ANALISIS_CRON_ENABLED=0`. El primer barrido va con `setTimeout` de ~5 s (sirve de «al arrancar») y luego se repite con `setInterval` de 5 min.
- Se registra en `server.ts`: el import, `start` dentro del bloque `production` junto a `startValidacionStaleCron()` (línea 78) y `stop` en el apagado (línea ~136).
- `barrerAnalisisHuerfanos(ahora)` usa el corte `ahora - 10 min` y hace dos `UPDATE`, cada uno atómico por sí solo:
  1. `SET analisis_estado='error_analisis' WHERE analisis_estado='en_curso' AND analisis_encolado_en < corte AND analisis_reencolados >= 1`. Esto es el «vuelve a fallar»: no se reencola.
  2. `SET analisis_reencolados = analisis_reencolados + 1, analisis_encolado_en = ahora WHERE analisis_estado='en_curso' AND analisis_encolado_en < corte AND analisis_reencolados = 0 RETURNING id`. Con eso se llama `encolarAnalisis(ids)`, **una sola vez**.
  - Los ids que ya están en `enCola` de este proceso no se cuentan como huérfanos: se excluyen con `notInArray`. Así no se castiga un job lento que todavía está vivo.
- El contador vuelve a `0` en cada encolado explícito (envío o reintento), no en la recuperación.
- **Tests con reloj fijo:** `vi.useFakeTimers()` + `vi.setSystemTime('2026-09-23T15:00:00Z')` y `TZ=UTC` en el comando. El corte se asierta **leyendo el SQL renderizado o las condiciones capturadas**, no la fila que devuelve el mock (ver la sección 7).

## 5. Ruta de reintento (AC5)

`POST /api/flito/impuestos/:id/reanalizar`, con verbo en infinitivo como `/:id/certificar` y `/:id/reactivar`.

| Aspecto | Decisión |
|---|---|
| Guarda | `exigirFuncion('impuestos.tramite.certificar')`, que da 403 con el cuerpo estándar |
| Validación | `z.string().uuid()` sobre `:id` → 400 |
| Frontera | `buscarConAcceso(id, ctx)` → **404** si no existe o no es suyo (404, no 403, igual que el detalle) |
| 202 | `{ id, analisisEstado: 'en_curso' }`. El job se encola **después** del `UPDATE` condicional y la respuesta no espera ni al OCR ni al RUNT |
| 409 `ANALISIS_EN_CURSO` | el `UPDATE … SET analisis_estado='en_curso', analisis_encolado_en=ahora, analisis_reencolados=0 WHERE id=$1 AND estado='solicitado' AND analisis_estado IN ('completado','error_analisis')` afecta 0 filas y la fila está `en_curso`. Es atómico: dos usuarios no encolan dos jobs |
| 409 `NO_SOLICITADO` | `estado <> 'solicitado'` |
| 409 `YA_CERTIFICADO` | `certificacionVigente(id)` no es null (se consulta antes del `UPDATE`) |
| 409 `SIN_ANALISIS` | `analisis_estado IS NULL` (histórico nunca encolado). Ver «Pendiente humano» |
| Auditoría | `audit(req, { action:'update', resource:'flito_impuesto', resourceId:id, detail:'Reintento de validación de factura encolado' })` |
| `logPiiAccess` | **No aplica en la ruta**: solo devuelve id y estado. La lectura de la factura con PII es de la 12826, que registrará `logPiiAccess` con actor sistema dentro de su paso |
| `rateLimiter` | **Sí** (AGENTS §18: el reintento dispara OCR y RUNT). `reanalizarLimiter` se declara como `zipSoportesLimiter`, en el mismo archivo. `security-agent` confirma la cifra |
| Catálogo | `op(\`${IMP} POST /:id/reanalizar\`, 'impuestos.tramite.certificar', …)` en `catalogo-operaciones.ts` |

La lógica vive en `reanalizarImpuesto` (`flito-impuestos.analisis.service.ts`) y devuelve un resultado discriminado. La ruta y el limiter viven en el **sub-router** `flito-impuestos.analisis.routes.ts` (`Router()` propio, `export default`).

El sub-router se monta desde `flito-impuestos.routes.ts` con `router.use(analisisRouter)` inmediatamente después de `router.use(authMiddleware)` (línea 49), así que hereda la autenticación. Un comentario de cabecera en el sub-router lo deja dicho (regla 4). `/:id/reanalizar` no choca con ninguna ruta existente del router padre.

El test de rutas monta el router **padre**, no el sub-router suelto, para cubrir que la autenticación se hereda.

## 6. `packages/shared-types`

En `src/flito-estados.ts`, junto a `EstadoImpuesto`:

```ts
export const AnalisisEstadoImpuesto = { EN_CURSO: 'en_curso', COMPLETADO: 'completado', ERROR: 'error_analisis' } as const;
export type AnalisisEstadoImpuesto = typeof AnalisisEstadoImpuesto[keyof typeof AnalisisEstadoImpuesto];
export const ANALISIS_ESTADO_IMPUESTO_LABEL: Record<AnalisisEstadoImpuesto, string>; // «Validando factura», «Validada», «Error al validar»
export type ResultadoReanalisis =
  | { resultado: 'ENCOLADO'; id: string; analisisEstado: 'en_curso' }
  | { resultado: 'ANALISIS_EN_CURSO' | 'NO_SOLICITADO' | 'YA_CERTIFICADO' | 'SIN_ANALISIS' | 'NO_ENCONTRADO' };
```

Mostrar `analisisEstado` en el DTO de cola o detalle queda para la 12830. Si se agrega aquí, hay que hacer el `grep` de `ImpuestoDetalle` en `apps/web` que exige la regla 7. Es un tipo nuevo y no rompe nada.

## 7. Archivos a crear o modificar (lista cerrada)

**Crear**
- `apps/api/src/db/migrations/0206_flito_impuestos_analisis.sql`
- `apps/api/src/shared/utils/limitador.ts`
- `apps/api/src/modules/flito-impuestos/runt-limitador.ts`
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.service.ts` (~180 líneas: cola, job, barrido, `reanalizarImpuesto`, `marcarEnCursoEnTx`)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.analisis.routes.ts` (sub-router: `POST /:id/reanalizar` + `reanalizarLimiter`)
- `apps/api/src/modules/flito-impuestos/flito-impuestos-analisis.cron.ts`

**Modificar**
- `apps/api/src/db/schema.ts` (enum + 4 columnas + índice parcial)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.service.ts` (`enviarAlGestor`: pide `analizadoEn` en el `SELECT`, llama a `marcarEnCursoEnTx(tx, filas)` y, tras el commit, a `encolarAnalisis`; **≤4 líneas netas**)
- `apps/api/src/modules/flito-impuestos/certificacion.service.ts` (envolver `consultarVehiculoRunt`)
- `apps/api/src/modules/flito-impuestos/flito-impuestos.routes.ts` (**2 líneas**: el import y `router.use(analisisRouter)` justo después de `router.use(authMiddleware)` en la línea 49)
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` (op nueva)
- `apps/api/src/server.ts` (start/stop del cron)
- `packages/shared-types/src/flito-estados.ts`

**Tests nuevos (P1)**, en `apps/api/__tests__/services/`:
- `shared-limitador.test.ts`: es puro, sin mocks. Nunca hay más de 2 en vuelo con 6 tareas (contador de pico), el orden es FIFO y un rechazo no deja un cupo retenido.
- `flito-impuestos.analisis.test.ts`: `vi.mock` de `db` y un paso falso con `registrarPasoAnalisis`. Casos:
  - dedup del mismo id
  - idempotencia por timestamps: el paso **no** se llama
  - un fallo marca `error_analisis` y el otro id termina `completado`
  - sin pasos, `analizado_en` no se escribe
  - barrido con reloj fijo: reencola una vez y a la segunda da `error_analisis`
  - `reanalizarImpuesto`: los 4 409 y el encolado
- `flito-impuestos.reanalizar.routes.test.ts`: supertest con 202, 403 (sin función), 404 (frontera), 409 (en curso) y 400 (id no uuid). Se asierta que `consultarVehiculoRunt` **no** se llama de forma síncrona antes de la respuesta.
- `flito-impuestos.enviar-analisis.test.ts`: con `vi.mock('…/flito-impuestos.analisis.service.js')`, se comprueba que `encolarAnalisis` recibe solo los ids sin `analizado_en`, que se llama **después** de resolver la transacción y que no se llama si la transacción lanza.

**Tests existentes que se tocan**
- Los que ejercen `enviarAlGestor` (`grep -l enviarAlGestor apps/api/__tests__`; como mínimo `flito-impuestos.workflow.test.ts` y `.contingencia.test.ts`) llevan `vi.mock` de `flito-impuestos.analisis.service.js`. Así el `setImmediate` del drenado no consume llamadas del mock de `db` y no descuadra sus conteos.
- Los de certificación (`.certificacion.service`, `.certificacion-lote`, `.certificar.routes`) deberían pasar igual porque el limitador es transparente. Se incluyen en el P1 por el cambio de `certificacion.service.ts`.

**Cuidado con los mocks** (lecciones del repo):
- El mock `chain` devuelve la fila entera, así que un aserto sobre el `WHERE` del barrido o del `UPDATE` condicional **tiene que leer el SQL renderizado o las condiciones capturadas**. Si no, sobrevive al mutante que quite `analisis_reencolados = 0` o `< corte`.
- El mock ignora `orderBy`.
- `enviarAlGestor` sigue en **una** transacción con el mismo stub. Solo agrega un `update` dentro, así que el stub pelado de `transaction` alcanza si expone `tx.update`. El análisis y el reintento **no** usan transacción (solo `UPDATE` condicionales), así que los specs que declaran el stub pelado no se rompen.

Comando P1: `TZ=UTC npm test -w apps/api -- __tests__/services/shared-limitador.test.ts __tests__/services/flito-impuestos.analisis.test.ts __tests__/services/flito-impuestos.reanalizar.routes.test.ts __tests__/services/flito-impuestos.enviar-analisis.test.ts <los existentes tocados>`, más `npm run build -w packages/shared-types` y `build:api` con 8 GB de heap.

## ADR: no aplica

Es una extensión del patrón: un barrido tipo `validacion-stale` y un pool tipo `con-concurrencia`, sin dependencias ni infra nuevas. Una cola en memoria es aceptable porque prod corre en un solo proceso. Si algún día la API escala a varias réplicas, sí hará falta un ADR: el tope y el dedup pasarían a Redis, que ya está integrado.

## Notas operativas

**backend-agent**
- Tamaños de hoy: `flito-impuestos.service.ts` tiene 782 líneas físicas (488 según `max-lines` sin blancos ni comentarios), `flito-impuestos.routes.ts` 795 (453) y `certificacion.service.ts` 277 según `max-lines`. El gate de CI cuenta sin blancos ni comentarios, pero por decisión del hilo **todo el código nuevo va en archivos nuevos**: `flito-impuestos.analisis.service.ts` y `flito-impuestos.analisis.routes.ts`. Los dos grandes solo crecen ≤4 y 2 líneas.
- Hay que volver a medir con `npx eslint <archivo>` antes de entregar.
- Envolver solo la llamada al RUNT.
- `log` del job solo con `impuestoId` y el mensaje del error, nunca `err.data`.
- `analisis_encolado_en` y `ahora` salen de un `Date` que se pasa a Drizzle, no a un fragmento `sql` (si va dentro de `sql`, se usa `toISOString()`).

**db-review-agent**
- Aplica (migración + `schema.ts`): revisar el enum, el índice parcial y la idempotencia de la migración (aplicarla dos veces).

**security-agent**
- Aplica (ruta nueva + limiter). Revisar: la guarda, el 404 de frontera, que no haya PII en los logs del job y la cifra del limiter.

**frontend**
- No se toca en esta HU. La 12830 consume `AnalisisEstadoImpuesto` y `POST /:id/reanalizar`.

## Pendiente humano

1. **Históricos** (`analisis_estado IS NULL`, en `solicitado` antes del deploy): el diseño responde `409 SIN_ANALISIS` y no los analiza. Si el PO quiere que «Reintentar» también los arranque, basta con agregar `IS NULL` al `IN (...)` del `UPDATE` condicional. Es una decisión de producto y no se puede leer de la AC5.
2. **Estado `con_novedad`:** la AC5 dice «solicitado». El diseño no permite el reintento en `con_novedad`. Hay que confirmarlo.
