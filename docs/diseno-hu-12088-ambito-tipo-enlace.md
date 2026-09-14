# Diseño slim — HU #12088 · El ámbito lo dicta `tipo_enlace`, y los organismos son 1..N

Feature #12072. Rama `HU/12088-davidchica-ambito-tipo-enlace` (apilada sobre #12087 @ `10f1d9a`).
Modo **slim**: reconducir la validación y la UI de ámbito al catálogo `permisos_roles.tipo_enlace`
(ADR-0015 / #12169) y unificar el almacenamiento de organismos en `flito_gestor_organismos`
(#12053). Sin ADR nuevo. **Una migración sí** (§5).

Decisiones del 10/09 que este diseño da por fijas: el ámbito lo sigue dictando `tipo_enlace`
(ADR-0015, sin cambio de modelo); las ~27 comparaciones del `superRefine` se reconducen; el
`CONSTRAINT TRIGGER` de la 0178 se **consume** (no se reimplementa); `users.transito_codigo` queda
obsoleta y **no se borra**.

---

## 1. Patrón reutilizado

| Pieza | Vecino | Qué se toma |
|---|---|---|
| Lectura de `tipo_enlace` antes de escribir | `users.service.ts` `rolAsignable` (:122-128) — ya devuelve `{ tipoEnlace }` | El handler decide el ámbito con ese valor; el `superRefine` **deja de nombrar roles** |
| Conjunto 1..N en tabla puente + composición en respuesta | `users.service.ts` `escribirOrganismos` / `organismosDe` / `organismosDeVarios` (#12053) | Misma semántica para **todo** `tipo_enlace = 'organismos_transito'` (`transito`, `gestor_impuestos`, roles nuevos) |
| Backfill con JOIN anti-23503 + NOTICE de huérfanos | `0173_flito_gestor_organismos.sql` bloques 2–3 | Idem para `role = 'transito'` (gestores ya migraron en la 0173) |
| Trigger de organismos solo puente (predicado unificado) | `0178` `users_ambito_organismos_requerido` + nota en `diseno-hu-12169` §3.2 / :370 | Se cae la mitad `transito_codigo IS NOT NULL`; queda `EXISTS (flito_gestor_organismos)` |
| Campos de ámbito en UI | `Ambito.tsx` + `AtaduraFields.tsx` / `CompaniaField.tsx` | Misma cara; el `switch` pasa de `role === '…'` a `tipoEnlace === '…'` |
| Catálogo de roles con `tipoEnlace` | `permisosApi.roles()` (`lib/api.ts:539`) + `RolCatalogo` en `shared-types` | Una carga en `UsersGestion`, mapa `codigo → tipoEnlace` a formularios y celda |

---

## 2. Contrato delta

```
POST  /api/users
PATCH /api/users/:id
  · Validación de ámbito: por tipoEnlace de permisos_roles (vía rolAsignable), NO por literales
    role === 'cliente' | 'proveedor' | 'gestor_impuestos' | 'transito'.
  · tipo_enlace = 'compania'        → companiaId obligatorio; resto de ataduras → 400
  · tipo_enlace = 'proveedor_soat'  → flitoProveedorSoatId obligatorio; resto → 400
  · tipo_enlace = 'organismos_transito' → organismosCodigos 1..N; resto → 400
  · tipo_enlace = 'ninguno'         → ninguna atadura; enviar cualquiera → 400
  · transitoCodigo: OBSOLETO en el body (como allowedPages en #12087). Si viene → log.warn y se
    descarta; la SPA deja de mandarlo. No se traduce a organismosCodigos (evitar pisar un PATCH).
  · Alta/edición con organismos_transito: escribe SOLO flito_gestor_organismos; users.transito_codigo
    se fuerza a NULL en esa misma tx.

GET /api/users (listado / export textoAmbito)
  · Celda «Ámbito» y CSV: por tipoEnlace del rol (join/lookup), no por role ===.
  · organismosCodigos compuesto para todo usuario con filas en la puente (incluye `transito` post-backfill).

Auth / JWT
  · Login y /me: si el rol tiene organismos en la puente, `transitoCodigo` del token = primer código
    ordenado (compat con bandeja de trámites). Si la puente está vacía, null.
  · Bandeja trámites (`transito-scope.ts`): lee puente (1.º código) con fallback a la columna
    mientras queden filas legacy sin migrar; tras backfill el fallback no debería dispararse.

BD (migración 0189 — primera libre tras 0188 en esta rama; renumerar si develop adelanta)
  · Backfill: users.role='transito' AND transito_codigo IS NOT NULL → flito_gestor_organismos
    (JOIN organismos_transito_config, ON CONFLICT DO NOTHING, NOTICE huérfanos).
  · UPDATE users SET transito_codigo = NULL WHERE role = 'transito' AND transito_codigo IS NOT NULL
    (espejo del bloque 4 de la 0173).
  · REPLACE FUNCTION users_ambito_organismos_requerido: solo exige ≥1 fila puente cuando
    tipo_enlace = 'organismos_transito' (sin brazo transito_codigo).
  · TRIGGER users_ambito_organismos_trg: AFTER INSERT OR UPDATE OF role (ya no OF transito_codigo).
  · COMMENT ON COLUMN users.transito_codigo: OBSOLETA desde HU #12088; fuente = puente.
  · users_ambito_trg (compañía / proveedor SOAT) de la 0178: SIN cambio — AC4 lo consume.

shared-types
  · Sin tipo nuevo. Opcional: helper `esTipoEnlaceOrganismos(t: TipoEnlace)` si evita duplicar el
    literal en web/api; no es bloqueante.
```

Mensajes 400: generalizar literales «Cliente» / «Gestor de Impuestos» a formulaciones por tipo
(«Compañía requerida para este rol», «Organismos requeridos para este rol», …) — el admin puede
haber creado un rol con otro nombre.

---

## 3. Modelo de datos

- **Sin tabla nueva.** `flito_gestor_organismos` (0173) pasa a ser la fuente única de
  `organismos_transito` para todos los roles con ese enlace.
- `users.transito_codigo`: columna conservada, NULL tras backfill, comentario de obsolescencia en
  `schema.ts` (mismo gesto que `allowedPages` en #12087). **No DROP.**
- Triggers 0178: se **ajustan** en 0189 (predicado + columnas OF); no se recrea el de compañía.
- FK / CHECK de `permisos_roles.tipo_enlace`: sin cambio.

---

## 4. Decisiones

### 4-1 · Dónde vive la validación (AC1)

El `superRefine` de `createSchema` **pierde** los bloques `role === 'cliente'|'proveedor'|…'|transito'`.
La obligatoriedad y los «sobra» pasan al handler **después** de `rolAsignable(role)`:

```
const rol = await rolAsignable(role); // null → 400 MSG_ROL_NO_ASIGNABLE
switch (rol.tipoEnlace) { … }
```

`updateSchema` sigue sin `superRefine` de ámbito; el PATCH ya valida en el handler — se reconduce
igual por `tipoEnlace` del `roleEfectivo` (lookup si cambia el rol o siempre, barato).

**Prueba AC1:** insertar fila en `permisos_roles` con `tipo_enlace='compania'` (rol nuevo) y POST
usuario con/sin `companiaId` → 201/400 **sin** haber tocado el `superRefine`. El mutante AC6
(«volver a `role === 'cliente'` en superRefine») deja ese test en rojo.

### 4-2 · Unificación organismos (AC2 + AC3)

| Antes | Después |
|---|---|
| `transito` → `users.transito_codigo` (1) + UI `FlitOrganismoCombobox` (catálogo nacional) | `organismosCodigos` → puente; UI `OrganismosField` (parametrizado), igual que gestor |
| `gestor_impuestos` → puente (ya) | igual |
| Rol nuevo `organismos_transito` | igual que gestor, sin código nuevo |

Un organismo es el caso N=1 del mismo camino. No hay rama especial para `transito`.

### 4-3 · Compat bandeja de trámites (Nota, no bloqueante)

`resolveTransitoScope` / JWT siguen un **único** código. Con N>1 en un usuario `transito` (o rol
nuevo con el mismo enlace), el alcance de trámites usa el **primero ordenado**. Ver «todos» en
impuestos ya es multi; ver N bandejas de trámites a la vez **no** es de esta HU (Nota en PR).
AC2 se afirma en: persistencia puente, listado/celda, cola de impuestos del gestor, y rechazo 400
si N=0.

### 4-4 · Front por `tipoEnlace` (AC5)

- `UsersGestion` carga `permisosApi.roles()` una vez (activos para el `<select>` de alta/edición;
  mapa completo `codigo → tipoEnlace` para la celda).
- `AmbitoCampos` / `AmbitoCelda` / validación cliente / body del submit: `switch (tipoEnlace)`.
- Al cambiar de rol: limpiar ataduras que ya no aplican (igual que hoy).
- `TransitoOrganismoField` + uso de `FlitOrganismoCombobox` en usuarios: se retiran de este flujo.
- El `<select>` de rol deja de alimentarse solo de `USER_ROLES` compilado: lista = roles **activos**
  del API (AC1: un rol nuevo asignable sin tocar el front). Conservar etiqueta `nombre` del catálogo.

### 4-5 · AC4 — trigger de compañía

No se toca `users_ambito_trg` / `users_ambito_requerido`. Test: INSERT usuario con rol nuevo
`tipo_enlace='compania'` sin `compania_id` → `23514` en base (además del 400 de API). Mutante AC6:
poner `tipo_enlace='ninguno'` al rol `cliente` deja ese test en rojo.

### 4-6 · Qué no se hace

- Borrar `users.transito_codigo`.
- Reimplementar el CONSTRAINT TRIGGER de oleada 0.
- Multi-org en bandeja de trámites / `transito-config` (Nota).
- Trigger extra sobre `DELETE` de la puente (propuesto en #12169 §3.7.3): endurecimiento opcional;
  la API ya rechaza N=0 en el handler + DEFERRED al COMMIT de `escribirOrganismos`. Si cabe en el
  mismo SQL 0189 sin alargar el WI, añadir; si no, Nota.

---

## 5. Migración `0189_users_ambito_organismos_unificado.sql`

Orden (espejo 0173, sin `BEGIN`/`COMMIT` propios):

1. `INSERT INTO flito_gestor_organismos … SELECT … FROM users u JOIN organismos_transito_config … WHERE u.role = 'transito' AND u.transito_codigo IS NOT NULL ON CONFLICT DO NOTHING`
2. `DO` NOTICE de huérfanos (`transito` con código fuera del parametrizado)
3. `UPDATE users SET transito_codigo = NULL WHERE role = 'transito' AND transito_codigo IS NOT NULL`
4. `CREATE OR REPLACE FUNCTION users_ambito_organismos_requerido` — solo puente
5. Recrear `users_ambito_organismos_trg` con `UPDATE OF role` (sin `transito_codigo`)
6. `COMMENT ON COLUMN users.transito_codigo …`

Verificación local (P6): aplicar **ese** archivo dos veces sobre BD ya migrada.

---

## 6. Archivos a crear / modificar

| Acción | Path |
|---|---|
| Crear | `apps/api/src/db/migrations/0189_users_ambito_organismos_unificado.sql` |
| Modificar | `apps/api/src/modules/users/users.routes.ts` (quitar literales del superRefine; handler por `tipoEnlace`; `textoAmbito`; dejar de escribir `transitoCodigo`) |
| Modificar | `apps/api/src/modules/users/users.service.ts` (alta/edición: siempre puente para organismos; `transitoCodigo` → null en writes de ámbito; comentario JSDoc) |
| Modificar | `apps/api/src/db/schema.ts` (comentario OBSOLETA en `transitoCodigo`) |
| Modificar | `apps/api/src/modules/auth/auth.routes.ts` (JWT/`me`: `transitoCodigo` desde puente) |
| Modificar | `apps/api/src/modules/tramites/transito-scope.ts` (lectura puente + fallback columna) |
| Modificar | `apps/api/__tests__/services/users.routes.test.ts` (+ test rol nuevo AC1; ajustar literales; AC4 vía BD si el harness lo permite o test de integración del trigger) |
| Modificar | `apps/web/src/pages/users/Ambito.tsx` |
| Modificar | `apps/web/src/pages/users/CreateUserForm.tsx` / `EditUserForm.tsx` |
| Modificar | `apps/web/src/pages/users/UsersGestion.tsx` (catálogo roles) |
| Modificar | `apps/web/src/pages/users/types.ts` (deprecar uso de `transitoCodigo` en formularios; celda lee `organismosCodigos`) |
| Tocados menores | `AtaduraFields.tsx` (copy genérico «este rol» si aplica), `UsersTable.tsx` si tipa props, E2E `users-ambito.spec.ts` |
| Este doc | `docs/diseno-hu-12088-ambito-tipo-enlace.md` |

**No tocar:** módulos de impuestos (ya leen la puente), `permisos.routes` / alta de roles, triggers de compañía.

---

## 7. ADR: no aplica

Extensión de ADR-0015 (roles como catálogo) + unificación ya anunciada en el diseño de #12169.
Sin precedente nuevo que merezca ADR.

---

## 8. Notas operativas

### backend-agent

1. Migración 0189 primero (o en el mismo PR que el código que deja de escribir la columna).
2. Quitar del `superRefine` **todas** las comparaciones de ámbito por literal de rol; dejar solo forma Zod.
3. Centralizar en un helper de ruta (p. ej. `assertAmbitoSegunEnlace(tipoEnlace, body)`) usado por POST y PATCH.
4. Tests P1: `users.routes.test.ts` (+ el archivo de trigger/migración si se añade). Mutantes: los nombra QA (AC6); el impl **no** muta.
5. `rolAsignable` mock en tests: devolver el `tipoEnlace` coherente con el rol del body (hoy a menudo `'ninguno'` — hay que alinear o los 400 de ámbito no disparan).

### frontend-agent

1. Mapa `tipoEnlace` desde `permisosApi.roles()`; no hardcodear listas de roles en `Ambito*`.
2. Un solo widget de organismos (`OrganismosField`) para todo `organismos_transito`.
3. Aviso de re-login al cambiar organismos / compañía / proveedor: se conserva.
4. E2E ámbito: escenarios por tipo de enlace, no por nombre de rol (salvo seeds que fijen el rol).

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Usuarios `transito` con código fuera de `organismos_transito_config` quedan sin fila | NOTICE + reasignar en `/users` (igual 0173) |
| JWT viejo con `transitoCodigo` tras NULL de columna | Invalidar sesión al editar ámbito (ya); login nuevo lee puente |
| Número de migración choca si mergean otra 0189 | Renumerar al tip antes del PR |
| `<select>` aún en `USER_ROLES` dejaría fuera roles nuevos | Esta HU lo pasa al API (4-4) — sin eso AC1 UI queda incompleto |

---

## HANDOFF (diseño)

```
HANDOFF
  Modo: slim
  Resultado: OK
  Decisión recomendada: validación y UI por tipoEnlace; organismos solo en flito_gestor_organismos;
    migracion 0189 backfill+trigger; transito_codigo obsoleta sin DROP; JWT/scope leen 1.er código
    de la puente (Nota: bandeja trámites no multi-org)
  ADR: no aplica
  Archivos: ver §6
  Siguiente: backend-agent + frontend-agent
  Pendiente humano: ninguno bloqueante; Nota de alcance trámites N>1 queda en el PR
```
