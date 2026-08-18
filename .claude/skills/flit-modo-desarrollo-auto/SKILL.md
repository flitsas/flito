---
name: flit-modo-desarrollo-auto
description: |
  Modo auto por Feature (FLIT - FLITO): cadena apilada. Cargar ESTA Skill al arrancar el Feature — no improvisar el ciclo.
  Por CADA HU: Skill flit-gestion-hu → architecture/ux si aplica → Agent backend/frontend (NUNCA codear HU en el hilo) → Skill flit-code-review ANTES del PR (+ security/db-review) → PR → Skill flit-integration-ado Modo A → Resolved vía Skill gestion-hu → Agent qa-agent (modo A temprano recomendado; B tras Resolved) → merge → Modo B → devops M1 al tip.
  Ledger obligatorio por HU. PROHIBIDO imitar skills con comentarios ADO branded / wit_* sueltos. Triggers — modo auto, feature completo, sin interrupción, sigue con la siguiente historia, flit-modo-desarrollo-auto.
---

# Modo de desarrollo auto

Ciclo cerrado por HU, repetido hasta que **todas** las historias del Feature quedan entregadas.
Esta skill **orquesta**; no duplica la lógica de las otras. La **matriz de invocación** vive en `AGENTS.md` — aquí solo se fija en qué paso del ciclo se dispara cada ejecutor:

- `flit-azure-devops` — conexión MCP/REST, encoding, idempotencia
- `flit-gestion-hu` — estados `Active` / `Resolved` y comentarios (**Skill en cada HU**)
- `architecture-agent` / `ux-agent` — diseño previo cuando aplica (paso 2c)
- `backend-agent` / `frontend-agent` — implementación (paso 3); el hilo principal no «codea de paso» una HU completa
- `flit-code-review` — revisión del diff antes del PR (paso 4b) (**Skill en cada HU**)
- `security-agent` / `db-review-agent` — gates pre-PR cuando el diff lo dispara (paso 4b)
- `qa-agent` — TCs/ejecución tras `Resolved` (**Agent en cada HU que aplique**)
- `flit-integration-ado` — Modo A al abrir PR y Modo B post-merge (**Skill; `Custom.Commits` obligatorio**)
- `devops-agent` — M1 post-Deploy (paso 2b / fin de ráfaga) (**Agent; curl del hilo no cuenta**)

## Contrato de invocación (rompe el ciclo si se viola)

En **cada** HU de la ráfaga el hilo principal debe usar la herramienta de delegación del runtime
(`Skill` / `Agent` / `Task`) con el nombre exacto del ejecutor. **Primera acción al arrancar un
Feature completo:** cargar **esta** skill (`Skill flit-modo-desarrollo-auto`) — no improvisar el
ciclo «de memoria».

### Prohibido imitar skills (hard-stop)

Un comentario ADO branded («usando @flit-gestion-hu», «usando @flit-integration-ado») **sin** haber
cargado la Skill en el turno **es imitación**, no cumplimiento. Igual: `wit_*` sueltos, tablas
«mi review», o Vitest del backend presentado como QA.

| Anti-patrón | Ejecutor que se saltó |
|---|---|
| Improvisar el Feature sin cargar esta skill | `flit-modo-desarrollo-auto` |
| `Edit`/`Write` de la HU entera en el hilo (incluida «solo migración/esquema») | `backend-agent` / `frontend-agent` |
| Tabla «mi code-review» / review después del PR | `flit-code-review` |
| Solo `security-agent` y abrir PR | `flit-code-review` (complementa, no sustituye) |
| `wit_*` + comentario branded sin `Skill flit-gestion-hu` | `flit-gestion-hu` |
| Discussion «PR registrado» sin `Custom.Commits` vía Skill | `flit-integration-ado` |
| Comentario «listo para QA» / seguir a la siguiente HU sin `Agent qa-agent` | `qa-agent` |
| `curl /api/health` del hilo presentado como M1 | `devops-agent` |

Si un paso no aplica, **declararlo en el cuerpo del PR / reporte** («architecture: no aplica — …»).
Omitir en silencio = fallo de proceso.

### Ledger de invocaciones (obligatorio al cerrar cada HU)

Pegar en el reporte del hilo (y opcionalmente en el cuerpo del PR) una línea por eslabón:

```
HU #<id> ledger: gestion=Skill✅|❌ · impl=Agent✅|❌ · code-review=Skill✅|❌ · security=✅|N/A · db=✅|N/A · integration-A=Skill✅|❌ · qa=HANDOFF✅|SIN-ENTORNO|❌ · merge · integration-B=Skill✅|N/A · M1=Agent✅|N/A
```

**Sin `qa=HANDOFF✅` o `qa=SIN-ENTORNO` → no arrancar la siguiente HU** presentando la actual como
«entregada a QA». En ráfaga, la invocación de `qa-agent` es el gate; el resultado puede ser
`SIN-ENTORNO`, pero el Agent **debe** haberse lanzado.

## Entrada

El Feature padre (ej. `#10938`) o una lista de HU. Si solo dan el Feature, obtener sus hijas por
WIQL y ordenarlas por dependencias (las declaradas en *Dependencies* dentro de Acceptance Criteria).

## Modo continuo (cadena apilada) — defecto del Feature completo

Cuando la entrada es un **Feature** (o la petición es "feature completo", "sin interrupción",
"modo auto"), **no se pausa entre HUs esperando el merge**. Tras abrir el PR y CI en verde, el
agente **mergea a `develop`** (regla de `AGENTS.md`) y rebasea la pila antes de seguir.

**Autorización (nivel B):** al arrancar el Feature, pedir **una vez** autorización explícita del
humano para mergear a `develop` durante ese Feature (p. ej. "puedes mergear a develop este
Feature"). Sin esa autorización, los PRs quedan abiertos y se sigue en cadena apilada sin merge
(comportamiento anterior). Un "sí" por PR también basta, pero no es el defecto.

```
HU1 → rama desde develop              → PR #1 → CI verde → merge a develop (agente)
HU2 → rama desde rama-HU1             → (tras merge #1) rebase sobre develop → PR #2 → merge
HU3 → rama desde rama-HU2             → idem
…sin pausar el desarrollo…
```

**Qué no cambia:** una rama por HU; gates por HU (tests, `flit-code-review`, `security-agent` /
`db-review-agent` si aplica, `qa-agent` tras Resolved si aplica); HU a `Resolved`; post-Deploy
`devops-agent` M1; merge a `staging`/`release` siempre humano (`flit-release`).

**Cuándo sí se pausa** (única excepción al continuo): CI rojo de la HU actual, veredicto
`BLOQUEADO`/`FAIL` en el paso 4b, cambios pedidos en revisión de un PR de la pila, AC ambiguo o
decisión de negocio pendiente. En esos casos se para **esa** HU (o la pila afectada), se deja
comentario en Discussion y se informa al humano — no se sigue construyendo encima de rojo.

**Modo secuencial (opt-in):** solo si el humano pide explícitamente "una HU a la vez", "espera el
merge" o "secuencial". Entonces cada HU nace de `develop` actualizado; con autorización del
Feature, el agente mergea tras CI verde antes de arrancar la siguiente.

## El ciclo (por cada HU, en orden de dependencias)

### 1. Activar en Azure

- **`Skill flit-gestion-hu` Paso 1** (obligatorio en **cada** HU, no solo la primera):
  - **Feature padre primero** (regla de `AGENTS.md`): si el Feature padre está `New`, pasarlo a **`Active`** con comentario de inicio en su Discussion. Si ya está `Active`, no rehacer.
  - `System.State` de la HU → **`Active`** + comentario de inicio (plantilla de la skill).
- Si la HU ya está `Active` o `Resolved`, **no** rehacer: continuar donde quedó.

### 2. Rama nueva (cadena apilada por defecto)

**Siempre** una rama por HU. Convención de nombre: `feat/flito-*` (lo exige la precondición 2 de
`flit-integration-ado`).

**Primera HU del Feature** (o modo secuencial):

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b feat/flito-hu<ID>-<slug-corto>
```

**HUs siguientes en modo continuo** (defecto): ramificar desde la rama de la HU previa, no desde
`develop`:

```bash
git checkout feat/flito-hu<ANTERIOR>-<slug>
git pull --ff-only origin feat/flito-hu<ANTERIOR>-<slug>   # si ya está en remoto
git checkout -b feat/flito-hu<ID>-<slug-corto>
```

| Situación | Estrategia |
|---|---|
| Cadena apilada (defecto del Feature) | Ramificar de la rama previa; declarar dependencia en el PR |
| Solo hacen falta tipos/esquema de la previa | Cherry-pick únicamente esos commits sobre `develop` |
| Modo secuencial (opt-in del humano) | Esperar merge de la previa; ramificar de `develop` actualizado |

**Cuerpo del PR (obligatorio en cadena):** declarar el eslabón y la dependencia, p. ej.:

```
Cadena del Feature #<FID> — eslabón N de M.
Depende de PR #<previo> (HU #<id-previa>). Mergear en orden.
Tras el merge de #<previo>, esta rama se rebaseará sobre develop.
```

### 2c. Diseño previo (cuando aplica — antes del código)

Consultar la matriz de `AGENTS.md`. En concreto:

1. **`architecture-agent`** si la HU abre módulo nuevo, modelo de datos nuevo, contrato de
   endpoints nuevo o una decisión técnica con tradeoffs. Omitir solo si el AC es un cambio
   mecánico sobre un patrón ya asentado (y declararlo en el PR: «architecture: no aplica — …»).
2. **`ux-agent`** si es HU FRONTEND con pantalla/wizard/bandeja nueva o sin spec de interacción
   en `docs/ux/`. Omitir en HUs BACKEND-only.

No empezar el paso 3 sin esos entregables cuando el disparador aplica.

### 2b. Merge a `develop` (tras CI verde, si hay autorización)

Solo si el humano autorizó merge a `develop` para este Feature (o dio "sí" por este PR):

1. Verificar precondiciones de `flit-integration-ado` (base = `develop`, tres checks CI en
   `success`, sin conflictos, rama `feat/flito-*`).
2. Mergear con MCP `github` (`merge_pull_request`, merge commit) — **nunca** a `staging`/`release`.
3. **`Skill flit-integration-ado` Modo B** (Deploy DEV + Commits integrado en `Custom.Commits`).
4. Tras Modo B (o al cerrar una ráfaga de merges de la pila): invocar **`Agent devops-agent` M1** una vez
   sobre el tip/ambiente DEV — no por cada PR intermedio, **tampoco cero**. Un `curl` del hilo no
   sustituye el Agent. Si no hay acceso al ambiente, el Agent debe devolver HANDOFF `SIN-ACCESO`
   (no fingir VERDE).
5. Rebasar las ramas pendientes de la pila sobre `origin/develop` y
   `git push --force-with-lease` solo de la rama propia.

Sin autorización: dejar el PR abierto y continuar la cadena apilada (el humano mergea cuando quiera;
tras cada merge humano, rebasear igual).

**Tras cada merge (agente o humano) de un eslabón:** rebasar las ramas pendientes sobre `develop`
(`git fetch origin && git rebase origin/develop`) y force-with-lease solo de la rama propia.

### 3. Desarrollo

Invocar **`backend-agent`** y/o **`frontend-agent`** (`Agent`/`Task`) según el tipo de HU.
**Prohibido** implementar una HU completa «de paso» en el hilo principal — también la primera HU
del Feature y las de «solo esquema/migración/seeds». Excepción única: fix ≤~20 líneas en un
archivo tras HANDOFF, o pedido explícito del humano. Cumplir los AC uno a uno (`AGENTS.md`).
No ampliar el alcance a otras HU.

### 4. Tests y pipelines

Local, en este orden — **cada uno debe pasar antes de seguir**:

```bash
npm run build -w packages/shared-types   # si se tocó shared-types (tsc -b)
npm run test:shared-types                # idem (corre sus tests con vitest de apps/api)
npm run check:hooks                      # scanner propio de Rules-of-Hooks
npm run build:api                        # tsc -b && tsc-alias
npm test -w apps/api                     # vitest run
npm run build:web                        # tsc --noEmit && vite build
npm run test:e2e:smoke -w apps/web       # solo si la HU toca UI y hay entorno levantado
```

Migraciones de BD: el runner necesita `DATABASE_URL`, que vive en `apps/api/.env` y **no** se carga
sola — hay que exportarla (`set -a; source apps/api/.env; set +a`). El dry-run
(`npx tsx src/scripts/db-apply.ts --dry`) lista todo lo que aplicaría, pero en la BD demo local la
tabla de control está vacía (las migraciones se aplicaron a mano), así que **listará todas**: eso no
significa que falten. Para validar de verdad una migración nueva, aplicarla sola contra la BD demo
y **correrla dos veces** para comprobar que es idempotente:

```bash
docker exec -i flito-postgres psql -U flito -d flito_demo -v ON_ERROR_STOP=1 < <migracion>.sql
```

**Nunca** `drizzle-kit migrate` (dejaría la BD inconsistente; ver
`apps/api/src/db/migrations/README.md`). Avisar al usuario de que se tocó su BD local.

Tras el push, esperar el pipeline remoto consultando `mcp__github__pull_request_read` con
`method: get_check_runs` (el workflow del repo publica un único check, `build + test`). Para no
consultar en bucle, lanzar un `sleep` con `run_in_background` y volver a mirar cuando avise.

**Si algo falla: arreglarlo y repetir. No se avanza con rojo.**

### 4b. Revisión y seguridad pre-PR (gate obligatorio)

Con el diff completo de la rama (`git diff origin/develop...HEAD`), **antes** de abrir PR
(**en cada HU**, no solo la primera):

1. **`Skill flit-code-review`** sobre el diff (veredicto canónico OK / OK-CON-OBSERVACIONES /
   BLOQUEADO). Un resumen improvisado del hilo **no** sustituye la skill. `BLOQUEADO` → corregir
   y re-revisar; el PR no se abre.
2. **`security-agent`** sobre el diff cuando toque superficie sensible (criterio de la propia
   skill / `flit-code-review`): `auth`, `permissions`, `pii-audit`, `laft/`, `privacy/`, `multer`,
   rutas nuevas, `package*.json` o campos PII. Veredicto `FAIL` → corregir; no hay excepción sin
   aprobación documentada del Líder Técnico.
3. **`db-review-agent`** cuando el diff toque `apps/api/src/db/schema.ts` o
   `apps/api/src/db/migrations/`. Veredicto con hallazgos críticos → corregir vía `backend-agent`
   antes del PR.
4. Si un gate no aplica, declararlo explícitamente en el cuerpo del PR
   ("superficie sensible: no aplica", "db-review: no aplica — sin cambios de esquema").

Los checks CI `dependency-audit` y `secret-scan` corren además en el pipeline tras el push — si
alguno falla en remoto, se corrige antes de pedir el merge.

### 5. Commit, push y PR

```bash
git add <archivos explícitos>        # NUNCA git add -A ni git add .
git status --short                   # verificar que no se cuela nada
git commit -m "feat(flito): ... (HU #<ID>)"
git push -u origin feat/flito-hu<ID>-<slug>
```

**El PR se crea con el servidor MCP `github`** (`mcp__github__create_pull_request`), no con `gh`:
en esta máquina `gh` es **otro programa** con el mismo nombre (un visor de ayuda), no el CLI de
GitHub. Comprobar con `gh --version` antes de asumir lo contrario. Para consultar el estado del PR
y sus checks, `mcp__github__pull_request_read` con `method: get_check_runs` / `get_status`.

Luego **`Skill flit-integration-ado` Modo A**: registrar el PR en `Custom.Commits` (HTML canónico)
y comentario breve en Discussion. Discussion **sola no basta**. Si el campo `Custom.Commits` es
muy largo, resumir historial previo y concatenar — **no** abandonar el campo «por tokens».
**Limitación conocida (hyperlink formal):** preferir `wit_work_item_link_write` con
`action: "link_to_pull_request"` o `add_artifact_link` (servidor MCP **`ado`**, cookbook en
`flit-azure-devops`). Si el schema/sesión no permite la relación, dejar el enlace dentro de
`Custom.Commits` y Discussion — **no** abandonar Commits. Los `updates[].value` de
`wit_work_item_write` van como string (HTML incluido).

### 6. Cerrar la HU

**`Skill flit-gestion-hu` Paso 3:** `System.State` → **`Resolved`** + comentario de entrega a QA
(plantillas de la skill), solo si build y pipeline están en verde. No cerrar con `wit_*` sueltos
sin la skill.

### 6b. QA (obligatorio — participación y precisión)

**Objetivo de proceso:** `qa-agent` en **cada** HU aplicable (no solo al final del Feature). Meta
operativa: HANDOFF en ≥90% de las HUs Resolved del Feature.

**Temprano (recomendado, sube participación):** con la HU en `Active` y AC Gherkin listos, lanzar
`qa-agent` **modo A** en paralelo al paso 3 (TCs / Tasks hijas). No esperar al Resolved para
descubrir que faltan TCs.

**Tras `Resolved` (no negociable):** lanzar `qa-agent` (`Agent`/`Task`) **antes** de dar la HU por
«entregada a QA»:

| Tipo HU | Modos mínimos | Precisión exigida en HANDOFF |
|---|---|---|
| AC Gherkin / FRONTEND | A (si faltan TCs) + **B** | Matriz AC→TC; salida real pegada; PASS / FAIL / SIN-ENTORNO |
| BACKEND-only | **B** (Vitest del módulo; E2E declarado si se omite) | Comando + salida real; no reusar solo el test del `backend-agent` |
| Entorno caído | Invocar igual | `SIN-ENTORNO` del **agente**, no del hilo |

**Prohibido:** comentario HTML de entrega como sustituto; «QA pendiente» sin Agent; inventar
`QA_PDN`; seguir a la siguiente HU sin fila `qa=` en el ledger.

En cadena apilada se puede arrancar la siguiente HU **solo si ya se invocó** `qa-agent` en la
actual (aunque quede `SIN-ENTORNO`). Sin HANDOFF de `qa-agent` en las HUs del Feature → no declarar
el Feature «listo para staging».

### 7. Siguiente HU (sin esperar merge humano)

En **modo continuo** (defecto): si hay autorización de merge a `develop` y el paso 2b ya mergeó,
continuar con la siguiente HU sobre `develop` actualizado (o rebasar la pila y seguir). Si no hay
autorización, arrancar la siguiente desde la rama previa **aunque el PR actual siga abierto**.

En **modo secuencial** (opt-in): no arrancar la siguiente hasta que la actual esté mergeada en
`develop` (por el agente bajo autorización, o por el humano).

Al terminar todas, reportar: HU, rama, PR, eslabón, estado del pipeline, merges hechos y PRs
pendientes.

## Reglas innegociables

1. **Nunca `git add -A` ni `git add .`** — el working tree puede tener parches de demo que no deben
   commitearse. Listar archivos explícitamente y verificar con `git status --short`.
2. **Merge solo a `develop`**, y solo con autorización del Feature (o "sí" por PR) + precondiciones
   de `flit-integration-ado` en verde. **Nunca** mergear a `staging` ni `release`.
3. **Nunca `Resolved` con build o pipeline en rojo.**
4. **Nunca abrir el PR sin el paso 4b en verde** — `flit-code-review` y, cuando aplique,
   `security-agent` y/o `db-review-agent`. La seguridad y el esquema no son opcionales ni quedan
   a criterio del momento. Un «crea el PR» del humano **no** salta el 4b: solo autoriza el
   `create_pull_request` cuando los gates ya están en verde (ver `.cursor/rules/pre-pr-gates.mdc`).
5. **Nunca commitear secretos** ni `.env`.
6. **Una rama por HU.** En modo continuo, la N-ésima nace de la rama de la (N-1) o de `develop`
   tras merge del eslabón previo; en modo secuencial, de `develop` actualizado. Dejarlo escrito
   en el cuerpo del PR.
7. **No tocar `Custom.Evidences`** aquí (lo llena el rol de tests/QA) ni los campos `Deploy *`
   sin pasar por `flit-integration-ado` Modo B.
8. Si una HU se bloquea (falta un dato de negocio, un permiso, un archivo de muestra, CI rojo o
   revisión pedida en un eslabón de la pila), **parar esa HU** (y no apilar encima), dejar
   comentario en Discussion explicando el bloqueo, y continuar solo con HUs que **no** dependan
   de ella. Informar al usuario al final.
9. **Nunca apilar ni mergear sobre rojo.** Si el PR del eslabón previo tiene checks fallando, no
   se mergea ni se abre la siguiente rama hasta que ese eslabón esté verde o el humano decida
   cortar la dependencia.
10. **Nunca saltar la matriz de `AGENTS.md`** en un Feature «modo auto»: architecture/ux cuando
    apliquen; **`backend-agent`/`frontend-agent` para implementar (toda HU)**; **`Skill
    flit-code-review` + `Skill flit-gestion-hu` + `Skill flit-integration-ado` en cada eslabón**;
    **`qa-agent` tras cada Resolved aplicable**; **`devops-agent` M1 al tip tras Modo B / ráfaga**.
    Sustituir cualquiera por prosa, curl o PATCH ADO suelto = fallo de proceso (ver Contrato de
    invocación).

## Cuándo parar y preguntar

- Un Acceptance Criteria es ambiguo o contradice el código existente.
- Hace falta una decisión de negocio que no está en la HU.
- El cambio exige tocar algo fuera del alcance del Feature.
- Un test que ya existía empieza a fallar por una razón no obvia.
- Un PR de la pila recibe cambios pedidos en revisión (hay que rebasar los eslabones encima).

## Checklist de salida por HU

- [ ] Feature padre en `Active` (regla de `AGENTS.md`)
- [ ] Esta skill cargada al inicio del Feature (no ciclo improvisado)
- [ ] HU en `Active` al empezar, `Resolved` al terminar — vía **Skill** `flit-gestion-hu` (no wit_* branded)
- [ ] Rama `feat/flito-hu<ID>-*` creada (desde `develop` o desde la rama previa, según el modo)
- [ ] En cadena: dependencia y eslabón declarados en el cuerpo del PR
- [ ] Diseño previo: `architecture-agent` / `ux-agent` ejecutados o «no aplica» declarado
- [ ] Implementación vía **Agent** `backend-agent` / `frontend-agent` (no código de HU completa en el hilo)
- [ ] (Recomendado) **Agent** `qa-agent` modo A en paralelo con AC listos
- [ ] Todos los AC cubiertos
- [ ] Build, tests y pipeline en verde
- [ ] **Skill** `flit-code-review` con veredicto OK u OK-CON-OBSERVACIONES **antes** del PR
- [ ] `security-agent` ejecutado si el diff tocó superficie sensible (o declarado "no aplica")
- [ ] `db-review-agent` ejecutado si el diff tocó esquema/migraciones (o declarado "no aplica")
- [ ] Commit sin archivos colados (`git status --short` limpio)
- [ ] PR abierto contra `develop`
- [ ] **Skill** `flit-integration-ado` Modo A → `Custom.Commits` (no solo Discussion / no imitación)
- [ ] **Skill** `flit-gestion-hu` → `Resolved` + plantilla entrega QA
- [ ] **Agent** `qa-agent` invocado con HANDOFF (`PASS`/`PASS-CON-OBSERVACIONES`/`FAIL`/`SIN-ENTORNO`)
- [ ] Ledger de la HU pegado en el reporte del hilo
- [ ] Si hay autorización: merge a `develop` (MCP github) + **Skill** Modo B; si no, PR pendiente de merge humano
- [ ] Tras Modo B / fin de ráfaga: **Agent** `devops-agent` M1 (o HANDOFF `SIN-ACCESO`)
- [ ] Siguiente HU solo si `qa=` del ledger ≠ ❌
