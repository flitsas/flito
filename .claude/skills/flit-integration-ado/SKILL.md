---
name: flit-integration-ado
description: Registra PRs de GitHub (repo flitsas/flito) en Azure DevOps (Custom.Commits, Discussion, hyperlinks) y confirma post-merge con Deploy DEV/QA/PDN según rama destino (develop/staging/release). Modo A al abrir PR; Modo B tras merge (rol Líder Técnico). Triggers PR GitHub, Custom.Commits, Deploy DEV, Deploy QA, Deploy PDN, post-merge, flit-integration-ado.
---

# flit-integration-ado — GitHub (código) + Azure DevOps (gestión)

**Contrato ADO:** `flit-azure-devops` (MCP `azure-devops` primero; REST con UTF-8 como fallback).

**Repositorio de código:** GitHub `flitsas/flito` (`origin`). **Work items:** Azure DevOps Boards (proyecto `FLIT - FLITO`).

**GitHub:** usar el CLI `gh` como vía principal (más simple para PR/checks); el servidor MCP `github` está disponible como alternativa.

---

## Campos ADO (canónicos)

| UI (módulo) | API | Quién escribe | Cuándo |
|-------------|-----|---------------|--------|
| **Commits** | `Custom.Commits` | hilo principal (rol integración) / Líder Técnico | Modo A (PR abierta) y Modo B (post-merge) |
| **Evidences** | `Custom.Evidences` | rol Dev / QA (evidencias de tests) | **Nunca** en esta skill |
| **Deploy DEV** | `Custom.DeployDEV` | Modo B | PR **MERGED** → target `develop` |
| **Deploy QA** | `Custom.DeployQA` | Modo B | PR **MERGED** → target `staging` |
| **Deploy PDN** | `Custom.DeployPDN` | Modo B | PR **MERGED** → target `release` |
| **Discussion** | `System.History` | Modo A y B | Comentario HTML breve (no duplicar el HTML largo de Commits) |

**Prohibido:** cambiar `System.State` (Resolved/Active/Closed lo gestionan implementación y PO). **Prohibido:** `Deploy * = true` si CI del merge commit no está en verde.

---

## Modos de operación

### Modo A — Registro de PR (hilo principal — rol integración)

**Cuándo:** Tras crear el PR en GitHub (`gh pr create`, target `develop` por defecto).

**Quién:** el hilo principal con esta skill (no frontend/backend-agent). **No existe un agente
`integration-agent` separado** — el rol integración lo asume el hilo principal.

**ADO (sin confirmación extra si va encadenado tras crear PR):**

1. `PATCH` `Custom.Commits` — bloque **«PR abierta»** (ver plantilla).
2. `PATCH` `System.History` — una línea: PR #N registrada, enlace GitHub.
3. `PATCH` relación `Hyperlink` al PR (si no existe ya).

**No** marcar `DeployDEV` / `DeployQA` / `DeployPDN` en Modo A.

---

### Modo B — Confirmación post-merge (Líder Técnico / hilo principal)

**Cuándo:** El usuario (típicamente **Líder Técnico**) pide validar integración y confirmar despliegue al desarrollador; o tras merge humano en GitHub UI.

**Invocación típica:** *«Valida si ya se integró el PR y actualiza Azure»* — **no** requiere segundo «sí» (solo verificación + PATCH ADO).

**Flujo:**

1. **GitHub:** `gh pr view <N> --json state,mergedAt,mergeCommit,baseRefName,headRefName,url,additions,deletions,changedFiles`
   - Si `state != MERGED` → informar «PR aún no integrada» y **no** poner Deploy * en true.
2. **CI del merge commit:** `gh api repos/{owner}/{repo}/commits/{merge_sha}/check-runs` — todos los checks requeridos en `success` (o `skipped` aceptable según política del repo).
   - Si algún check requerido falla → **bloquear** Deploy * = true; reportar URL del run fallido.
3. **ADO:** leer HU actual (`GET workitem`) — comprobar `System.State == Resolved`; si no, **avisar** al humano (no cambiar estado).
4. **ADO:** `PATCH` `Custom.Commits` — **añadir** bloque **«Integrado»** **sin borrar** el bloque «PR abierta» (reemplazar campo con HTML concatenado: sección anterior + `<hr/>` + nueva sección).
5. **ADO:** según `baseRefName` del PR merged:

| `baseRefName` | Campo Deploy |
|---------------|--------------|
| `develop` | `Custom.DeployDEV` = `true` |
| `staging` | `Custom.DeployQA` = `true` |
| `release` | `Custom.DeployPDN` = `true` |

6. **ADO:** `System.History` — mensaje para desarrollador: PR integrada, rama destino, Deploy * activado, enlace PR.

**Quién ejecuta Modo B:** hilo principal o **Líder Técnico** (mismo contrato).

---

## Plantilla HTML — `Custom.Commits`

Usar tablas con `style="border:1px solid #cccccc;padding:6px 8px"` en **cada** `<th>` y `<td>`.

### Sección Modo A — PR abierta

```html
<h2>Evidencia Pull Request — HU #{hu_id}</h2>
<p><strong>Estado:</strong> Abierta (pendiente merge)</p>
<p><strong>Registrado:</strong> {YYYY-MM-DD HH:MM}</p>
<h3>Pull Request GitHub</h3>
<table style="border-collapse:collapse;width:100%">
  <!-- filas: PR URL, Estado, Rama origen, Rama destino, Diff (archivos, +/− líneas) -->
</table>
<h3>Commits en el PR</h3>
<table><!-- SHA corto | mensaje --></table>
<h3>Archivos modificados</h3>
<ul><li><code>ruta</code></li></ul>
<h3>Checks CI (última ejecución en PR)</h3>
<table><!-- Check | Resultado --></table>
```

### Sección Modo B — Integrado (append)

```html
<hr/>
<h2>Integración confirmada — HU #{hu_id}</h2>
<p><strong>Estado PR:</strong> MERGED</p>
<p><strong>Fecha merge:</strong> {mergedAt}</p>
<p><strong>Confirmado por:</strong> {USER_REAL_NAME} (Líder Técnico / hilo principal)</p>
<h3>Merge en GitHub</h3>
<table>
  <!-- Merge commit SHA, baseRefName, enlace a rama destino en repo -->
</table>
<h3>Checks CI (merge commit)</h3>
<table><!-- todos success antes de Deploy * = true --></table>
<h3>Despliegue ADO</h3>
<p><strong>{DeployDEV|DeployQA|DeployPDN}:</strong> <code>true</code> — integrado en <code>{baseRefName}</code>.</p>
```

**Regla de merge de contenido:** antes del PATCH Modo B, `GET` el valor actual de `Custom.Commits`. Si ya existe HTML Modo A, **conservarlo** y concatenar la sección Integrado. Si estaba vacío, publicar solo la sección Integrado.

---

## Plantilla — Discussion (`System.History`)

**Modo A:**

```html
<div>🔗 [@{actor}] PR <a href="{pr_url}">#{pr_number}</a> registrada en <b>Commits</b> (HU #{hu_id}). Target: <code>{baseRefName}</code>.</div>
```

**Modo B:**

```html
<div>✅ [@{actor}] PR <a href="{pr_url}">#{pr_number}</a> <b>MERGED</b> en <code>{baseRefName}</code>. <b>Deploy {DEV|QA|PDN}</b> = true. Confirmación de despliegue para el equipo de desarrollo.</div>
```

Menciones con `<a href="mailto:{email}">@{nombre}</a>`.

---

## JSON Patch (referencia)

**Modo A — Commits (add o replace si vacío):**

```json
[{ "op": "add", "path": "/fields/Custom.Commits", "value": "<html Modo A>" }]
```

**Modo B — Commits (replace con HTML concatenado):**

```json
[{ "op": "replace", "path": "/fields/Custom.Commits", "value": "<html Modo A + Modo B>" }]
```

**Modo B — Deploy (solo si MERGED + CI verde):**

```json
[{ "op": "replace", "path": "/fields/Custom.DeployDEV", "value": true }]
```

(usar `Custom.DeployQA` o `Custom.DeployPDN` según tabla de ramas).

Con MCP: `mcp__azure-devops__wit_update_work_item`. Con REST: `json.dumps(patch, ensure_ascii=False)` en Python o `JSON.stringify(patch)` + `charset=utf-8` en Node.

**Hyperlink PR:**

```json
[{
  "op": "add",
  "path": "/relations/-",
  "value": {
    "rel": "Hyperlink",
    "url": "https://github.com/{org}/{repo}/pull/{n}",
    "attributes": { "comment": "PR #{n} — HU #{hu_id}" }
  }
}]
```

---

## GitHub — comandos

```bash
# Crear PR (hilo principal, target develop por defecto)
gh pr create --base develop --head <branch> --title "HU{id}: ..." --body-file pr-body.md

# Modo B — estado
gh pr view <N> --repo <owner/repo> --json state,mergedAt,mergeCommit,baseRefName,headRefName,url,commits,additions,deletions,changedFiles

# Checks del merge commit
gh pr checks <N> --repo <owner/repo>
gh api repos/<owner>/<repo>/commits/<merge_sha>/check-runs --jq '.check_runs[] | {name, conclusion}'

# Merge (solo con "sí" textual — humano o Líder Técnico)
gh pr merge <N> --merge   # o --squash según estrategia acordada
```

**Detección owner/repo:** `git remote get-url origin` o `gh repo view --json nameWithOwner`.

---

## Pre-condiciones merge (GitHub) — antes de ejecutar `gh pr merge`

Aplican solo si el Líder Técnico **ejecuta** el merge con `gh` (con «sí» textual). **No** aplican en Modo B de solo verificación.

| # | Condición | Verificación GitHub |
|---|-----------|------------------------|
| 1 | PR `OPEN` | `state == OPEN` |
| 2 | Rama origen válida | `feat/flito-*` (convención del repo) **o** `feat/*` / `fix/*` |
| 3 | Target permitido | `develop` (flujo HU) / `staging` / `release` (promoción LT) |
| 4 | ≥1 aprobación humana | `gh pr view --json reviews` |
| 5 | CI build/test | check `build + test` → `success` |
| 6 | Security | checks `dependency-audit` y `secret-scan` (jobs de `ci.yml`) → `success` |
| 7 | 0 threads sin resolver | `gh pr view --json reviewThreads` o UI |
| 8 | HU en ADO: `Custom.Refinement=true`, Story Points | `GET workitem` |
| 9 | Diff ≤ 800 líneas | `additions + deletions` del PR |

Si falla una → reportar número y **no** mergear.

---

## Matriz de responsabilidades (confirmada FLIT)

| Paso | Responsable por defecto |
|------|-------------------------|
| Implementar código | frontend-agent / backend-agent / humano |
| Crear PR en GitHub | **hilo principal** (rol integración) |
| Registrar PR en ADO (Modo A) | **hilo principal** (rol integración) |
| Ejecutar merge | **Humano** (GitHub UI) **o** **Líder Técnico** con `gh pr merge` tras «sí» textual |
| Verificar merge + Deploy * + Commits integrado (Modo B) | **hilo principal** o **Líder Técnico** |
| Evidencias unitarias (`Custom.Evidences`) | rol de desarrollo / tester |
| Estado `Resolved` en HU | quien implementó (gestión HU) — el hilo principal **solo avisa** si falta |

---

## Errores frecuentes

| Situación | Acción |
|-----------|--------|
| `Custom.Commits` 400 | Enviar JSON UTF-8 con `charset=utf-8`; con MCP usar `wit_update_work_item` |
| PR merged pero CI rojo | No Deploy * = true; comentario en Discussion con enlace al run |
| Target `staging` pero usuario esperaba DEV | Explicar matriz develop→DEV, staging→QA, release→PDN |
| Duplicar Hyperlink PR | `GET` relations antes de `add` |

---

## Skills relacionadas

- `flit-azure-devops` — conexión MCP/REST, encoding y PATCH
- `flit-gestion-hu` — estado `Resolved` de la HU antes del Modo B
