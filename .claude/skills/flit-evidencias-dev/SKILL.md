---
name: flit-evidencias-dev
description: |
  Sesión conjunta (humano + hilo) de pruebas del Feature en DEV y carga de evidencias
  (capturas del flujo) en el Feature de Azure DevOps. Se dispara tras DeployDEV + M1
  o como hard-stop antes de flit-release. Sin evidencias completas del Feature NO se
  promueve a QA. Herramientas: Claude in Chrome + Playwright.
  Triggers — evidencias DEV, pruebas en DEV, capturas Feature, adjuntar screenshots,
  flit-evidencias-dev, post-DeployDEV, antes de promover a QA.
---

# flit-evidencias-dev — pruebas conjuntas en DEV y evidencias en el Feature

**No sustituye** al `qa-agent` B (ese es pre-PR, tests automáticos). **No menciona** al QA
humano: Daniel Amado se etiqueta **solo** al promover a `staging` (`flit-gestion-hu` Paso 3).

**Dónde se guarda:** el **Feature** (donde se evalúan las historias), campo
`Custom.Evidences` + adjuntos (capturas). **No** en Discussion. **No** en cada HU como
destino principal (se puede enlazar desde la HU hacia el Feature).

**Contrato ADO:** `flit-azure-devops` (MCP `ado`). Identidad QA canónica (solo para
referencia; **no** se menciona en esta skill): Daniel Amado · `daniel.amado@flitsas.com`.

## CUÁNDO INVOCAR — HARD-STOP

| Disparador | Acción |
|---|---|
| Tras `flit-integration-ado` Modo B (`DeployDEV=true`) + `devops-agent` M1 **al tip** de la ráfaga del Feature | **Invocar esta skill** — sesión conjunta de las HUs/Bugs que acaban de quedar en DEV |
| Tras el DeployDEV de una HU suelta (no hay más eslabones) | **Invocar** para esa HU y appendear al Feature |
| Humano pide promover a QA / `flit-release` Modo A | **Verificar** evidencias del Feature. Si faltan → **esta skill primero**. Sin `COMPLETO` → **NO-GO** de promoción |
| Feature BACKEND-only (sin UI) | Invocar igual: evidencia = captura del contrato/respuesta en DEV o del consumidor, no un «N/A» silencioso |

**Cómo contar:** `Read` de este `SKILL.md` en el mismo turno **y** sesión conjunta con
capturas + PATCH a `Custom.Evidences` del Feature. Un comentario «probamos en DEV» **sin**
capturas en el Feature **no cuenta**.

**NO cuenta — imitación:**
- Pegar el stdout de Vitest / `qa-agent` B como «evidencia DEV»
- Un `curl /api/health` o el HANDOFF M1 presentados como prueba de flujo
- Evidencia solo en la HU y el Feature vacío
- Promover a QA «y las capturas las subimos después»
- Recorrer el flujo **sin** el humano de la sesión

## Relación con el resto del ciclo

```
merge develop → Modo B DeployDEV → M1 DEV
  → ESTA SKILL (sesión conjunta + evidencias en el Feature)
  → … (siguientes HUs si la ráfaga sigue; se appendea)
  → flit-release (bloquea si el Feature no está COMPLETO)
  → merge staging → DeployQA → flit-gestion-hu Paso 3 (tag QA + @Daniel Amado + Resolved)
```

Espera al humano aquí **sí es gate** (como el merge a `staging`). El anti-estancamiento
de `flit-modo-desarrollo-auto` **no** aplica: no se pide «continúa» por CI; se invita a
probar **ahora** y se para la promoción hasta tener `COMPLETO`.

En cadena apilada se puede **seguir codeando** la siguiente HU **mientras** el humano
aún no se sentó a probar. **No** se puede abrir el PR de promoción.

## Ambiente y herramientas

| Qué | Valor |
|---|---|
| Ambiente | **DEV** — `https://dev.operaciones.flitsas.online` (API `https://api.dev.operaciones.flitsas.online`) |
| Herramienta 1 | **Claude in Chrome** (o el browser del runtime): recorrer el flujo como un operador, con el humano en la sesión |
| Herramienta 2 | **Playwright**: capturas (`page.screenshot` / `toHaveScreenshot`) de cada paso del flujo en DEV. Specs de `e2e/tests/` si ya existen; si no, script puntual **sin** commitearlo salvo que el humano lo pida |
| Destino ADO | Feature `Custom.Evidences` (HTML) + adjuntos PNG/WebP en el **Feature** |

Prohibido probar el flujo de esta skill en `staging` / PDN. Prohibido commitear capturas
al repo (`test-results/` y `playwright-report/` ya están en `.gitignore`).

## Paso 1 — Alcance del Feature

1. Leer el Feature (`wit_work_item` `get`, `expand: Relations`) y sus hijos (WIQL
   `[System.Parent] = <FID>`).
2. Listar HUs/Bugs con `Custom.DeployDEV = true` que **aún no** tienen fila de evidencia
   en el Feature (o cuya evidencia quedó obsoleta: SHA de `develop` distinto).
3. Si no queda ninguna pendiente → veredicto `COMPLETO` (no rehacer).
4. Presentar al humano el plan de sesión (una línea por HU: flujo, URL, AC o repro).
   **Parar** hasta que el humano diga que empieza (o «ahora»).

## Paso 2 — Sesión conjunta (humano + hilo)

Para **cada** HU/Bug pendiente, en DEV:

1. El humano guía o confirma cada paso (login, pantalla, acción, resultado esperado).
2. El hilo conduce Claude in Chrome y/o Playwright sobre la URL de DEV.
3. **Captura obligatoria** de: estado inicial → acción → resultado (mínimo 1 por AC
   visible; en BACKEND-only, 1 captura de la respuesta/contrato en DEV).
4. El humano declara **pass / fail** de ese flujo. Fail → no se marca la HU como
   evidenciada; se corrige en su rama (`backend-agent` / `frontend-agent`) **antes**
   de seguir a QA. No se radica Bug (P9) salvo que el QA humano lo pida después.
5. Nombrar cada archivo: `feature-<FID>-hu-<ID>-<paso>-<YYYYMMDD>.png`.

Sin captura del flujo **no** hay evidencia de esa HU, aunque el humano diga «sí, funciona».

## Paso 3 — Subir al Feature

1. `GET` el Feature: valor actual de `Custom.Evidences` y tags.
2. **Append** (nunca borrar lo previo) un bloque HTML por sesión (plantilla abajo).
3. Adjuntar las capturas al Feature:
   - **Vía 1 (preferida en sesión):** el humano las sube en ADO (Feature → Attachments)
     y el hilo las nombra en el HTML.
   - **Vía 2:** si hay `AZURE_PAT` en la sesión, subir con la Attachments REST de ADO
     (`POST …/_apis/wit/attachments` + `PATCH` relación `AttachedFile`) — **excepción
     autorizada** al fallback REST suspendido, **solo** para binarios de esta skill
     (MCP `ado` no tiene upload).
   - MCP `wit_work_item_attachment` **solo descarga**; no sirve para subir.
4. Si el tipo Feature rechaza `Custom.Evidences`: HTML en Discussion del Feature **y**
   declararlo. Nunca descartar las capturas.
5. Comentario breve en el Feature (Discussion), **sin** mencionar a Daniel Amado:

```html
<div>📸 [@{actor}] usando <b>@flit-evidencias-dev</b>: Sesión conjunta en DEV
(<code>dev.operaciones.flitsas.online</code>) bajo supervisión de
<a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a>.
Evidencias (capturas) en <b>Evidences</b> de este Feature.
HUs cubiertas: {#id, #id}. Pendientes: {#id o «ninguna»}.</div>
```

## Plantilla HTML — `Custom.Evidences` del Feature (append)

Tablas con `style="border:1px solid #cccccc;padding:6px 8px"` en **cada** `<th>` y `<td>`.

```html
<hr/>
<h2>Evidencias DEV — Feature #{FID} — {YYYY-MM-DD HH:MM}</h2>
<p><strong>Ambiente:</strong> DEV (<code>dev.operaciones.flitsas.online</code>)</p>
<p><strong>SHA develop:</strong> <code>{sha}</code> · <strong>M1:</strong> {VERDE|VERDE-PARCIAL|SIN-ACCESO}</p>
<p><strong>Sesión:</strong> conjunto con <a href="mailto:{USER_REAL_EMAIL}">@{USER_REAL_NAME}</a>
· herramientas: Claude in Chrome + Playwright</p>
<table style="border-collapse:collapse;width:100%">
  <tr>
    <th style="border:1px solid #cccccc;padding:6px 8px">HU/Bug</th>
    <th style="border:1px solid #cccccc;padding:6px 8px">Flujo / AC o repro</th>
    <th style="border:1px solid #cccccc;padding:6px 8px">Resultado</th>
    <th style="border:1px solid #cccccc;padding:6px 8px">Capturas (adjunto)</th>
  </tr>
  <!-- una fila por HU/Bug de esta sesión -->
</table>
<p><strong>Veredicto Feature:</strong> COMPLETO | PARCIAL (faltan {#ids})</p>
```

## Veredicto (exactamente uno)

- **COMPLETO** — todas las HUs/Bugs hijas del Feature que viajan a QA tienen fila con
  resultado pass y **al menos una captura** adjunta o nombrada en el Feature.
- **PARCIAL** — quedan hijas en DEV sin evidencia. Se puede seguir desarrollando.
  **Prohibido** `flit-release`.
- **BLOQUEADO** — DEV inaccesible, el humano no se sentó, o un flujo falló y no se
  corrigió. **Prohibido** `flit-release`.

```
HANDOFF → hilo: flit-evidencias-dev · Feature #<FID> · Veredicto: COMPLETO|PARCIAL|BLOQUEADO
  Cubiertas: <#ids> · Pendientes: <#ids|ninguna>
  Capturas: <n> en Feature #<FID> Custom.Evidences + adjuntos
  Siguiente: COMPLETO → flit-release si el humano pide QA | PARCIAL → seguir HUs o retomar sesión
             | BLOQUEADO → no promover; corregir o reprogramar sesión
```

## Hard-stops

1. **NUNCA** crear el PR `develop → staging` ni mergear a `staging` con veredicto
   distinto de `COMPLETO`.
2. **NUNCA** dar por evidenciado un flujo sin captura.
3. **NUNCA** recorrer DEV a solas y firmar por el humano.
4. **NUNCA** mencionar al QA / Daniel Amado en esta skill (eso es el Paso 3 de
   `flit-gestion-hu` al llegar a `staging`).
5. **NUNCA** commitear PNG/WebP de la sesión al repo.
