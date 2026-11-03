# Diseño slim — HU #14119 Catálogo de motivos de llegada a FLIT

Feature C3.1 #14093 · Épica #13758 · ADR-0030 (catálogo administrable, sin borrado, activo/orden).
Salida del `architecture-agent` en modo slim. **No UI. No viaje a FLIT** (HU #14122). Flujo LOCAL.

## Patrón reutilizado

- **Tabla, índices y seed (ya existen, no recrear):** `apps/api/src/db/migrations/0275_flito_logistica_traslados.sql` §1
  y Drizzle `flitoLogisticaMotivosLlegada` en `apps/api/src/db/schema/flito-logistica-traslados.ts`.
  Único por `lower(nombre)` (`uq_flito_log_motivos_llegada_nombre`); listado por `(activo, orden)`.
  Seed de los tres nombres con `ON CONFLICT DO NOTHING`. FK de líneas `motivo_llegada_id … ON DELETE RESTRICT`.
- **HTTP de catálogo (CRUD sin DELETE):** `apps/api/src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.ts`
  + `.service.ts` — Zod en la ruta, errores de dominio → 409/404, `audit` en escrituras, `exigirFuncion`.
  Montaje **antes** del router que tiene `GET /:id`, sin `conAlcance` (catálogo interno; enlace cerrado).
- **Función nueva de logística:** calco 0283 (`logistica.traslado.anular`): operación **opcional** (no se gana con la
  acción padre), siembra idempotente, `padre_codigo`, `NACIDOS_DESPUES_DE_0239`, `catalogo-operaciones.ts`.

La 0275 **ya está aplicada** (rama apilada sobre #14117). No se enmienda: AGENTS.md regla 6.

## Contrato delta

Base: `GET|POST /api/flito/logistica/motivos-llegada` · `PATCH …/:id` · `PATCH …/:id/estado`.
Todas las guardas: `exigirFuncion('logistica.motivos.gestionar')`. Auth + `apiLimiter` del `/api`. Sin rate limit extra.

| Método | Body / query | Éxito | Error |
|---|---|---|---|
| `GET /` | `?soloActivos=true` (ausente = todos) | 200 `{ id, nombre, activo, orden }[]` ordenados por `orden, nombre` | 401 / 403 |
| `POST /` | `{ nombre }` (1–120, trim); `orden` opcional (int, default 0) | **201** + fila | 409 nombre `lower()` duplicado; 422 |
| `PATCH /:id` | `{ nombre?, orden? }` ≥1 campo | 200 | 404; 409; 422 |
| `PATCH /:id/estado` | `{ activo: boolean }` | 200 (inactivar idempotente) | 404; 422 |
| `DELETE` | — | **no se registra** (AC4 → 404 de Express, no 405) | |

Query `soloActivos` no es PII: GET+query está bien (AGENTS.md §14). DTO sin PII. `creado_por_id` = `req.user.sub`.

**Transportadora externa:** es SOLO el motivo sembrado «Destino lejano (transportadora externa)». Cero columnas de precio, guía o proveedor. El viaje a FLIT (#14122) importa `listarMotivosActivos()` del servicio; no consume este HTTP.

## Migración `0284_flito_logistica_motivos_permiso.sql`

Siguiente número tras 0283 (14117 no creó migración). Sin `BEGIN/COMMIT`. Idempotente. **No** `CREATE TABLE`.

1. Re-seed de los tres nombres (AC5 de **esta** HU; P6 = aplicar **0284** dos veces). `ON CONFLICT (lower(nombre)) DO NOTHING` — no pisa `orden`/`activo` si un admin los cambió; si falta el nombre, lo inserta.

```
'Sin dirección de entrega al recoger'  orden 10
'Destino lejano (transportadora externa)'  orden 20
'Otro'  orden 30
```

2. Función, calco 0283: `logistica.motivos.gestionar` tipo `operacion`, módulo `logistica`,
   `padre_codigo = 'accion.logistica.ver_consola'`. Reparto: **solo `admin`**. Resto, desde el panel.

Padre `ver_consola`: los opcionales **no se expanden** (auditor con «Ver la consola» sigue en 403). No se crea
acción nueva del árbol (las 55 de Gestión quedan; el epic C1–C2 sembró opcionales, no nodos).

## Archivos a crear/modificar

**Crear**

- `apps/api/src/db/migrations/0284_flito_logistica_motivos_permiso.sql`
- `apps/api/src/modules/flito-logistica/flito-logistica-motivos.routes.ts`
- `apps/api/src/modules/flito-logistica/flito-logistica-motivos.service.ts`
- `apps/api/__tests__/services/flito-logistica-motivos.routes.test.ts` (P1 HTTP: AC1–AC4, AC6)
- `apps/api/__tests__/db/migracion-0284.test.ts` (P1: estática + AC5 dos pasadas / seed)

**Modificar**

- `apps/api/src/app.ts` — `app.use('/api/flito/logistica/motivos-llegada', motivosRoutes)` **antes** de `flitoLogisticaRoutes` (`GET /:id` se tragaría el segmento).
- `apps/api/src/modules/permisos/arbol/acciones-gestion.ts` — `opcionales` de `accion.logistica.ver_consola` += `logistica.motivos.gestionar`.
- `apps/api/src/modules/permisos/arbol/sql-legado.ts` — `NACIDOS_DESPUES_DE_0239`.
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` — 4 llaves, mismo código (const `LOGM` al fichero nuevo).
- `apps/api/src/modules/permisos/inventario-guardas.ts` — `{ modulo: 'logistica', fichero: '…/flito-logistica-motivos.routes.ts' }`.
- `apps/api/src/modules/permisos/inventario.generado.ts` — 4 filas, `roles: ["admin"]`.
- `apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts` — las 4 rutas.
- `apps/api/__tests__/services/permisos-arbol-gestion.test.ts` — lista literal de opcionales.

**No tocar:** `schema.ts` / `flito-logistica-traslados.ts` (tabla ya está), `0275`, `apps/web`, `shared-types`, viaje a FLIT.

## ADR: no aplica

Extensión del catálogo 0275 + patrón HTTP de proveedores-logística + siembra opcional 0283. Sin tabla/contrato nuevos ni tradeoff de PII/auth/integración.

## Notas operativas (backend)

- Unicidad: pre-chequeo `lower(nombre)` + catch `23505` / `uq_flito_log_motivos_llegada_nombre` → `MotivoLlegadaDuplicadoError` (409). Carrera cubierto.
- Inactivar no borra: el histórico (`flito_logistica_traslado_lts.motivo_llegada_id`) conserva el id; `GET ?soloActivos=true` filtra `activo = true`.
- Exportar `listarMotivosActivos()` para #14122; no montar GET público.
- Inventario: las 4 rutas nuevas van a la foto a mano (comentario de `inventario.generado.ts`).
- P1 (lista explícita, no el glob de logística):

```
npm test -w apps/api -- \
  __tests__/services/flito-logistica-motivos.routes.test.ts \
  __tests__/db/migracion-0284.test.ts
```

Mutantes: 0 en impl. QA B: hasta 3 solo si el gate los nombra (duplicado / filtro activos / 403).

## Gates al PR (no en este slim)

- `security-agent`: **sí** (rutas nuevas). Sin PII en DTO/query/logs.
- `db-review-agent`: **sí** (migración 0284; tabla 0275 es contexto, no se rediseña).
- `flit-code-review` + `qa-agent` B: sí. Flujo LOCAL: no abrir PR ni mergear aquí.

## P1 — qué aserta cada test

`flito-logistica-motivos.routes.test.ts` (supertest + db mock, calco `proveedores-logistica.routes.test.ts`):

- AC1: POST válido → 201, `audit` con id/nombre, sin PII.
- AC2: mismo nombre distinta capitalización → 409; 23505 del índice → 409 (nunca 500).
- AC3: PATCH estado `activo: false` → 200; GET `?soloActivos=true` no lo trae; GET sin query sí.
- AC4: `router.stack` sin `DELETE`; `request.delete` → 404.
- AC6: sin token 401; con token sin la función 403 en GET/POST/PATCH.

`migracion-0284.test.ts`:

- AC5: SQL con los tres literales + `ON CONFLICT`; `scanForTxControl` vacío; contra PG si `TEST_DATABASE_URL`: aplicar 0284 dos veces, count de los tres nombres estable.

## Fuera de alcance (declarado)

UI del catálogo; registrar viaje organismo→FLIT (#14122); columnas de transportadora/precio/guía; acción nueva del árbol de Gestión.
