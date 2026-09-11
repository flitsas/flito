# Diseño slim — HU #12089 · Baja lógica de usuarios

**Feature** [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072) · **HU** [#12089](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12089)
**Modo:** slim. Extiende `users` + `authMiddleware` + enganche ya dejado por #12084 (`CONDICION_USUARIO_VIVO`). Sin ADR nuevo.
**Rama:** `HU/12089-davidchica-baja-logica` (apilada sobre tip #12088 = `b1df5c5`).
**Migración:** `0190_users_baja_logica.sql` (0189 ya existe en esta rama; renumerar si `develop` adelanta).
**ADR:** no aplica. Se apoya en ADR-0014 (auditoría por campo, sin PII del titular) y en el invariante de #12084 (`conSeguroAntiBloqueo`).

---

## 1. Patrón reutilizado

| Pieza | Vecino | Qué se toma |
|---|---|---|
| Suspensión ≠ baja | `cambiarActivo` (`users.service.ts` ~528–551) + comentarios #12171/#12089 | `active` sigue siendo toggle; `deleted_at` es el quinto camino del AC4 de #12084 |
| Invariante anti-bloqueo | `shared/permisos-anti-bloqueo.ts` `CONDICION_USUARIO_VIVO` (= `sql\`true\`` hoy) + `conSeguroAntiBloqueo` | Baja/reactivar envuelven el `UPDATE` igual que `cambiarActivo`; `CONDICION_USUARIO_VIVO` → `deleted_at IS NULL` |
| Invalidación de sesión | `PATCH /:id/toggle` + `invalidateSessionCacheFor` post-commit | Baja escribe `sessionInvalidatedAt` y llama al cache; middleware ya corta tokens viejos |
| Auditoría por campo | `registrarCambioPermisos` / `actorDeRequest`; `CAMPOS_AUDITABLES.usuario` ya incluye `deleted_at`; acciones `baja`/`reactivar` ya en CHECK 0185 | Par `campo='deleted_at'`, valores ISO o `null` — **nunca** username/email/name del afectado |
| Login genérico 401 | `auth.routes.ts` `!user \|\| !user.active` → «Credenciales inválidas» | Añadir `\|\| user.deletedAt` al mismo predicado |
| UI 4 estados + toolbar | `UsersTable` / `UsersToolbar` / `UsersGestion` (partida #12175/#12172) | Filtro «Dados de baja», chip de estado, acciones Baja/Reactivar; HistorialPermisos **ya** etiqueta `baja`/`reactivar`/`deleted_at` |
| Catálogo de funciones | `catalogo-operaciones.ts` bloque `usuarios` + inventario 0181-style | Dos códigos nuevos + filas en `inventario.generado` + seed SQL en 0190 |

---

## 2. Decisiones (fijas para impl)

1. **Nunca** `db.delete(users)` ni `DELETE FROM users` en producto. `DELETE HTTP` = marca. Test grep (AC1) sobre `apps/api/src` (y specs que no deben introducir el hard-delete).
2. **`deleted_at` ≠ `active`.** Baja no toca `active`. Toggle no toca `deleted_*`. Reactivar solo limpia `deleted_at`/`deleted_by` (deja `active` como estaba).
3. **Unicidad:** `username` UNIQUE global se conserva (fila sigue existiendo → nombre no se libera). `email` **no** tiene UNIQUE en BD desde la 0002; al crear, si el AC exige 409 por email colisionando con una fila (viva o baja), es chequeo de aplicación (`eq` case-insensitive) además del de username. Mensaje genérico tipo «Username ya registrado» / «Email ya registrado» **sin** revelar si está de baja (evita enumeración); el 409 cumple AC6.
4. **Self-baja:** 400, mismo espíritu que toggle (`No puede desactivarse a sí mismo` → variante «darse de baja»).
5. **Último admin / capacidades de administración:** verdad = `conSeguroAntiBloqueo` dentro de la tx de baja (población con `deleted_at IS NULL`). Pre-check opcional con mensaje claro (patrón toggle 409). Reactivar **no** necesita el invariante (añade capacidad).
6. **authMiddleware:** la lectura de sesión pasa a traer también `deleted_at`; si no es null → 401 (mismo tono que sesión invalidada / token inválido; no filtrar PII). Fail-soft de BD actual se mantiene solo para el fetch de invalidación; **no** fail-soft a «asumir vivo» si la columna existe y la fila tiene baja (preferible: si el SELECT falla, comportamiento actual; si la fila viene con `deletedAt`, rechazar).
7. **Listado default:** `deleted_at IS NULL`. `?incluirBajas=true` incluye bajas (y permite filtrar solo bajas vía UI). Export y resumen respetan el mismo predicado.
8. **Operaciones sobre baja:** PATCH/toggle/password/invalidate sobre usuario con `deleted_at` → **404** (o 409 «dado de baja»; preferir 404 para no filtrar existencia en rutas con id). Reactivar es la única escritura que los acepta.
9. **Techo de líneas:** `users.routes.ts` ~783 / `users.service.ts` ~721. La lógica de baja/reactivar vive en **service**; rutas delgadas. Si el router roza 800, extraer helpers de query Zod al service o a un `users-baja.ts` colindante — no inflar el router.

---

## 3. Migración 0190

Archivo: `apps/api/src/db/migrations/0190_users_baja_logica.sql` (idempotente donde se pueda).

```sql
-- Columnas
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by integer
  REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN users.deleted_at IS 'HU #12089 baja lógica; NULL = en alta. Independiente de active (suspensión).';
COMMENT ON COLUMN users.deleted_by IS 'Actor de la baja; FK RESTRICT (nunca hard-delete de users).';

-- Índice del camino caliente (listados / selectores / invariante)
CREATE INDEX IF NOT EXISTS idx_users_vivos ON users (id) WHERE deleted_at IS NULL;
-- Opcional listado de bajas:
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- Semilla de funciones (admin):
--   usuarios.usuario.baja      → DELETE /api/users/:id
--   usuarios.usuario.reactivar → POST /api/users/:id/reactivar
-- + pares permisos_rol_funcion ('admin', …)  [mismo patrón 0186/0181]
```

Drizzle (`schema.ts` en `users`):

```ts
deletedAt: timestamp('deleted_at', { withTimezone: true }),
deletedBy: integer('deleted_by').references((): any => users.id, { onDelete: 'restrict' }),
```

`CONDICION_USUARIO_VIVO` en `permisos-anti-bloqueo.ts`:

```ts
export const CONDICION_USUARIO_VIVO: SQL = isNull(users.deletedAt);
// o sql`${users.deletedAt} IS NULL`
```

P6: aplicar **solo** 0190 dos veces sobre BD ya migrada.

---

## 4. Contrato API (delta)

Montaje existente `/api/users` (`users.routes.ts`). Literales **antes** de `/:id`.

| Método | Ruta | Función | Comportamiento |
|---|---|---|---|
| `DELETE` | `/:id` | `usuarios.usuario.baja` | Si `id === req.user.sub` → 400. Si ya baja → 404 (idempotencia suave) o 200 no-op; preferir **404** si no encontrado / ya baja para tests claros, o 204 idempotente si se documenta — **recomendación:** 404 si no existe; si ya tiene `deleted_at`, 200 con el DTO actual (idempotente). Marca `deleted_at=now()`, `deleted_by=actor`, `sessionInvalidatedAt=now()` dentro de `conSeguroAntiBloqueo`. Auditoría `accion:'baja'`, `campo:'deleted_at'`, antes=`null`, después=ISO. Tras commit: `invalidateSessionCacheFor(id)`. 409 si invariante. |
| `POST` | `/:id/reactivar` | `usuarios.usuario.reactivar` | Si no existe → 404. Si `deleted_at` null → 200 idempotente. Limpia `deleted_at`/`deleted_by` (no toca `active`). Auditoría `accion:'reactivar'`, antes=ISO, después=`null`. **No** exige invalidar sesión (no había sesión válida). |
| `GET` | `/` · `/export` · `/resumen` | (existentes) | Query Zod: `incluirBajas: z.coerce.boolean().optional()` (default false). Default añade `deleted_at IS NULL`. Con `true`, no añade ese predicado; la UI puede pedir solo bajas con un flag adicional `soloBajas` **o** filtrar en cliente — **recomendación API:** `incluirBajas` + filtro UI; si hace falta servidor `soloBajas=true` ⇒ `deleted_at IS NOT NULL` (mutuamente excluyente con default). |
| `PATCH` | `/:id/toggle` | sin cambio de semántica | Guarda extra: si `deleted_at` set → 404. Self y 409 invariante intactos. |
| `POST` | `/` (crear) | | Tras chequeos actuales: si existe username (cualquier `deleted_at`) → 409. Idem email no vacío si se implementa el chequeo de app. |

DTO listado: exponer `deletedAt: string \| null` (y opcional `deletedBy` solo id numérico, sin join de PII). Chip UI: «Dado de baja» si `deletedAt`; si no, Activo/Inactivo como hoy.

Login (`POST /api/auth/login`): predicado `!user \|\| !user.active \|\| user.deletedAt` → 401 genérico.

---

## 5. Tabla `from(users)` — filtrar vs no (AC3)

Criterio: **filtrar** = el usuario debe poder actuar / ser elegido / contar como población viva. **No filtrar** = lookup por id de autoría, firma, historial, o conteo FK (la fila sigue existiendo).

### Filtrar (`deleted_at IS NULL`), salvo `incluirBajas`

| Sitio | Motivo |
|---|---|
| `users.service` `condicionesUsuarios` / `listarUsuarios` / `resumenUsuarios` | Listado y export de gestión |
| `permisos-anti-bloqueo` vía `CONDICION_USUARIO_VIVO` | Población administradora |
| `maintenance/catalog.routes` GET `/mechanics` | Selector de mecánicos activos |
| `flito-logistica.service` selector `role='mensajero'` | Asignación de mensajeros |
| `drivers.routes` listados/selectores de conductores | Padrón operativo |
| `drivers/trainings.routes` validación de userId | Alta de capacitación |
| `jornadas/notify` `getAdminEmails` | Destinatarios vivos |
| `laft/cash/aros.cron` admin id/emails | Cron operativo |
| `rndc/envio.service` admins activos | Notificación operativa |
| `auth.routes` login (+ middleware) | Acceso |

### No filtrar (autoría / id / FK)

| Sitio | Motivo |
|---|---|
| `users.service` `actualizarUsuario` / get-by-id internos de edición | Carga por id; la ruta rechaza baja con 404 antes de mutar (salvo reactivar) |
| `users.routes` create uniqueness | Debe **ver** bajas para 409 (AC6) |
| `permisos-roles.service` `count(*)` por rol (`usuarios` / borrable) | FK `ON DELETE RESTRICT` del rol: las bajas **siguen** ocupando el rol |
| `permisos-efectivos` resolución por `userId` | Sesión ya cortada por middleware; no reescribir el resolutor |
| `auth` `/me` por `req.user.sub` | Middleware ya bloqueó baja |
| `laft/manual`, `pesv/policy`, `pesv/export` firmantes por id | Autoría histórica |
| `laft/officer`, `laft/employees`, `laft/audit-plan` por userId | Expediente / vínculo |
| `rndc/pdf.service` conductorId | Documento histórico |
| `drivers.routes` detalle por id | Ficha histórica |
| `users-auditoria` titulares / filas | Historial |
| `flito-soat.service` `contextoSoat` por `user.sub` | Sesión viva |
| `tramites/transito-scope` por `user.sub` | Sesión viva |
| Seeds / scripts one-shot | Fuera de runtime de producto |

**Nota:** `tramites/transito-config` conteo de usuarios por organismo: tras #12088 la fuente de organismos es la puente; si el conteo sigue leyendo `users`, contar **vivos** (ocupación actual), no autoría. Declarar en el PR si el conteo se toca o se deja (deuda preexistente + `transito_codigo` obsoleta = Nota P4 si no es necesario para AC).

Fuera de alcance de esta HU salvo que un selector concreto deje elegir un dado de baja en una pantalla de asignación: entonces se añade el predicado en ese sitio (lista de arriba).

---

## 6. UI (apps/web)

Archivos ya partidos — no reabrir `Users.tsx` monolito.

| Archivo | Cambio |
|---|---|
| `pages/users/types.ts` | `deletedAt: string \| null` en `User` |
| `pages/users/UsersToolbar.tsx` | Control «Dados de baja» (checkbox o select: En alta / Dados de baja / Todos). Dispara `incluirBajas` / `soloBajas` en la query |
| `pages/users/UsersTable.tsx` | Chip «Dado de baja»; acciones: si baja → solo «Reactivar»; si en alta → «Dar de baja» (+ Editar/Contraseña/toggle como hoy). Self: deshabilitar baja como toggle |
| `pages/users/UsersGestion.tsx` | Handlers `api.delete('/users/:id')` y `api.post('/users/:id/reactivar')`; confirm; toasts; `recargar` resumen |
| `pages/users/HistorialPermisos.tsx` | **Sin cambio de etiquetas** (ya mapea `baja`/`reactivar`/`deleted_at`) |
| Export Excel | Columna estado: Activo / Inactivo / Dado de baja |

4 estados de la tabla (cargando / error+reintento / vacío / lleno) se mantienen; el vacío con filtro «Dados de baja» es mensaje distinto opcional («Nadie dado de baja»).

---

## 7. Archivos a crear / modificar

**Crear**

- `apps/api/src/db/migrations/0190_users_baja_logica.sql`
- `apps/api/__tests__/…` tests de este WI (baja, middleware, login, incluirBajas, self, invariante, unicidad, auditoría, grep anti-`db.delete(users)`)
- este doc (ya)

**Modificar (API)**

- `apps/api/src/db/schema.ts` — columnas `deletedAt` / `deletedBy`
- `apps/api/src/shared/permisos-anti-bloqueo.ts` — `CONDICION_USUARIO_VIVO`
- `apps/api/src/shared/middleware/auth.ts` — SELECT + rechazo si baja
- `apps/api/src/modules/auth/auth.routes.ts` — login
- `apps/api/src/modules/users/users.service.ts` — `darDeBaja`, `reactivarUsuario`, `condicionesUsuarios` (+ flags), `userSelect`
- `apps/api/src/modules/users/users.routes.ts` — DELETE, POST reactivar, query `incluirBajas`, guardas 404 en toggle/patch
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` + `inventario.generado.ts` + fixtures/reconducción (contadores) + seed en 0190
- Selectores de la tabla §5 «Filtrar» (mínimo los listados/selectors de producto que asignan trabajo)

**Modificar (web)**

- `apps/web/src/pages/users/{types,UsersToolbar,UsersTable,UsersGestion}.tsx` (+ export estado si vive en Gestion)

**shared-types:** `CAMPOS_AUDITABLES` / acciones ya listos — **sin cambio** salvo que se quiera tipar un DTO de usuario compartido (opcional; hoy el tipo vive en `pages/users/types.ts`).

**Ayuda in-app:** si `users` tiene ficha en `content/ayuda/`, delta con `flit-ayuda-flito`; si no, N/A declarado en PR.

---

## 8. Tests y mutantes (AC8) — guía para qa-agent B

P1 (impl + QA re-run), ejemplos de archivos de este WI:

- `users.baja-logica.test.ts` (o nombre alineado al repo)
- extensión de specs de auth / anti-bloqueo si tocan predicado

Mutantes nombrados (tope 3, solo QA):

1. Quitar `deleted_at IS NULL` del listado default → debe fallar el aserto «GET /users sin query no trae bajas».
2. Omitir `sessionInvalidatedAt` en baja → debe fallar el aserto de sesión invalidada / 401 con token previo.
3. Permitir `db.delete(users)` o saltarse self-check → debe fallar grep o el 400 de self-baja.

---

## 9. Notas operativas

**backend-agent**

- Implementar service primero (`darDeBaja` / `reactivarUsuario` espejo de `cambiarActivo`).
- Enganchar `CONDICION_USUARIO_VIVO` **antes** de confiar en el pre-check de «último admin».
- Inventario + catálogo + migración de funciones en el mismo WI (rompe foto de montajes si se omiten).
- No glob del módulo en tests; lista P1 explícita.
- Revisar selectores §5 en el mismo PR o declarar Nota si alguno queda fuera con riesgo bajo (P4).

**frontend-agent**

- Extender toolbar/tabla/gestión; no rediseñar layout.
- 4 estados intactos; filtro bajas con vacío específico.

**security-agent (pre-PR):** dispara — auth + rutas nuevas + posible PII en auditoría (verificar que valores de `deleted_at` no arrastren fila). Diff-scoped.

**db-review-agent (pre-PR):** dispara — `schema.ts` + `0190_*.sql`.

---

## 10. Riesgos / fuera de alcance

- Hard-delete o liberación de username: fuera.
- Cascade de FKs que apuntan a `users`: no se tocan; por eso RESTRICT en `deleted_by` y baja lógica.
- Email UNIQUE a nivel BD: no se reintroduce en 0190.
- Renombrar `active` / unificar suspensión y baja: fuera (ya semántica #12171).
