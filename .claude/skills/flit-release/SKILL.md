---
name: flit-release
description: Gobierna la promoción entre ambientes del monorepo FLITO — develop → staging (QA) → release (PDN). Verifica CI verde y QA_PDN de las HUs, coordina la regresión con qa-agent modo D, crea el PR de promoción con checklist de rollback y valida post-merge con smoke de producción. No toca Custom.Commits ni Deploy * (eso es flit-integration-ado Modo B, tras el merge humano). Triggers promover a QA, promover a staging, subir a producción, release, PDN, rollback, flit-release.
---

# flit-release — promoción develop → staging → release

**Quién gobierna qué:** esta skill decide **si el código está listo para promover** y prepara el PR de promoción. El merge lo hace un humano (GitHub UI o Líder Técnico con "sí" textual). Tras el merge, `flit-integration-ado` **Modo B** activa `Deploy QA` (staging) o `Deploy PDN` (release) — nunca desde esta skill.

**Ramas y ambientes:**

| Rama | Ambiente | Campo ADO que se activa (Modo B) |
|---|---|---|
| `develop` | DEV | `Custom.DeployDEV` |
| `staging` | QA | `Custom.DeployQA` |
| `release` | PDN (producción) | `Custom.DeployPDN` |

La promoción siempre es un PR de la rama inferior a la superior: `develop → staging`, luego `staging → release`. Nunca `develop → release` directo.

## Modo A — Promover a QA (`develop → staging`)

### Pre-condiciones (todas, verificadas con salida real)

1. CI en verde sobre el último commit de `develop`: checks `build + test`, `dependency-audit` y `secret-scan` en `success` (MCP `github` → `pull_request_read` / check-runs del commit).
2. Todas las HUs incluidas en el diff `staging...develop` están en `Resolved` con tag `QA_PDN` — listar las HUs vía WIQL y su estado. Si alguna tiene `QA_NOVEDAD` abierta o bugs Crítico/Alto sin resolver → **no-go**.
3. Regresión ejecutada: `qa-agent` modo D sobre los módulos afectados (mínimo `npm run test:e2e:smoke -w apps/web` con entorno levantado). Veredicto **go** requerido.

### Ejecución

1. Resumen de lo que se promueve: HUs (ID, título, estado QA), PRs mergeados, diff estadístico (`git diff staging...develop --stat`).
2. Crear el PR `develop → staging` con el servidor MCP `github` (recordar: `gh` no es el CLI de GitHub en esta máquina), cuerpo con: lista de HUs, resultado de regresión, checks CI, y checklist de rollback (abajo).
3. **Gate humano:** el merge lo hace el Líder Técnico. Esta skill no mergea.
4. Post-merge (humano confirma): `flit-integration-ado` Modo B activa `Deploy QA` por cada HU del PR.

## Modo B — Promover a PDN (`staging → release`)

Todo lo del Modo A, **más**:

1. Las HUs llevan en `staging` el tiempo de maduración acordado por el equipo, sin bugs productivos abiertos contra los módulos del release.
2. Autorización explícita del Líder Técnico para ejecutar contra producción — sin ella no se corre nada de lo siguiente.
3. Post-merge: verificación **M1 del `devops-agent`** — health público + `npm run smoke:prod` y `npm run synthetic:check` (raíz) con salida real pegada. Si fallan → rollback con **M3 del `devops-agent`** y radicar bug Crítico vía `qa-agent` modo C.
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
5. NUNCA promover una HU sin `QA_PDN`. Un "ya casi pasa QA" es un no-go.
6. NUNCA inventar salidas de smoke ni de CI: si el entorno o el check no se puede verificar, se reporta y se detiene.

## Formato de salida

```
PROMOCIÓN — <develop → staging | staging → release>

Contenido: <n> HUs — <lista ID + título + estado QA>
CI rama origen: <checks + resultado real>
Regresión (qa-agent D): <comando + veredicto go/no-go>
Pre-condiciones: PASS/FAIL por ítem

Veredicto: GO — PR de promoción creado: #<n> | NO-GO — <qué falta>
Pendiente humano: <merge por Líder Técnico | resolver bloqueos listados>
```
