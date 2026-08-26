---
name: flit-release
description: Gobierna la promoción entre ambientes del monorepo FLITO — develop → staging (QA) → release (PDN). Verifica CI verde y la certificación QA de las HUs (tag QA_PDN SUSPENDIDO por permisos desde 2026-08-21; vale el comentario de certificación del gate en Discussion), coordina la regresión con qa-agent modo D, crea el PR de promoción con checklist de rollback y valida post-merge con smoke de producción. El merge de promoción es siempre humano; no toca Custom.Commits ni Deploy * (eso es flit-integration-ado Modo B). Triggers promover a QA, promover a staging, subir a producción, release, PDN, rollback, flit-release.
---

# flit-release — promoción develop → staging → release

**Quién gobierna qué:** esta skill decide **si el código está listo para promover** y prepara el PR de promoción. El merge a `staging`/`release` lo hace **siempre un humano** (GitHub UI o Líder Técnico con "sí" textual) — ningún agente mergea promociones (regla de `AGENTS.md`; el merge a `develop` del flujo HU es otro contrato). Tras el merge, `flit-integration-ado` **Modo B** activa `Deploy QA` (staging) o `Deploy PDN` (release) — nunca desde esta skill.

**Ramas y ambientes:**

| Rama | Ambiente | Campo ADO que se activa (Modo B) |
|---|---|---|
| `develop` | DEV | `Custom.DeployDEV` |
| `staging` | QA | `Custom.DeployQA` |
| `release` | PDN (producción) | `Custom.DeployPDN` |

La promoción siempre es un PR de la rama inferior a la superior: `develop → staging`, luego `staging → release`. Nunca `develop → release` directo.

## Modo A — Promover a QA (`develop → staging`)

### Pre-condiciones (todas, verificadas con salida real)

1. CI en verde sobre el último commit de `develop`: checks `build + test`, `dependency-audit` y `secret-scan` en `success` (MCP `github` → `pull_request_read` / check-runs del commit). El check `naming` solo corre en PRs: en el PR de promoción exige el título `RELEASE: …`.
2. Todos los work items incluidos en el diff `staging...develop` —**HUs y Bugs por igual**— están en `Resolved` **con certificación QA del gate registrada en Discussion** (matriz AC→TC, o repro+regresión en Bug, con salida real del `qa-agent`). Un Bug mergeado que sigue en `Active` (Bug huérfano) es **no-go**: se cierra antes con `flit-gestion-hu`. El tag `QA_PDN` está **SUSPENDIDO** (2026-08-21, sin permisos de tags en ADO) — no exigirlo ni escribirlo; el comentario de certificación es el registro vigente. Si alguna tiene `QA_NOVEDAD` abierta o bugs Crítico/Alto sin resolver → **no-go**.
3. Regresión ejecutada: `qa-agent` modo D sobre los módulos afectados (mínimo `npm run test:e2e:smoke -w apps/web` con entorno levantado). Veredicto **go** requerido.

### Ejecución

1. Resumen de lo que se promueve: work items —HUs y Bugs— (ID, tipo, título, estado QA), PRs mergeados, diff estadístico (`git diff staging...develop --stat`).
2. Crear el PR `develop → staging` con el servidor MCP `github` (recordar: `gh` no es el CLI de GitHub en esta máquina). **Título:** `RELEASE: <descripción>` — prefijo reservado a promociones, ≤ 100 caracteres, p. ej. `RELEASE: Promoción a QA de 4 HUs del Feature 11623 (comparendos)`. Cuerpo con: lista de HUs, resultado de regresión, checks CI, y checklist de rollback (abajo).
3. **Gate humano:** el merge lo hace el Líder Técnico. Esta skill no mergea.
4. Post-merge (humano confirma): `flit-integration-ado` Modo B activa `Deploy QA` por cada HU del PR.

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
5. NUNCA promover una HU **o un Bug** sin certificación QA registrada en ADO (mientras dure la suspensión del tag `QA_PDN`: el comentario de certificación del gate en Discussion). Un "ya casi pasa QA" es un no-go.
6. NUNCA inventar salidas de smoke ni de CI: si el entorno o el check no se puede verificar, se reporta y se detiene.

## Formato de salida

```
PROMOCIÓN — <develop → staging | staging → release>

Contenido: <n> work items — <lista ID + tipo (HU|Bug) + título + estado QA>
CI rama origen: <checks + resultado real>
Regresión (qa-agent D): <comando + veredicto go/no-go>
Pre-condiciones: PASS/FAIL por ítem

Veredicto: GO — PR de promoción creado: #<n> | NO-GO — <qué falta>
Pendiente humano: <merge por Líder Técnico | resolver bloqueos listados>
```
