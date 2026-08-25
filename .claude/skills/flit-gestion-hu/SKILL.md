---
name: flit-gestion-hu
description: |
  Ciclo Active → Resolved de un work item de desarrollo en Azure DevOps (FLIT - FLITO): **HU (User Story) o Bug, mismo ciclo**. Activar padre + WI, comentario de inicio, cierre Resolved **tras el merge** y aviso al QA humano (HTML + mailto).
  INVOCACIÓN OBLIGATORIA: cargar esta Skill en CADA HU y en CADA Bug (Active y Resolved). PROHIBIDO imitarla con comentario «usando @flit-gestion-hu» + wit_* sin cargar la skill.
  Un Bug corregido y mergeado que queda en Active es Bug huérfano = fallo de proceso: esta skill lo cierra igual que una HU.
  El gate `qa-agent` B es **pre-PR** (matriz AGENTS.md); esta skill **no** lo lanza en el Paso 3. FAIL del gate → corregir antes del PR; modo C solo con pedido explícito del QA humano.
  Triggers — Active, Resolved, implementar HU, corregir bug, cerrar bug, activar bug, Bug Resolved, bug huérfano, flit-gestion-hu, entrega QA, activar HU, cerrar HU, flit-modo-desarrollo-auto pasos 1 y 6.
---

# flit-gestion-hu — ciclo Active → Resolved de un work item de desarrollo

**Alcance: HU *o* Bug.** El nombre de la skill es histórico; el ciclo es el mismo para una User
Story y para un Bug (regla «Paridad HU ↔ Bug» de `AGENTS.md`). Donde aquí diga «HU», léase **work
item de desarrollo**. Un Bug **no** es una zona gris sin proceso: si se trabaja, se activa con esta
skill y se cierra con esta skill.

**Integración ADO:** `flit-azure-devops` (MCP servidor **`ado`** primero; estados vía `wit_work_item_write` `action=update`; comentarios vía `wit_work_item_comment_write` `action=add`).

## CUÁNDO INVOCAR — HARD-STOP (hilo principal / modo auto)

| Disparador | Paso de esta skill |
|---|---|
| Empezar desarrollo de una HU (modo auto o suelto) | **Paso 1 — Activación** (Feature padre + HU → `Active` + comentario) |
| Empezar la corrección de un **Bug** (propio o radicado por QA) | **Paso 1 — Activación** (padre si tiene + Bug → `Active` + comentario) |
| Build/AC verdes, **PR mergeado a `develop`**, se cierra técnicamente | **Paso 3 — Cierre** (`Resolved` + comentario al QA humano) |
| **Bug** corregido, con repro en verde y PR **mergeado** | **Paso 3 — Cierre** (`Resolved` + aviso a QA). **Nunca** dejarlo en `Active` |
| Siguiente HU o Bug de la misma ráfaga | **Otra vez Paso 1** — no reutilizar solo el de la primera |

**Cómo contar:** herramienta `Skill` con `skill: flit-gestion-hu` (args: ID de HU/Bug + `inicio|cierre`)
**o** `Read` de este `SKILL.md` en el mismo turno, y **entonces** aplicar las plantillas HTML.

**NO cuenta — imitación (anti-patrones graves):**
- Comentario ADO «🤖 usando @flit-gestion-hu» + `wit_*` **sin** haber cargado esta skill en el turno
- `wit_work_item_write` / `wit_work_item_comment_write` sueltos «de memoria»
- Activar solo la primera HU del Feature y en las siguientes cambiar estado sin esta skill
- Dar por cerrado el ciclo sin `Resolved` **después del merge**
- Relanzar `qa-agent` B en el Paso 3 (ese gate es pre-PR)
- **Preguntar al humano «¿paso el Bug a Resolved?» como si el proceso no existiera** — existe: es
  este Paso 3. Se pregunta lo que decide el humano (autorizar la escritura en ADO), no si hay ciclo.

**Orden obligatorio:** (1) cargar esta skill → (2) plantillas + PATCH estado. Tras Paso 3
(`Resolved` post-merge) el comentario **notifica al QA humano** de ambiente; **no** lanza
`qa-agent` (el modo B ya corrió antes del PR).

**Encadenamiento tras Paso 3:** `flit-integration-ado` Modo B si aún no se hizo con el merge;
esta skill **no** invoca subagentes. El cierre termina con:

```
HANDOFF → hilo: Modo B si falta + devops M1 al tip de ráfaga. No relanzar qa-agent.
```

## HU y Bug — qué cambia (y qué no)

**No cambia:** estados (`New → Active → Resolved → Closed`), comentarios de inicio y cierre,
menciones `mailto:`, `Custom.Commits` / `Deploy *` vía `flit-integration-ado`, gate `qa-agent`
tras `Resolved`, y que **`Closed` es del PO/QA** — nunca de un agente.

**Cambia** solo el origen del criterio y algunos campos (verificado contra el proyecto real el
2026-08-22 en los Bugs #11518, #11599, #11604, #11622, #11649, #11694, #11711, #11720):

| Aspecto | HU | Bug |
|---|---|---|
| Qué se implementa | Acceptance Criteria (Gherkin) | `Microsoft.VSTS.TCM.ReproSteps` — el tipo Bug **no tiene** campo Acceptance Criteria |
| Criterio de cierre | Todos los AC cumplidos | El **repro pasa de rojo a verde** + regresión del módulo tocado, sin romper vecinos |
| Padre | Feature (obligatorio activarlo antes) | Feature o HU **opcional**: si no tiene, se declara en el comentario de inicio |
| Dimensionamiento | Story Points + `Custom.Refinement` | `Microsoft.VSTS.Common.Severity` + `Priority` |
| `Microsoft.VSTS.Common.ResolvedReason` | lo fija ADO | idem — el valor por defecto al pasar a `Resolved` es `Fixed`; no forzarlo salvo que el motivo sea otro |
| Rama / PR | `HU/<ID>-…` · `HU <ID>: …` | `BUG/<ID>-…` · `BUG <ID>: …` |

## Requisitos

- Trazabilidad: nombre/email del usuario autenticado en Azure DevOps (ver `flit-azure-devops`); nunca un correo fijo por defecto.
- QA: `QA_LEAD_NAME` / `QA_LEAD_EMAIL` si están definidos; si no, preguntar al supervisor a quién se entrega para validación.
- **Bug:** leer también quién lo radicó (`System.CreatedBy`) — se le menciona en el cierre junto al QA.

## Checklist

- [ ] Padre en `Active` si existe (Feature de la HU; Feature/HU del Bug) — regla de `AGENTS.md`
- [ ] Estado `Active` + comentario de inicio
- [ ] Implementación según Acceptance Criteria (HU) o Repro Steps + corrección esperada (Bug)
- [ ] `npm run build` exitoso (raíz del monorepo)
- [ ] Estado `Resolved` + comentario de cierre
- [ ] Mención QA en HTML para validación (y a quien radicó, si es Bug)

## Paso 1 — Activación

1. **Padre primero** (regla de `AGENTS.md`): consultar `System.Parent` y el estado del padre. Si está `New` → pasarlo a **`Active`** con su propio comentario de inicio en Discussion (p. ej. "Inicia el desarrollo del Feature con la HU #<ID>"). Si ya está `Active` o superior, no rehacer. Si el work item no tiene padre — caso frecuente en Bugs — **declararlo** en el comentario de inicio ("Bug sin padre en el board").
2. Cambiar estado del work item a **`Active`** (`wit_work_item_write` `action=update` → `/fields/System.State`).
3. Comentario de inicio (Discussion / `System.History`):

```html
<div>🤖 [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Iniciando desarrollo bajo supervisión de <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a></div>
```

Para un **Bug**, la misma línea más el reconocimiento de origen y alcance:

```html
<div>🤖 [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Iniciando la corrección bajo supervisión de <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a>.</div>
<div>Reportado por <a href="mailto:{REPORTER_EMAIL}">@{REPORTER_NAME}</a> · Severidad {Severity} · Padre: {#ID o «sin padre en el board»}.</div>
<div><b>Repro que debe quedar en verde:</b> {resumen de una línea de los Repro Steps}.</div>
```

## Paso 2 — Desarrollo

1. Cumplir los Acceptance Criteria (HU) o los Repro Steps + «corrección esperada» (Bug) y el stack del repo (Node/TS + Express + Drizzle en `apps/api`; React + Vite + Tailwind en `apps/web`).
2. Verificar compilación:
   - Monorepo completo: `npm run build` (ejecuta `build:api` + `build:web`).
   - Solo un workspace: `npm run build:api` o `npm run build:web`.
   - Si tocaste `packages/shared-types`: `npm run test:shared-types`.
3. Verificar los criterios antes de cerrar. En un **Bug**, eso incluye **reproducir el fallo antes
   del fix** (o dejar constancia de que el test/gate nuevo se pone rojo sin el cambio) y verlo en
   verde después. Un Bug cerrado sin esa prueba de mutación es un cierre a ciegas.

## Paso 3 — Cierre técnico

1. Estado **`Resolved`** solo si el PR está **mergeado** a `develop` y el `qa-agent` B ya pasó **antes** del PR.
2. Comentario de entrega a QA (Discussion):

**HU:**

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Desarrollo completado y listo para pruebas de QA.</div>
<div><a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a> — Por favor proceder con la validación de esta HU.</div>
```

**Bug** (misma estructura + qué se corrigió y cómo se comprobó):

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Corrección completada y lista para pruebas de QA.</div>
<div><b>Causa:</b> {una o dos líneas}. <b>Corrección:</b> {qué cambió y dónde}.</div>
<div><b>Repro verificado:</b> {comando/pasos} — rojo antes del cambio, verde después.</div>
<div><a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a> — Por favor proceder con la validación. <a href="mailto:{REPORTER_EMAIL}">@{REPORTER_NAME}</a> (reportó el hallazgo) queda notificado.</div>
```

3. **No relanzar `qa-agent`.** El comentario HTML notifica al QA **humano** de ambiente (staging/DEV).
   El gate de desarrollo (`qa-agent` B) ya corrió en el paso pre-PR. Relanzarlo aquí, en paralelo
   al `pr-monitor-agent`, es el anti-patrón que duplica el ciclo.

## Reglas

- Todas las menciones `@` en ADO deben usar `<a href="mailto:...">`.
- Prohibido `Resolved` si el build falla.
- **Prohibido dejar un Bug en `Active` con su corrección mergeada** (Bug huérfano). Si al revisar
  el board aparece uno así, se cierra con el Paso 3 — con «sí» del humano para escribir en ADO,
  igual que cualquier PATCH.
- `Closed` no lo pone esta skill ni ningún agente: es del PO/QA.
- El registro del PR y los campos `Custom.Commits` / `Deploy *` los gestiona `flit-integration-ado`,
  **no** esta skill — y aplican igual a HU y a Bug.
- Las evidencias de tests van a `Custom.Evidences` (rol dev/QA), **no** a Discussion. Si el tipo Bug
  rechaza ese campo en el PATCH, registrar la evidencia en Discussion y **declarar la limitación**;
  nunca descartarla en silencio.
- El comentario de entrega a QA **notifica** al rol QA humano de ambiente. El `qa-agent` modo B
  es **pre-PR**, no de este Paso 3. Hallazgos formales / Bugs nuevos → solo cuando el QA humano
  lo pida (modo C), no por un FAIL de desarrollo ni por una Nota.
