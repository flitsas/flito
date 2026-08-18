# Diseño — Feature #11492 (17a) Monitoreo de Comparendos — Ingesta y parametrización

| Campo | Valor |
|---|---|
| Feature ADO | [#11492](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11492) |
| Sucesor | [#11495](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11495) (17b visor/gestión/export) — contratos listos; UI fuera de alcance |
| Estado del diseño | **Aceptado** (2026-08-13) — Opción 1; hosts env; sync síncrono; retención 24 meses parametrizable |
| ADRs | `docs/adr/ADR-0001-…`, `ADR-0002-…`, `ADR-0003-…` |
| Módulo | `flito-comparendos` → `/api/flito/comparendos` |
| Migración inicial | `0150_flito_comparendos_ingesta.sql` (`0149` ocupado por Siigo en rama actual) |

## Contexto

Hoy FLITO no tiene un módulo operativo de monitoreo multi-NIT / multi-municipio. Existen:

- Consultas SIMIT en `apps/api/src/modules/integraciones/` (FCM directo + proxy CEA) usadas por **preflight/traspaso**.
- Gate `traspaso-simit-gate` y semáforo de pre-vuelo.
- Tipo de incidente PESV `comparendo` — otro dominio.

Ninguno sustituye el monitoreo operativo. Este Feature crea el módulo **nuevo** `flito-comparendos` (API + persistencia + sync bajo demanda), reutilizando solo utilidades HTTP, **sin** mezclar tablas, rutas ni reglas de traspaso/PESV.

Decisiones de producto cerradas (Feature + humano): sync solo endpoint; unicidad = número de comparendo; merge SIMIT > municipal; token editable con trazabilidad; municipios parametrizables + seed 8; datos fuente inmutables; causales CRUD en 17a; sync global o por NIT(s); permisos = `admin` (operaciones FLITO); inactivación si desaparece de ambas fuentes en un sync exitoso; placa = dato/filtro.

Patrones análogos en el repo:

| Necesidad | Patrón vigente |
|---|---|
| routes/service + `requireRole('admin')` | `flito-parametrizacion`, `flito-sync` |
| Sync disparado a mano | `POST /api/flito/sync/sincronizar` |
| Secreto cifrado AES-256-GCM + AAD | `siigoCredenciales` / `rndcCredenciales` + `shared/utils/crypto.ts` |
| Timeline append-only | `flitoLiquidacionEventos`, `flitoLogisticaEventos` |
| Cliente HTTP sin acoplar dominio | `integraciones/http.ts` (`httpsJson`, `httpsGetJson`) |
| Normalización de forma SIMIT (referencia de campos, no de transporte) | `integraciones/simit.direct.ts` → `SimitComparendo` / `normalizeComparendos` |

**Qué NO reutilizar como dueño de dominio:** `consultarSimit`, `simit.direct` (PoW FCM), `cea-proxy`, `traspaso-simit-gate`, tablas PESV. El Feature pide Verifik (`GET …/v2/co/simit/consultar?documentType&documentNumber`) + UTS municipal (`GET …/infraction/api/Infraccion/ConsultarInfraccionFuente?fuente&nit`) — distinto del SIMIT FCM/CEA.

## Alternativas

### Opción 1 — Módulo autónomo + canónico tipado + raw JSONB + sync con corridas (recomendada)

Módulo `flito-comparendos` con tablas propias; clientes Verifik/UTS como adapters internos; columnas canónicas tipadas + `payload_simit` / `payload_municipal` JSONB; tabla de mapeo versionable; `sync_runs` + `sync_run_steps` para fallos parciales; token cifrado al estilo Siigo.

| Pros | Contras |
|---|---|
| Alineado a CF y a módulos `flito-*` | Más tablas/migración inicial |
| 17b puede filtrar por columnas sin parsear JSON | Mapa provisional hasta spike de payloads reales |
| Fallos NIT×municipio auditable y no “falsos inactivos” | Sync síncrono puede tardar con muchos NIT×municipio |
| Secreto y PII con patrones ya probados | Nueva env key de cifrado + hosts |

- **Esfuerzo:** M
- **Riesgos:** Homologación provisional incorrecta hasta spike; timeouts en matriz grande (mitigar con reporte parcial + rate limit + límites de concurrencia).

### Opción 2 — Solo JSONB “blob” + vistas materializadas después

Persistir casi solo payloads crudos y metadatos mínimos (`numero`, `nit`, `estado`); derivar canónico en lectura o en job posterior.

| Pros | Contras |
|---|---|
| Tolera drift de API sin migración de columnas | Filtros/export 17b más caros e inestables |
| Spike más rápido | Merge SIMIT>municipal opaco y frágil |
| Menos columnas iniciales | Dificulta índices (placa, fecha, organismo) |

- **Esfuerzo:** S→M (barato al inicio, caro en 17b)
- **Riesgos:** Reescritura del modelo al llegar el visor; deuda de consulta.

### Opción 3 — Extender `integraciones/` + tablas compartidas con traspaso

Ampliar `consultarSimit` / rutas de integraciones y persistir en tablas “comunes” de multas.

| Pros | Contras |
|---|---|
| Reutiliza nombre “SIMIT” ya conocido | Viola decisión de producto y CF de separación |
| Menos módulos nuevos | Acopla rate limits/credenciales Verifik al preflight FCM |
| | Riesgo de romper traspaso al cambiar contratos |

- **Esfuerzo:** M (pero con alto costo de acoplamiento)
- **Riesgos:** Confusión de dominio (Feature lo marca Medio); regresiones en gate de traspaso.

## Decisión y justificación

**Elegir Opción 1.** Es la única que cumple CF-06…CF-12, deja contratos estables para 17b, y reutiliza patrones del monorepo (Siigo credenciales, flito-sync manual, eventos append-only) sin inventar stack ni mezclar con traspaso/PESV.

Detalle de la opción elegida en las secciones siguientes. Decisiones satélite en ADRs 0001–0003.

## Diagrama de secuencia (Mermaid)

```mermaid
sequenceDiagram
  autonumber
  actor Ops as Operaciones (admin)
  participant API as flito-comparendos.routes
  participant Svc as flito-comparendos.service
  participant Tok as token (cipher AES-GCM)
  participant DB as PostgreSQL
  participant V as Verifik SIMIT
  participant U as UTS municipal

  Ops->>API: POST /sync { nits?: string[] }
  API->>API: auth + requireRole(admin) + rateLimit
  API->>Svc: iniciarSync(scope, userId)
  Svc->>DB: INSERT sync_run (running)
  Svc->>Tok: decrypt token (Redacted; nunca log)
  loop cada NIT del scope
    Svc->>V: GET /v2/co/simit/consultar?documentType&documentNumber (Bearer)
    alt OK
      V-->>Svc: lista comparendos
      Svc->>DB: upsert canónico (fuente simit) + step ok
    else fallo
      V-->>Svc: error/timeout
      Svc->>DB: sync_run_step failed (simit, nit)
      Note over Svc: NIT marcado "simit_incompleto"; no inactivar por este NIT
    end
    loop cada municipio activo
      Svc->>U: GET /infraction/api/Infraccion/ConsultarInfraccionFuente?fuente&nit
      alt OK
        U-->>Svc: lista
        Svc->>DB: merge municipal (solo campos ausentes) + step ok
      else fallo
        Svc->>DB: sync_run_step failed (municipal, nit, fuente)
        Note over Svc: municipio incompleto; no contar como "ausente"
      end
    end
  end
  Svc->>DB: para NIT con SIMIT ok y municipales ok del scope:<br/>inactivar no vistos + timeline
  Svc->>DB: UPDATE sync_run (completed|partial|failed) + resumen
  Svc-->>API: ComparendosSyncResultado
  API-->>Ops: 200 JSON (sin token, PII redactada en logs)
```

## Contrato de endpoints

Base: `/api/flito/comparendos`. Todas las rutas: `authMiddleware` + `requireRole('admin')` (CF-12). Sync y PUT token: `rateLimiter`.

### Catálogo NITs (CF-01)

| Método | Ruta | Body / query (Zod) | Respuesta | Errores |
|---|---|---|---|---|
| `GET` | `/nits` | — | `ComparendosNit[]` | 401/403 |
| `POST` | `/nits` | `{ nit: string(5–20), alias?: string\|null, activo?: boolean }` | `201 ComparendosNit` | 400, 409 `nit_duplicado` |
| `PATCH` | `/nits/:id` | `{ alias?, activo? }` (no cambia `nit` si ya hubo sync — o permitir solo si `activo`/`alias`) | `ComparendosNit` | 400, 404 |
| `DELETE` | `/nits/:id` | soft: preferir `PATCH activo=false`; hard solo si sin comparendos | `204` / `409 nit_en_uso` | 404, 409 |

### Municipios (CF-02)

| Método | Ruta | Body | Respuesta | Errores |
|---|---|---|---|---|
| `GET` | `/municipios` | — | `ComparendosMunicipio[]` | 401/403 |
| `POST` | `/municipios` | `{ codigoFuente: string, nombre?: string, activo?: boolean }` — `codigoFuente` = valor `fuente` UTS | `201` | 400, 409 |
| `PATCH` | `/municipios/:id` | `{ nombre?, activo? }` | fila | 400, 404 |

Seed (migración): BELLO, ITAGUI, CALI, ENVIGADO, MANIZALES, MEDELLIN, RIONEGRO, SABANETA — `activo=true`.

### Causales (CF-04) — listos para 17b

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| `GET` | `/causales` | — | `ComparendosCausal[]` |
| `POST` | `/causales` | `{ nombre: string, activo?: boolean, orden?: number }` | `201` |
| `PATCH` | `/causales/:id` | `{ nombre?, activo?, orden? }` | fila |

Seed sugerido: Registrado, Contactado cliente, Pago gestionado, En proceso de validación, Observación operativa.

### Token SIMIT (CF-03)

| Método | Ruta | Body | Respuesta | Notas |
|---|---|---|---|---|
| `GET` | `/config/token-simit` | — | `{ configurado: boolean, actualizadoEn: iso\|null, actualizadoPor: {id,nombre}\|null, keyVersion: number\|null }` | **Nunca** el token |
| `PUT` | `/config/token-simit` | `{ token: string.min(1).max(2048) }` | mismo shape que GET | Cifra en reposo; audit `flito_comparendos_token`; `Redacted` |

### Sync (CF-05, CF-06)

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| `POST` | `/sync` | `{ nits?: string[] }` — omitido/vacío = todos los NIT activos | `ComparendosSyncResultado` |
| `GET` | `/sync/runs` | `?limit=20` | lista resumida |
| `GET` | `/sync/runs/:id` | — | detalle + `steps[]` |

`ComparendosSyncResultado` (forma):

```ts
{
  runId: string; // uuid
  estado: 'completed' | 'partial' | 'failed';
  iniciadoEn: string;
  finalizadoEn: string;
  scopeNits: string[];
  resumen: {
    nitsProcesados: number;
    llamadasSimitOk: number;
    llamadasSimitError: number;
    llamadasMunicipalOk: number;
    llamadasMunicipalError: number;
    upserts: number;
    inactivados: number;
    reactivados: number;
    primeraLlegada: number;
  };
  steps: ComparendosSyncStep[]; // nit, fuente ('simit'|codigoMunicipio), ok, httpStatus?, errorCode?, duracionMs, itemsLeidos?
}
```

Errores sync: `400` sin NIT activos / NIT filtro inválido; `409 sync_en_curso` (un sync a la vez — advisory lock o fila `running`); `503 token_no_configurado` / `llave_maestra`; `429` rate limit.

### Lectura para 17b (contratos, sin UI)

| Método | Ruta | Query | Body | Respuesta | Notas |
|---|---|---|---|---|---|
| `GET` | `/registros` | `estado?`, `q?` (número), `limit`, `cursor` | — | `{ items: ComparendoRegistro[], nextCursor }` | Vista por defecto. Sin filtros de identidad: `?nit=` es **400** |
| `POST` | `/registros/buscar` | las mismas de arriba | `{ nit?, placa? }` | igual que el `GET` | Búsqueda, no mutación: responde **200** |
| `GET` | `/registros/:id` | — | — | `ComparendoRegistroDetalle` (+ timeline) | El `id` es un UUID opaco: el path lo admite |
| `GET` | `/registros/:id/eventos` | — | — | `ComparendoEvento[]` | Sin PII en la respuesta (RN-20/RN-35) |

> **Corrección sobre el AC1 original (HU #11502).** El diseño pedía `GET /registros` con `nit` y `placa` en la query, y eso
> incumple AGENTS.md §14: los filtros con PII o cuasi-PII van en el **cuerpo** de un `POST …/buscar`. Se descartó tramitar
> el ADR de excepción porque su mitigación principal —que nginx no registre la query en claro— depende de una configuración
> que no está versionada en el repo y no se puede verificar. Todo lo demás del AC1 (paginación por cursor, límite de página,
> proyección sin payloads) se mantiene. Tope de página: **50** filas.
>
> Las tres lecturas con NIT o placa salen con `Cache-Control: no-store` y dejan registro en `pii_access_log`.

**Fuera de 17a (17b):** PATCH causal/observación, PageSlug, export Excel, UI config.

Si se quiere desbloquear 17b en paralelo, el PATCH de gestión puede quedar stub documentado:

| Método | Ruta | Body | Feature |
|---|---|---|---|
| `PATCH` | `/registros/:id/gestion` | `{ causalId?: uuid\|null, observacion?: string\|null }` | **17b** (no implementar en 17a; columna sí existe) |

## Modelo de datos (Drizzle)

Prefijo tablas: `flito_comparendos_*`. Enums locales (no reutilizar PESV).

```ts
// --- sketch para schema.ts (backend-agent traduce 1:1) ---

export const flitoComparendosEstadoEnum = pgEnum('flito_comparendos_estado', ['activo', 'inactivo']);
export const flitoComparendosSyncEstadoEnum = pgEnum('flito_comparendos_sync_estado', [
  'running', 'completed', 'partial', 'failed',
]);
export const flitoComparendosEventoTipoEnum = pgEnum('flito_comparendos_evento_tipo', [
  'primera_llegada', 'inactivacion', 'reaparicion',
]);
export const flitoComparendosOrigenMergeEnum = pgEnum('flito_comparendos_origen_merge', [
  'simit', 'municipal', 'ambos',
]);

export const flitoComparendosNits = pgTable('flito_comparendos_nits', {
  id: uuid('id').primaryKey().defaultRandom(),
  nit: varchar('nit', { length: 20 }).notNull(), // unique
  alias: varchar('alias', { length: 120 }),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  nitUq: uniqueIndex('uq_flito_comparendos_nits_nit').on(t.nit),
}));

export const flitoComparendosMunicipios = pgTable('flito_comparendos_municipios', {
  id: uuid('id').primaryKey().defaultRandom(),
  codigoFuente: varchar('codigo_fuente', { length: 40 }).notNull(), // valor ?fuente=
  nombre: varchar('nombre', { length: 80 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fuenteUq: uniqueIndex('uq_flito_comparendos_municipios_fuente').on(t.codigoFuente),
}));

export const flitoComparendosCausales = pgTable('flito_comparendos_causales', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: varchar('nombre', { length: 120 }).notNull(),
  activo: boolean('activo').notNull().default(true),
  orden: smallint('orden').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nombreUq: uniqueIndex('uq_flito_comparendos_causales_nombre').on(t.nombre),
}));

/** Singleton lógico: una fila activa de token (historial = filas inactivas). Ver ADR-0002. */
export const flitoComparendosTokenSimit = pgTable('flito_comparendos_token_simit', {
  id: smallserial('id').primaryKey(),
  tokenCipher: bytea('token_cipher').notNull(),
  tokenIv: bytea('token_iv').notNull(),
  tokenAuthTag: bytea('token_auth_tag').notNull(),
  aadNonce: uuid('aad_nonce').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
}, (t) => ({
  unActivo: uniqueIndex('uq_flito_comparendos_token_activo').on(t.activo).where(sql`${t.activo}`),
}));

/**
 * Mapa versionable SIMIT/municipal → canónico (ADR-0003).
 * sourcePath: JSONPath / clave top-level documentada; targetField: columna canónica.
 */
export const flitoComparendosFieldMap = pgTable('flito_comparendos_field_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(), // bump al validar spike
  origen: varchar('origen', { length: 20 }).notNull(), // 'simit' | 'municipal'
  sourcePath: varchar('source_path', { length: 120 }).notNull(),
  targetField: varchar('target_field', { length: 60 }).notNull(),
  provisional: boolean('provisional').notNull().default(true),
  notas: text('notas'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  verOrigPath: uniqueIndex('uq_flito_comparendos_field_map').on(t.version, t.origen, t.sourcePath),
}));

export const flitoComparendosRegistros = pgTable('flito_comparendos_registros', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Clave de negocio (CF-07)
  numeroComparendo: varchar('numero_comparendo', { length: 60 }).notNull(),
  nitMonitoreado: varchar('nit_monitoreado', { length: 20 }).notNull(),
  // --- Campos de FUENTE (inmutables vía API; solo el sync escribe) ---
  placa: varchar('placa', { length: 10 }),
  codigoInfraccion: varchar('codigo_infraccion', { length: 20 }),
  descripcionInfraccion: text('descripcion_infraccion'),
  fechaComparendo: date('fecha_comparendo'),
  organismo: varchar('organismo', { length: 120 }),
  municipioFuente: varchar('municipio_fuente', { length: 40 }), // codigo UTS si aplica
  monto: numeric('monto', { precision: 14, scale: 2 }),
  estadoFuente: varchar('estado_fuente', { length: 80 }), // texto crudo del proveedor
  origenMerge: flitoComparendosOrigenMergeEnum('origen_merge').notNull(),
  vistoEnSimit: boolean('visto_en_simit').notNull().default(false),
  vistoEnMunicipal: boolean('visto_en_municipal').notNull().default(false),
  payloadSimit: jsonb('payload_simit'),
  payloadMunicipal: jsonb('payload_municipal'),
  // --- Estado de monitoreo (sync) ---
  estado: flitoComparendosEstadoEnum('estado').notNull().default('activo'),
  primeraVistoEn: timestamp('primera_visto_en', { withTimezone: true }).notNull().defaultNow(),
  ultimoVistoEn: timestamp('ultimo_visto_en', { withTimezone: true }).notNull().defaultNow(),
  inactivadoEn: timestamp('inactivado_en', { withTimezone: true }),
  ultimoSyncRunId: uuid('ultimo_sync_run_id'),
  // --- Gestión operativa (17b escribe; 17a solo esquema) ---
  causalId: uuid('causal_id').references(() => flitoComparendosCausales.id),
  observacion: text('observacion'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numeroUq: uniqueIndex('uq_flito_comparendos_numero').on(t.numeroComparendo),
  nitIdx: index('idx_flito_comparendos_nit').on(t.nitMonitoreado),
  placaIdx: index('idx_flito_comparendos_placa').on(t.placa),
  estadoIdx: index('idx_flito_comparendos_estado').on(t.estado),
}));

export const flitoComparendosEventos = pgTable('flito_comparendos_eventos', {
  id: uuid('id').primaryKey().defaultRandom(),
  registroId: uuid('registro_id').notNull()
    .references(() => flitoComparendosRegistros.id, { onDelete: 'cascade' }),
  tipo: flitoComparendosEventoTipoEnum('tipo').notNull(),
  syncRunId: uuid('sync_run_id'),
  detalle: jsonb('detalle'), // sin token; nit/placa opcionales — pii-audit en lecturas
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  regIdx: index('idx_flito_comparendos_eventos_reg').on(t.registroId, t.createdAt),
  // Anti-spam duro: a lo sumo un evento del mismo tipo por registro+run
  regTipoRunUq: uniqueIndex('uq_flito_comparendos_evento_reg_tipo_run')
    .on(t.registroId, t.tipo, t.syncRunId),
}));

export const flitoComparendosSyncRuns = pgTable('flito_comparendos_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  estado: flitoComparendosSyncEstadoEnum('estado').notNull().default('running'),
  scopeNits: jsonb('scope_nits').notNull(), // string[]
  resumen: jsonb('resumen'),
  iniciadoPor: integer('iniciado_por').references(() => users.id),
  iniciadoEn: timestamp('iniciado_en', { withTimezone: true }).notNull().defaultNow(),
  finalizadoEn: timestamp('finalizado_en', { withTimezone: true }),
});

export const flitoComparendosSyncSteps = pgTable('flito_comparendos_sync_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull()
    .references(() => flitoComparendosSyncRuns.id, { onDelete: 'cascade' }),
  nit: varchar('nit', { length: 20 }).notNull(),
  fuente: varchar('fuente', { length: 40 }).notNull(), // 'simit' | codigoMunicipio
  ok: boolean('ok').notNull(),
  httpStatus: smallint('http_status'),
  errorCode: varchar('error_code', { length: 60 }),
  mensaje: text('mensaje'), // sin PII/token
  itemsLeidos: integer('items_leidos'),
  duracionMs: integer('duracion_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('idx_flito_comparendos_sync_steps_run').on(t.runId),
}));
```

### Reglas de merge e inactivación

1. **Unicidad:** upsert por `numero_comparendo` (normalizar trim/uppercase según spike).
2. **Merge:** aplicar primero SIMIT (sobrescribe canónicos); municipal solo si el canónico destino es `null`/vacío (CF-08). Actualizar `visto_en_*`, `origen_merge`, payloads.
3. **Inactivación (CF-10):** solo para NITs cuyo paso SIMIT fue `ok` **y** todos los municipios activos del run fueron `ok`. Comparendos de ese NIT no re-vistos → `estado=inactivo`, `inactivado_en`, evento `inactivacion` si antes estaba `activo`.
4. **Reaparición:** inactivo vuelve a aparecer → `activo`, limpia `inactivado_en`, evento `reaparicion`.
5. **Primera llegada:** insert nuevo → evento `primera_llegada` una vez. Syncs siguientes con el registro activo: solo `ultimo_visto_en` (sin evento).
6. **Idempotencia:** re-sync con mismos datos no duplica filas ni eventos (índice único evento por run+tipo).

### Homologación provisional (hasta spike)

Mapa v1 `provisional=true` inspirado en `SimitComparendo` + alias comunes:

| targetField | SIMIT (candidates) | Municipal (candidates) |
|---|---|---|
| `numeroComparendo` | `numeroComparendo`, `comparendo`, `numero`, `numeroMulta` | `numero`, `numeroComparendo`, `comparendo` |
| `placa` | `placa` | `placa` |
| `codigoInfraccion` | `codigoInfraccion`, `codigo` | `codigo`, `infraccion` |
| `descripcionInfraccion` | `descripcionInfraccion` | `descripcion`, `descripcionInfraccion` |
| `fechaComparendo` | `fechaComparendo`, `fechaImposicion` | `fecha`, `fechaComparendo` |
| `organismo` | `secretariaNombre`, `organismoTransito` | `organismo`, `secretaria` |
| `monto` | `valorAPagar`, `valor`, `monto` | `valor`, `monto` |
| `estadoFuente` | `estado`, `estadoCartera` | `estado` |

Spike obligatorio (HU BACKEND corta): capturar 1 respuesta Verifik + 1 UTS reales (redactadas) en `apps/api/__tests__/fixtures/comparendos/` y subir `field_map.version` con `provisional=false`.

## Archivos a crear/modificar

### Crear

| Ruta | Qué |
|---|---|
| `apps/api/src/modules/flito-comparendos/flito-comparendos.routes.ts` | Zod + HTTP + roles + rate limit |
| `apps/api/src/modules/flito-comparendos/flito-comparendos.service.ts` | CRUD catálogos + orquestación sync + errores `*Error` |
| `apps/api/src/modules/flito-comparendos/flito-comparendos-token.service.ts` | Cifrado/descifrado token (patrón Siigo) |
| `apps/api/src/modules/flito-comparendos/flito-comparendos-merge.ts` | Homologación + merge SIMIT>municipal |
| `apps/api/src/modules/flito-comparendos/clients/verifik-simit.client.ts` | Adapter Verifik (MODE mock\|real) |
| `apps/api/src/modules/flito-comparendos/clients/uts-municipal.client.ts` | Adapter UTS |
| `apps/api/src/modules/flito-comparendos/clients/types.ts` | DTOs crudos tipados mínimos |
| `apps/api/src/db/migrations/0150_flito_comparendos_ingesta.sql` | Tablas, enums, índices, seeds municipios/causales/field_map v1 |
| `apps/api/__tests__/flito-comparendos*.test.ts` | Vitest: merge, inactivación parcial, token redaction, sync idempotente |
| `apps/api/__tests__/fixtures/comparendos/` | Payloads redactados (post-spike) |
| `packages/shared-types/src/flito-comparendos.ts` | Tipos/DTOs públicos |
| `docs/adr/ADR-0001-flito-comparendos-modulo-sync.md` | Este diseño / módulo |
| `docs/adr/ADR-0002-flito-comparendos-token-simit.md` | Token cifrado |
| `docs/adr/ADR-0003-flito-comparendos-homologacion.md` | Field map + spike |
| `docs/features/flito-comparendos-ingesta-parametrizacion.md` | Este documento |

### Modificar

| Ruta | Qué |
|---|---|
| `apps/api/src/db/schema.ts` | Tablas/enums Drizzle |
| `apps/api/src/app.ts` | `app.use('/api/flito/comparendos', …)` |
| `apps/api/src/config/env.ts` | `VERIFIK_SIMIT_BASE_URL`, `UTS_MUNICIPAL_BASE_URL`, `COMPARENDOS_ENC_KEY?`, `COMPARENDOS_SIMIT_MODE` (`mock`\|`real`), timeouts opcionales |
| `packages/shared-types/src/index.ts` | `export * from './flito-comparendos.js'` |
| `docs/dominio.md` | Entrada glosario monitoreo comparendos (CF-13) |
| `apps/api/.env.example` (si existe) | Vars nuevas sin secretos reales |

### No tocar (dominio ajeno)

- `integraciones/simit.direct.ts`, `integraciones.service.ts`, `cea-proxy.ts` (salvo import de `httpsJson` / `httpsGetJson` desde el adapter nuevo).
- `tramites/traspaso-simit-gate.ts`, `preflight.ts`, PESV.
- `apps/web/**` (17b).

## Impacto en shared-types

Archivo nuevo `packages/shared-types/src/flito-comparendos.ts` (propuesta de nombres):

```ts
export type ComparendosEstado = 'activo' | 'inactivo';
export type ComparendosSyncEstado = 'running' | 'completed' | 'partial' | 'failed';
export type ComparendosEventoTipo = 'primera_llegada' | 'inactivacion' | 'reaparicion';
export type ComparendosOrigenMerge = 'simit' | 'municipal' | 'ambos';

export interface ComparendosNit { id: string; nit: string; alias: string | null; activo: boolean; /* timestamps */ }
export interface ComparendosMunicipio { id: string; codigoFuente: string; nombre: string; activo: boolean; }
export interface ComparendosCausal { id: string; nombre: string; activo: boolean; orden: number; }

export interface ComparendosTokenSimitMeta {
  configurado: boolean;
  actualizadoEn: string | null;
  actualizadoPor: { id: number; nombre: string } | null;
  keyVersion: number | null;
}

export interface ComparendoRegistro {
  id: string;
  numeroComparendo: string;
  nitMonitoreado: string;
  placa: string | null;
  codigoInfraccion: string | null;
  descripcionInfraccion: string | null;
  fechaComparendo: string | null; // YYYY-MM-DD
  organismo: string | null;
  municipioFuente: string | null;
  monto: string | null; // decimal como string
  estadoFuente: string | null;
  origenMerge: ComparendosOrigenMerge;
  estado: ComparendosEstado;
  primeraVistoEn: string;
  ultimoVistoEn: string;
  inactivadoEn: string | null;
  causalId: string | null;
  observacion: string | null;
}

export interface ComparendoRegistroDetalle extends ComparendoRegistro {
  vistoEnSimit: boolean;
  vistoEnMunicipal: boolean;
  eventos?: ComparendoEvento[];
}

export interface ComparendoEvento {
  id: string;
  tipo: ComparendosEventoTipo;
  syncRunId: string | null;
  createdAt: string;
  detalle?: Record<string, unknown> | null;
}

export interface ComparendosSyncStep { /* ver contrato sync */ }
export interface ComparendosSyncResultado { /* ver contrato sync */ }

export interface ComparendosSyncRequest { nits?: string[]; }
export interface ComparendosGestionPatch { causalId?: string | null; observacion?: string | null; } // 17b
```

Sin `PageSlug` en 17a.

## Token SIMIT — almacenamiento (resumen; detalle ADR-0002)

| Enfoque | Veredicto |
|---|---|
| Solo `process.env` | No cumple “editable en app + quién/cuándo” |
| Texto plano en BD | Rechazado (riesgo Alto del Feature) |
| **AES-256-GCM en BD + `COMPARENDOS_ENC_KEY` + meta GET sin secreto** | **Elegido** — igual que Siigo/RNDC; audit middleware; `Redacted` en runtime |

Bootstrap opcional: si no hay fila activa y existe `VERIFIK_SIMIT_TOKEN` en env (solo boot/dev), el servicio puede usarlo **sin** loguearlo; la UI/API de 17b persistirá el valor vía PUT. No es sustituto del cifrado en reposo en PDN.

## Sync resiliente (resumen)

- Un `sync_run` por disparo; steps por `(nit, fuente)`.
- Errores parciales → `estado=partial` si hubo al menos un step ok; `failed` si cero ok.
- Inactivación **conservadora** (solo NITs con cobertura completa de fuentes en ese run).
- Concurrencia: rechazar segundo sync con `409` mientras exista run `running` (o lock `pg_try_advisory_lock`).
- **Paralelismo acotado (ADR-0001 §7):** steps municipales con pool 4–6 y timeout por llamada ~8s (techo nginx `proxy_read_timeout` ≈ 120s). Endpoint sigue síncrono.
- Timeouts por llamada (env); no tumbar el run completo.
- Logs: códigos de error + conteos; NIT/placa hasheados o truncados según `pii-audit`; token nunca.

## Notas operativas por agente

### backend-agent

- Implementar Opción 1 + migración SQL plana `0150_flito_comparendos_ingesta.sql` (idempotente donde se pueda); **no** `drizzle-kit generate`.
- Imports ESM con `.js`.
- Clientes Verifik/UTS dentro del módulo; importar solo `httpsJson`/`httpsGetJson` de `integraciones/http.js`.
- Mock MODE para tests sin red.
- Cabecera RN-xx en el módulo (unicidad, merge, inmutabilidad fuente, inactivación conservadora).
- Tras schema: invocar **db-review-agent** en pre-PR.

### frontend-agent

- **No** en 17a. Contratos anteriores bastan para 17b.

### qa-agent

- TCs sobre CF-01…CF-12 (API): sync parcial no inactiva; merge SIMIT gana; timeline sin spam; token ausente en respuestas/logs.
- Fixtures post-spike.

### security-agent

- Pre-PR: token cipher, env keys, rate limit sync/PUT token, PII (NIT/placa), retención declarada (**24 meses por defecto, parametrizable** en config del módulo).
- Verificar que no se reutiliza logging de integraciones que imprima cuerpos.

### tech-lead-agent

- ADRs 0001–0003 **Aceptados** (2026-08-13). **Modo B** descomponer #11492 en HUs BACKEND (≈30–35 SP). Sugerencia de corte: (1) schema+seeds+retención, (2) CRUD nits/municipios/causales, (3) token, (4) clients+mock, (5) sync síncrono+merge+timeline, (6) spike homologación, (7) shared-types+tests+dominio.

## Decisiones humanas cerradas (2026-08-13)

1. **Opción 1** aceptada (módulo autónomo + canónico + sync_runs).
2. **Hosts** Verifik/UTS siempre por `process.env` / config (nunca hardcode).
3. **Retención PII/timeline:** 24 meses por defecto, **parametrizable**.
4. **Sync síncrono** en v1 con **paralelismo acotado** de steps municipales (no 202/polling); cola asíncrona = ADR sucesor si la matriz crece.
5. ADRs 0001–0003 → **Aceptado**.
6. **Corrección post-review (2026-08-13):** migración `0150_*` (no 0149); env prefix `COMPARENDOS_*` (ortografía correcta).
7. **Corrección de contratos (2026-08-18, sin Bug — el contrato se documentó mal desde el origen, no es una regresión):** las **dos** fuentes son **GET**. En Verifik, `documentType` y `documentNumber` son parámetros de búsqueda y **no** cuerpo; en UTS la ruta completa es `/infraction/api/Infraccion/ConsultarInfraccionFuente` (antes se documentó `/ConsultarInfraccion`, incompleta). Consecuencia asumida: el NIT viaja en la URL de Verifik (y del UTS) por contrato del proveedor.

   **Qué regla aplica.** No es una excepción a AGENTS.md §14: §14 regula **nuestras** superficies —URLs de páginas de `apps/web`, nuestros access logs y los filtros de nuestra API autenticada— y su default de diseño (PII y cuasi-PII en el **cuerpo** de un `POST …/buscar`) **se sigue cumpliendo entero** en este módulo: el API de comparendos busca por NIT en body. Lo que cambia aquí es una llamada **saliente** a un tercero, que §14 no gobierna (sus mitigaciones —`auth`, `requireRole`, `logPiiAccess`— son de una lectura nuestra y no tienen dónde aplicarse en un GET a Verifik). Lo que sí aplica es la **Ley 1581**: remitir el NIT monitoreado a Verifik y al UTS es una **transferencia a un tercero**, y esa es la razón por la que el punto merece estar escrito.

   **Garantías nuestras, verificadas por `security-agent` (PASS-CON-OBSERVACIONES, 0 bloqueantes, 2026-08-18):** ninguna URL de estas llamadas se registra en log alguno del módulo; el NIT solo sale por `maskDocument`; `comoErrorDeFuente` descarta el mensaje original de la capa de red —que trae la URL completa— y conserva solo el `code`; y las dos peticiones salen con `Cache-Control: no-store` para que ningún proxy intermedio almacene una respuesta cuya clave de caché lleva el NIT dentro.

## Riesgos abiertos (no bloquean Modo B)

1. **Payloads reales Verifik/UTS** — mapa v1 provisional; spike cierra homologación.
2. **Valores de hosts por ambiente** — Ops provisiona `VERIFIK_SIMIT_BASE_URL`, `UTS_MUNICIPAL_BASE_URL`, `COMPARENDOS_ENC_KEY`.
3. **Normalización del número de comparendo** — trim + case; cerrar en spike.
4. **UTS municipal solo publica `http://`** — el host indicado por el proveedor (`http://ec2-<id>.compute-1.amazonaws.com`) es texto plano, y `integraciones/http.ts` (`httpsJson`/`httpsGetJson`) usa `https.request` incondicionalmente. Por tanto **el modo `real` de la fuente municipal no es operativo todavía**; `COMPARENDOS_SIMIT_MODE=mock` es el único modo ejercitable de esa fuente. Desde 2026-08-18 la limitación está **forzada en el código** y no solo documentada: `baseUrlExigida` rechaza con 503 `fuente_no_configurada` cualquier base que no sea `https:` (antes, una base `http://` no habría fallado por texto plano sino que habría salido igual contra el 443 de ese host, o habría dado un error opaco de TLS/DNS). `UTS_MUNICIPAL_BASE_URL` tampoco admite **puerto**: el helper compartido arma la petición con `{ hostname, path }` y descarta `u.port` — añadirlo toca traspaso, RUNT y Fasecolda y va en su propio PR. Decisión del Líder Técnico (2026-08-18): **preguntar antes al proveedor si expone HTTPS** en vez de abrir el cliente compartido a texto plano (lo usan también traspaso, RUNT y Fasecolda). Si la respuesta es que no, se evaluará un transporte `http` acotado a esta única fuente, con ADR.
