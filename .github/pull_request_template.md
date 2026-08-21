<!--
  Título del PR (obligatorio, lo valida el check «naming»):
    HU <ID>: <descripción>     ·  BUG <ID>: <descripción>
    CHORE: / DOCS: <descripción>  (solo sin work item y sin tocar apps/ ni packages/)
  Máx. 100 caracteres, descriptivo, sin punto final, mismo ID que la rama HU/<ID>-<dev>-<desc>.
  Detalle: .cursor/rules/convenciones-rama-pr.mdc
-->

## HU y contexto

AB#_____ <!-- ID de Azure DevOps — obligatorio: todo desarrollo va ligado a una HU o un Bug. Solo los PRs CHORE/DOCS pueden ir sin work item -->

## Qué cambia y por qué

<!-- 2-4 líneas. Si toca auth, PII (LAFT/Privacy), pagos o crons, dilo explícitamente aquí. -->

## Checklist (flit-code-review)

- [ ] Tests locales en verde con salida real (`npm run test -w apps/api` y/o `npm run test:e2e:smoke -w apps/web`)
- [ ] Typecheck en verde (`npm run build`)
- [ ] Lint sin errores nuevos (`npm run lint`)
- [ ] Diff ≤ 800 líneas; si no, expliqué el motivo arriba
- [ ] Rama y título en formato canónico (`node scripts/check-naming.mjs --branch … --title …` en verde)
- [ ] **Backend**: patrón `routes`/`service`, guarda de permiso antes de la lógica, migración Drizzle incluida si cambié `schema.ts`
- [ ] **Frontend**: 4 estados (loading / error / empty / data), sin drift visual en módulos `flito-*`

## Seguridad

- [ ] Este PR **no** toca auth, PII, pagos ni crons — o si toca, pasó por `security-agent` y pegué su veredicto

## Rollback

<!-- Cómo se revierte si sale mal: revert del PR, migración reversible, feature flag, etc. -->
