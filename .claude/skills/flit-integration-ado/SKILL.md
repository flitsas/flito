---
name: flit-integration-ado
description: |
  Registra PRs de GitHub (flitsas/flito) en Azure DevOps: Custom.Commits (HTML canónico), Discussion, hyperlinks; post-merge Deploy DEV/QA/PDN según rama.
  INVOCACIÓN OBLIGATORIA: cargar esta Skill Modo A en CADA PR de HU; Modo B en CADA merge (o tip de ráfaga). Discussion / comentario branded NO sustituyen Custom.Commits (anti-imitación).
  Tras Modo B con Deploy*=true → Agent devops-agent M1 (una vez por tip).
  Triggers — PR GitHub, Custom.Commits, Deploy DEV, Deploy QA, Deploy PDN, post-merge, Modo A, Modo B, flit-integration-ado, flit-modo-desarrollo-auto pasos 5 y 2b.
---

# flit-integration-ado — GitHub (código) + Azure DevOps (gestión)

**Contrato ADO:** `flit-azure-devops` (MCP servidor **`ado`**; ante fallo de MCP: detener, reintentar una vez a los pocos segundos y, si persiste, detener e informar — el fallback REST/`az` está **suspendido** desde 2026-08-21 salvo pedido explícito del humano).

**Repositorio de código:** GitHub `flitsas/flito` (`origin`). **Work items:** Azure DevOps Boards (proyecto `FLIT - FLITO`).

**GitHub:** servidor MCP `github` **primero** (`list_pull_requests`, `pull_request_read`, `create_pull_request`, `merge_pull_request`, `actions_*`). En esta máquina `gh` no es el CLI de GitHub (visor de ayuda): comprobar con `gh --version` antes de usarlo; si no es el CLI real, no usarlo. Donde este documento mencione `gh`, traducir a la herramienta MCP equivalente.

## CUÁNDO INVOCAR — HARD-STOP (hilo principal / modo auto)

| Disparador | Modo | Campo obligatorio |
|---|---|---|
| Justo después de `create_pull_request` de una HU | **Modo A** | `Custom.Commits` sección «PR abierta» (HTML) + Discussion breve + hyperlink si se puede |
| PR de HU **MERGED** a `develop` / `staging` / `release` | **Modo B** | Añadir «Integrado» en `Custom.Commits` **sin borrar** lo previo + `Deploy*` según rama |
| Ráfaga de merges | Modo B por PR (o consolidado al tip con evidencia de cada SHA) + **una** `devops-agent` M1 al tip | No omitir Commits «por presupuesto de tokens» |

**Cómo contar:** herramienta `Skill` con `skill: flit-integration-ado` y args `Modo A|B` + IDs de
PR/HU, **o** `Read` de este `SKILL.md` en el mismo turno + seguir plantillas HTML. El campo
`Custom.Commits` actualizado con el HTML canónico es la prueba de Modo A/B; Discussion es auxiliar.

**NO cuenta — imitación (anti-patrones graves):**
- Comentario Discussion branded («usando @flit-integration-ado») **sin** PATCH a `Custom.Commits`
- Solo un comentario «PR registrado» / «integrado» **sin** actualizar `Custom.Commits`
- Omitir Modo A/B «porque el campo ya pesa muchos KB» — si hay límite, **resumir** el HTML previo y concatenar; no abandonar el campo
- PATCH ADO / `wit_*` sueltos sin cargar esta skill ni las plantillas
- Dar por cerrado el post-merge sin invocar `devops-agent` M1 tras `Deploy*=true`
- Modo B solo en Discussion cuando `Custom.Commits` quedó vacío (caso #11500 — no repetir)

**Hard-gate antes de crear el PR:** aunque el humano diga «crea / abre el PR», el hilo principal **debe** evaluar y ejecutar los gates Pre-PR de `AGENTS.md` (`flit-code-review` siempre; `security-agent` / `db-review-agent` si el diff lo dispara) **antes** de `create_pull_request`. «Crea el PR» autoriza el paso final, no salta la matriz. Ver `.cursor/rules/pre-pr-gates.mdc`. Sin veredicto OK / OK-CON-OBSERVACIONES (y sin FAIL/críticos en security/db-review) → no abrir el PR.

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

**Prohibido:** cambiar `System.State` (Resolved/Active/Closed lo gestionan implementación y PO). **Prohibido:** `Deploy * = true` si el CI que valida la integración (ver Modo B §2) no está en verde.

**PRs sin work item (`CHORE/`, `DOCS/`):** única vía permitida sin HU/Bug, y solo para lo que **no es producto** (documentación, `.claude/`, `.cursor/`, tooling, CI, `scripts/`). Merge a `develop` con «sí» humano y checks verdes; **no** hay Modo A/B en ADO (no hay work item). Rama `CHORE/<dev>-<desc>` o `DOCS/<dev>-<desc>`, título `CHORE:` / `DOCS: <descripción>`. Si el diff toca `apps/**` o `packages/**` es desarrollo: exige HU o Bug y rama `HU/`/`BUG/` (lo bloquea el check CI `naming`).

---

## Modos de operación

### Modo A — Registro de PR (hilo principal — rol integración)

**Cuándo:** Tras crear el PR en GitHub (MCP `create_pull_request`, target `develop` por defecto). Solo aplica a PRs de **HU** con work item en ADO.

**Quién:** el hilo principal con esta skill (no frontend/backend-agent). **No existe un agente
`integration-agent` separado** — el rol integración lo asume el hilo principal.

**ADO (sin confirmación extra si va encadenado tras crear PR):**

1. `PATCH` `Custom.Commits` — bloque **«PR abierta»** en HTML (plantilla Modo A abajo). No dejar solo una línea de texto suelta: el HTML es el formato canónico al registrar.
2. `PATCH` `System.History` — una línea: PR #N registrada, enlace GitHub.
3. `PATCH` relación `Hyperlink` al PR (si no existe ya).

**No** marcar `DeployDEV` / `DeployQA` / `DeployPDN` en Modo A.

---

### Modo B — Confirmación post-merge (Líder Técnico / hilo principal)

**Cuándo:** Tras un merge a `develop` (agente bajo autorización o humano) o tras merge de promoción a `staging`/`release` (siempre humano); o cuando el Líder Técnico pide validar integración y confirmar Deploy. Solo PRs con HU en ADO.

**Invocación típica:** *«Valida si ya se integró el PR y actualiza Azure»* — **no** requiere segundo «sí» (solo verificación + PATCH ADO).

**Flujo:**

1. **GitHub (MCP):** `pull_request_read` method `get` — `state`, `merged_at`, merge SHA, `base.ref`, `head.ref`, `html_url`, diff stats.
   - Si no está `MERGED` → informar «PR aún no integrada» y **no** poner Deploy * en true.
2. **CI que valida la integración:** checks requeridos (`build + test`, `dependency-audit`, `secret-scan`, `naming`; `lint` si corre) en `success` (o `skipped` aceptable — `naming` solo corre en PRs, así que en el tip de `develop` aparece ausente, no rojo).
   - Caso normal: check-runs del **merge commit** del PR.
   - **Cadena apilada / merges en ráfaga:** el workflow CI usa `cancel-in-progress` por ref; los runs de merges intermedios a `develop` suelen quedar `cancelled`. El gate es el CI del **tip de `develop`** que ya contiene el merge (y el resto de la cadena), no exigir verde en cada SHA intermedio cancelado.
   - Si el tip (o el merge commit, en caso normal) tiene un check requerido en rojo → **bloquear** Deploy * = true; reportar URL del run fallido.
3. **ADO:** leer HU actual (`GET workitem`) — comprobar `System.State == Resolved`; si no, **avisar** al humano (no cambiar estado).
4. **ADO:** `PATCH` `Custom.Commits` — **añadir** bloque **«Integrado»** **sin borrar** el contenido previo (reemplazar campo con HTML concatenado: sección anterior + `<hr/>` + nueva sección).
5. **ADO:** según `baseRefName` del PR merged:

| `baseRefName` | Campo Deploy |
|---------------|--------------|
| `develop` | `Custom.DeployDEV` = `true` |
| `staging` | `Custom.DeployQA` = `true` |
| `release` | `Custom.DeployPDN` = `true` |

6. **ADO:** `System.History` — mensaje para desarrollador: PR integrada, rama destino, Deploy * activado, enlace PR.
7. **Post-Deploy (obligatorio tras Modo B exitoso):** invocar **`devops-agent` M1** sobre el ambiente
   correspondiente (`develop`→DEV, `staging`→QA, `release`→PDN). En ráfaga de merges, **una sola**
   M1 al tip tras el último Modo B — no una por PR. Si no hay acceso SSH/URL, reportar
   «devops M1 pendiente — sin acceso» y no inventar VERDE. Smoke/synthetic de PDN siguen
   requiriendo autorización humana (`AGENTS.md`).

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

**Regla de merge de contenido:** antes del PATCH Modo B, `GET` el valor actual de `Custom.Commits`.
- Si hay HTML Modo A (u otro contenido previo, aunque sea texto plano de una línea) → **conservarlo** y concatenar `<hr/>` + sección Integrado.
- Si estaba vacío → publicar solo la sección Integrado.
- No reescribir el historial previo «para dejarlo bonito»; el append es la operación.

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

Con MCP: `wit_work_item_write` (servidor **`ado`**). Con REST: `json.dumps(patch, ensure_ascii=False)` en Python o `JSON.stringify(patch)` + `charset=utf-8` en Node.

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

## GitHub — vía MCP (canónica)

| Operación | MCP `github` |
|-----------|----------------|
| Crear PR | `create_pull_request` (base `develop`; `title` = `HU <ID>: <descripción>` — ver `.cursor/rules/convenciones-rama-pr.mdc`) |
| Corregir título | `update_pull_request` (si el check `naming` lo marca) |
| Ver PR / merge SHA | `pull_request_read` method `get` |
| Checks del HEAD o merge | `pull_request_read` method `get_check_runs`; runs en rama: `actions_list` |
| Merge (sí textual / Feature) | `merge_pull_request` con `merge_method: merge` |

**Owner/repo:** `git remote get-url origin` → `flitsas/flito`.

**No usar `gh` como vía principal.** En esta máquina no es el CLI de GitHub. Solo si el usuario autoriza explícitamente otra vía *y* `gh --version` confirma el CLI real de GitHub (cli/cli), puede usarse como atajo puntual; MCP sigue siendo la vía canónica.

---

## Pre-condiciones merge (GitHub) — antes de ejecutar el merge

Aplican cuando el hilo principal (o el Líder Técnico) **ejecuta** el merge. El agente solo puede
mergear si **`baseRefName` es exactamente `develop`** y hay autorización del Feature (o «sí»
textual por ese PR). Merge a `staging`/`release` → siempre humano (`flit-release`). Ejecución vía
MCP `github` (`merge_pull_request`, merge commit).

| # | Condición | Verificación |
|---|-----------|----------------|
| 1 | PR `OPEN` | `state == OPEN` |
| 2 | Rama origen y título | Flujo HU/Bug: rama `HU/<ID>-<dev>-<desc>` o `BUG/<ID>-…` **y** título `HU <ID>: <descripción>` / `BUG <ID>: …` con el mismo ID (`.cursor/rules/convenciones-rama-pr.mdc`). Sin work item: solo `CHORE/` y `DOCS/` con «sí» humano y **sin** Modo A/B ADO |
| 3 | Target | Agente: **solo `develop`**. Humano/LT: también `staging` / `release` (promoción) |
| 4 | Autorización | «puedes mergear a develop este Feature» (sesión) **o** «sí» textual por este PR |
| 5 | CI build/test | check `build + test` → `success` |
| 6 | Security | checks `dependency-audit` y `secret-scan` → `success` |
| 6b | Convenciones | check `naming` → `success` (rama, título y trazabilidad HU/Bug). Título mal puesto: corregir con `update_pull_request` y esperar el re-run |
| 7 | Sin conflictos | mergeable / no conflict |
| 8 | HU en ADO (solo flujo HU/Bug) | `Custom.Refinement=true`, Story Points — `GET workitem`. Omitir en `CHORE/` y `DOCS/` |
| 9 | Diff ≤ 800 líneas | `additions + deletions` del PR (avisar si se excede; no bloquea solo) |
| 10 | HEAD con veredicto vigente | El HEAD a mergear == `SHA revisado` del veredicto de `flit-code-review`; commits post-veredicto (fixes, retrabajo QA) exigen re-review de la skill sobre el nuevo HEAD |
| 11 | Gate QA invocado (flujo HU/Bug con AC) | `qa-agent` modo B lanzado tras `Resolved` con HANDOFF ✅/PASS-CON-OBSERVACIONES/SIN-ENTORNO; nunca mergear con qa ❌ ni con FAIL sin retrabajo |

Si falla cualquiera → reportar número y **no** mergear. Tras merge a `develop` de una HU → Modo B (Deploy DEV). Docs/chore: merge listo; no tocar ADO.

---

## Matriz de responsabilidades (confirmada FLIT)

| Paso | Responsable por defecto |
|------|-------------------------|
| Implementar código | frontend-agent / backend-agent / humano |
| Crear PR en GitHub | **hilo principal** (rol integración) |
| Registrar PR en ADO (Modo A) | **hilo principal** (rol integración) |
| Ejecutar merge → `develop` | **hilo principal** (MCP github) tras autorización del Feature + precondiciones; o humano |
| Ejecutar merge → `staging` / `release` | **Siempre humano** (`flit-release`) |
| Verificar merge + Deploy * + Commits integrado (Modo B) | **hilo principal** o **Líder Técnico** |
| Smoke post-Deploy (M1) | **`devops-agent`** (hilo principal lo invoca tras Modo B) |
| Evidencias unitarias (`Custom.Evidences`) | rol de desarrollo / tester / **`qa-agent`** |
| Estado `Resolved` en HU | quien implementó (gestión HU) — el hilo principal **solo avisa** si falta |
| TCs y certificación funcional | **`qa-agent`** tras Resolved (matriz `AGENTS.md`) |

---

## Errores frecuentes

| Situación | Acción |
|-----------|--------|
| `Custom.Commits` 400 | Enviar JSON UTF-8 con `charset=utf-8`; con MCP usar `wit_work_item_write` |
| PR merged pero CI tip/merge rojo | No Deploy * = true; comentario en Discussion con enlace al run |
| Merges en cadena: CI intermedio `cancelled` | Esperado por concurrency; validar tip de `develop` (Modo B §2) |
| PR `CHORE/` / `DOCS/` sin HU | Merge con sí + CI verde; no Modo A/B. Si toca `apps/**` o `packages/**` → exigir HU/Bug y renombrar la rama |
| Check `naming` en rojo | Leer el motivo del run: título (corregir con `update_pull_request`) o rama (`git branch -m` + re-push, o cerrar y reabrir el PR desde la rama nueva) |
| Target `staging` pero usuario esperaba DEV | Explicar matriz develop→DEV, staging→QA, release→PDN |
| Duplicar Hyperlink PR | `GET` relations antes de `add` |

---

## Skills relacionadas

- `flit-azure-devops` — conexión MCP/REST, encoding y PATCH
- `flit-gestion-hu` — estado `Resolved` de la HU antes del Modo B
