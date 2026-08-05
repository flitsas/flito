## HU y contexto

AB#_____ <!-- ID de Azure DevOps — obligatorio: flit-integration-ado lo usa para la trazabilidad -->

## Qué cambia y por qué

<!-- 2-4 líneas. Si toca auth, PII (LAFT/Privacy), pagos o crons, dilo explícitamente aquí. -->

## Checklist (flit-code-review)

- [ ] Tests locales en verde con salida real (`npm run test -w apps/api` y/o `npm run test:e2e:smoke -w apps/web`)
- [ ] Typecheck en verde (`npm run build`)
- [ ] Lint sin errores nuevos (`npm run lint`)
- [ ] Diff ≤ 800 líneas; si no, expliqué el motivo arriba
- [ ] **Backend**: patrón `routes`/`service`, guarda de permiso antes de la lógica, migración Drizzle incluida si cambié `schema.ts`
- [ ] **Frontend**: 4 estados (loading / error / empty / data), sin drift visual en módulos `flito-*`

## Seguridad

- [ ] Este PR **no** toca auth, PII, pagos ni crons — o si toca, pasó por `security-agent` y pegué su veredicto

## Rollback

<!-- Cómo se revierte si sale mal: revert del PR, migración reversible, feature flag, etc. -->
