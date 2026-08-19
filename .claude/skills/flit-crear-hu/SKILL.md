---
name: flit-crear-hu
description: Crea Historias de Usuario en Azure DevOps con Description, Acceptance Criteria y Discussion separados; formato Como/quiero/para, AC Gherkin, Story Points y trazabilidad. Commits y Evidences NO se rellenan al crear. Triggers HU, User Story, FRONTEND, BACKEND, Gherkin, flit-crear-hu.
---

# Crear Historia de Usuario en Azure DevOps

Al **crear** una HU solo se rellenan los campos del momento de refinamiento/planificación. **Nunca** mezclar Gherkin ni trazabilidad dentro de `Description`.

**Integración ADO:** `flit-azure-devops` (MCP servidor **`ado`** primero, REST como fallback). Proyecto: `FLIT - FLITO`.

## Mapeo — qué se rellena al crear la HU

| Módulo en Azure DevOps | Campo API (`referenceName`) | ¿Al crear HU? | Contenido |
|------------------------|----------------------------|---------------|-----------|
| **Description** | `System.Description` | **Sí** | Solo **Como / quiero / para** en HTML |
| **Acceptance Criteria** | `Microsoft.VSTS.Common.AcceptanceCriteria` | **Sí** | **Gherkin** en HTML (+ notas técnicas opcionales) |
| **Discussion** | `System.History` | **Sí** | Comentario HTML de trazabilidad del agente |
| **Commits** | `Custom.Commits` | **No** | Se completa en integración de PR a `develop` (ver `flit-integration-ado`) |
| **Evidences** | `Custom.Evidences` | **No** | Se completa con evidencias de tests (unitarios / E2E) — **nunca** en Discussion |

### Prohibido al crear

- Poner Gherkin o criterios en `System.Description`.
- Poner la narrativa Como/quiero/para en `AcceptanceCriteria`.
- Escribir **cualquier texto** en `Custom.Commits` o `Custom.Evidences` (ni placeholders).
- Poner trazabilidad del agente en `Description` o `AcceptanceCriteria` (solo en **Discussion**).
- Enviar texto plano con `\n` en Description o AC — ADO usa HTML; usar `<br>` y `<p>`.

## Requisitos previos

1. Feature padre existente (idealmente `Active` o superior).
2. Capa: **FRONTEND** o **BACKEND**.
3. Identidad del usuario autenticado en Azure DevOps confirmada (para `AssignedTo` y trazabilidad — ver `flit-azure-devops`).

## Paso 1 — Borrador (solo 3 bloques + SP)

Utiliza estrictamente la plantilla [Plantilla historias de usuario](assets/user-story.template.md) 


## Paso 2 — Registro en ADO (API)

Los campos `System.Description` y `Microsoft.VSTS.Common.AcceptanceCriteria` **deben enviarse en HTML**. ADO no renderiza texto plano con `\n`; usar `<br>` para saltos de línea y `<pre>` para bloques de código Gherkin.

Un solo `POST $User%20Story` con JSON Patch (`ensure_ascii=False` / UTF-8). Fases e idempotencia: ver `flit-azure-devops`.

```json
[
  {
    "op": "add",
    "path": "/fields/System.Title",
    "value": "[FRONTEND] – Módulo – Verbo sustantivo"
  },
  {
    "op": "add",
    "path": "/fields/System.Description",
    "value": "<p><strong>Como</strong> &lt;rol&gt;,<br><strong>quiero</strong> &lt;acción&gt;,<br><strong>para</strong> &lt;beneficio&gt;.</p>"
  },
  {
    "op": "add",
    "path": "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
    "value": "<h3>AC1 — Escenario positivo</h3><pre>Given &lt;precondición&gt;\nWhen &lt;acción&gt;\nThen &lt;resultado&gt;</pre><h3>AC2 — Escenario negativo</h3><pre>Given &lt;precondición&gt;\nWhen &lt;acción&gt;\nThen &lt;resultado&gt;</pre>"
  },
  {
    "op": "add",
    "path": "/fields/Microsoft.VSTS.Scheduling.StoryPoints",
    "value": 2
  },
  {
    "op": "add",
    "path": "/fields/System.AssignedTo",
    "value": "email@dominio.com"
  },
  {
    "op": "add",
    "path": "/fields/System.Tags",
    "value": "adopcion-ia; DOR"
  },
  {
    "op": "add",
    "path": "/fields/Custom.Refinement",
    "value": true
  },
  {
    "op": "add",
    "path": "/fields/System.AreaPath",
    "value": "FLIT - FLITO"
  },
  {
    "op": "add",
    "path": "/fields/System.IterationPath",
    "value": "FLIT - FLITO\\<Sprint siguiente al activo>"
  },
  {
    "op": "add",
    "path": "/relations/-",
    "value": {
      "rel": "System.LinkTypes.Hierarchy-Reverse",
      "url": "{AZURE_ORG_URL}/{projectEncoded}/_apis/wit/workitems/{parentFeatureId}"
    }
  }
]
```

**No** incluir `Custom.Commits` ni `Custom.Evidences` en el `POST` ni en ningún `PATCH` de creación.

### Construcción del HTML para Description (TypeScript)

```typescript
const descriptionHtml =
  `<p><strong>Como</strong> ${rol},<br>` +
  `<strong>quiero</strong> ${accion},<br>` +
  `<strong>para</strong> ${beneficio}.</p>`;
```

### Construcción del HTML para Acceptance Criteria (TypeScript)

```typescript
const acBlocks = escenarios.map(
  ({ titulo, gherkin }, i) => `<h3>AC${i + 1} — ${titulo}</h3><pre>${gherkin}</pre>`,
);
if (notasTecnicas) acBlocks.push(`<p><em>Notas técnicas:</em> ${notasTecnicas}</p>`);
const acHtml = acBlocks.join("");
```

---

## Paso 3 — Discussion (trazabilidad)

Tras obtener el `id` del `POST`, enviar `PATCH` con:

```json
[{ "op": "add", "path": "/fields/System.History", "value": "<div>🤖 Acción registrada por @{Nombre-del-Agente} usando el skill <b>@flit-crear-hu</b> bajo la supervisión de <a href=\"mailto:{USER_REAL_EMAIL}\">{USER_REAL_NAME}</a> (Feature padre #{FEATURE_ID})</div>" }]
```

---

## Cuándo se llenan Commits y Evidences

| Campo | Momento |
|-------|---------|
| `Custom.Commits` | Integración de PR a `develop` — ver `flit-integration-ado` |
| `Custom.Evidences` | Al adjuntar evidencias de tests (unitarios / E2E) |

## Reglas

- Título: prefijo `[FRONTEND] –` o `[BACKEND] –` con guion largo `–`; incluir módulo y verbo+sustantivo.
- Description y AC siempre en **HTML** al enviar a ADO (`<p>`, `<br>`, `<h3>`, `<pre>`).
- Confirmar al usuario: ID, URL; campos Description y AC poblados; Commits/Evidences **vacíos**.
- Anti-duplicado: WIQL por título exacto antes de crear (ver `flit-azure-devops`).
- Plantilla de referencia: `.claude/skills/flit-crear-hu/assets/user-story.template.md`

## Checklist de salida

- [ ] Título con `–` (guion largo), módulo y verbo+sustantivo
- [ ] `System.Description` = HTML con Como / quiero / para
- [ ] `Microsoft.VSTS.Common.AcceptanceCriteria` = HTML con AC1/AC2/… en `<h3>` + `<pre>`
- [ ] `Custom.Refinement` = `true`
- [ ] `System.IterationPath` = Sprint siguiente al activo
- [ ] `Custom.Commits` y `Custom.Evidences` **sin tocar** (vacíos en ADO)
- [ ] `System.History` = comentario de trazabilidad HTML
- [ ] Hijo del Feature padre vinculado (`Hierarchy-Reverse`)
- [ ] WIQL anti-duplicado ejecutado antes del `POST`
