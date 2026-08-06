---
name: flit-gestion-hu
description: Guía el ciclo de implementación de una HU en Azure DevOps (proyecto FLIT - FLITO) — activación (Active), build, cierre técnico (Resolved) y entrega a QA con comentarios HTML y menciones mailto. Usar al implementar una HU asignada. Triggers Active, Resolved, implementar HU, flit-gestion-hu, entrega QA.
---

# flit-gestion-hu — ciclo Active → Resolved de una HU

**Integración ADO:** `flit-azure-devops` (MCP `azure-devops` primero; comentarios/estados vía `wit_update_work_item` + `wit_add_work_item_comment`).

## Requisitos

- Trazabilidad: nombre/email del usuario autenticado en Azure DevOps (ver `flit-azure-devops`); nunca un correo fijo por defecto.
- QA: `QA_LEAD_NAME` / `QA_LEAD_EMAIL` si están definidos; si no, preguntar al supervisor a quién se entrega para validación.

## Checklist

- [ ] Feature padre en `Active` (activado si estaba `New`) — regla de `AGENTS.md`
- [ ] Estado `Active` + comentario de inicio
- [ ] Implementación según Acceptance Criteria
- [ ] `npm run build` exitoso (raíz del monorepo)
- [ ] Estado `Resolved` + comentario de cierre
- [ ] Mención QA en HTML para validación

## Paso 1 — Activación

1. **Feature padre primero** (regla de `AGENTS.md`): consultar `System.Parent` y el estado del padre. Si está `New` → pasarlo a **`Active`** con su propio comentario de inicio en Discussion (p. ej. "Inicia el desarrollo del Feature con la HU #<ID>"). Si ya está `Active` o superior, no rehacer. Si la HU no tiene padre, declararlo en el comentario de inicio.
2. Cambiar estado de la HU a **`Active`** (`wit_update_work_item` → `System.State`).
3. Comentario de inicio (Discussion / `System.History`):

```html
<div>🤖 [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Iniciando desarrollo bajo supervisión de <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a></div>
```

## Paso 2 — Desarrollo

1. Cumplir los Acceptance Criteria y el stack del repo (Node/TS + Express + Drizzle en `apps/api`; React + Vite + Tailwind en `apps/web`).
2. Verificar compilación:
   - Monorepo completo: `npm run build` (ejecuta `build:api` + `build:web`).
   - Solo un workspace: `npm run build:api` o `npm run build:web`.
   - Si tocaste `packages/shared-types`: `npm run test:shared-types`.
3. Verificar los criterios de aceptación antes de cerrar.

## Paso 3 — Cierre técnico

1. Estado **`Resolved`** solo si el build pasa.
2. Comentario de entrega a QA (Discussion):

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Desarrollo completado y listo para pruebas de QA.</div>
<div><a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a> — Por favor proceder con la validación de esta HU.</div>
```

## Reglas

- Todas las menciones `@` en ADO deben usar `<a href="mailto:...">`.
- Prohibido `Resolved` si el build falla.
- El registro del PR y los campos `Custom.Commits` / `Deploy *` los gestiona `flit-integration-ado`, **no** esta skill.
- La auditoría formal de QA la ejecuta el rol/agente de QA (fuera del alcance de esta skill).
