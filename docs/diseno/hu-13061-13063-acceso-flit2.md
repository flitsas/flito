# Diseño slim — Acceso de FLITO a FLIT 2 (HU #13061 y #13063)

Feature #13057 «Acceso de FLITO a FLIT 2» · Épica #12736. Estado: **Propuesto** (sin ADR, ver abajo).
Contrato del proveedor: `docs/integraciones/flit2-api.md` §2 (lo versiona la #13061).
Habla con **`flito-sync`** (módulo FLITO). El adaptador de FLIT 1 (`flit-http.adapter.ts`, `flit.port.ts`) **no se toca**.

## Patrón reutilizado

- Token SIMIT de Comparendos: `apps/api/src/modules/flito-comparendos/flito-comparendos.token.service.ts`
  (RN-07 una fila activa + rotar = desactivar e insertar; RN-08 la consulta no trae el cipher; RN-09 sin llave → 503 explícito; RN-10 descifrado fallido desactiva la fila).
- Tabla: `flitoComparendosTokenSimit` en `apps/api/src/db/schema.ts` (bytea cipher/iv/tag, `aad_nonce`, `key_version`, índice único parcial sobre `activo`).
- Keyspace de cifrado: bloque «Comparendos» de `apps/api/src/shared/utils/crypto.ts` (`encryptComparendosSecret` / `ComparendosEncKeyError`).
- Env: `COMPARENDOS_ENC_KEY` y `VERIFIK_SIMIT_BASE_URL` en `apps/api/src/config/env.ts` (opcionales con `vacioComoAusente`).
- Siembra de funciones: `0212_permiso_soat_reintentar_runt.sql` (INSERT … ON CONFLICT DO NOTHING + reparto a admin + DO de resumen) y `MIGRACIONES_CON_REPARTO` en `apps/api/__tests__/helpers/permisos-seed-sql.ts`.
- Limitador: `rateLimit` + `makeStore` + `userOrIpKey` de `shared/middleware/rateLimiter.ts`, como `tokenLimiter` en `flito-comparendos.routes.ts`.
- Guardas: `exigirFuncion(...)` + `audit(...)` como en `flito-sync.routes.ts`.

## Decisiones

1. **Llave de cifrado — nueva `FLIT2_ENC_KEY`** (64 hex, `openssl rand -hex 32`), keyspace propio en `crypto.ts` (`encryptFlit2Secret` / `decryptFlit2Secret` / `Flit2EncKeyError`). Mismo criterio que ADR-0002: mínimo privilegio, una llave comprometida no abre otra integración. Opcional en `env.ts`: **la API arranca sin ella**; `GET acceso` sigue respondiendo (diagnóstico), `PUT` y todo uso del pase fallan con 503 `llave_maestra` antes de tocar la base. Sin derivación de respaldo en desarrollo.
2. **Caché del pase en memoria del proceso; marcas en la tabla.** El `accessToken` vive solo en RAM (un `Map` de módulo + single-flight de la petición en curso): perderlo en un reinicio cuesta una llamada de token, y no se persiste un bearer. Las marcas **rechazado** (401 `invalid_client` / 403 `secret_rotation_required`) y **bloqueado hasta** (423 → +15 min; 429 → `Retry-After`) van **en la fila vigente**: sobreviven al reinicio y, como reemplazar el acceso crea una fila nueva, la marca se levanta sola sin UPDATE. Redis no aporta con un solo contenedor y agregaría una dependencia de disponibilidad a una marca que debe ser durable.
3. **URL base — `FLIT2_BASE_URL`** (`z.preprocess(vacioComoAusente, z.string().url().optional())`). El host no va al repo (repo público): solo en el `.env` de cada ambiente y un placeholder vacío en `.env.example`. Ausente → resultado `no_configurado` («FLIT 2 no está configurado en este ambiente»), sin llamar. Timeout fijo de 10 s con `AbortSignal.timeout` sobre `fetch` nativo (sin dependencia nueva).
4. **Esquema — tabla `flito_sync_flit2_acceso`** (Drizzle `flitoSyncFlit2Acceso`), AAD `{ table: 'flito_sync_flit2_acceso', column: 'secret_cipher', empresaNit: 'flit2', aadNonce }`. Índice único parcial `uq_flito_sync_flit2_acceso_activo ON (activo) WHERE activo`. Columnas abajo.
5. **Rutas — confirmadas** `GET/PUT /api/flito/sync/flit2/acceso` y `POST /api/flito/sync/flit2/acceso/probar`, en un router propio `flit2.routes.ts` montado en `app.ts` como `app.use('/api/flito/sync/flit2', flit2Routes)` **antes** de la línea de `flitoSyncRoutes` (hoy `app.ts:256`), para no pasar dos veces por `authMiddleware` ni engordar `flito-sync.routes.ts`.
6. **Migración `0214_flit2_acceso.sql`** (la 0213 es de la #13070). Crea la tabla (incluidas las columnas de marcas que usa la #13063, para no necesitar una segunda migración), siembra `tramites.flit2.ver_acceso` y `tramites.flit2.guardar_acceso` (`modulo = 'tramites'`, `tipo = 'operacion'`) y el reparto solo a `admin`; DO de resumen con `RAISE EXCEPTION` si no cuadra. Se agrega a `MIGRACIONES_CON_REPARTO`.
7. **Interfaz para #13059:** `flit2-pase.service.ts` exporta `conPase<T>(fn: (pase: Flit2Pase) => Promise<Response>): Promise<Response>` (inyecta el bearer, ante 401 invalida y renueva **una** vez, traduce errores), más `obtenerPase(): Promise<Flit2Pase>` e `invalidarPase(): void`. `Flit2Pase = { authorization: Redacted<string>; scope: string[]; conPii: boolean; expiraEn: Date }`. La lectura decide qué hacer si `conPii === false`.

## Modelo de datos (Drizzle / SQL de la 0214)

| Columna | Tipo | Nota |
|---|---|---|
| `id` | smallserial PK | |
| `client_id` | varchar(120) NOT NULL | usuario de servicio; no es secreto ni PII, se devuelve |
| `secret_cipher` / `secret_iv` / `secret_auth_tag` | bytea NOT NULL | AES-256-GCM, `FLIT2_ENC_KEY` |
| `aad_nonce` | uuid NOT NULL | generado antes del INSERT |
| `key_version` | smallint NOT NULL DEFAULT 1 | |
| `activo` | boolean NOT NULL DEFAULT true | índice único parcial |
| `rechazado_en` | timestamptz NULL | marca durable (#13063) |
| `rechazo_motivo` | varchar(40) NULL | `invalid_client` \| `secret_rotation_required` (CHECK) |
| `bloqueado_hasta` | timestamptz NULL | 423 (+15 min) o 429 (`Retry-After`) |
| `bloqueo_motivo` | varchar(40) NULL | `client_locked` \| `rate_limited` (CHECK) |
| `descifrado_fallido_en` / `_motivo` | timestamptz / varchar(200) NULL | RN-10 |
| `created_at/by`, `updated_at/by` | como SIMIT | `updated_by` FK `users.id` |

Reemplazar = transacción: `UPDATE … SET activo=false` de la vigente + `INSERT` nueva (rastro = filas inactivas). Unicidad violada → 409 rotación concurrente (como SIMIT). Tras el commit: `invalidarPase()`.

## Contrato delta

```
GET  /api/flito/sync/flit2/acceso          exigirFuncion('tramites.flit2.ver_acceso')
  200 Flit2AccesoMeta { configurado, clientId|null, actualizadoPor {id,nombre}|null,
                        actualizadoEn|null, estado: 'vigente'|'rechazado'|'bloqueado'|null,
                        bloqueadoHasta|null }      -- nunca el secreto; select sin columnas cipher
PUT  /api/flito/sync/flit2/acceso          exigirFuncion('tramites.flit2.guardar_acceso') + audit
  body (Zod .strict) { clientId: string 1..120, clientSecret: string 1..512 }
  200 Flit2AccesoMeta · 400 validación · 409 concurrente · 503 llave_maestra
POST /api/flito/sync/flit2/acceso/probar   exigirFuncion('tramites.flit2.guardar_acceso') + flit2ProbarLimiter (5/min por usuario) + audit
  200 Flit2PruebaResultado { resultado: 'conectado'|'conectado_sin_pii'|'rechazado'|'bloqueado'
        |'no_responde'|'no_configurado'|'sin_acceso', mensaje, bloqueadoHasta|null, scope: string[] }
  503 llave_maestra · 429 limitador
```

El resultado de la prueba es dato (200), no error HTTP: la pantalla lo pinta como aviso. `probar` ignora la caché y pide siempre un pase nuevo; si sale bien, deja ese pase en la caché.

Traducción (única, en `flit2-pase.service.ts`, la usan `conPase` y `probar`): 200 → pase (sin `external.tramites.pii.read` → `conectado_sin_pii`); 401 `invalid_client` / 403 `secret_rotation_required` → marca rechazado en la fila; 423 → `bloqueado_hasta = now()+15 min`; 429 → `bloqueado_hasta = now()+Retry-After` (60 s si falta); timeout / red / 5xx → `no_responde` (sin marca). Los procesos automáticos (`conPase`) **no llaman** si la fila está rechazada o `bloqueado_hasta > now()`: lanzan `Flit2RechazadoError` / `Flit2BloqueadoError` al instante.

Auditoría: `audit` con acción `flit2.acceso.guardar` / `flit2.acceso.probar`, `resourceId` = id de la fila, detalle solo `clientId` y resultado. Nunca `clientSecret` ni `accessToken` en audit, logger ni respuesta de error. `logPiiAccess` no aplica (no se lee PII).

## Archivos a crear/modificar

### HU #13061 — guardar/reemplazar/consultar el acceso
- `apps/api/src/db/migrations/0214_flit2_acceso.sql` (crear)
- `apps/api/src/db/schema.ts` (tabla `flitoSyncFlit2Acceso`)
- `apps/api/src/config/env.ts` (`FLIT2_ENC_KEY`, `FLIT2_BASE_URL`) y `apps/api/.env.example` (placeholders vacíos, sin host)
- `apps/api/src/shared/utils/crypto.ts` (keyspace FLIT 2)
- `apps/api/src/modules/flito-sync/flit2.errors.ts` (crear: `Flit2LlaveMaestraError`, `Flit2AccesoRotacionConcurrenteError`, `Flit2AccesoDescifradoError`, y los de la #13063)
- `apps/api/src/modules/flito-sync/flit2-acceso.service.ts` (crear: `obtenerMetaAcceso`, `guardarAcceso`, `leerSecretoVigente(): Redacted`, `marcarRechazo`, `marcarBloqueo`)
- `apps/api/src/modules/flito-sync/flit2.routes.ts` (crear: GET/PUT)
- `apps/api/src/app.ts` (montaje antes de `/api/flito/sync`)
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` (ops GET/PUT) + `inventario.generado.ts` regenerado con `npm run permisos:seed -w apps/api`
- `apps/api/__tests__/helpers/permisos-seed-sql.ts` (`'0214_flit2_acceso.sql'` en `MIGRACIONES_CON_REPARTO`)
- `packages/shared-types/src/flito-flit2.ts` (crear: `Flit2AccesoMeta`, `Flit2GuardarAccesoInput`) + export en el índice
- `docs/integraciones/flit2-api.md` (versionar)
- Tests: `apps/api/__tests__/services/flito-sync.flit2-acceso.test.ts`, `apps/api/__tests__/db/migracion-0214.test.ts` (asertar «la anterior es 0213», no «es la última»)

### HU #13063 — pase y «Probar conexión»
- `apps/api/src/modules/flito-sync/flit2-pase.service.ts` (crear: `obtenerPase`, `conPase`, `invalidarPase`, `probarConexion`, traducción de respuestas)
- `apps/api/src/modules/flito-sync/flit2.routes.ts` (POST `probar` + `flit2ProbarLimiter` 5/min `userOrIpKey('flit2-probar')`)
- `apps/api/src/modules/flito-sync/flit2.errors.ts` (`Flit2NoConfiguradoError`, `Flit2SinAccesoError`, `Flit2RechazadoError`, `Flit2BloqueadoError`, `Flit2NoRespondeError`)
- `apps/api/src/modules/flito-sync/flit2-acceso.service.ts` (`guardarAcceso` llama `invalidarPase()` tras el commit — si la #13063 va después, la llamada entra aquí)
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` (op `POST /acceso/probar` → `tramites.flit2.guardar_acceso`) + `inventario.generado.ts`
- `packages/shared-types/src/flito-flit2.ts` (`Flit2PruebaResultado`)
- Tests: `apps/api/__tests__/services/flito-sync.flit2-pase.test.ts` (fetch mockeado: caché hasta `expiresIn−60`, un solo reintento ante 401, 401/403/423/429/5xx/timeout, sin url, scope sin PII, marca durable leída de la fila, reemplazo levanta la marca). Fijar `TZ=UTC` / reloj falso en los asertos de caducidad.

Sin migración propia en la #13063: las columnas de marcas nacen en la 0214.

## ADR: no aplica

Extensión directa del patrón SIMIT (ADR-0002) a otra credencial de integración; no hay contrato público nuevo ni excepción de PII en URL.

## Notas operativas (backend)

- `crypto.ts`: medir con `npx eslint apps/api/src/shared/utils/crypto.ts` tras el cambio (tope 800 sin blancos/comentarios).
- Verificar que el `redact` de pino cubre `clientSecret` y `authorization`; si no, añadirlos en `shared/logger.ts`.
- El `mensaje` de la prueba sale de un mapa de copy fijo en el servicio, nunca del cuerpo de FLIT 2.
- La consulta de metadatos no selecciona las columnas cipher (RN-08 de SIMIT), exclusión a nivel de query.
- Frontend: fuera del alcance de estas dos HUs (BACKEND). La pantalla que consuma el contrato va en otra HU.

## Pendiente humano

- **`probar` con la fila marcada «rechazado»:** propuesta = el admin sí puede probar (es manual) y, si sale 200, la marca se limpia; si está `bloqueado_hasta` futuro, no llama y responde `bloqueado`. Alternativa estricta: solo un acceso nuevo levanta la marca. Confirmar.
- **Permiso de `probar`:** propuesta = reutiliza `tramites.flit2.guardar_acceso` (la AC solo nombra dos códigos). Si se quiere un tercero, cambia la 0214.
