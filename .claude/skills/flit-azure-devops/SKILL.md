---
name: flit-azure-devops
description: Integración con Azure DevOps Boards para el proyecto FLIT - FLITO. Prioridad de conexión: MCP (servidor `azure-devops`) → REST API (PAT, curl/Node) → borrador local .md. Invocar antes de crear, actualizar o consultar work items en ADO desde cualquier skill (flit-crear-hu, flit-gestion-hu, flit-integration-ado).
---

# Azure DevOps — MCP primero, REST después

Todas las skills que toquen Azure DevOps **deben** seguir este contrato. Entorno real: **Linux + bash**, monorepo Node/TypeScript (`operaciones-system`). No hay Azure CLI ni PowerShell aquí; no los uses.

## Contexto del proyecto

| Dato | Valor |
|------|-------|
| Proyecto ADO (`System.TeamProject`) | `FLIT - FLITO` |
| Area Path | `FLIT - FLITO` |
| Iteration Path | `FLIT - FLITO\<Sprint>` |
| Servidor MCP | `azure-devops` (habilitado en `.claude/settings.local.json`) |
| Repo de código | GitHub `flitsas/flito` (`origin`) |

El nombre del proyecto lleva espacios: en URLs REST **codificarlo** (`encodeURIComponent` en Node, `--data-urlencode`/`jq -rR @uri` en bash).

## Identidad y credenciales

- **MCP `azure-devops`** ya viene autenticado por su configuración de servidor: **no** requiere PAT en el repo para las operaciones normales.
- **Trazabilidad** (nombre/email en comentarios HTML): usar el usuario supervisor (por defecto `admin@flitsas.io`). Si necesitas otro, pídelo.
- **REST fallback** requiere un PAT (scope *Work Items Read & Write*). Léelo de `.env.user-identity` en la raíz **si existe**; hoy ese archivo **no está** en el repo, así que el fallback REST solo aplica cuando alguien lo provee. **Nunca** imprimir ni commitear el PAT.

Variables opcionales de `.env.user-identity` (solo para el fallback REST):

| Variable | Uso |
|----------|-----|
| `USER_REAL_NAME` / `USER_REAL_EMAIL` | Trazabilidad y menciones `mailto:` |
| `AZURE_ORG_URL` | Base, ej. `https://dev.azure.com/<org>` |
| `AZURE_PROJECT_NAME` | `FLIT - FLITO` (exacto, con espacios) |
| `AZURE_PAT` | Personal Access Token (Work Items R/W) |

## Estrategia de ejecución (obligatoria)

```
1. MCP (azure-devops)   ← SIEMPRE primero — verificar conexión antes de usar
2. REST API (curl/Node) ← Solo si MCP no responde Y hay PAT disponible
3. Borrador .md local   ← Si MCP falla y no hay PAT
```

**Motivo MCP → REST:** el servidor MCP `azure-devops` es la integración nativa del IDE, ya autenticada y sin gestión manual de PAT ni encoding. La REST API solo se usa como red de seguridad cuando MCP no está disponible (p. ej. ejecución headless/CI, donde el MCP interactivo puede no autenticar).

## Verificación de conexión MCP (paso obligatorio)

Antes de operar con MCP, **verificar** que el servidor responde con una llamada de bajo impacto:

```
mcp__azure-devops__core_list_projects  (sin argumentos)
```

- **Devuelve la lista de proyectos** → MCP disponible; usar MCP en todos los pasos.
- **Error de auth / timeout / modo no soportado (p. ej. `AADSTS70007` en headless)** → pasar a REST si hay PAT; si no, entregar borrador `.md`. **No** reintentar MCP en la misma sesión.

### Equivalencia MCP ↔ REST

Las herramientas del servidor `azure-devops` mapean directamente sobre los endpoints REST:

| Operación | Herramienta MCP | Equivalente REST |
|-----------|-----------------|------------------|
| Crear work item | `mcp__azure-devops__wit_create_work_item` | `POST /_apis/wit/workitems/$Type` |
| Actualizar work item | `mcp__azure-devops__wit_update_work_item` | `PATCH /_apis/wit/workitems/{id}` |
| Consultar por ID | `mcp__azure-devops__wit_get_work_item` | `GET /_apis/wit/workitems/{id}` |
| Consultar lote | `mcp__azure-devops__wit_get_work_items_batch_by_ids` | `POST /_apis/wit/workitemsbatch` |
| WIQL (buscar duplicados) | `mcp__azure-devops__wit_query_by_wiql` | `POST /_apis/wit/wiql` |
| Agregar comentario | `mcp__azure-devops__wit_add_work_item_comment` | `POST /_apis/wit/workitems/{id}/comments` |
| Vincular ítems | `mcp__azure-devops__wit_work_items_link` | `PATCH /_apis/wit/workitems/{id}` (relations) |
| Listar proyectos | `mcp__azure-devops__core_list_projects` | `GET /_apis/projects` |

> Con MCP activo, usar **siempre** las herramientas MCP; no mezclar MCP y REST en la misma operación.

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

Todos los cuerpos JSON enviados a ADO **deben** preservar UTF-8 sin escaparlo a `\uXXXX`; si no, ADO renderiza `é` en vez de `é`.

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
# Cargar PAT desde .env.user-identity (si existe) — nunca imprimirlo
set -a; source .env.user-identity; set +a

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

Al implementar o modificar cualquiera de ellas, **enlazar** `flit-azure-devops` y no duplicar la lógica de autenticación/encoding.
