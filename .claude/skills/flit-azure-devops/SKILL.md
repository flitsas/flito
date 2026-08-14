---
name: flit-azure-devops
description: Integración con Azure DevOps Boards para el proyecto FLIT - FLITO. Prioridad de conexión: MCP (servidor `ado`) → REST API (PAT, curl/Node) → borrador local .md. Invocar antes de crear, actualizar o consultar work items en ADO desde cualquier skill (flit-crear-hu, flit-gestion-hu, flit-integration-ado).
---

# Azure DevOps — MCP primero, REST después

Todas las skills que toquen Azure DevOps **deben** seguir este contrato. Entorno real: **Linux + bash**, monorepo Node/TypeScript. No hay Azure CLI ni PowerShell aquí; no los uses.

**Fuente de verdad del servidor MCP en Cursor:** id **`ado`** (regla `.cursor/rules/mcp-github-primero.mdc`).  
**Prohibido** invocar un servidor llamado `azure-devops` o tools `mcp__azure-devops__*` — ese nombre es legado y **no existe** en este runtime.

## Contexto del proyecto

| Dato | Valor |
|------|-------|
| Proyecto ADO (`System.TeamProject`) | `FLIT - FLITO` |
| Area Path | `FLIT - FLITO` |
| Iteration Path | `FLIT - FLITO\<Sprint>` |
| Servidor MCP (Cursor) | **`ado`** |
| Repo de código | GitHub `flitsas/flito` (`origin`) |

El nombre del proyecto lleva espacios: en URLs REST **codificarlo** (`encodeURIComponent` en Node, `--data-urlencode`/`jq -rR @uri` en bash).

## Identidad y credenciales

- **MCP `ado`** es la vía de acceso — ya viene autenticado por su configuración de servidor: **no** requiere PAT ni archivos de credenciales en el repo.
- **Trazabilidad** (nombre/email en comentarios HTML y menciones `mailto:`): la identidad del **usuario autenticado en Azure DevOps** — la cuenta con la que opera el MCP `ado` (la que figura como `CreatedBy` en cualquier escritura; búscala con `core_get_identity_ids` si necesitas su id). Si no está clara, pregúntala. **Nunca** uses un correo fijo por defecto.
- **REST fallback:** solo aplica si el usuario provee un PAT **en la sesión** (variable de entorno temporal, scope *Work Items Read & Write*). En este proyecto **no existe** archivo de credenciales local — no lo busques ni lo crees. **Nunca** imprimir ni commitear el PAT.

Variables de entorno para el fallback REST (las provee el usuario en la sesión):

| Variable | Uso |
|----------|-----|
| `AZURE_ORG_URL` | Base, ej. `https://dev.azure.com/<org>` |
| `AZURE_PROJECT_NAME` | `FLIT - FLITO` (exacto, con espacios) |
| `AZURE_PAT` | Personal Access Token (Work Items R/W) — solo en sesión, nunca en el repo |

## Estrategia de ejecución (obligatoria)

```
1. MCP (ado)            ← SIEMPRE primero — verificar conexión antes de usar
2. REST API (curl/Node) ← Solo si MCP no responde Y hay PAT disponible
3. Borrador .md local   ← Si MCP falla y no hay PAT
```

**Motivo MCP → REST:** el servidor MCP `ado` es la integración nativa del IDE, ya autenticada y sin gestión manual de PAT ni encoding. La REST API solo se usa como red de seguridad cuando MCP no está disponible (p. ej. ejecución headless/CI).

## Verificación de conexión MCP (paso obligatorio)

Antes de operar:

1. Descubrir schema: herramienta del runtime `GetMcpTools` con `server: "ado"` (o tool concreto).
2. Llamada de bajo impacto: `CallMcpTool` → `server: "ado"`, `toolName: "core_list_projects"`.

- **Devuelve la lista de proyectos** → MCP disponible; usar MCP en todos los pasos.
- **Error de auth / timeout / modo no soportado** → pasar a REST si hay PAT; si no, entregar borrador `.md`. **No** reintentar MCP en la misma sesión.
- Si `GetMcpTools` lista el servidor como `needsAuth` → pedir al humano autenticar MCP `ado` en Cursor; no inventar PAT.

### Cookbook MCP `ado` (nombres reales)

Las tools son **action-based** (un tool + `action`), no un tool por verbo. Antes de cada llamada, confirma el schema con `GetMcpTools`.

| Operación | MCP `ado` | Args típicos | Equivalente REST |
|-----------|-----------|--------------|------------------|
| Listar proyectos | `core_list_projects` | (opcional `projectNameFilter`) | `GET /_apis/projects` |
| Identidad | `core_get_identity_ids` | `searchFilter` | Identity API |
| Leer WI | `wit_work_item` | `action: "get"`, `id`, `project` | `GET .../workitems/{id}` |
| Leer lote | `wit_work_item` | `action: "get_batch"`, `ids` | `POST .../workitemsbatch` |
| Comentarios (leer) | `wit_work_item` | `action: "list_comments"`, `workItemId` | Comments API |
| WIQL / query | `wit_query` | `action: "wiql"`, `wiql`, `project` | `POST .../wiql` |
| Buscar WI (texto) | `search_workitem` | `searchText`, `project` | Search API |
| Crear WI | `wit_work_item_write` | `action: "create"`, `workItemType`, `fields[]` | `POST .../$Type` |
| Actualizar WI | `wit_work_item_write` | `action: "update"`, `id`, `updates[]` (`path`/`value`) | `PATCH .../workitems/{id}` |
| Batch update | `wit_work_item_write` | `action: "update_batch"`, `batchUpdates[]` | batch PATCH |
| Hijo bajo padre | `wit_work_item_write` | `action: "add_child"`, `parentId`, `items[]` | create + link |
| Comentario | `wit_work_item_comment_write` | `action: "add"`, `workItemId`, `text`, `format` | Comments API |
| Vincular WIs | `wit_work_item_link_write` | `action: "link"`, `updates[]` | relations PATCH |
| Link a PR | `wit_work_item_link_write` | `action: "link_to_pull_request"` | artifact link |

**Aliases legacy (NO usar como toolName):** `wit_create_work_item`, `wit_update_work_item`, `wit_get_work_item`, `wit_query_by_wiql`, `wit_add_work_item_comment`, `wit_work_items_link`, `mcp__azure-devops__*`.

> Con MCP activo, usar **siempre** `CallMcpTool` con `server: "ado"`; no mezclar MCP y REST en la misma operación.

### Ejemplo — leer HU

```
CallMcpTool
  server: ado
  toolName: wit_work_item
  arguments: { "action": "get", "project": "FLIT - FLITO", "id": 11499, "expand": "Relations" }
```

### Ejemplo — actualizar estado / Custom.Commits

```
CallMcpTool
  server: ado
  toolName: wit_work_item_write
  arguments: {
    "action": "update",
    "project": "FLIT - FLITO",
    "id": 11499,
    "updates": [
      { "op": "add", "path": "/fields/System.State", "value": "Active" }
    ]
  }
```

Para campos HTML largos (`Custom.Commits`, Description, AC): preferir `updates` con el HTML completo. Si el schema tipa `value` como string, enviar el HTML como string (no como objeto).

### Ejemplo — comentario Discussion

```
CallMcpTool
  server: ado
  toolName: wit_work_item_comment_write
  arguments: {
    "action": "add",
    "project": "FLIT - FLITO",
    "workItemId": 11499,
    "text": "<div>…</div>",
    "format": "Html"
  }
```

## Idempotencia al crear work items (obligatorio)

**Regla:** nunca repetir la creación sin verificar si el ítem ya existe. Un fallo en pasos posteriores (historial, asignación, vínculo padre) **no** autoriza una segunda creación.

### Flujo en 3 fases (separar try/catch)

```
Fase A — crear          → guardar workItemId de la respuesta
Fase B — campos         → descripción, tags, AssignedTo (reintentar solo esto)
Fase C — History        → comentario de trazabilidad (reintentar solo esto)
```

- **Prohibido:** un solo `try/catch` que envuelva A+B+C y, al fallar, vuelva a crear.
- Si B o C fallan: consultar el ítem por `id` y continuar desde la fase que faltó; **no** crear otro.

### Antes de crear — anti-duplicado (WIQL, recomendado)

Buscar duplicado reciente por título exacto (evita doble clic humano + reintentos ciegos):

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = 'FLIT - FLITO'
  AND [System.WorkItemType] = 'User Story'
  AND [System.Title] = @title
  AND [System.State] <> 'Removed'
ORDER BY [System.CreatedDate] DESC
```

Invocar con `wit_query` + `action: "wiql"`.

- **Exactamente 1** resultado → usar ese `id` (Fase B/C); **no** crear.
- **0** → crear.
- **>1** → detener e informar al usuario con la lista de IDs.

### Si la creación falla o es ambigua

1. **Tienes `id`** (aunque el script crashee después) → tratar como creado; ir a Fase B/C.
2. **Error de red sin `id`** → WIQL por título (últimas 24 h).
3. **WIQL encuentra candidato** → consultar y confirmar título; reutilizar `id`.
4. **WIQL no encuentra nada** → un solo reintento de creación (máximo **1** por sesión).

### Node — persistir id en cuanto exista

```typescript
const created = await createWorkItem(patch);
const workItemId = created.id;                 // guardar ANTES de History / AssignedTo
await patchWorkItem(workItemId, historyPatch); // fallo aquí → reintentar solo esto
```

## Encoding — regla obligatoria (tildes y caracteres especiales)

Todos los cuerpos JSON enviados a ADO **deben** preservar UTF-8 sin escaparlo a `\uXXXX`; si no, ADO renderiza mal las tildes.

| Lenguaje | MAL | BIEN |
|----------|-----|------|
| **Node** | — (no escapa UTF-8 por defecto) | `JSON.stringify(patch)` + header `charset=utf-8` |
| **Python** | `json.dumps(patch)` | `json.dumps(patch, ensure_ascii=False)` |
| **bash/curl** | `--data "$json"` con locale ASCII | `--data-binary @body.json` (archivo UTF-8) |

El header debe incluir el charset:

```
Content-Type: application/json-patch+json; charset=utf-8
```

### HTML dentro de campos

ADO ignora/escapa HTML con comillas dobles `"` no escapadas dentro del string JSON. Usa `&quot;` o comillas simples para atributos HTML en la descripción.

### Tags (`System.Tags`)

Un tag **nuevo** en `System.Tags` va en **petición aparte** — mezclarlo con otros campos puede fallar con `TF401289` y tumbar el patch completo (`AGENTS.md`).

---

## Fallback nivel 2 — REST API (solo con PAT)

### Autenticación

- Header: `Authorization: Basic <base64(:PAT)>`
- `Content-Type: application/json-patch+json; charset=utf-8`
- `api-version=7.1`

### URLs

- Codificar el proyecto (`FLIT - FLITO` → `FLIT%20-%20FLITO`).
- Crear: `POST {AZURE_ORG_URL}/{projectEncoded}/_apis/wit/workitems/$User%20Story?api-version=7.1` (cambiar `$User%20Story` por `$Feature`, `$Bug`, etc.)
- Actualizar: `PATCH {AZURE_ORG_URL}/{projectEncoded}/_apis/wit/workitems/{id}?api-version=7.1`
- Consultar: `GET` misma URL sin tipo.

### JSON Patch (ejemplos)

**Crear User Story:**

```json
[
  { "op": "add", "path": "/fields/System.Title", "value": "[BACKEND] – Módulo – Verbo sustantivo" },
  { "op": "add", "path": "/fields/System.Description", "value": "<p>...</p>" },
  { "op": "add", "path": "/fields/System.AreaPath", "value": "FLIT - FLITO" },
  { "op": "add", "path": "/fields/System.AssignedTo", "value": "usuario@flitsas.io" },
  { "op": "add", "path": "/fields/System.Tags", "value": "DOR; adopcion-ia" }
]
```

**Comentario de trazabilidad** (`System.History` → módulo **Discussion**):

```json
[{ "op": "add", "path": "/fields/System.History", "value": "<div>🤖 Acción registrada por @Agente ...</div>" }]
```

**Evidencias de tests** (`Custom.Evidences` → módulo **Evidences**): las tablas deben llevar `style` inline con `border:1px solid #cccccc` en **cada** `<th>` y `<td>` (ADO elimina `border="1"` del `<table>`). No intercambiar destinos: Discussion ≠ Evidences.

**Vínculo padre–hijo:**

```json
[{
  "op": "add",
  "path": "/relations/-",
  "value": {
    "rel": "System.LinkTypes.Hierarchy-Reverse",
    "url": "{AZURE_ORG_URL}/{projectEncoded}/_apis/wit/workitems/{parentId}"
  }
}]
```

### bash / curl (referencia)

```bash
# El PAT lo provee el usuario en la sesión (AZURE_PAT en el entorno) — no hay
# archivo de credenciales en el repo. Nunca imprimirlo.
auth=$(printf ':%s' "$AZURE_PAT" | base64 -w0)
projectEncoded=$(jq -rn --arg p "$AZURE_PROJECT_NAME" '$p|@uri')

curl -sS -X POST \
  "$AZURE_ORG_URL/$projectEncoded/_apis/wit/workitems/\$User%20Story?api-version=7.1" \
  -H "Authorization: Basic $auth" \
  -H "Content-Type: application/json-patch+json; charset=utf-8" \
  --data-binary @patch-create.json          # archivo UTF-8, preserva tildes
```

### Node / fetch (referencia)

```typescript
const auth = Buffer.from(`:${pat}`).toString("base64");
const projectEncoded = encodeURIComponent(project); // "FLIT - FLITO"
await fetch(`${org}/${projectEncoded}/_apis/wit/workitems/$User%20Story?api-version=7.1`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json-patch+json; charset=utf-8",
  },
  body: JSON.stringify(patch), // Node no escapa UTF-8; el charset garantiza el render
});
```

## Fallback nivel 3 — borrador local `.md`

Si MCP falla y no hay PAT: entregar un `.md` con el work item redactado (título, campos, HTML) para que un humano lo cargue. **No** intentar Azure CLI.

## Tags FLIT por defecto

- Features: `DOR; adopcion-ia; fase-1-diseño`
- User Stories: `DOR; adopcion-ia`

## Skills que dependen de este contrato

- `flit-crear-hu` — crear User Stories
- `flit-gestion-hu` — ciclo Active → Resolved
- `flit-integration-ado` — Commits / Deploy tras PR

Al implementar o modificar cualquiera de ellas, **enlazar** `flit-azure-devops` y no duplicar la lógica de autenticación/encoding. Si el schema MCP cambia, actualizar **este** archivo primero; las skills hijas solo nombran operaciones, no inventan toolNames.
