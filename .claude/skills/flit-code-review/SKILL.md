---
name: flit-code-review
description: |
  Revisión estructurada del diff ANTES de abrir el PR en el monorepo FLITO. Checklist AGENTS.md; escala a security-agent y db-review-agent. Veredicto canónico OK / OK-CON-OBSERVACIONES / BLOQUEADO.
  INVOCACIÓN OBLIGATORIA antes de create_pull_request en CADA PR. Orden fijo: review → luego PR (nunca al revés). security-agent NO sustituye esta skill.
  PROHIBIDO: imitar con tabla «mi revisión», «gates cerrados» sin bloque Veredicto, o revisar después de abrir el PR.
  Triggers — code review, revisa el diff, revisión antes del PR, pre-PR, create_pull_request, flit-code-review, flit-modo-desarrollo-auto paso 4b.
---

# flit-code-review — revisión de diff pre-PR

**Fuente de verdad de convenciones:** `AGENTS.md` (raíz del monorepo). Esta skill solo aplica el checklist; no redefine las reglas.

## CUÁNDO INVOCAR — HARD-STOP (hilo principal / modo auto)

| Disparador | ¿Invocar esta Skill? |
|---|---|
| Antes de `create_pull_request` (cualquier HU, docs, chore) | **SÍ — siempre** |
| Humano dice «crea / abre / sube el PR» | **SÍ primero**; el pedido solo autoriza el PR *después* del veredicto |
| Paso 4b de `flit-modo-desarrollo-auto` (cada eslabón de la cadena) | **SÍ — en cada HU**, no solo en la primera |
| Pedido «revisa el diff» / «code review» | **SÍ** |

**Cómo contar:** herramienta `Skill` con `skill: flit-code-review` **o** `Read` de este `SKILL.md`
en el mismo turno, **seguir** el checklist de punta a punta, y emitir el bloque **Veredicto**
canónico (con la línea `Veredicto: OK|…`). Sin ese bloque → no hubo code-review.

**Orden fijo (rompe si se invierte):** diff listo → **esta skill** (+ security/db si aplica) →
veredicto OK / OK-CON-OBSERVACIONES → **entonces** `create_pull_request`. Review **después** del
PR = fallo de proceso (aunque el veredicto sea OK).

**NO cuenta — imitación (anti-patrones graves):**
- Tabla improvisada «Mi revisión» / «gates cerrados» sin cargar esta skill ni el veredicto canónico
- Haber corrido solo `security-agent` / `db-review-agent` y dar por cerrado el pre-PR
- Reusar el veredicto de la HU anterior en la cadena apilada
- Abrir el PR y «revisar después» (aunque sea retrospectivo «documental», no desbloquea el PR ya abierto como si el gate se hubiera cumplido)

**Relación con otros gates:** esta skill es el **checklist de proceso+código**. Escala a `security-agent` / `db-review-agent` cuando aplique; esos agentes **complementan**, no reemplazan.

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
- [ ] Sin PII en consola ni en URLs del SPA; filtros sensibles vía estado UI / API según `AGENTS.md` §14.

### 4. Escalado a seguridad (bloqueante)

Invocar `security-agent` (**diff-scoped** por defecto) sobre el diff cuando toque **cualquiera** de:

- `shared/middleware/auth.ts`, `permissions.ts`, `pii-audit.ts`, módulos `laft/` o `privacy/`
- Subida de archivos (`multer`) o validación de MIME
- Rutas nuevas o cambios en `requireRole`/`authMiddleware`
- `package.json` / `package-lock.json` (dependencias nuevas)
- Manejo de campos PII (cédula, teléfono, dirección, biométricos, NIT/placa en listados/búsqueda)
- `requireRole` con roles fuera de `USER_ROLES` o reintroducción de `operaciones`

Si el diff no toca nada de eso, declararlo explícitamente ("superficie sensible: no aplica") — nunca omitir el paso en silencio.

### 5. Escalado a esquema BD (bloqueante)

Invocar `db-review-agent` cuando el diff toque **cualquiera** de:

- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrations/*.sql` (alta o cambio de migración)

Si no toca esquema ni migraciones, declarar "db-review: no aplica". Hallazgos críticos del
`db-review-agent` → veredicto **BLOQUEADO** hasta corrección vía `backend-agent`.

### 5b. Paralelismo (obligatorio cuando ambos aplican)

Tras el checklist propio de esta skill, si **security** y **db-review** aplican ambos, el hilo debe
lanzarlos **en el mismo turno en paralelo** (`Agent`/`Task` concurrentes). No serializar «por
costumbre». Si solo uno aplica, lanzar solo ese.

### Evidencia de tests aceptada

Aceptar salida real de verificación **filtrada al alcance** (módulo/spec) según `AGENTS.md` /
agentes de impl. Exigir suite monorepo local completa solo si el umbral transversal aplica
(shared/schema transversal/shared-types amplios) o falta evidencia del alcance.

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
