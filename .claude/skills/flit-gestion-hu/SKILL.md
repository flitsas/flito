---
name: flit-gestion-hu
description: |
  Ciclo Active → Resolved de una HU en Azure DevOps (FLIT - FLITO): activar Feature+HU, comentario de inicio, cierre Resolved y entrega a QA (HTML + mailto).
  INVOCACIÓN OBLIGATORIA: el hilo principal DEBE cargar esta skill (Skill flit-gestion-hu) en CADA HU al activar y al resolver — también en modo auto. No basta con wit_work_item_write «a mano» sin seguir las plantillas/pasos.
  Tras Resolved (paso 3): el hilo DEBE invocar qa-agent (matriz AGENTS.md); el comentario de entrega NO sustituye a qa-agent.
  Triggers — Active, Resolved, implementar HU, flit-gestion-hu, entrega QA, activar HU, cerrar HU, flit-modo-desarrollo-auto pasos 1 y 6.
---

# flit-gestion-hu — ciclo Active → Resolved de una HU

**Integración ADO:** `flit-azure-devops` (MCP servidor **`ado`** primero; estados vía `wit_work_item_write` `action=update`; comentarios vía `wit_work_item_comment_write` `action=add`).

## CUÁNDO INVOCAR — HARD-STOP (hilo principal / modo auto)

| Disparador | Paso de esta skill |
|---|---|
| Empezar desarrollo de una HU (modo auto o suelto) | **Paso 1 — Activación** (Feature padre + HU → `Active` + comentario) |
| Build/AC verdes y se va a cerrar técnicamente | **Paso 3 — Cierre** (`Resolved` + comentario entrega QA) |
| Siguiente HU de la misma ráfaga | **Otra vez Paso 1** — no reutilizar solo el de la primera HU |

**Cómo contar:** herramienta `Skill` con `skill: flit-gestion-hu` (args con el ID de la HU y si es inicio o cierre) y aplicar plantillas HTML de este documento.

**NO cuenta (anti-patrones graves):**
- `wit_work_item_write` / `wit_work_item_comment_write` sueltos sin cargar la skill ni las plantillas
- Activar solo la primera HU del Feature y en las siguientes cambiar estado «de memoria»
- Dar por cerrada la entrega a QA solo con el comentario HTML (falta el HANDOFF a `qa-agent`)

**Encadenamiento obligatorio tras Paso 3:** el hilo principal invoca `qa-agent` (ver matriz). Esta skill **no** invoca subagentes; deja el HANDOFF explícito.

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
2. Cambiar estado de la HU a **`Active`** (`wit_work_item_write` `action=update` → `/fields/System.State`).
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

3. **HANDOFF a `qa-agent` — obligatorio** (el hilo principal lo ejecuta con `Agent`/`Task`; esta skill no invoca subagentes):
   - HU con AC Gherkin o FRONTEND → `qa-agent` modo A (TCs si faltan) + modo B (ejecución).
   - HU BACKEND-only → al menos modo B sobre tests del módulo; declarar si se omite E2E.
   - Sin entorno → **igual invocar** el agente; HANDOFF `SIN-ENTORNO` + comentario «QA pendiente de entorno»; no inventar evidencia.
   - **Prohibido** dar por cerrada la HU en el reporte del Feature sin ese HANDOFF.

## Reglas

- Todas las menciones `@` en ADO deben usar `<a href="mailto:...">`.
- Prohibido `Resolved` si el build falla.
- El registro del PR y los campos `Custom.Commits` / `Deploy *` los gestiona `flit-integration-ado`, **no** esta skill.
- El comentario de entrega a QA **no sustituye** la ejecución de `qa-agent` — solo notifica; la auditoría formal la corre el agente/rol de QA (matriz de `AGENTS.md`).
