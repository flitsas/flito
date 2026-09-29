# Diseño slim — HU #13091 Lectura incremental de trámites FLIT 2

> Feature #13059 · Épica #12736 · Estado: **Propuesto** (lo implementa `backend-agent`).
> Contrato: `docs/integraciones/flit2-api.md` v3.1 (§3 feed, §4 ítem, §5 guía).
> Habla con el módulo **FLITO** `flito-sync` (no con el legacy `sync`/`tramites`).

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Puerto + adaptador HTTP + selector | `flit.port.ts` / `flit-http.adapter.ts` / `flit.adapter.ts` (FLIT 1) |
| Llamada autenticada | `conPase()` de `flit2-pase.service.ts` (RN-04: renueva el pase una vez ante 401) |
| Base URL | `env.FLIT2_BASE_URL` (ya en `config/env.ts:150`); nunca un host en el repo (repo público) |
| Escritura del trámite | `flito-sync.service.ts` (`upsertVehiculo`, `registrarDiferencias`, historial `origen 'api'`, audit de cambio de estado) |
| Emparejado compañía/organismo | `companiaPorNit()` + `resolverOrganismoDeFlit()` (FLIT 1, mismo orden: código DIVIPOLA → ciudad → nombre) |
| Errores con `status`/`codigo` | `flit2.errors.ts` (`Flit2Error`) y `fallo()` de `flit2.routes.ts` |
| Sub-router montado desde `flit2.routes.ts` | `flit2-probar.routes.ts` |
| Tabla de una fila de estado | patrón `smallint PK` + CHECK (sin precedente exacto; ver §1) |
| Migración idempotente con DO etiquetado y resumen | `0213` / `0214` |

## Decisiones

### 1. Migración `0215_flit2_lectura_incremental.sql`

Sin `BEGIN/COMMIT` (lo envuelve el runner), idempotente, DO con dollar-quoting etiquetado.

```sql
-- Paso 1 — columnas del trámite
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS id_flit2     uuid   NULL;
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS sync_version bigint NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_tramites_id_flit2
  ON flito_tramites (id_flit2) WHERE id_flit2 IS NOT NULL;

-- Paso 2 — CHECKs (pre-chequeo con mensaje claro antes de añadirlos)
DO $ck0215$
BEGIN
  IF EXISTS (SELECT 1 FROM flito_tramites
              WHERE (fuente = 'flit2') <> (id_flit2 IS NOT NULL)
                 OR (id_flit2 IS NOT NULL AND sync_version IS NULL)) THEN
    RAISE EXCEPTION '0215: hay filas que violarían los CHECK de fuente/id_flit2/sync_version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_tramites_fuente_id_flit2'
                   AND conrelid = 'flito_tramites'::regclass) THEN
    ALTER TABLE flito_tramites ADD CONSTRAINT ck_flito_tramites_fuente_id_flit2
      CHECK ((fuente = 'flit2') = (id_flit2 IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_tramites_flit2_sync_version'
                   AND conrelid = 'flito_tramites'::regclass) THEN
    ALTER TABLE flito_tramites ADD CONSTRAINT ck_flito_tramites_flit2_sync_version
      CHECK (id_flit2 IS NULL OR sync_version IS NOT NULL);
  END IF;
END $ck0215$;

-- Paso 3 — posición de lectura (una sola fila)
CREATE TABLE IF NOT EXISTS flito_sync_flit2_lectura (
  id                   smallint PRIMARY KEY DEFAULT 1,
  cursor               text NULL,
  since_arranque       timestamptz NULL,
  ultima_exitosa_en    timestamptz NULL,
  ultimo_intento_en    timestamptz NULL,
  ultimo_error_codigo  varchar(40) NULL,
  atrasada             boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_flito_sync_flit2_lectura_una_fila CHECK (id = 1),
  CONSTRAINT ck_flito_sync_flit2_lectura_cursor_len CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 2000)
);
INSERT INTO flito_sync_flit2_lectura (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE flito_sync_flit2_lectura IS 'HU #13091: posición de lectura del feed de FLIT 2 (una fila, id=1).';

-- Resumen para el log del CD (RAISE EXCEPTION si falta índice/CHECK/fila; RAISE NOTICE si ok).
```

- **Compatibilidad con lo existente:** hoy todas las filas son `fuente='flit'` con `id_flit2 NULL` → `(false) = (false)` → `true`; el segundo CHECK pasa trivialmente. El pre-chequeo solo aborta si alguien ya escribió `fuente='flit2'` a mano; mejor un mensaje legible que el error crudo de `ADD CONSTRAINT`.
- **Una sola fila:** `PRIMARY KEY` + `CHECK (id = 1)` + siembra `ON CONFLICT DO NOTHING`. Nadie hace `INSERT` desde el código: solo `UPDATE … WHERE id = 1`.
- **`since_arranque` inmutable:** se escribe únicamente con `UPDATE … SET since_arranque = $ahora WHERE id = 1 AND since_arranque IS NULL`. Se descarta un trigger que prohíba cambiarlo: el contrato (§5) dice que volver a cargar el histórico es reversible, y eso lo decide una persona con SQL a mano, no el código. El test de AC1 afirma el `WHERE … IS NULL`.
- `atrasada` y `ultimo_error_codigo` los consume la #13092 (cron/topes). Se crean aquí para no pedir otra migración, igual que la 0214 con las marcas de la #13063.
- `id_flit` sigue `NOT NULL UNIQUE`: el radicado `FTn-NNNNNNN` entra ahí, y ese índice es el que detecta el choque con FLIT 1 (AC4).

**Drizzle.**
- `schema.ts` → en `flitoTramites`: `idFlit2: uuid('id_flit2')`, `syncVersion: bigint('sync_version', { mode: 'number' })`, más `uniqueIndex('uq_flito_tramites_id_flit2').on(t.idFlit2).where(sql\`${t.idFlit2} IS NOT NULL\`)` y los dos `check(...)`. Esto deja **~5 líneas contadas**, y `schema.ts` está hoy en **3388/3400** (techo congelado): caben, pero hay que medirlo con `npx eslint apps/api/src/db/schema.ts` antes del PR.
- `schema/flito-sync.ts` → `flitoSyncFlit2Lectura` (la tabla nueva) y su re-export en `schema.ts` junto al de `flitoSyncFlit2Acceso` (misma línea `export { … }`, así no suma líneas).

### 2. Transacción: **por página**, con el avance del cursor dentro

Una corrida sigue este bucle:

1. `port.verificarAcceso()`. En HTTP es `obtenerPase()`, que lanza si no hay acceso o si el acceso está rechazado o bloqueado. En el fake no hace nada.
2. Se lee la fila de lectura. Si `cursor IS NULL`:
   - si `since_arranque IS NULL`, se fija con `now()` usando el UPDATE condicional y se vuelve a leer;
   - la llamada va con `since = since_arranque`, sin cursor (AC1).
   Si ya hay cursor, se llama con `cursor`.
   Si la primera página falla, el siguiente intento **reutiliza el mismo `since_arranque`**. Por eso se fija antes de llamar.
3. `UPDATE ultimo_intento_en = now()`, fuera de la transacción de la página.
4. Se hace el **fetch de la página fuera de toda transacción**: no se tiene una conexión de BD abierta durante la red.
5. `db.transaction(tx => { aplicar cada ítem; UPDATE lectura SET cursor = nextCursor … WHERE id = 1 AND cursor IS NOT DISTINCT FROM $cursorLeido })`:
   - Si el UPDATE toca 0 filas, otra corrida movió el cursor. Se lanza `Flit2LecturaConcurrenteError` y la página se revierte. Es control optimista barato hasta que la #13092 ponga el advisory lock; como el upsert es idempotente por `syncVersion`, repetir la página no ensucia nada.
6. Se hace commit y se sigue mientras `hasMore && paginas < maxPaginas`.
7. Al terminar sin error: `ultima_exitosa_en = now()` y `ultimo_error_codigo = NULL`. Si algo falla: `ultimo_error_codigo = e.codigo` (sin PII) y se relanza con los totales parciales.

Por qué por página y no por trámite: el AC2 exige que el cursor avance **solo** después de guardar la página. Con una transacción por trámite, un fallo a mitad de página dejaría el cursor atrás y la mitad aplicada. Eso no es incorrecto, porque el upsert es idempotente, pero complica el razonamiento sin ganar nada. Dentro de la página, los desenlaces esperados (conflicto, sin vehículo, tombstone, estado desconocido, ítem inválido) son **datos que se cuentan, no excepciones**, así que no revierten la página. Solo un fallo inesperado de BD la revierte.

### 3. Reutilizar el upsert de FLIT 1 sin duplicarlo

El cambio en `flito-sync.service.ts` es mínimo y conserva el comportamiento de FLIT 1:

- **Extraer `escribirTramite(tx, existente | null, valores, meta)`** del cuerpo actual de `upsertTramite`: registrar diferencias, UPDATE/INSERT y audit del cambio de `flit_estado`. `upsertTramite` (FLIT 1) queda así: lookup por `idFlit` → `valores` de FLIT 1 → `escribirTramite` → compradores con `mapearCompradores` (sin cambios). Se exportan `escribirTramite`, `upsertVehiculo` y `setVehiculoDesdeFlit`; `resolverOrganismoDeFlit` ya está exportada.
  - `valores` es `ValorTramite = Omit<typeof flitoTramites.$inferInsert, 'id' | 'createdAt'>`. Cada fuente arma el suyo. Las columnas del historial se leen de `valores`, así que FLIT 2 hereda el historial y el audit sin copiarlos.
  - El INSERT usa `{ idFlit, ...valores }`. En FLIT 2, `valores` incluye `fuente: 'flit2'`, `idFlit2` y `syncVersion`. En FLIT 1 no los incluye, así que queda el default `'flit'` y ninguna columna nueva cambia.
- **Ampliar las firmas con tipos estructurales**, sin cambios para quien ya llama:
  - `resolverOrganismoDeFlit(tf: Pick<TramiteFlit, 'organismoCodigo' | 'ciudad' | 'transitoNombre'>)`
  - `upsertVehiculo(tx, v: VehiculoFlit, companiaId)` y `setVehiculoDesdeFlit(v: VehiculoFlit)`, con `VehiculoFlit = Pick<TramiteFlit, 'vin' | 'placa' | 'marca' | 'linea' | 'cilindraje' | 'carroceria' | 'tipoServicio' | 'numMotor' | 'numSerie' | 'compradores'>`. FLIT 1 sigue pasando su `tf` completo.
- **Guarda `fuente='flit2'` en FLIT 1 (AC4, segunda mitad):** va **al principio de `sincronizarUno`**, antes de `upsertVehiculo`, para que FLIT 1 tampoco toque el vehículo de un trámite de FLIT 2:
  ```ts
  const [previo] = await tx.select({ fuente: flitoTramites.fuente }).from(flitoTramites)
    .where(eq(flitoTramites.idFlit, tf.idFlit)).limit(1);
  if (previo?.fuente === 'flit2') { r.tramitesOmitidosOtraFuente += 1; return; }
  ```
  En `ResultadoSync` (`flit.port.ts`) se añade `tramitesOmitidosOtraFuente: number`, que también se inicializa en `nuevoResultado()`. El cambio es aditivo en la respuesta de `POST /api/flito/sync/sincronizar`.
- **Placa (riesgo específico de FLIT 2):** `setVehiculoDesdeFlit` escribe `plate: tf.placa` siempre, y un ítem en `preasignacion` o en retroceso puede traer `placa: null`. En el camino de FLIT 2, `vehiculo.placa = null` con vehículo existente **conserva** la placa: se pasa la placa guardada al construir `VehiculoFlit`, y `plate_complete` se mantiene igual. FLIT 1 no cambia.

**Aplicar un ítem de FLIT 2** (`aplicarItem(tx, it, r)` en `flit2-lectura.service.ts`), en este orden:

1. `it.eliminado` → `eliminadosIgnorados++`, fin (AC8). No se toca ni el existente.
2. `porId = SELECT … WHERE id_flit2 = it.id`.
   - Si existe y `it.syncVersion <= porId.syncVersion` → `sinCambios++`, sin escribir (AC3).
3. Si no existe `porId`: `porRadicado = SELECT … WHERE id_flit = it.radicado`.
   - Si existe (tenga `fuente='flit'` o sea `flit2` con otro `id_flit2`) → `conflictos++` + `log.warn({ idFlit2, radicado })`, sin escribir (AC4).
4. Vehículo (AC5):
   - `it.vehiculo` o su `vin` es null y no hay existente → `sinVehiculo++`, sin escribir.
   - Es null y hay existente → se conserva `existente.vehiculoId`.
   - Tiene datos → `upsertVehiculo(tx, vehiculoFlit, companiaId)`.
5. `companiaPorNit(it.companiaNit)` y `resolverOrganismoDeFlit({ organismoCodigo: codigoSecretaria, ciudad, transitoNombre: nombre })`. Se suman `companiasFaltantes` y `organismosSinEmparejar` como en FLIT 1.
6. `escribirTramite(tx, porId ?? null, valoresFlit2(...))` → `nuevos`, `actualizados` o `sinCambios` según `esNuevo` / `huboCambios`.
7. Compradores: **no se tocan** (ver §5). SOAT e impuesto: **no se arrancan** (#13093).

Así los contadores quedan en una sola clase por ítem y cuadran: `leidos = nuevos + actualizados + sinCambios + conflictos + sinVehiculo + eliminadosIgnorados + invalidos`. El test lo afirma.

### 4. Mapeo de estados y familia (`flit2-mapeo.ts`, funciones puras)

Lo que verifiqué en el código:
- FLIT 1 guarda en `flit_estado` el `Estado` crudo del reporte (`aTramite`: `s(it.Estado) ?? 'Desconocido'`).
- El estado FLITO sale de `estadoEnumDesdeFlit()`, que pasa el texto a minúscula y lo busca en `{asignado, entregado, aprobado, rechazado, anulado}`; si no está, deja null.
- El texto capitalizado lo confirman el comentario de `flitEstado` en `schema.ts` («Borrador, Asignado, Aprobado, …»), `flito-tramites.service.ts:164` (`'Aprobado'`) y `ESTADO_TRAMITE_FLITO_LABEL` de shared-types (`asignado → 'Asignado'`, …).
- **No pude comprobarlo contra datos**: no había contenedor de BD local. Antes de cerrar el AC6, el backend debe correr `SELECT DISTINCT flit_estado FROM flito_tramites` y ajustar la tabla si el reporte usa otra grafía.

| `estado` FLIT 2 | `estado` (enum FLITO) | `flit_estado` |
|---|---|---|
| asignado / entregado / aprobado / rechazado / anulado | el mismo código | `ESTADO_TRAMITE_FLITO_LABEL[código]` → `Asignado`, `Entregado`, `Aprobado`, `Rechazado`, `Anulado` |
| revocado (AC7) | `anulado` | `Revocado` |
| borrador / preparado / preasignacion | `null` | `Borrador`, `Preparado`, `Preasignacion` |
| desconocido | `null` | el código con la primera letra en mayúscula, recortado a 60; **nunca se descarta** (AC6) |

- `estadoDesdeFlit2(codigo): { estado: EstadoTramiteFlito | null; flitEstado: string }` se apoya en `estadoEnumDesdeFlit` para los cinco comunes, así la regla no se duplica.
- AC7: esta HU no toca SOAT, impuesto ni logística en ningún estado, así que «no cambian» se cumple por construcción. La #13093 **no debe** arrancar SOAT ni impuesto con `revocado` (queda anotado para ella).
- Retroceso (por ejemplo `asignado` → `borrador`): `estado` pasa a `null`, igual que en FLIT 1 con `Borrador`. El historial registra el cambio de `flit_estado`.
- `familiaATipoTramite(f)`: `MATRICULAS → 'Matricula'`, `TRASPASO → 'Traspaso'`, `OTROS → 'Otros'`, cualquier otro valor → `null` (AC9). Finanzas compara con `UPPER(TRIM(COALESCE(tipo_tramite,'')))` (`finanzas.service.ts:163`).
- Otros campos de `valoresFlit2`:
  - `ciudad = organismo.ciudad`, `transitoNombreFlit = organismo.nombre`, `companiaNit = companiaGestora.nit`;
  - `fechaAprobacion` y `fechaCreacionFlit` pasan por `fechaValida()`;
  - `tipoPropiedad` se deriva del **conteo** de compradores (0 → se conserva el existente o queda null; 1 → `unico_propietario`; 2 o más → `multiple_propietario`). El conteo no es PII;
  - `facturaVentaFlitId = null` (la factura es de la #13095; en un UPDATE se conserva la existente);
  - `valorImpuestoLiquidado = null` (conservar);
  - `plateComplete = vehiculo.placa ?? existente.plateComplete`;
  - `flitRaw = rawSinPii(item)`;
  - `sincronizadoEn = now`;
  - `fuente = 'flit2'`, `idFlit2`, `syncVersion`.

### 5. Compradores en la 13091

- **No se escriben filas en `flito_compradores`.** La #13093 las completa y aplica la política de reemplazo, incluido el `[]` del retroceso, que según el contrato **no** se rechaza.
- FLIT 2 **no llama a `mapearCompradores`**, así que la regla de FLIT 1 de lanzar ante 0 compradores sigue intacta y sin excepción.
- Lo único que la 13091 guarda de los compradores es el conteo (en `tipo_propiedad`) y la parte no personal en `flit_raw` (ver abajo).
- **Titular del vehículo:** `VehiculoFlit.compradores = []` hace que `titularDe()` devuelva null, y los spreads condicionales **conservan** el propietario que ya había. Esta HU no pone ningún propietario.
- **`rawSinPii(item)` (AC10)** hace una copia del ítem en la que `compradores` se sustituye por una **lista blanca** `{ ordinal, porcentajeParticipacion, rolActor, tipoPersona, tipoDocumento }`. Desaparecen `numeroDocumento`, `nombreCompleto`, `direccion`, `ciudad`, `celular` y `correo`. Es lista blanca y no lista negra: una clave nueva de comprador que FLIT 2 añada en el futuro no entra.
- `flit_raw` de FLIT 1 no cambia: su camino no se toca.
- El ítem **completo** (con PII) solo vive en memoria durante la página, dentro de `ItemFlit2.compradores`, para que la #13093 lo consuma. Nunca va a un log.

### 6. Respuesta del botón (sin PII) — `Flit2LecturaResultado` en `packages/shared-types/src/flito-flit2.ts`

```ts
export interface Flit2LecturaResultado {
  leidos: number; nuevos: number; actualizados: number; sinCambios: number;
  conflictos: number; sinVehiculo: number; eliminadosIgnorados: number;
  invalidos: number;                 // ítem que no cumple el contrato (id no uuid, syncVersion no entero…)
  companiasFaltantes: number; organismosSinEmparejar: number;
  paginas: number; hasMore: boolean; // hasMore=true ⇒ se cortó por maxPaginas: volver a pulsar
  modo: 'since' | 'cursor';          // la primera corrida es 'since'
  ejecutadoEn: string;               // ISO
}
```

`invalidos` es un añadido al pedido y se justifica así: un ítem roto se cuenta y se salta en vez de envenenar la página. Solo lleva números y enums: ningún radicado ni nombre.

**Endpoint** `POST /api/flito/sync/flit2/sincronizar` (`flit2-lectura.routes.ts`, montado con `router.use(lecturaRouter)` en `flit2.routes.ts`, que ya aplica `authMiddleware`):
- Guarda `exigirFuncion('sync.sync.lanzar')`. Es el permiso existente de la 0179 (solo admin), así que **no hace falta migración de siembra**.
- `rateLimit` de 6 por minuto por usuario (`userOrIpKey('flit2-lectura')`, `makeStore('rl:flit2-lectura:')`), igual que `accesoLimiter`.
- Cuerpo `z.object({}).strict()`: cualquier clave, incluida `initialDate`, da 400 `datos_invalidos`. La fecha no se elige.
- Respuestas:
  - `200 Flit2LecturaResultado`.
  - `Flit2Error` → `{ error, codigo }` con su `status`. Es el patrón de `fallo()`; los casos son `no_configurado` 503, `sin_acceso` 503, rechazado o bloqueado (los de la #13063), `lectura_concurrente` 409 y `flit2_respuesta` 502.
  - Si ya había páginas guardadas, el cuerpo de error añade `parcial: Flit2LecturaResultado`.
- `audit(req, { action: 'update', resource: 'flito_sincronizacion_flit2', detail: 'Sync FLIT 2 (<modo>): N leídos, …' })`, solo con totales. Es el mismo patrón que la ruta de FLIT 1. La #13092 extiende la auditoría al cron.

### 7. Selección del adaptador

- `config/env.ts`: `FLIT2_SYNC_ADAPTER: z.enum(['http', 'fake']).default('http')`, con un `superRefine` que **rechaza `fake` si `NODE_ENV === 'production'`**. `FLIT2_BASE_URL` ya existe.
- `flit2-sync.adapter.ts` expone `getFlit2SyncAdapter()` con una instancia perezosa, igual que `flit.adapter.ts`: `fake` → `crearFlit2SyncFake()`, `http` → `crearFlit2SyncHttp()`. El HTTP lanza `Flit2NoConfiguradoError` si falta la base URL, y lo hace al usarse, no al arrancar, como `baseUrl()` del pase.
- Los tests inyectan el puerto como segundo argumento: `leerIncremental(opciones, port)`, como `sincronizar(rango, flit)`.
- El fake lleva páginas en memoria con datos **ficticios** y deterministas (un uuid fijo por radicado `FT9-00000NN`, VIN y NIT de ejemplo). `crearFlit2SyncFake(paginas?)` acepta páginas a medida para los tests. Por defecto sirve 2 páginas con un caso por AC. Nada de `.env*` en el diff; `apps/api/.env.example` documenta `FLIT2_SYNC_ADAPTER=http`.

## Firmas

```ts
// flit2-sync.port.ts
export interface VehiculoFlit2 { vin: string; placa: string | null; marca: string | null; linea: string | null;
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  numMotor: string | null; numSerie: string | null; }
export interface CompradorFlit2 { ordinal: number; porcentajeParticipacion: number | null; rolActor: string;
  tipoPersona: string | null; tipoDocumento: string | null; numeroDocumento: string | null;
  nombreCompleto: string | null; direccion: string | null; ciudad: string | null;
  celular: string | null; correo: string | null; }            // lo consume la #13093; PII solo en memoria
export interface ItemFlit2 {
  idFlit2: string; radicado: string; syncVersion: number; eliminado: boolean;
  estado: string;                               // código crudo en minúscula
  familia: string | null; fechaCreacion: string | null; fechaAprobacion: string | null;
  vehiculo: VehiculoFlit2 | null;               // null si el bloque o el VIN vienen null
  organismo: { codigoSecretaria: string | null; ciudad: string | null; nombre: string | null } | null;
  companiaNit: string | null;
  facturaAdjuntoId: string | null;              // #13095
  compradores: CompradorFlit2[];
  raw: unknown;                                 // YA sin PII (rawSinPii en el adaptador)
}
export type PosicionLectura = { cursor: string } | { since: Date };
export interface PaginaFlit2 { items: ItemFlit2[]; invalidos: number; nextCursor: string; hasMore: boolean }
export interface Flit2SyncPort {
  verificarAcceso(): Promise<void>;
  leerPagina(pos: PosicionLectura, pageSize: number): Promise<PaginaFlit2>;
  // #13095 añade: urlAdjunto(idFlit2: string, adjuntoId: string): Promise<{ url: string } | null>;
}

// flit2-mapeo.ts (puras)
export function estadoDesdeFlit2(codigo: string): { estado: EstadoTramiteFlito | null; flitEstado: string };
export function familiaATipoTramite(familia: string | null): 'Matricula' | 'Traspaso' | 'Otros' | null;
export function rawSinPii(item: Record<string, unknown>): Record<string, unknown>;
export function tipoPropiedadPorConteo(n: number): TipoPropiedad | null;

// flit2-sync-http.adapter.ts
export function aItemFlit2(crudo: unknown): ItemFlit2 | null;   // Zod safeParse; null ⇒ inválido
export function crearFlit2SyncHttp(): Flit2SyncPort;
//   GET new URL('/api/v1/external/tramites/sync', base) con cursor XOR since (toISOString), pageSize=500,
//   vía conPase(p => fetch(url, { headers: { Authorization: p.authorization.unwrap(), Accept }, redirect: 'error',
//   signal: AbortSignal.timeout(30_000) })). Sobre ≠ 200 o JSON inválido → Flit2RespuestaError(status, codigo)
//   (el código RFC 7807 se toma como en codigoDeProblema; el cuerpo nunca se reenvía). Los datos técnicos del
//   vehículo pasan por los mismos topes de FLIT 1 (acotado/motorYSerieParaVehiculo); cilindraje int → String,
//   si es null se usa cilindrajeTexto acotado; tipoServicio = tipoServicio.nombre.

// flit2-lectura.service.ts
export interface OpcionesLectura { pageSize?: number /*500*/; maxPaginas?: number /*10*/; ahora?: () => Date }
export async function leerIncremental(op?: OpcionesLectura, port?: Flit2SyncPort): Promise<Flit2LecturaResultado>;
export async function aplicarPagina(tx: Tx, items: ItemFlit2[], r: Flit2LecturaResultado): Promise<void>;

// flit2.errors.ts (nuevos)
export class Flit2LecturaConcurrenteError extends Flit2Error {}  // 'lectura_concurrente', 409
export class Flit2RespuestaError extends Flit2Error {}           // 'flit2_respuesta', 502; lleva statusFlit2 y codigoFlit2

// flito-sync.service.ts (exportaciones nuevas o ampliadas)
export type ValorTramite = Omit<typeof flitoTramites.$inferInsert, 'id' | 'createdAt'>;
export async function escribirTramite(tx: Tx, existente: typeof flitoTramites.$inferSelect | null,
  idFlit: string, valores: ValorTramite): Promise<{ row: typeof flitoTramites.$inferSelect; esNuevo: boolean; huboCambios: boolean }>;
export async function upsertVehiculo(tx: Tx, v: VehiculoFlit, companiaId: number | null): Promise<number>;
```

- `maxPaginas = 10` (5000 ítems) protege el timeout de 90 s del cliente web en un endpoint síncrono. Con `hasMore=true` basta volver a pulsar el botón.
- El tope definitivo y su configuración son de la **#13092**. Aquí solo existe el parámetro.

## Archivos a crear o modificar

**Crear**
- `apps/api/src/db/migrations/0215_flit2_lectura_incremental.sql`
- `apps/api/src/modules/flito-sync/flit2-sync.port.ts`
- `apps/api/src/modules/flito-sync/flit2-sync-http.adapter.ts`
- `apps/api/src/modules/flito-sync/flit2-sync-fake.adapter.ts`
- `apps/api/src/modules/flito-sync/flit2-sync.adapter.ts` (selector)
- `apps/api/src/modules/flito-sync/flit2-mapeo.ts`
- `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` (cabecera con `RN-xx`: posición, página atómica, clasificación del ítem, sin PII)
- `apps/api/src/modules/flito-sync/flit2-lectura.routes.ts`
- Tests, en el directorio de los de la #13063:
  - `flit2-mapeo.test.ts` (AC6, AC7, AC9, AC10);
  - `flit2-sync-http.adapter.test.ts` (since XOR cursor, 401 → un reintento vía `conPase`, sobre inválido, ítem inválido contado);
  - `flit2-lectura.test.ts` (AC1–AC8, cuadre de contadores, UPDATE optimista del cursor);
  - `flit2-lectura.routes.test.ts` (permiso, cuerpo strict, 503/409/502, sin PII en la respuesta);
  - un caso nuevo en el test existente de `flito-sync` para la guarda `fuente='flit2'`.

**Modificar**
- `apps/api/src/db/schema.ts`: columnas, índice y CHECK en `flitoTramites`, y el re-export de `flitoSyncFlit2Lectura` (medir el techo de 3400).
- `apps/api/src/db/schema/flito-sync.ts`: `flitoSyncFlit2Lectura`.
- `apps/api/src/modules/flito-sync/flito-sync.service.ts`: extraer `escribirTramite`, exportar `upsertVehiculo` y `setVehiculoDesdeFlit` con `VehiculoFlit`, Pick en `resolverOrganismoDeFlit`, y la guarda al principio de `sincronizarUno`. Hoy tiene 284 líneas contadas; queda muy por debajo de 800.
- `apps/api/src/modules/flito-sync/flit.port.ts`: `ResultadoSync.tramitesOmitidosOtraFuente`.
- `apps/api/src/modules/flito-sync/flit2.errors.ts`: los dos errores.
- `apps/api/src/modules/flito-sync/flit2.routes.ts`: `router.use(lecturaRouter)` y una línea en la cabecera.
- `apps/api/src/config/env.ts`: `FLIT2_SYNC_ADAPTER`.
- `apps/api/.env.example`: documentar la variable, sin valores reales.
- `packages/shared-types/src/flito-flit2.ts`: `Flit2LecturaResultado`, más su export si el índice lo requiere. Es un tipo nuevo, así que el `grep` en `apps/web` sale vacío; declararlo.

**No se tocan:** `mapeo-compradores.ts`, `flit-http.adapter.ts`, `flit2-pase.service.ts` (solo se consume `conPase`/`obtenerPase`), `flito-sync.routes.ts` ni `app.ts`.

## Puntos de extensión para las HUs siguientes

| HU | Dónde engancha |
|---|---|
| #13092 cron, candado, topes, 429/423, auditoría | `flito-sync.cron.ts` llama a `leerIncremental()` envuelto en `pg_try_advisory_lock` (sustituye al 409 optimista como guarda principal y el UPDATE condicional queda como cinturón). `maxPaginas` y `pageSize` salen a config. `Flit2RespuestaError` con `statusFlit2 === 429` o `423` pasa a `Flit2BloqueadoError` / `marcarBloqueo` en el adaptador. `atrasada` se calcula contra `ultima_exitosa_en`. |
| #13093 compradores y arranque de SOAT e impuestos | Un paso nuevo en `aplicarItem`, después de `escribirTramite`: `reemplazarCompradoresFlit2(tx, row.id, it.compradores)`, que tolera `[]` y no pasa por `mapearCompradores`. Luego, con `estado === 'asignado'`, compañía y organismo emparejados, se reutilizan `resolverSoat` y `resolverImpuesto` (hay que exportarlos y hacer su `tf` estructural). Nunca con `revocado`. |
| #13094 PII enmascarada | En `aItemFlit2`, si `!pase.conPii` (o si detecta el patrón `*`), marca `compradores[].enmascarado`. La #13093 decide no escribirlos. `rawSinPii` ya los excluye. |
| #13095 factura | `Flit2SyncPort.urlAdjunto`. `ItemFlit2.facturaAdjuntoId` ya llega; `valoresFlit2` empezará a escribir `facturaVentaFlitId`. |

## ADR: no aplica

Es una extensión del patrón puerto/adaptador de `flito-sync` y del acceso de la #13061/#13063 (diseño `docs/diseno/hu-13061-13063-acceso-flit2.md`). No lleva dependencias nuevas, ni PII en URL (el feed no lleva filtros de persona), ni roles nuevos.

## Notas operativas (backend)

- **Presupuesto P8:** este documento trae las firmas y los paths. Antes de editar, leer solo `flito-sync.service.ts` y el test existente de `flito-sync` (para el mock de `db`/`transaction`). Ojo con la memoria «stub pelado de `transaction`»: `aplicarPagina` usa `db.transaction` y el mock tiene que soportarlo.
- **Primer paso obligatorio:** `SELECT DISTINCT flit_estado FROM flito_tramites` en la BD local (puerto 5434), para confirmar la grafía de la tabla de §4.
- **Migración (P6):** aplicar la 0215 dos veces sobre la BD local ya migrada. `db-review-agent` pre-PR (toca `schema.ts` y `migrations/`); si hay test de migración, **no** exigir «es la última».
- **`security-agent` diff-scoped aplica:** ruta nueva, datos personales en tránsito y `flit_raw`.
- **Logs:** solo `idFlit2`, `radicado`, contadores, `status` y `codigo`. Nunca el ítem, los compradores ni la URL con cursor.
- **P1:**
  ```
  npm test -w apps/api -- <los 4 tests nuevos> <test de flito-sync tocado>
  NODE_OPTIONS=--max-old-space-size=8192 npm run build:api
  npm run build -w packages/shared-types
  ```
- **Frontend:** no aplica en esta HU; el botón lo consume otra HU.

## Riesgos abiertos

1. **La grafía de `flit_estado` no se contrastó con datos.** No había BD accesible; queda como primer paso del backend.
2. **Página envenenada:** un fallo de BD inesperado en un ítem revierte la página y la corrida siguiente se atasca en ella. Se mitiga con la validación Zod (ítem inválido → contado) y con la escritura acotada que ya usa FLIT 1. Si ocurre, la #13092 decide una cuarentena por ítem con savepoint.
3. **`tipoServicio`:** FLIT 1 guarda el texto del reporte y FLIT 2 manda `{codigo, nombre}`; se elige `nombre`. Hay que confirmar contra `SELECT DISTINCT tipo_servicio FROM vehicles`; si FLIT 1 usa mayúsculas tipo código, usar `codigo`.
4. **Conflicto AC4:** el trámite queda solo en FLIT 1 y el ítem de FLIT 2 no se aplica **nunca**, aunque siga cambiando. El contrato v3.1 dice que los migrados no se entregan, así que un conflicto debería ser anómalo. Se deja un `log.warn` sin PII para detectarlo.
