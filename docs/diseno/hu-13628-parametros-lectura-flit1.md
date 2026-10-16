# Diseño slim — HU #13628 · Parámetros de la lectura automática de FLIT 1

Feature #13612 · Épica #13576 · Módulo **FLITO** `flito-sync` (no el legacy). Estado: **Propuesto**.
ADR: **no aplica** (extensión del patrón del interruptor, HU #13237 / 0217, y de la fila única de
lectura de FLIT 2, HU #13091 / 0215).

## Patrón reutilizado

| Pieza | Vecino que se calca |
|---|---|
| Guardado con `FOR UPDATE` + upsert en la misma tx + auditoría del par anterior/nuevo (RN-05) | `apps/api/src/modules/flito-sync/flito-sync-interruptor.service.ts` (`guardarInterruptor`, `detalleAuditoriaInterruptor`) |
| PUT con Zod `.strict()` + 400 `datos_invalidos` + `audit()` | `apps/api/src/modules/flito-sync/flito-sync-interruptores.routes.ts` |
| GET fuera de la lista del inventario de guardas | `apps/api/src/modules/flito-sync/flito-sync-interruptores-lectura.routes.ts` |
| Tabla de **una fila** (`id = 1` + CHECK, sembrada por la migración, el código solo hace upsert por PK) | `flito_sync_flit2_lectura` (0215) en `apps/api/src/db/schema/flito-sync.ts` |
| Fila ausente = valores por defecto + `warn` sin PII (RN-02) | `fuenteHabilitada` / `aInterruptor` del interruptor |
| Migración sin control de tx, idempotente, bloque `DO $resumenNNNN$` de cierre | `0217_sync_interruptor_fuente.sql` |

## Decisión de almacenamiento

**Tabla propia de una fila: `flito_sync_flit1_lectura`.** Guarda los cuatro parámetros **y** el estado
de AC8 (última buena, próxima prevista, último fallo). No se añaden columnas a la fila `flit1` de
`flito_sync_interruptor`.

Motivos:

1. **El interruptor se comparte con `flit2`.** Las columnas de FLIT 1 quedarían nulas en la fila
   `flit2`, y los CHECK de rango tendrían que ir condicionados por `fuente` (`fuente <> 'flit1' OR …`).
   Eso son reglas de una fuente metidas en una tabla de dos.
2. **Contención.** Cada guarda del cron lee `flito_sync_interruptor` por PK (RN-03, sin caché), y el
   PUT del interruptor la bloquea con `FOR UPDATE`. La #13629 escribirá el estado de AC8 en cada
   corrida (cada 2–60 min). Si ese estado viviera en la fila del interruptor, apagar la fuente
   competiría con la corrida que justo se quiere frenar. La 0217 ya separó el interruptor de
   `flito_sync_flit2_lectura` por este mismo motivo.
3. **Calco directo de la 0215**, que es el análogo exacto en FLIT 2: fila única de lectura con
   `ultima_exitosa_en` / `ultimo_error_codigo`.
4. **Parámetros y estado en la misma fila, con autoría separada.** La 0215 advierte que su
   `updated_at` lo mueve cada página. Por eso aquí **no hay un `updated_at` genérico**: quién y cuándo
   (AC2) van en `parametros_actualizados_en/por`, que solo mueve el PUT. Las columnas de estado las
   escribe la #13629 con un `UPDATE … WHERE id = 1` corto que nunca toca la autoría.
   - Alternativa descartada: dos tablas (parámetros / estado). Sería más aislada, pero AC8 dice que
     aquí «solo se exponen y se persisten». Una fila es suficiente y la #13629 no corre en una tx
     larga. Si la #13629 llegara a necesitar una tx larga sobre esa fila, ese es el punto para
     partirla (ver Riesgos).

**`system_kv['flito.ultima_sincronizacion']` no se toca ni se lee en esta HU.** La usa el sync manual
como `initialDate` incremental y existe en PDN. Si GET `/estado-lectura` la leyera como respaldo,
rompería AC8 («antes de la primera corrida, los tres van vacíos») en cualquier ambiente con
corridas manuales previas. La #13629 decide si la jubila, si la migra a `ultima_buena_en` o si
conviven.

## DDL propuesto — `apps/api/src/db/migrations/0241_flito_sync_flit1_lectura.sql`

```sql
-- 0241_flito_sync_flit1_lectura.sql
-- HU #13628 (Feature #13612, Épica #13576) — parámetros de la lectura automática de FLIT 1 + estado
--   de la lectura (lo llena la HU #13629). Fila única sembrada con los defaults: sin cambio de
--   comportamiento al desplegar. Diseño: docs/diseno/hu-13628-parametros-lectura-flit1.md.
-- Reglas: sin BEGIN/COMMIT (el runner envuelve); idempotente; SIN literales de rol ni filas de
--   permisos (no hay función ni página nueva: la 0227 tumbó DEV por FK a permisos_roles).

CREATE TABLE IF NOT EXISTS flito_sync_flit1_lectura (
  id                          smallint    PRIMARY KEY DEFAULT 1,
  frecuencia_minutos          smallint    NOT NULL DEFAULT 2,
  ventana_dias                smallint    NOT NULL DEFAULT 7,
  ventana_nocturna_dias       smallint    NOT NULL DEFAULT 60,
  arranque                    date        NULL,          -- null = «hoy − 1 mes» (Bogotá), calculado al leer
  parametros_actualizados_en  timestamptz NULL,          -- null = nadie los ha guardado (AC1)
  parametros_actualizados_por integer     NULL REFERENCES users(id),
  ultima_buena_en             timestamptz NULL,          -- AC8, lo escribe la #13629
  proxima_prevista_en         timestamptz NULL,          -- AC8, lo escribe la #13629
  ultimo_fallo_en             timestamptz NULL,          -- AC8, lo escribe la #13629
  ultimo_fallo_codigo         varchar(40) NULL,          -- AC8, código técnico, nunca texto libre
  CONSTRAINT ck_flito_sync_flit1_lectura_una_fila   CHECK (id = 1),
  CONSTRAINT ck_flito_sync_flit1_lectura_frecuencia CHECK (frecuencia_minutos BETWEEN 2 AND 60),
  CONSTRAINT ck_flito_sync_flit1_lectura_ventana    CHECK (ventana_dias BETWEEN 1 AND 90),
  CONSTRAINT ck_flito_sync_flit1_lectura_nocturna   CHECK (ventana_nocturna_dias BETWEEN 7 AND 90),
  CONSTRAINT ck_flito_sync_flit1_lectura_nocturna_ge_ventana CHECK (ventana_nocturna_dias >= ventana_dias),
  CONSTRAINT ck_flito_sync_flit1_lectura_fallo_par  CHECK ((ultimo_fallo_en IS NULL) = (ultimo_fallo_codigo IS NULL)),
  CONSTRAINT ck_flito_sync_flit1_lectura_fallo_codigo CHECK (ultimo_fallo_codigo IS NULL OR ultimo_fallo_codigo ~ '^[a-z0-9_]{1,40}$')
);

COMMENT ON TABLE flito_sync_flit1_lectura IS
  'HU #13628: parámetros de la lectura automática de FLIT 1 (propios del ambiente) y estado de la lectura (HU #13629). Una fila (id = 1). arranque null = hoy − 1 mes en America/Bogota.';

INSERT INTO flito_sync_flit1_lectura (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $resumen0241$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM flito_sync_flit1_lectura WHERE id = 1;
  IF n <> 1 THEN RAISE EXCEPTION '0241: flito_sync_flit1_lectura sin su fila única (n=%)', n; END IF;
  RAISE NOTICE '0241: flito_sync_flit1_lectura lista (fila única sembrada con los defaults)';
END $resumen0241$;
```

Notas:
- «Arranque no futuro» **no** puede ser CHECK porque depende de `now()`, que no es inmutable. Se
  valida en la app (AC4).
- El CHECK de formato de `ultimo_fallo_codigo` es la barrera de base contra PII colada en el campo
  de fallo (AC8).
- `ON CONFLICT DO NOTHING`: la segunda pasada no pisa parámetros que alguien ya guardó.
- **Sin siembra de permisos.** No hay función nueva (`tramites.sincronizacion.configurar` y
  `sync.sync.ver_estado` ya existen en `permisos_funciones`) ni página nueva (`pagina.<slug>`). Las
  memorias «Página nueva exige siembra» y «Sin permisos sueltos fuera del menú» no se disparan aquí.
  La UI que consuma esto es otra HU; si crea página, esa HU siembra.

Drizzle, en `apps/api/src/db/schema/flito-sync.ts`: `flitoSyncFlit1Lectura`, que calca
`flitoSyncFlit2Lectura` con `smallint` para los tres números, `date('arranque', { mode: 'string' })`,
los timestamps `withTimezone` y los mismos `check()`. Se re-exporta en `schema.ts` (línea 51).

## Contrato delta

Base: `/api/flito/sync`. Todas las rutas llevan `authMiddleware` (401 sin token).

| Método y ruta | Guarda | Respuestas |
|---|---|---|
| `GET /flit1/parametros-lectura` | `exigirFuncion('tramites.sincronizacion.configurar')` | 200 `ParametrosLecturaFlit1` · 401 · 403 |
| `PUT /flit1/parametros-lectura` | `exigirFuncion('tramites.sincronizacion.configurar')` | 200 `ParametrosLecturaFlit1` · 400 `datos_invalidos` · 401 · 403 |
| `GET /flit1/estado-lectura` | `configurar` **o** `sync.sync.ver_estado` (ver Notas backend) | 200 `EstadoLecturaFlit1` · 401 · 403 |

PUT body (`.strict()`, los cuatro campos obligatorios):
```json
{ "frecuenciaMinutos": 5, "ventanaDias": 10, "ventanaNocturnaDias": 45, "arranque": "2026-09-01" }
```
`arranque`: `"YYYY-MM-DD"` real (no `2026-02-30`), ≤ hoy en Bogotá, o `null` (vuelve a «hace 1 mes»).

Respuesta 200 (GET y PUT):
```json
{
  "frecuenciaMinutos": 5, "ventanaDias": 10, "ventanaNocturnaDias": 45,
  "arranque": "2026-09-01",
  "arranquePorDefecto": false,
  "actualizadoEn": "2026-10-16T15:04:05.000Z",
  "actualizadoPor": { "id": 7, "nombre": "…" }
}
```
En un ambiente nuevo (AC1) la respuesta es `2 / 7 / 60`, `arranque` = hoy (Bogotá) − 1 mes,
`arranquePorDefecto: true`, `actualizadoEn: null` y `actualizadoPor: null`.

400 (AC3, AC4, AC5), con forma calcada de `datosInvalidos` más `campos` para nombrar el campo:
```json
{ "error": "Datos inválidos", "codigo": "datos_invalidos",
  "campos": ["ventanaNocturnaDias"],
  "faltantes": ["ventanaNocturnaDias debe ser mayor o igual que ventanaDias."] }
```
Los mensajes nombran el campo y el rango (`frecuenciaMinutos debe estar entre 2 y 60.`). Nunca
repiten lo recibido. Con un 400 no se escribe nada.

`GET /flit1/estado-lectura` 200:
```json
{ "ultimaLecturaBuenaEn": null, "proximaLecturaPrevistaEn": null, "ultimoFallo": null }
```
Cuando hay fallo: `"ultimoFallo": { "en": "<ISO>", "codigo": "timeout" }`.

## Tipos — `packages/shared-types`

Archivo nuevo `packages/shared-types/src/flito-sync-flit1.ts`, re-exportado desde el `index`:

- `ParametrosLecturaFlit1Input` (cuerpo del PUT), `ParametrosLecturaFlit1` (respuesta) y
  `EstadoLecturaFlit1`.
- `LIMITES_PARAMETROS_LECTURA_FLIT1 = { frecuenciaMinutos: { min: 2, max: 60 }, ventanaDias: { min: 1, max: 90 }, ventanaNocturnaDias: { min: 7, max: 90 } } as const`.
- `DEFAULTS_PARAMETROS_LECTURA_FLIT1 = { frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60 } as const`.

El Zod del API lee los límites de estas constantes. El SQL los repite como literales, y el test
de la migración ata ambos (paridad constante ↔ CHECK). Solo se añaden tipos, no se cambia ninguno:
el grep en `apps/web` (regla 7) sale vacío, pero hay que declararlo.

## Archivos a crear o modificar

Crear:
- `apps/api/src/db/migrations/0241_flito_sync_flit1_lectura.sql`
- `apps/api/src/modules/flito-sync/flito-sync-flit1-parametros.service.ts`: `leerParametrosLecturaFlit1`,
  `guardarParametrosLecturaFlit1` (RN-05), `leerEstadoLecturaFlit1`, la función pura
  `arranquePorDefecto(hoy)` y `detalleAuditoriaParametrosFlit1(anterior, nuevo)`. Cabecera con
  RN-01..RN-0n. Va en un archivo propio para no engordar el del interruptor.
- `packages/shared-types/src/flito-sync-flit1.ts`
- `apps/api/__tests__/services/flito-sync.flit1-parametros.test.ts`
- `apps/api/__tests__/db/migracion-0241.test.ts` (calco de `migracion-0217.test.ts`)

Modificar:
- `apps/api/src/db/schema/flito-sync.ts`: tabla `flitoSyncFlit1Lectura`.
- `apps/api/src/db/schema.ts`: añadir `flitoSyncFlit1Lectura` al re-export de la línea 51.
- `apps/api/src/modules/flito-sync/flito-sync-interruptores.routes.ts`: `PUT /flit1/parametros-lectura`
  y actualizar la cabecera (deja de tener «UNA guarda»).
- `apps/api/src/modules/flito-sync/flito-sync-interruptores-lectura.routes.ts`: `GET /flit1/parametros-lectura`
  y `GET /flit1/estado-lectura`, más la cabecera.
- `apps/api/src/modules/permisos/catalogo-operaciones.ts`: debajo de la línea 303, añadir
  `op(\`${SYI} PUT /flit1/parametros-lectura\`, 'tramites.sincronizacion.configurar', …)` con los
  **mismos** textos de negocio que la línea 303 (la función ya existe, byte a byte con la 0217). Los
  GET van fuera de la lista y no llevan línea, igual que `GET /interruptores`.
- `packages/shared-types/src/index.ts`: export del archivo nuevo.

No se tocan `flito-sync.routes.ts` (ya monta `interruptoresRouter` en la línea 81),
`inventario-guardas.ts` (el fichero SYI ya está en la lista), `system_kv` ni el cron.

## Tests P1

`npm test -w apps/api -- __tests__/services/flito-sync.flit1-parametros.test.ts __tests__/db/migracion-0241.test.ts __tests__/services/permisos-catalogo.test.ts __tests__/services/permisos.reconduccion-cierre.test.ts`
y además `npm run build -w packages/shared-types` y `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`.

Los dos de `permisos-*` entran porque el diff toca `catalogo-operaciones.ts`.

`flito-sync.flit1-parametros.test.ts` (supertest + mocks del patrón de `flito-sync.interruptores.test.ts`):
- AC1: fila con defaults y `arranque` null. Con reloj fijo y `TZ=UTC` (memoria «Tests de hora y
  huso local»), `2026-10-16T03:00Z` (15 oct en Bogotá) da `arranque = 2026-09-15`. Fila ausente da
  defaults + `warn`.
- `arranquePorDefecto` pura, con clamp de fin de mes: `2026-03-31 → 2026-02-28`.
- AC2: el PUT devuelve los valores, `actualizadoEn` y `actualizadoPor`. Asertar que la tx hace
  `FOR UPDATE` antes del upsert, leyendo el SQL emitido y no el mock `chain` (memoria «Mock `chain`
  inventa columnas»).
- AC3: cada campo en `min−1` y `max+1` da 400 con ese nombre en `campos`, y el servicio no se llama.
  Lo mismo con una clave de más (`.strict()`).
- AC4: `arranque` mañana (Bogotá), `2026-02-30` y `"x"` dan 400. `arranque` hoy da 200.
- AC5: nocturna 7 con ventana 10 da 400 con `campos: ['ventanaNocturnaDias']`.
- AC6: sin la función, PUT y GET dan 403. Sin token, 401.
- AC7: `detalleAuditoriaParametrosFlit1` lleva los cuatro pares anterior → nuevo, sin el nombre del
  usuario, y `audit()` se llama una vez por PUT (también al mismo valor).
- AC8: estado vacío da tres null. Con solo `ver_estado` responde 200, con solo `configurar` 200 y
  con ninguna de las dos 403. Con fallo, `{ en, codigo }`.

`migracion-0241.test.ts`: sin `BEGIN`/`COMMIT`, sin literales de rol (`permisos_rol_funcion` /
`rol_codigo` ausentes), `IF NOT EXISTS` y `ON CONFLICT DO NOTHING`, y los CHECK con los literales de
`LIMITES_PARAMETROS_LECTURA_FLIT1`. Con Postgres local (P6): aplicar el archivo dos veces.

## Notas operativas (backend)

- **OR de funciones en `GET /estado-lectura`.** No existe `exigirAlgunaFuncion`, y no se crea
  porque tocaría `shared/` y el lector de inventario. El handler usa
  `funcionesConcedidas(req, ['tramites.sincronizacion.configurar', 'sync.sync.ver_estado'])`. Si el
  conjunto sale vacío, responde 403 con **el mismo cuerpo** que pone `exigirFuncion` (leer
  `exigir-funcion.ts` 135–185 y reutilizar `textoDe`). Va en el fichero de lectura, fuera de la
  lista del inventario, como `GET /interruptores`.
- **Validación:** Zod con `.int()` y `.min/.max` tomados de las constantes, más `superRefine` para
  `ventanaNocturnaDias >= ventanaDias` (path en ese campo) y para la fecha real y no futura con
  `hoyColombia()` de `shared/utils/fecha-rango.ts`. El orden de los chequeos debe dar `campos`
  deterministas.
- **Guardado (RN-05):** `select … for('update')` de la fila 1, después
  `insert … onConflictDoUpdate(target: id)` con los cuatro valores y `parametros_actualizados_*`. No
  se tocan las columnas de estado. Fila ausente: se recrea y el anterior sale de
  `DEFAULTS_*` / `arranque` null.
- **Auditoría:** `audit(req, { action: 'update', resource: 'flito_sync_flit1_lectura', resourceId: 'flit1', detail })`.
  El arranque anterior en null se escribe `(hace 1 mes)`, no la fecha calculada.
- Un 23514 (CHECK) que llegue de la base es una carrera o un bug de validación. Va al
  `errorHandler` (500) y no se traduce a 400 en silencio.
- Comprobar `npx eslint` sobre los ficheros de rutas tocados (memoria «max-lines»).

## Riesgos

1. **Catálogo con un código en dos operaciones.** `tramites.sincronizacion.configurar` pasará a
   guardar `PUT /interruptores/:fuente` y `PUT /flit1/parametros-lectura`. No lo verifiqué contra
   `permisos-catalogo.test.ts`. Si ese test exige que el código sea único por operación, el backend
   lo ve en P1. La salida sería mover el PUT a un fichero sin lista con `tieneFuncion` en línea, y
   eso **se consulta antes**: no se resuelve solo.
2. **`system_kv['flito.ultima_sincronizacion']` frente a `ultima_buena_en`.** Hay dos fuentes de
   «última lectura buena» hasta que la #13629 decida. Pendiente de la #13629, no bloquea esta HU.
3. **Contención en la fila única.** Es aceptable mientras la #13629 escriba el estado en
   transacciones cortas. Si necesita mantener la fila bloqueada durante la corrida, hay que partir
   el estado en otra tabla (migración nueva, no editar la 0241 si ya se aplicó).
4. **`arranque: null` en el PUT** (restaurar «hace 1 mes») es una extensión que los AC no piden. Si
   el PO no la quiere, se quita del Zod y nada más cambia.
5. **Aplicación en QA y PDN:** la migración es manual fuera de local (`AGENTS.md` §6). En DEV la
   aplica el CD.
