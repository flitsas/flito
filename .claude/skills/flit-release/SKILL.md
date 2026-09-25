---
name: flit-release
description: Gobierna la promoción entre ambientes del monorepo FLITO — develop → staging (QA) → release (PDN). HARD-STOP: no se crea el PR develop→staging si el Feature no tiene evidencias COMPLETAS de flit-evidencias-dev (sesión conjunta en DEV + capturas en el Feature). Tras el merge a staging: tag QA + mención a Daniel Amado + Resolved (flit-gestion-hu Paso 3) y cascada Feature → Épica (Paso 4). El merge de promoción es siempre humano; Deploy * es flit-integration-ado Modo B. Triggers promover a QA, promover a staging, subir a producción, release, PDN, rollback, flit-release.
---

# flit-release — promoción develop → staging → release

**Quién gobierna qué:** esta skill decide **si el código está listo para promover** y prepara el PR de promoción. El merge a `staging`/`release` lo hace **siempre un humano** (GitHub UI o Líder Técnico con "sí" textual) — ningún agente mergea promociones (regla de `AGENTS.md`; el merge a `develop` del flujo HU es otro contrato). Tras el merge, `flit-integration-ado` **Modo B** activa `Deploy QA` (staging) o `Deploy PDN` (release) — nunca desde esta skill.

**Estados en ADO (`AGENTS.md` «Jerarquía y cascada»):** el QA humano prueba **en QA = `staging`**. Por eso los WIs llegan a esta skill en **`Active` + `DeployDEV=true`** (mergeados a `develop`, aún no en QA) y salen de la promoción a `staging` en **`Resolved`** (Paso 3 de `flit-gestion-hu`, con el aviso al QA), con el Feature y la Épica en `Resolved` si todos sus hijos lo están (Paso 4). Un WI `Resolved` antes de la promoción es un error del ciclo previo, no un requisito de esta skill.

**Ramas y ambientes:**

| Rama | Ambiente | Campo ADO que se activa (Modo B) |
|---|---|---|
| `develop` | DEV | `Custom.DeployDEV` |
| `staging` | QA | `Custom.DeployQA` |
| `release` | PDN (producción) | `Custom.DeployPDN` |

La promoción siempre es un PR de la rama inferior a la superior: `develop → staging`, luego `staging → release`. Nunca `develop → release` directo.

## Modo A — Promover a QA (`develop → staging`)

### Pre-condiciones (todas, verificadas con salida real)

0. **Evidencias DEV del Feature — irrompible.** Cada Feature cuyos hijos viajan en el diff tiene veredicto **`COMPLETO`** de `flit-evidencias-dev`: sesión conjunta en DEV (Claude in Chrome + Playwright) y capturas en `Custom.Evidences` **del Feature**. Si falta o es `PARCIAL`/`BLOQUEADO` → **NO-GO**. No se crea el PR de promoción. Invocar la skill y sentarse con el humano; Vitest / `qa-agent` B / M1 **no** sustituyen. Detalle: `.cursor/rules/evidencias-dev-qa.mdc`.
1. CI en verde sobre el último commit de `develop`: checks `build + test`, `dependency-audit` y `secret-scan` en `success` (MCP `github` → `pull_request_read` / check-runs del commit). El check `naming` solo corre en PRs: en el PR de promoción exige el título `RELEASE: …`.
2. Todos los work items incluidos en el diff `staging...develop` —**HUs y Bugs por igual**— están en **`Active` con `Custom.DeployDEV=true`** (mergeados a `develop` vía `pr-monitor` + Modo B) y **con certificación QA del gate B registrada en Discussion** (matriz AC→TC, o repro+regresión en Bug, con salida real del `qa-agent`). **No se exige `Resolved`**: ese estado lo pone esta misma promoción (post-merge, abajo). Un WI mergeado **sin** `DeployDEV` ni Modo B es un eslabón sin integrar → cerrarlo antes con `flit-integration-ado` Modo B. Si alguna tiene `QA_NOVEDAD` abierta o bugs Crítico/Alto sin resolver → **no-go**.
   - **Si se promueve «una Épica» o «un Feature»:** verificar su **árbol** antes (WIQL de Features hijos de la Épica y de HUs/Bugs hijos de cada Feature) y cruzarlo con los PRs del diff. Lo que está en el diff y no cuelga del árbol se declara («además viaja: …»); lo que cuelga del árbol y no está en el diff se declara como «queda fuera» — y entonces el Feature/Épica **no** podrá pasar a `Resolved` en esta promoción (Paso 4 lo detectará).
3. Regresión ejecutada: `qa-agent` modo D sobre los módulos afectados (mínimo `npm run test:e2e:smoke -w apps/web` con entorno levantado). Veredicto **go** requerido.

### Ejecución

1. Resumen de lo que se promueve: work items —HUs y Bugs— (ID, tipo, título, estado QA), PRs mergeados, diff estadístico (`git diff staging...develop --stat`).
2. Crear el PR `develop → staging` con el servidor MCP `github` (recordar: `gh` no es el CLI de GitHub en esta máquina). **Título:** `RELEASE: <descripción>` — prefijo reservado a promociones, ≤ 100 caracteres, p. ej. `RELEASE: Promoción a QA de 4 HUs del Feature 11623 (comparendos)`. Cuerpo con: lista de HUs, resultado de regresión, checks CI, y checklist de rollback (abajo).
3. **Gate humano:** el merge lo hace el Líder Técnico. Esta skill no mergea.
4. Post-merge (humano confirma), **en el mismo ciclo y en este orden**, por cada HU/Bug del PR:
   1. `flit-integration-ado` **Modo B** → `Custom.DeployQA = true` + «Integrado» en `Custom.Commits`.
   2. **`Skill flit-gestion-hu` Paso 3** → tag `QA` (petición aparte) + `System.State = Resolved` + comentario de entrega a **Daniel Amado** (`mailto:daniel.amado@flitsas.com`) en cada WI **y** en el Feature. Es **aquí** donde el QA se entera.
   3. **`Skill flit-gestion-hu` Paso 4** (una vez por Feature afectado) → si todos los hijos del Feature están `Resolved`/`Closed`, Feature a `Resolved`; si todos los Features de la Épica lo están, Épica a `Resolved`. Declarar en el reporte los Features/Épicas que **no** cascadan y por qué hijo.
   4. `devops-agent` M1 sobre QA (una vez al tip).
   Un WI que quede `Active` en `staging` tras este paso es fallo de esta skill, no un pendiente del QA.

## Modo B — Promover a PDN (`staging → release`)

Todo lo del Modo A, **más**:

1. Las HUs llevan en `staging` el tiempo de maduración acordado por el equipo, sin bugs productivos abiertos contra los módulos del release.
2. Autorización explícita del Líder Técnico para ejecutar contra producción — sin ella no se corre nada de lo siguiente.
3. Post-merge: verificación **M1 del `devops-agent`** — health público + `npm run smoke:prod` y `npm run synthetic:check` (raíz) con salida real pegada. Si fallan → rollback con **M3 del `devops-agent`**. Radicar Bug Crítico vía `qa-agent` modo C **solo** si el QA o el Líder Técnico lo piden **explícitamente** tras el fallo (no encadenar modo C automáticamente).
4. Comunicación: comentario en Discussion del Feature padre con versión desplegada, hora y resultado del smoke.

## Checklist de rollback (va en el cuerpo del PR de promoción)

```markdown
## Rollback
- [ ] Revert del merge commit: `git revert -m 1 <merge_sha>` sobre la rama de ambiente
- [ ] BD: ¿este release aplica migraciones? Listarlas y confirmar que son aditivas (no destructivas). Una migración destructiva exige plan de rollback de datos aparte, aprobado por el Líder Técnico
- [ ] PDN (Docker): redeploy del tag `sha-<anterior>` inmutable — lo ejecuta M3 del `devops-agent` con autorización (PDN despliega tags inmutables; `ecosystem.config.cjs`/PM2 es legacy)
- [ ] Verificación post-rollback: M1 del `devops-agent` sobre el ambiente afectado
```

## Reglas innegociables

1. NUNCA promover con algún check CI en rojo o con regresión sin ejecutar — no hay "a ver si pasa".
2. NUNCA ejecutar el merge del PR de promoción — es del Líder Técnico.
3. NUNCA activar `DeployQA`/`DeployPDN` desde esta skill — eso es `flit-integration-ado` Modo B, tras el merge humano.
4. NUNCA promover a PDN sin autorización explícita y sin plan de rollback en el PR.
5. NUNCA promover una HU **o un Bug** —ni un Feature— sin evidencias DEV `COMPLETAS` en el Feature (`flit-evidencias-dev`) **y** sin certificación del gate B en Discussion. Un "ya casi pasa QA" o "las capturas las subimos después" es un no-go.
6. NUNCA inventar salidas de smoke ni de CI: si el entorno o el check no se puede verificar, se reporta y se detiene.
7. NUNCA dejar un WI en `Active` después de mergear la promoción a `staging`, ni un Feature/Épica en `Active` con todos sus hijos `Resolved`: el post-merge del Modo A (Modo B → Paso 3 con tag `QA` + @Daniel Amado → Paso 4) es parte de la promoción. Y NUNCA mencionar a Daniel Amado antes de ese merge: las evidencias DEV no son aviso a QA.

## Formato de salida

```
PROMOCIÓN — <develop → staging | staging → release>

Contenido: <n> work items — <lista ID + tipo (HU|Bug) + título + estado QA>
CI rama origen: <checks + resultado real>
Regresión (qa-agent D): <comando + veredicto go/no-go>
Pre-condiciones: PASS/FAIL por ítem (ítem 0 = evidencias DEV del Feature)

Veredicto: GO — PR de promoción creado: #<n> | NO-GO — <qué falta>
Pendiente humano: <merge por Líder Técnico | sesión flit-evidencias-dev | resolver bloqueos>
Post-merge (cuando el humano confirme): Modo B DeployQA ×<n> · flit-gestion-hu Paso 3 ×<n> (tag QA + @Daniel Amado + Resolved) · Paso 4: Feature #<id> → Resolved|sigue Active (falta #<hijo>) · Épica #<id> → Resolved|sigue Active · M1 QA
```
