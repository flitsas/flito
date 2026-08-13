---
name: flit-code-review
description: Revisión estructurada de un diff antes de abrir el PR en el monorepo FLITO. Aplica el checklist del repo (patrón routes/service, imports .js, 4 estados de UI, guardas de permiso, tests con salida real, git status limpio), detecta archivos colados y escala a security-agent (superficie sensible) y a db-review-agent (schema.ts / migrations). Emite veredicto OK / OK-CON-OBSERVACIONES / BLOQUEADO. Triggers code review, revisa el diff, revisión antes del PR, flit-code-review.
---

# flit-code-review — revisión de diff pre-PR

**Fuente de verdad de convenciones:** `AGENTS.md` (raíz del monorepo). Esta skill solo aplica el checklist; no redefine las reglas.

**Cuándo se invoca:** **siempre** antes de `create_pull_request` — también cuando el usuario diga solo «crea / abre / sube el PR». Ese pedido autoriza abrir el PR *después* de este checklist, no lo sustituye. También cuando pida "revisa el diff" / "code review", o en el paso 4b de `flit-modo-desarrollo-auto`. Aplica a PRs de HU y a `docs/*` / `chore/*`.

**Autonomía:** read-only sobre el código. No corrijo nada: reporto hallazgos y veredicto; las correcciones las hace `backend-agent` / `frontend-agent` o el humano.

## Entrada

1. Determinar el diff a revisar:
   - Cambios sin commitear → `git diff` (y `git status --short`).
   - Rama de HU → `git diff origin/develop...HEAD` (y el log de commits).
2. Si la HU tiene ID de ADO, leer título y AC con la skill `flit-azure-devops` para revisar contra ellos.

## Checklist

### 1. Proceso (bloqueante)

- [ ] `git status --short` sin archivos colados: nada de `.claude/`, parches de demo, `.env*`, archivos ajenos a la HU.
- [ ] Rama con convención `feat/flito-hu<ID>-*` basada en `develop` (si aplica).
- [ ] Salida **real** de verificación pegada por quien implementó (ver comandos en `AGENTS.md`); si falta, exigirla o ejecutarla. Prohibido aceptar "los tests pasan" sin salida.
- [ ] Diff ≤ 800 líneas (precondición de merge de `flit-integration-ado`); si se pasa, recomendar partir el PR.

### 2. Backend (si el diff toca `apps/api`)

- [ ] Patrón `routes` / `service` intacto: la ruta valida con Zod y traduce a HTTP; la lógica y los datos están en el servicio.
- [ ] Imports relativos con extensión `.js`.
- [ ] Sin SQL concatenado: query builder de Drizzle o `sql` parametrizado.
- [ ] Rutas nuevas con `authMiddleware` (+ `requireRole` si aplica) y montadas en `src/app.ts`.
- [ ] Migraciones nuevas: SQL plano a mano en `apps/api/src/db/migrations/` (nunca `drizzle-kit generate`/`migrate`; no editar migraciones ya aplicadas).
- [ ] Sin credenciales/hosts hardcodeados (`process.env` / `src/config`).
- [ ] Si tocó `packages/shared-types`: `grep` de usos en `apps/web` realizado.

### 3. Frontend (si el diff toca `apps/web`)

- [ ] Datos vía `src/lib/api.ts` — sin `fetch` suelto ni URL hardcodeada.
- [ ] Vistas con datos tienen los **4 estados** (cargando, error con reintento, vacío, lleno).
- [ ] Página nueva registrada en `App.tsx` con `lazy()` + guarda de permiso (`hasPage`/`PageSlug`).
- [ ] `dangerouslySetInnerHTML` solo con sanitización en la misma expresión.
- [ ] Accesibilidad: labels asociados, `aria-label` donde aplica, foco visible.
- [ ] Sin PII en consola ni en URLs.

### 4. Escalado a seguridad (bloqueante)

Invocar `security-agent` sobre el diff cuando toque **cualquiera** de:

- `shared/middleware/auth.ts`, `permissions.ts`, `pii-audit.ts`, módulos `laft/` o `privacy/`
- Subida de archivos (`multer`) o validación de MIME
- Rutas nuevas o cambios en `requireRole`/`authMiddleware`
- `package.json` / `package-lock.json` (dependencias nuevas)
- Manejo de campos PII (cédula, teléfono, dirección, biométricos)

Si el diff no toca nada de eso, declararlo explícitamente ("superficie sensible: no aplica") — nunca omitir el paso en silencio.

### 5. Escalado a esquema BD (bloqueante)

Invocar `db-review-agent` cuando el diff toque **cualquiera** de:

- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrations/*.sql` (alta o cambio de migración)

Si no toca esquema ni migraciones, declarar "db-review: no aplica". Hallazgos críticos del
`db-review-agent` → veredicto **BLOQUEADO** hasta corrección vía `backend-agent`.

## Veredicto

```
CODE REVIEW — <rama o alcance>
Alcance: <archivos y workspaces> | Diff: <+/- líneas>

Bloqueantes
- [sección] archivo:línea — qué falla y contra qué regla de AGENTS.md

Observaciones (no bloquean)
- …

Seguridad: [escalado a security-agent: veredicto | no aplica — por qué]
Esquema: [escalado a db-review-agent: veredicto | no aplica — por qué]

Veredicto: OK | OK-CON-OBSERVACIONES | BLOQUEADO
```

- **BLOQUEADO** si hay ≥1 hallazgo bloqueante, falta salida real de tests, o un escalado
  security/db-review quedó en FAIL/crítico → corregir y re-revisar. El PR no se abre.
- **OK-CON-OBSERVACIONES**: el PR puede abrirse; las observaciones van en el cuerpo del PR.
- **OK**: limpio.

## Reglas

1. NUNCA apruebes sin la salida real de la verificación — es el fraude más común.
2. NUNCA corrijas el código tú mismo: reporta y devuelve.
3. NUNCA trates observaciones como bloqueantes ni al revés — cita la regla de `AGENTS.md` que sustenta cada bloqueante.
4. NUNCA revises más allá del diff: deuda preexistente se reporta como observación, no como bloqueante de este PR.
