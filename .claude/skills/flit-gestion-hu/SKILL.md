---
name: flit-gestion-hu
description: |
  Ciclo Active → Resolved de un work item de desarrollo en Azure DevOps (FLIT - FLITO): **HU (User Story) o Bug, mismo ciclo**. Activar la cadena de padres (Épica → Feature) + WI, comentario de inicio, cierre Resolved **cuando el desarrollo llega al ambiente de QA (`staging`)** con aviso al QA humano (HTML + mailto), **cascada** Feature → Épica a Resolved, y **reactivación** hacia arriba cuando el QA reabre o radica un Bug.
  INVOCACIÓN OBLIGATORIA: cargar esta Skill en CADA HU y en CADA Bug (Active, Resolved, cascada y reactivación). PROHIBIDO imitarla con comentario «usando @flit-gestion-hu» + wit_* sin cargar la skill.
  El merge a `develop` NO resuelve: el WI queda `Active` + `DeployDEV`. El QA humano prueba en `staging`; mencionarlo con el código en DEV es error de proceso.
  Un Bug corregido y promovido a `staging` que queda en Active es Bug huérfano = fallo de proceso: esta skill lo cierra igual que una HU.
  El gate `qa-agent` B es **pre-PR** (matriz AGENTS.md); esta skill **no** lo lanza en el Paso 3. FAIL del gate → corregir antes del PR; modo C solo con pedido explícito del QA humano.
  Triggers — Active, Resolved, implementar HU, corregir bug, cerrar bug, activar bug, Bug Resolved, bug huérfano, flit-gestion-hu, entrega QA, activar HU, cerrar HU, activar épica, Feature Resolved, épica Resolved, reactivar, flit-modo-desarrollo-auto pasos 1 y 6, flit-release post-merge.
---

# flit-gestion-hu — ciclo Active → Resolved de un work item de desarrollo

**Alcance: HU *o* Bug.** El nombre de la skill es histórico; el ciclo es el mismo para una User
Story y para un Bug (regla «Paridad HU ↔ Bug» de `AGENTS.md`). Donde aquí diga «HU», léase **work
item de desarrollo**. Un Bug **no** es una zona gris sin proceso: si se trabaja, se activa con esta
skill y se cierra con esta skill.

**Jerarquía y cascada** (`AGENTS.md` «Jerarquía Épica → Feature → HU/Bug»): la Épica la escribe el
PO y aquí **solo se lee y se mueve de estado**; el Feature cuelga de ella; la HU/Bug del Feature.
El estado sube por activación (Paso 1), sube por resolución (Paso 4) y vuelve a bajar por
reactivación del QA (Paso 5).

**Dónde prueba el QA humano:** en el **ambiente de QA = rama `staging`**. Nunca en DEV. Por eso
`Resolved` (= «listo para que QA lo valide») se pone **cuando el WI llega a `staging`**, y no al
mergear a `develop`.

**Integración ADO:** `flit-azure-devops` (MCP servidor **`ado`** primero; estados vía `wit_work_item_write` `action=update`; comentarios vía `wit_work_item_comment_write` `action=add` con `format: "Html"`; hijos vía `wit_query` WIQL o `wit_work_item` con relaciones).

## CUÁNDO INVOCAR — HARD-STOP (hilo principal / modo auto)

| Disparador | Paso de esta skill |
|---|---|
| Empezar desarrollo de una HU (modo auto o suelto) | **Paso 1 — Activación** (Épica → Feature → HU a `Active` + comentario en cada nivel que suba) |
| Empezar la corrección de un **Bug** (propio o radicado por QA) | **Paso 1 — Activación** (padres si tiene + Bug → `Active` + comentario) |
| PR **mergeado a `develop`** (`pr-monitor=MERGED`) | **Nada de estado.** El WI sigue `Active`; `flit-integration-ado` Modo B pone `DeployDEV`. Si alguien pide «pásala a Resolved» aquí: explicar que Resolved = staging |
| PR de promoción **mergeado a `staging`** (humano, `flit-release`) y Modo B con `DeployQA=true` | **Paso 3 — Cierre** por **cada** HU/Bug del diff promovido (`Resolved` + aviso al QA humano) → **Paso 4 — Cascada** |
| Última HU/Bug de un Feature en `Resolved` | **Paso 4 — Cascada** (Feature → `Resolved`; si todos los Features de la Épica lo están → Épica `Resolved`) |
| El QA humano reactiva una HU, o radica un Bug (`qa-agent` C) bajo un Feature/HU | **Paso 5 — Reactivación** (HU si aplica, Feature y Épica de vuelta a `Active`) |
| **Bug** corregido, mergeado y **promovido a `staging`** | **Paso 3 + Paso 4** (`Resolved` + aviso; el Feature vuelve a `Resolved` si era el único hijo abierto). **Nunca** dejarlo en `Active` |
| Siguiente HU o Bug de la misma ráfaga | **Otra vez Paso 1** — no reutilizar solo el de la primera |

**Cómo contar:** herramienta `Skill` con `skill: flit-gestion-hu` (args: ID de HU/Bug + `inicio|cierre|cascada|reactivacion`)
**o** `Read` de este `SKILL.md` en el mismo turno, y **entonces** aplicar las plantillas HTML.

**NO cuenta — imitación (anti-patrones graves):**
- Comentario ADO «🤖 usando @flit-gestion-hu» + `wit_*` **sin** haber cargado esta skill en el turno
- `wit_work_item_write` / `wit_work_item_comment_write` sueltos «de memoria»
- Activar solo la primera HU del Feature y en las siguientes cambiar estado sin esta skill
- Pasar a `Resolved` **al mergear a `develop`**, o mencionar al QA humano con el código solo en DEV
- Resolver la última HU y dejar el Feature `Active` (o la Épica) — la cascada es parte del cierre
- Radicar/aceptar un Bug de QA y dejar el Feature en `Resolved`
- Relanzar `qa-agent` B en el Paso 3 (ese gate es pre-PR)
- **Preguntar al humano «¿paso el Bug a Resolved?» como si el proceso no existiera** — existe: es
  este Paso 3. Se pregunta lo que decide el humano (autorizar la escritura en ADO), no si hay ciclo.

**Orden obligatorio:** (1) cargar esta skill → (2) plantillas + PATCH estado. Tras Paso 3
(`Resolved` en staging) el comentario **notifica al QA humano**; **no** lanza `qa-agent` (el modo B
ya corrió antes del PR).

**Encadenamiento:** esta skill **no** invoca subagentes. Cierra con:

```
HANDOFF → hilo: <Paso ejecutado> · WIs movidos: <ids y estados> · cascada: Feature #<id> <estado> · Épica #<id> <estado> | sin cambio · Siguiente: <Modo B si falta | devops M1 al tip | siguiente HU>. No relanzar qa-agent.
```

## HU y Bug — qué cambia (y qué no)

**No cambia:** estados (`New → Active → Resolved → Closed`), comentarios de inicio y cierre,
menciones `mailto:`, `Custom.Commits` / `Deploy *` vía `flit-integration-ado`, cascada a los
padres, y que **`Closed` es del PO/QA** — nunca de un agente.

**Cambia** solo el origen del criterio y algunos campos (verificado contra el proyecto real el
2026-08-22 en los Bugs #11518, #11599, #11604, #11622, #11649, #11694, #11711, #11720):

| Aspecto | HU | Bug |
|---|---|---|
| Qué se implementa | Acceptance Criteria (Gherkin) | `Microsoft.VSTS.TCM.ReproSteps` — el tipo Bug **no tiene** campo Acceptance Criteria |
| Criterio de cierre | Todos los AC cumplidos | El **repro pasa de rojo a verde** + regresión del módulo tocado, sin romper vecinos |
| Padre | Feature (obligatorio activarlo antes; y la Épica del Feature) | Feature o HU **opcional**: si no tiene, se declara en el comentario de inicio. Un Bug radicado por QA **sí** cuelga del Feature/HU y los reactiva (Paso 5) |
| Dimensionamiento | Story Points + `Custom.Refinement` | `Microsoft.VSTS.Common.Severity` + `Priority` |
| `Microsoft.VSTS.Common.ResolvedReason` | lo fija ADO | idem — el valor por defecto al pasar a `Resolved` es `Fixed`; no forzarlo salvo que el motivo sea otro |
| Rama / PR | `HU/<ID>-…` · `HU <ID>: …` | `BUG/<ID>-…` · `BUG <ID>: …` |

## Requisitos

- Trazabilidad: nombre/email del usuario autenticado en Azure DevOps (ver `flit-azure-devops`); nunca un correo fijo por defecto.
- QA: `QA_LEAD_NAME` / `QA_LEAD_EMAIL` si están definidos; si no, preguntar al supervisor a quién se entrega para validación.
- **Bug:** leer también quién lo radicó (`System.CreatedBy`) — se le menciona en el cierre junto al QA.
- **Cadena de padres:** leer `System.Parent` del WI y, recursivamente, del Feature (la Épica). Se
  necesita en el Paso 1 (activar hacia arriba), en el Paso 4 (resolver hacia arriba) y en el Paso 5.

## Checklist

- [ ] Épica `Active` (si el Feature tiene) y Feature `Active` antes de activar la HU/Bug — regla de `AGENTS.md`
- [ ] Estado `Active` + comentario de inicio
- [ ] Implementación según Acceptance Criteria (HU) o Repro Steps + corrección esperada (Bug)
- [ ] `npm run build` exitoso (raíz del monorepo)
- [ ] Merge a `develop` → el WI **sigue `Active`** (`DeployDEV` lo pone `flit-integration-ado`)
- [ ] Promoción a `staging` mergeada + `DeployQA=true` → estado `Resolved` + comentario de cierre
- [ ] Mención QA en HTML para validación **en QA** (y a quien radicó, si es Bug)
- [ ] Cascada: hermanos consultados; Feature → `Resolved` si todos resueltos; Épica → `Resolved` si todos los Features resueltos
- [ ] Reactivación (si el QA reabre): HU/Bug, Feature y Épica de vuelta a `Active` con comentario

## Paso 1 — Activación

1. **Padres primero** (regla de `AGENTS.md`), de arriba hacia abajo:
   - Leer `System.Parent` del WI (Feature) y el `System.Parent` del Feature (Épica).
   - Si la **Épica** está `New` → pasarla a **`Active`** con comentario de inicio en su Discussion
     (p. ej. «Inicia el desarrollo de la Épica con el Feature #<FID>»). **No** se edita su
     descripción ni sus criterios: la Épica la escribe el PO. Si ya está `Active` o superior, no rehacer.
   - Si el **Feature** está `New` → pasarlo a **`Active`** con su propio comentario de inicio
     (p. ej. «Inicia el desarrollo del Feature con la HU #<ID>»). Si ya está `Active` o superior, no rehacer.
   - Si el work item no tiene padre — caso frecuente en Bugs — **declararlo** en el comentario de
     inicio («Bug sin padre en el board»).
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

Comentario de inicio en el **Feature** o la **Épica** que se activa por esta HU:

```html
<div>🤖 [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Inicia el desarrollo de este {Feature|Épica} con {la HU|el Feature} #{ID} bajo supervisión de <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a>.</div>
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
4. **Tras el merge a `develop`** (`pr-monitor=MERGED` → `flit-integration-ado` Modo B `DeployDEV`):
   el WI **permanece en `Active`**. Está en DEV, no en QA. No se menciona al QA humano todavía.
   Si el humano pide «pásala a Resolved» en este punto, se explica que `Resolved` = en `staging`
   y se deja para el Paso 3 con la promoción.

## Paso 3 — Cierre técnico (el WI está en `staging`)

**Cuándo:** el PR de promoción `develop → staging` se mergeó (humano, `flit-release`) y
`flit-integration-ado` Modo B puso `Custom.DeployQA = true` en el WI. Se ejecuta **por cada**
HU/Bug incluido en el diff promovido (`flit-release` los lista); una promoción de N WIs son N
Pasos 3 (y luego la cascada del Paso 4 una vez por Feature afectado).

1. Estado **`Resolved`** solo si: PR mergeado a `develop`, `qa-agent` B pasó **antes** del PR, y
   el WI **está en `staging`** (`DeployQA=true` o el SHA del merge de promoción contiene su PR).
2. Comentario de entrega a QA (Discussion):

**HU:**

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Desarrollo desplegado en el ambiente de QA (<code>staging</code>, promoción PR <a href="{PR_PROMOCION_URL}">#{PR_PROMOCION}</a>) y listo para pruebas.</div>
<div><a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a> — Por favor proceder con la validación de esta HU en QA. Si hay hallazgos: reactivar esta HU o radicar el Bug bajo el Feature #{FID}.</div>
```

**Bug** (misma estructura + qué se corrigió y cómo se comprobó):

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Corrección desplegada en el ambiente de QA (<code>staging</code>, promoción PR <a href="{PR_PROMOCION_URL}">#{PR_PROMOCION}</a>) y lista para pruebas.</div>
<div><b>Causa:</b> {una o dos líneas}. <b>Corrección:</b> {qué cambió y dónde}.</div>
<div><b>Repro verificado:</b> {comando/pasos} — rojo antes del cambio, verde después.</div>
<div><a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a> — Por favor proceder con la validación en QA. <a href="mailto:{REPORTER_EMAIL}">@{REPORTER_NAME}</a> (reportó el hallazgo) queda notificado.</div>
```

3. **No relanzar `qa-agent`.** El comentario HTML notifica al QA **humano**, que prueba en
   `staging`. El gate de desarrollo (`qa-agent` B) ya corrió en el paso pre-PR. Relanzarlo aquí es
   el anti-patrón que duplica el ciclo.
4. Seguir con el **Paso 4** para cada Feature afectado por la promoción.

## Paso 4 — Cascada hacia arriba (Feature → Épica)

Se ejecuta **inmediatamente después** del Paso 3 (una vez por Feature afectado), y también cuando
al revisar el board aparece un Feature con todos los hijos resueltos y aún `Active`.

1. **Feature:** consultar los hijos del Feature (WIQL `[System.Parent] = <FID>` o relaciones
   `Hierarchy-Forward`). Si **todos** están en `Resolved` o `Closed` → Feature a **`Resolved`** +
   comentario. Si queda alguno en `New`/`Active` → el Feature sigue `Active`; se declara en el
   HANDOFF cuáles faltan. **Un Feature `Resolved` con un hijo abierto es tan huérfano como un Bug
   sin cerrar.**
2. **Épica:** si el Feature pasó a `Resolved`, consultar los Features hermanos (hijos de la Épica).
   Si **todos** están `Resolved`/`Closed` → Épica a **`Resolved`** + comentario. Si no, sigue `Active`.
3. Ni el Feature ni la Épica pasan a `Closed` aquí: eso es del PO.

Comentario de cascada (en el Feature y, si aplica, en la Épica):

```html
<div>✅ [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Todas las {historias|features} hijas están en QA (<code>Resolved</code>): {#id, #id, …}. Este {Feature|Épica} pasa a <b>Resolved</b> a la espera de la validación de <a href="mailto:{QA_LEAD_EMAIL}">@{QA_LEAD_NAME}</a>. El cierre (<code>Closed</code>) queda para el Product Owner.</div>
```

## Paso 5 — Reactivación (hallazgo del QA humano en `staging`)

**Cuándo:** el QA humano, probando en QA, **reactiva** una HU (la pasa a `Active` o lo pide en
Discussion) **o** radica/pide radicar un Bug (`qa-agent` modo C, hijo del Feature o de la HU).
También cuando el Bug llega ya creado por el QA y se empieza a corregir (Paso 1 del Bug).

1. **HU** (si el hallazgo es sobre ella o el Bug cuelga de ella): a `Active` con comentario que
   enlace el hallazgo/Bug. Si el QA ya la reactivó, no rehacer.
2. **Feature** padre: de `Resolved` a **`Active`** con comentario («Reactivado por hallazgo de QA:
   Bug #<id> / HU #<id>»). Si ya está `Active`, no rehacer.
3. **Épica**: si estaba `Resolved`, vuelve a **`Active`** con el mismo comentario. Si estaba
   `Active`, no rehacer.
4. El Bug/HU reactivada entra al ciclo normal: Paso 1 (ya `Active`) → desarrollo → PR → merge a
   `develop` (sigue `Active`) → promoción a `staging` → **Paso 3** (`Resolved`) → **Paso 4**: el
   Feature vuelve a `Resolved` cuando ese era su único hijo abierto, y la Épica igual.

Comentario de reactivación (Feature / Épica):

```html
<div>🔁 [@{Nombre-del-Agente}] usando <b>@flit-gestion-hu</b>: Reactivado a <b>Active</b> por hallazgo de QA en <code>staging</code> — {Bug #<id> | HU #<id> reactivada} bajo supervisión de <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a>. Volverá a Resolved cuando la corrección llegue a QA.</div>
```

## Reglas

- Todas las menciones `@` en ADO deben usar `<a href="mailto:...">`.
- Prohibido `Resolved` si el build falla.
- **Prohibido `Resolved` al mergear a `develop`.** `Resolved` = el WI está en `staging`
  (`DeployQA=true`). Un WI en DEV se queda `Active`; mencionar al QA humano en ese momento es el
  error que esta regla corrige.
- **Prohibido dejar un Bug en `Active` con su corrección en `staging`** (Bug huérfano). Si al
  revisar el board aparece uno así, se cierra con el Paso 3 + Paso 4 — con «sí» del humano para
  escribir en ADO, igual que cualquier PATCH.
- **Prohibido resolver la última HU y no cascadar.** El Paso 4 es parte del cierre, no un extra.
- **Prohibido reactivar una HU o aceptar un Bug de QA sin devolver el Feature (y la Épica) a
  `Active`.** La cascada baja igual que sube.
- `Closed` no lo pone esta skill ni ningún agente: es del PO/QA.
- La Épica **no se redacta ni se edita** desde aquí ni desde ninguna skill: solo cambia de estado
  y recibe comentarios.
- El registro del PR y los campos `Custom.Commits` / `Deploy *` los gestiona `flit-integration-ado`,
  **no** esta skill — y aplican igual a HU y a Bug.
- Las evidencias de tests van a `Custom.Evidences` (rol dev/QA), **no** a Discussion. Si el tipo Bug
  rechaza ese campo en el PATCH, registrar la evidencia en Discussion y **declarar la limitación**;
  nunca descartarla en silencio.
- El comentario de entrega a QA **notifica** al rol QA humano, que prueba en `staging`. El
  `qa-agent` modo B es **pre-PR**, no de este Paso 3. Hallazgos formales / Bugs nuevos → solo cuando
  el QA humano lo pida (modo C), no por un FAIL de desarrollo ni por una Nota.
