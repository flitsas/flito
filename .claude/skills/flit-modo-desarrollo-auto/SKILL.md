---
name: flit-modo-desarrollo-auto
description: |
  Modo auto por Feature (FLIT - FLITO): cadena apilada. Cargar ESTA Skill al arrancar el Feature — no improvisar el ciclo.
  Por CADA HU **o Bug** (mismo ciclo — paridad de AGENTS.md): Skill flit-gestion-hu → architecture/ux slim|full si aplica → Agent backend/frontend (prompt denso; NUNCA codear la HU/Bug en el hilo) → verificación filtrada → Skill flit-code-review ANTES del PR (+ security diff-scoped ∥ db-review) → PR → Skill flit-integration-ado Modo A → Resolved vía Skill gestion-hu → Agent qa-agent B alcance AC (repro+regresión en Bug; A temprano; FAIL=retrabajo sin Bug nuevo) → monitor CI + merge al verde en paralelo con el siguiente work item → Modo B → devops M1 mínimo al tip.
  Ledger obligatorio por work item. PROHIBIDO imitar skills con comentarios ADO branded / wit_* sueltos, y PROHIBIDO dejar un Bug mergeado sin Resolved. Triggers — modo auto, feature completo, sin interrupción, sigue con la siguiente historia, corrige los bugs, flit-modo-desarrollo-auto.
---

# Modo de desarrollo auto

Ciclo cerrado por work item, repetido hasta que **todos** los del lote quedan entregados.

**«HU» aquí significa work item de desarrollo: User Story *o* Bug.** El ciclo, los gates y el ledger
son idénticos (regla «Paridad HU ↔ Bug» de `AGENTS.md`). Un lote de Bugs se trabaja en cadena
apilada igual que las HUs de un Feature: rama `BUG/<ID>-…`, título `BUG <ID>: …`, y **cierre a
`Resolved` con `flit-gestion-hu`** — un Bug mergeado que se queda en `Active` es fallo de proceso,
no un pendiente que se le consulta al humano.
Esta skill **orquesta**; no duplica la lógica de las otras. La **matriz de invocación** vive en `AGENTS.md` — aquí solo se fija en qué paso del ciclo se dispara cada ejecutor:

- `flit-azure-devops` — conexión MCP/REST, encoding, idempotencia
- `flit-gestion-hu` — estados `Active` / `Resolved` y comentarios (**Skill en cada HU y en cada Bug**)
- `architecture-agent` / `ux-agent` — diseño previo cuando aplica (paso 2c)
- `backend-agent` / `frontend-agent` — implementación (paso 3); el hilo principal no «codea de paso» una HU completa
- `flit-code-review` — revisión del diff antes del PR (paso 4b) (**Skill en cada HU**)
- `security-agent` / `db-review-agent` — gates pre-PR cuando el diff lo dispara (paso 4b)
- `qa-agent` — TCs (A) + gate B tras `Resolved` (**Agent en cada HU que aplique**); **prohibido** modo C por FAIL del gate
- `flit-integration-ado` — Modo A al abrir PR y Modo B post-merge (**Skill; `Custom.Commits` obligatorio**)
- `pr-monitor-agent` — monitoreo del PR y merge a `develop` tras Modo A (**Agent en cada PR**, en background; paso 2b)
- `devops-agent` — M1 post-Deploy (paso 2b / fin de ráfaga) (**Agent; curl del hilo no cuenta**)

## Contrato de invocación (rompe el ciclo si se viola)

En **cada** HU de la ráfaga el hilo principal debe usar la herramienta de delegación del runtime
(`Skill` / `Agent` / `Task`) con el nombre exacto del ejecutor. **Primera acción al arrancar
O RETOMAR un Feature** («continúa», «retoma», «sigue con el Feature», sesión nueva sobre el mismo ID):
cargar **esta** skill (`Skill flit-modo-desarrollo-auto`) **en ese turno**. Una carga de hace horas
o de otra HU **no cuenta**. No improvisar el ciclo «de memoria».

Si al retomar hay **otro Feature Active** en paralelo (otra sesión), **antes** invocar
`orchestrator-agent` (bloque `DUEÑOS`) y solo entonces esta skill sobre **el** Feature de esta sesión.

### Prohibido imitar skills (hard-stop)

Un comentario ADO branded («usando @flit-gestion-hu», «usando @flit-integration-ado») **sin** haber
cargado la Skill en el turno **es imitación**, no cumplimiento. Igual: `wit_*` sueltos, tablas
«mi review», o Vitest del backend presentado como QA.

| Anti-patrón | Ejecutor que se saltó |
|---|---|
| Improvisar el Feature sin cargar esta skill **también al retomar** («continúa» no vale) | `flit-modo-desarrollo-auto` |
| `Edit`/`Write` de la HU entera en el hilo (incluida «solo migración/esquema») | `backend-agent` / `frontend-agent` |
| Tabla «mi code-review» / review después del PR | `flit-code-review` |
| Solo `security-agent` y abrir PR | `flit-code-review` (complementa, no sustituye) |
| `wit_*` + comentario branded sin `Skill flit-gestion-hu` | `flit-gestion-hu` |
| Discussion «PR registrado» sin `Custom.Commits` vía Skill | `flit-integration-ado` |
| Comentario «listo para QA» / seguir a la siguiente HU sin `Agent qa-agent` | `qa-agent` |
| Radicar Bug / modo C porque falló el gate B del Feature | `qa-agent` (FAIL = re-trabajo, no Bug) |
| `curl /api/health` del hilo presentado como M1 | `devops-agent` |
| Polling de check-runs a mano, o cerrar el turno con «avísame cuando el CI pase» | `pr-monitor-agent` |
| Bug mergeado que queda en `Active`, o «¿lo paso a Resolved?» como si no hubiera proceso | `flit-gestion-hu` Paso 3 (mismo cierre que una HU) |
| Bug trabajado sin comentario de inicio/cierre, sin `Custom.Commits` o sin gate QA | el ciclo completo — el Bug no es un work item de segunda |

Si un paso no aplica, **declararlo en el cuerpo del PR / reporte** («architecture: no aplica — …»).
Omitir en silencio = fallo de proceso.

### Ledger de invocaciones (obligatorio al cerrar cada HU o Bug)

Pegar en el reporte del hilo (y opcionalmente en el cuerpo del PR) una línea por eslabón:

```
<HU|Bug> #<id> ledger: gestion=Skill✅(HH:MM)|❌ · impl=Agent✅|❌ · code-review=Skill✅(HH:MM)|❌ · security=✅|N/A · db=✅|N/A · integration-A=Skill✅(HH:MM)|❌ · qa=HANDOFF✅|SIN-ENTORNO|FAIL-retrabajo|❌ · estado=Resolved✅|❌ · pr-monitor=Agent MERGED|LISTO-PARA-MERGE|CI-EN-CURSO|CI-ROJO|❌ · merge · integration-B=Skill✅(HH:MM)|N/A · M1=Agent✅|N/A
```

`estado=Resolved` es la casilla que delata al **Bug huérfano**: si el work item se mergeó y el
ledger no puede marcarla, el ciclo no está cerrado.

Cada ✅ de Skill lleva la **hora de su carga en el turno de esa operación**. Una carga tiene
vigencia de **una operación** (una activación/cierre de HU, un code-review, un Modo A, un Modo B):
en cadena apilada cada eslabón **recarga** la skill en su turno. Una carga de la HU anterior o de
hace horas en la misma sesión **no cuenta** — es la imitación más frecuente (veredicto «de
memoria»). Ver `.cursor/rules/skill-no-imitation.mdc`.

**Sin `qa=HANDOFF✅` (`PASS`) o `qa=SIN-ENTORNO` → no arrancar la siguiente HU** presentando la actual como
«entregada a QA». `qa=FAIL-retrabajo` = gate B rojo **o** `PASS-CON-OBSERVACIONES` sin waiver: HU a `Active`, corregir hasta **PASS**, **sin** Bug/modo C;
no contar como entregada. En ráfaga, la invocación de `qa-agent` es el gate; `SIN-ENTORNO`
(QA pendiente de entorno) no finge PASS, pero el Agent **debe** haberse lanzado.

## Entrada

El Feature padre (ej. `#10938`), una lista de HU, **o una lista de Bugs** (p. ej. «corrige los bugs
#11766 y #11767»). Si solo dan el Feature, obtener sus hijas por WIQL y ordenarlas por dependencias
(las declaradas en *Dependencies* dentro de Acceptance Criteria). Un lote de Bugs se ordena por
severidad y por dependencia entre módulos, y se recorre con el **mismo** ciclo de abajo.

## Modo continuo (cadena apilada) — defecto del Feature completo

Cuando la entrada es un **Feature** (o la petición es "feature completo", "sin interrupción",
"modo auto"), **no se pausa entre HUs esperando el merge**. Tras abrir el PR y CI en verde, el
agente **mergea a `develop`** (regla de `AGENTS.md`) y rebasea la pila antes de seguir.

**Autorización (nivel B):** al arrancar el Feature, pedir **una vez** autorización explícita del
humano para mergear a `develop` durante ese Feature (p. ej. "puedes mergear a develop este
Feature"). Sin esa autorización, los PRs quedan abiertos y se sigue en cadena apilada sin merge
(comportamiento anterior). Un "sí" por PR también basta, pero no es el defecto.

```
HU1 → rama desde develop              → PR #1 → CI en curso ──┐
HU2 → rama desde rama-HU1 (en paralelo mientras corre CI #1)   │
…                                                              ▼
        CI #1 verde + auth → merge #1 → rebase pila → CI #2 → merge #2 …
```

**Qué no cambia:** una rama por HU; gates por HU (tests, `flit-code-review`, `security-agent` /
`db-review-agent` si aplica, `qa-agent` tras Resolved si aplica); HU a `Resolved`; post-Deploy
`devops-agent` M1; merge a `staging`/`release` siempre humano (`flit-release`).

### Anti-estancamiento post-PR (obligatorio — rompe la agilidad si se viola)

Abrir el PR **no** es un gate humano de “espera a que te digan sigue”. Tras `create_pull_request`
+ Modo A (+ Resolved/qa según ciclo), el hilo **debe** mantener el Feature en movimiento.

| Pista | Qué hace | No hace |
|---|---|---|
| **A — CI → merge** | **Delegada al `Agent pr-monitor-agent`** (en background) con el número del PR y los hechos de gate: él monitorea los checks, hace triage del log rojo, detecta conflictos y mergea a `develop` con la auth del Feature, sin nuevo “sí”. | No termina el turno con «PR abierto, avísame cuando CI pase»; no vigila los checks a mano con `pull_request_read` suelto |
| **B — Siguiente HU** | En cadena apilada, **arranca la siguiente HU** (Active → diseño si aplica → impl) desde la rama previa **mientras** corre el CI de la actual, si el ledger `qa=` de la actual ya es ✅ o `SIN-ENTORNO` | No se queda idle solo porque el merge aún no ocurrió |

**Prohibido (anti-patrones de estancamiento):**

1. Terminar el turno pidiendo al humano que diga «continúa» **solo** porque el PR está abierto o el CI está `pending`/`in_progress`.
2. Bloquear toda la ráfaga esperando CI en un bucle vacío sin avanzar la pista B (siguiente HU apilada).
3. Re-preguntar autorización de merge si **ya** se otorgó a nivel Feature en la sesión.
4. Tratar “PR creado” como fin del trabajo de la HU cuando aún faltan monitor CI, merge (si auth) o la siguiente HU del Feature.
5. Quedar idle tras un merge con la **cola post-merge pendiente** (Modo B, `devops-agent` M1, QA retro de la ráfaga): esa cola se ejecuta **en el mismo ciclo**, no es trabajo diferible.
6. Mantener subagentes vivos con mensajes de «espera» (p. ej. qa-agent modo A retenido esperando la implementación): cada modo es una invocación acotada que cierra con HANDOFF.
7. Preguntar al humano «qué debo hacer», «qué te queda», «qué sigue» cuando el siguiente paso está en la matriz de `AGENTS.md` (22 ago: varias sesiones lo devolvieron a David). El siguiente ejecutor se invoca; no se consulta.
8. Codear un WI de **otro** Feature porque ADO lo muestra como siguiente. Dueño = esta sesión + bloque orchestrator si hay paralelo.

**Espera legítima (NO es estancamiento ni ineficiencia):** detenerse a esperar al humano ante una
decisión de negocio, un gate humano (merge sin autorización de Feature, promoción, despliegue), un
AC ambiguo o un permiso faltante es **obligatorio** — las decisiones importantes las toma el
humano, no los agentes. El anti-estancamiento aplica solo a trabajo **ya autorizado y ejecutable**
(CI verde sin merge hecho, Modo B/M1 pendientes, siguiente HU lista).

**Cómo monitorear CI sin congelar el hilo:**

1. Tras el push/PR + Modo A: lanzar `Agent pr-monitor-agent` **en background** (contrato de invocación en `.claude/agents/pr-monitor-agent.md`: PR, autorización del Feature, `SHA revisado` del veredicto, HANDOFF de qa, campos del work item, si es eslabón de la pila).
2. Arrancar de inmediato la pista B (siguiente HU/Bug). El hilo **no** hace polling propio de check-runs: eso es trabajo del subagente, que espera con backoff hasta ~25-30 min.
3. Su HANDOFF decide: `MERGED` → cola post-merge (Modo B + M1 + rebase de la pila) en el **mismo ciclo**, sin preguntar de nuevo · `LISTO-PARA-MERGE` → completar el gate que falta y relanzarlo · `CI-EN-CURSO` → relanzarlo al terminar el eslabón en curso · `CONFLICTO` → delegar al agente dueño que él nombra.
4. Si el veredicto es `CI-ROJO` con causa `CODIGO` → **sí** pausar esa HU/pila, delegar la corrección al agente dueño, comentar en Discussion e informar al humano (única pausa legítima por CI). Con causa `INFRA` el subagente ya relanzó el job una vez: no relanzarlo otra vez a mano.

**Cuándo sí se pausa** (única excepción al continuo): CI rojo de la HU actual, veredicto
`BLOQUEADO`/`FAIL` en el paso 4b, cambios pedidos en revisión de un PR de la pila, AC ambiguo o
decisión de negocio pendiente. En esos casos se para **esa** HU (o la pila afectada), se deja
comentario en Discussion y se informa al humano — no se sigue construyendo encima de rojo.

**Modo secuencial (opt-in):** solo si el humano pide explícitamente "una HU a la vez", "espera el
merge" o "secuencial". Entonces cada HU nace de `develop` actualizado; con autorización del
Feature, el agente mergea tras CI verde antes de arrancar la siguiente. **Aun así**, no pide
«continúa» al humano mientras el CI está en curso: monitorea y mergea solo.

## El ciclo (por cada HU, en orden de dependencias)

### 1. Activar en Azure

- **`Skill flit-gestion-hu` Paso 1** (obligatorio en **cada** HU y en **cada Bug**, no solo la primera):
  - **Padre primero** (regla de `AGENTS.md`): si el Feature padre está `New`, pasarlo a **`Active`** con comentario de inicio en su Discussion. Si ya está `Active`, no rehacer. Un Bug **sin padre** se activa igual y la ausencia se declara en el comentario.
  - `System.State` del work item → **`Active`** + comentario de inicio (plantilla de la skill; en Bug incluye quién lo reportó, severidad y el repro que debe quedar en verde).
- Si el work item ya está `Active` o `Resolved`, **no** rehacer: continuar donde quedó.

### 2. Rama nueva (cadena apilada por defecto)

**Siempre** una rama por HU, y **siempre ligada a un work item**: sin HU o Bug en ADO no se abre
rama (trazabilidad estricta de `AGENTS.md`). Convención **obligatoria** de nombre
(`.cursor/rules/convenciones-rama-pr.mdc`, lo exige la precondición 2 de `flit-integration-ado` y
lo bloquea el check CI `naming`):

```
HU/<ID>-<desarrollador>-<descripcion-breve>      # p. ej. HU/11678-davidchica-ajustes-flito
BUG/<ID>-<desarrollador>-<descripcion-breve>
```

`<desarrollador>` = humano de la sesión en minúsculas sin acentos (derivar de `git config user.name`).
Prefijo en MAYÚSCULAS, ID sin `#`, descripción kebab-case, ≤ 80 caracteres, **sin sufijo de ambiente**.

**Worktree aislado** (cuando el checkout principal está ocupado): tras crearlo, correr
`npm install` en la raíz del worktree **antes** de lanzar agentes (sin `node_modules`, el
typecheck y los tests mueren y cada subagente lo redescribe por su cuenta).

**Primera HU del Feature** (o modo secuencial):

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b HU/<ID>-<desarrollador>-<descripcion-breve>
node scripts/check-naming.mjs --branch "$(git branch --show-current)"
```

**HUs siguientes en modo continuo** (defecto): ramificar desde la rama de la HU previa, no desde
`develop`:

```bash
git checkout HU/<ANTERIOR>-<desarrollador>-<desc>
git pull --ff-only origin HU/<ANTERIOR>-<desarrollador>-<desc>   # si ya está en remoto
git checkout -b HU/<ID>-<desarrollador>-<descripcion-breve>
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

Consultar la matriz de `AGENTS.md`. Umbrales proporcionales:

1. **`architecture-agent`**
   - **full:** módulo nuevo, modelo nuevo, contrato nuevo, o tradeoff real (PII/auth/integración).
   - **slim:** extiende módulo existente sin tabla/contrato nuevos; patrón = vecino nombrado (default cuando aplique).
   - **omitir:** cambio mecánico sobre patrón asentado → declarar en el PR: `architecture: no aplica — …`.
2. **`ux-agent`**
   - **full:** nueva ruta/`PageSlug`, wizard/bandeja nueva, o HU FRONTEND sin `docs/ux/`.
   - **slim:** extensión de pantalla existente (filtros/columnas/botón) reusando `flit`/`shell`.
   - **omitir:** copy/a11y menor o extensión trivial → `ux: no aplica — extensión de <Page>`; BACKEND-only siempre omit.

El prompt del Task debe ser **denso** (AC pegados, paths, modo slim|full). No empezar el paso 3 sin entregables cuando el disparador exige full/slim.

### 2b. Merge a `develop` (tras CI verde, si hay autorización)

Solo si el humano autorizó merge a `develop` para este Feature (o dio "sí" por este PR):

1. Los pasos 1 y 2 los ejecuta el **`Agent pr-monitor-agent`** ya lanzado en el anti-estancamiento:
   verifica las precondiciones de `flit-integration-ado` (base = `develop`, checks CI en `success`
   — incluido `naming` —, sin conflictos, rama `HU/<ID>-*` o `BUG/<ID>-*`, HEAD == `SHA revisado`,
   gate QA invocado) y mergea con MCP `github` (`merge_pull_request`, merge commit) — **nunca** a
   `staging`/`release`. El hilo solo mergea por su cuenta si el subagente devolvió
   `LISTO-PARA-MERGE` y el gate faltante ya se completó.
2. Del HANDOFF del subagente se toma el **SHA del merge commit** para el Modo B.
3. **`Skill flit-integration-ado` Modo B** (Deploy DEV + Commits integrado en `Custom.Commits`).
4. Tras Modo B (o al cerrar una ráfaga de merges de la pila): invocar **`Agent devops-agent` M1** una vez
   sobre el tip/ambiente DEV — no por cada PR intermedio, **tampoco cero**. El prompt lleva el **SHA
   esperado** (tip). Un `curl` del hilo no sustituye el Agent. Correlación: SSH **o** CD de GitHub
   Actions (`cd.yml`); **prohibido** decir que DEV «está roto» si `/api/health` está 200 (eso es
   DESFASE o CD en curso). Si no hay acceso, HANDOFF `SIN-ACCESO` (no fingir VERDE).
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
No ampliar el alcance a otras HU. Pasar prompt denso (AC + paths + decisión de diseño +
prohibiciones operativas: **no** `git add -A`/`.` ni staging masivo, **no** commits, verificación
filtrada por defecto — no suite completa local salvo umbral transversal).

### 4. Tests y pipelines

**Mínimo local vs CI** (cada comando del mínimo debe pasar con salida real; prohibido inventar):

| Toque | Local mínimo | CI (gate suite completa) |
|---|---|---|
| API módulo | `npm test -w apps/api -- <paths __tests__>` + `build:api` si tipos | suite API completa |
| Web página | `typecheck -w apps/web` + E2E del spec si entorno up | `build:web` + e2e smoke |
| shared-types / shared API / schema transversal | build shared-types + greps + tests afectados / suite API | completo |
| Shell / router / login | typecheck + `test:e2e:smoke` si entorno | completo |

Comandos de referencia (aplicar según la fila; no correr la lista entera «por costumbre»):

```bash
npm run build -w packages/shared-types   # si shared-types
npm run test:shared-types                # si shared-types
npm run check:hooks                      # si hooks
npm run build:api                        # si tipos API
npm test -w apps/api -- <paths>          # default filtrado
npm run test -w apps/api                 # solo umbral transversal
npm run build:web / typecheck -w apps/web
npx playwright test e2e/tests/<spec>.spec.ts   # default E2E filtrado
npm run test:e2e:smoke -w apps/web       # shell/login o pedido explícito
```

Migraciones de BD: exportar `DATABASE_URL` (`set -a; source apps/api/.env; set +a`). Validar migración
nueva contra BD demo y **correrla dos veces** (idempotencia):

```bash
docker exec -i flito-postgres psql -U flito -d flito_demo -v ON_ERROR_STOP=1 < <migracion>.sql
```

**Nunca** `drizzle-kit migrate`. Avisar al usuario de que se tocó su BD local.

Tras el push y el PR, **Anti-estancamiento post-PR**: lanzar `Agent pr-monitor-agent` (background);
en paralelo avanzar la siguiente HU si el ledger lo permite; al verde + auth él mergea sin nuevo “sí”.

**Si CI falla: arreglarlo y repetir. No apilar encima de rojo.**

### 4b. Revisión y seguridad pre-PR (gate obligatorio)

Con el diff (`git diff origin/develop...HEAD`), **antes** de abrir PR (**cada HU**):

1. **`Skill flit-code-review`** (veredicto canónico). `BLOQUEADO` → corregir; no abrir PR.
2. **`security-agent` (diff-scoped)** si superficie sensible. `FAIL` → corregir.
3. **`db-review-agent`** si toca `schema.ts` o migraciones. Críticos → corregir vía backend.
4. Si **ambos** 2 y 3 aplican → lanzarlos **en paralelo** en el mismo turno.
5. Si un gate no aplica → declararlo en el cuerpo del PR.

Los checks CI `dependency-audit` y `secret-scan` siguen siendo gates de merge.

### 5. Commit, push y PR

```bash
git add <archivos explícitos>        # NUNCA git add -A ni git add .
git status --short                   # verificar que no se cuela nada
git commit -m "feat(flito): ... (HU #<ID>)"
git push -u origin HU/<ID>-<desarrollador>-<descripcion-breve>
```

**Título del PR — formato obligatorio** (`.cursor/rules/convenciones-rama-pr.mdc`):
`HU <ID>: <descripción>` (o `BUG <ID>: …`), ≤ 100 caracteres, descriptivo del cambio y su para
qué, sin punto final y con el **mismo ID que la rama**. Verificar antes de abrir:

```bash
node scripts/check-naming.mjs --branch "$(git branch --show-current)" --title "HU <ID>: <descripción>"
```

**El PR se crea con el servidor MCP `github`** (`mcp__github__create_pull_request`), no con `gh`:
en esta máquina `gh` es **otro programa** con el mismo nombre (un visor de ayuda), no el CLI de
GitHub. Comprobar con `gh --version` antes de asumir lo contrario. El estado del PR y sus checks los
consulta el **`Agent pr-monitor-agent`** (`mcp__github__pull_request_read` con `method:
get_check_runs` / `get_status`), no el hilo con polling propio.

Luego **`Skill flit-integration-ado` Modo A**: registrar el PR en `Custom.Commits` (HTML canónico)
y comentario breve en Discussion. Discussion **sola no basta**. Si el campo `Custom.Commits` es
muy largo, resumir historial previo y concatenar — **no** abandonar el campo «por tokens».
**Limitación conocida (hyperlink formal):** preferir `wit_work_item_link_write` con
`action: "link_to_pull_request"` o `add_artifact_link` (servidor MCP **`ado`**, cookbook en
`flit-azure-devops`). Si el schema/sesión no permite la relación, dejar el enlace dentro de
`Custom.Commits` y Discussion — **no** abandonar Commits. Los `updates[].value` de
`wit_work_item_write` van como string (HTML incluido).

### 6. Cerrar la HU o el Bug

**`Skill flit-gestion-hu` Paso 3:** `System.State` → **`Resolved`** + comentario de entrega a QA
(plantillas de la skill; la de Bug añade causa, corrección y repro verificado). Condición mínima:
**build/tests locales en verde** —y, en Bug, el repro en verde tras estar rojo— y PR abierto con
Modo A. **Un Bug no se salta este paso**: cerrar el ciclo sin `Resolved` es dejarlo huérfano. Si el CI remoto aún está `pending`, **no** bloquear el Resolved ni la pista B: dejar el
monitor de CI activo y mergear (paso 2b) cuando pase a verde. **No** `Resolved` si el CI remoto
ya está en rojo — corregir antes. No cerrar con `wit_*` sueltos sin la skill.

### 6b. QA (obligatorio — participación y precisión)

**Objetivo de proceso:** `qa-agent` en **cada** HU aplicable (no solo al final del Feature). Meta
operativa: HANDOFF en ≥90% de las HUs Resolved del Feature.

**Temprano (recomendado, sube participación):** con la HU en `Active` y AC Gherkin listos, lanzar
`qa-agent` **modo A** en paralelo al paso 3 (TCs / Tasks hijas). No esperar al Resolved para
descubrir que faltan TCs. El modo A **cierra con HANDOFF al entregar los TCs**: **prohibido**
retener el subagente vivo con mensajes de «espera a la implementación» para reusarlo como modo B —
el modo B es una **invocación nueva** tras `Resolved`. Un qa-agent retenido >30 min esperando
código es desperdicio de contexto/wall-time, no paralelismo.

**Tras `Resolved` (no negociable):** lanzar `qa-agent` (`Agent`/`Task`) en **modo B** como
**gate de calidad de desarrollo** (`Contexto: desarrollo-gate`) **antes** de dar la HU por
«entregada a QA»:

| Tipo de work item | Modos mínimos | Precisión exigida en HANDOFF |
|---|---|---|
| AC Gherkin / FRONTEND | A (si faltan TCs) + **B** (alcance AC: spec/módulo filtrado) | Matriz AC→TC; re-run propio; PASS / FAIL / SIN-ENTORNO |
| BACKEND-only | **B** Vitest del módulo (filtrado); E2E declarado si se omite | Comando + salida real de **esta** invocación |
| **Bug** | **B** con alcance repro + regresión del módulo (A antes si no hay TC del repro) | Repro rojo→verde con salida real; TC de regresión nombrado |
| Entorno caído | Invocar igual | Fast-path `SIN-ENTORNO` (≤2 checks); del **agente**, no del hilo |

**FAIL del gate B:** reactivar la HU a `Active` y corregir vía `backend-agent` / `frontend-agent`.
**Prohibido** encadenar **modo C** / crear Bug / `QA_NOVEDAD` porque falló el 6b — FAIL de
desarrollo ≠ defecto formal. Modo C solo si el **QA lo pide explícitamente** (etapa formal).

**Prohibido:** comentario HTML de entrega como sustituto; «QA pendiente» sin Agent; inventar
`QA_PDN`; copiar stdout del impl como evidencia QA sin re-run; suite monorepo local como único
criterio de PASS del gate B (el alcance AC basta; CI cubre la suite completa); seguir a la
siguiente HU sin fila `qa=` en el ledger; tratar FAIL del gate como «novedad con Bug».

En cadena apilada se puede arrancar la siguiente HU **solo si ya se invocó** `qa-agent` en la
actual **y** el resultado no es `FAIL` (aunque quede `SIN-ENTORNO`). Con `FAIL`: re-trabajo
antes de presentar la HU como entregada. Sin HANDOFF de `qa-agent` en las HUs del Feature → no
declarar el Feature «listo para staging».

### 7. Siguiente HU (sin esperar merge humano ni “continúa”)

En **modo continuo** (defecto):

1. Tras PR + Modo A + qa del ledger en ✅/`SIN-ENTORNO` → **arrancar la siguiente HU de inmediato**
   (pista B), aunque el CI/merge de la actual aún no hayan terminado.
2. En paralelo, pista A: cuando CI esté verde y haya auth del Feature → merge + Modo B + rebase pila
   **sin** preguntar otra vez.
3. Si no hay autorización de merge: igual se apila la siguiente desde la rama previa; los PRs
   quedan abiertos para merge humano — **sin** quedarse idle.

En **modo secuencial** (opt-in): no arrancar la siguiente hasta merge de la actual; durante la
espera de CI, **monitorear y mergear** (si auth), no pedir al humano que despierte el hilo.

Al terminar todas, reportar: HU, rama, PR, eslabón, estado del pipeline, merges hechos y PRs
pendientes.

## Reglas innegociables

1. **Nunca `git add -A` ni `git add .`** — el working tree puede tener parches de demo que no deben
   commitearse. Listar archivos explícitamente y verificar con `git status --short`.
2. **Merge solo a `develop`**, y solo con autorización del Feature (o "sí" por PR) + precondiciones
   de `flit-integration-ado` en verde. **Nunca** mergear a `staging` ni `release`.
3. **Nunca `Resolved` con build local en rojo o con CI remoto ya fallido.** CI remoto `pending`
   no bloquea Resolved ni la siguiente HU en cadena; sí obliga a seguir monitoreando hasta merge
   o rojo.
4. **Nunca abrir el PR sin el paso 4b en verde** — `flit-code-review` y, cuando aplique,
   `security-agent` y/o `db-review-agent`. La seguridad y el esquema no son opcionales ni quedan
   a criterio del momento. Un «crea el PR» del humano **no** salta el 4b: solo autoriza el
   `create_pull_request` cuando los gates ya están en verde (ver `.cursor/rules/pre-pr-gates.mdc`).
5. **Nunca commitear secretos** ni `.env`.
6. **Una rama por HU, siempre ligada a un work item.** Sin HU o Bug en ADO no hay rama ni PR.
   Nombre `HU/<ID>-<desarrollador>-<desc>` y título `HU <ID>: <descripción>` — formato estricto de
   `.cursor/rules/convenciones-rama-pr.mdc`, bloqueado por el check CI `naming`. En modo continuo,
   la N-ésima nace de la rama de la (N-1) o de `develop` tras merge del eslabón previo; en modo
   secuencial, de `develop` actualizado. Dejarlo escrito en el cuerpo del PR.
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
11. **Nunca crear Feature/HU/Bug/Task sin `System.AssignedTo`** (identidad de sesión — `AGENTS.md` /
    `flit-azure-devops`). Vacío = FAIL de proceso; corregir antes de seguir.
12. **Nunca estancar tras abrir el PR** pidiendo al humano «continúa» solo porque CI está en curso.
    Pistas A (monitor→merge) y B (siguiente HU) según Anti-estancamiento post-PR.

## Cuándo parar y preguntar

- Un Acceptance Criteria es ambiguo o contradice el código existente.
- Hace falta una decisión de negocio que no está en la HU.
- El cambio exige tocar algo fuera del alcance del Feature.
- Un test que ya existía empieza a fallar por una razón no obvia.
- Un PR de la pila recibe cambios pedidos en revisión (hay que rebasar los eslabones encima).

## Checklist de salida por HU o Bug

- [ ] Padre en `Active` si existe (regla de `AGENTS.md`); Bug sin padre → declarado
- [ ] Esta skill cargada al inicio del Feature / lote (no ciclo improvisado)
- [ ] Work item en `Active` al empezar, **`Resolved` al terminar** — vía **Skill** `flit-gestion-hu` (no wit_* branded). Vale igual para Bugs: ninguno queda en `Active` con su fix mergeado
- [ ] Rama `HU/<ID>-<desarrollador>-<desc>` o `BUG/<ID>-…` creada (desde `develop` o desde la rama previa, según el modo)
- [ ] Título del PR `HU <ID>: <descripción>` o `BUG <ID>: <descripción>` (≤ 100 car., mismo ID que la rama) — `check-naming.mjs` en verde
- [ ] En cadena: dependencia y eslabón declarados en el cuerpo del PR
- [ ] Diseño previo: `architecture-agent` / `ux-agent` en slim|full **o** «no aplica» declarado en PR
- [ ] Implementación vía **Agent** `backend-agent` / `frontend-agent` con prompt denso (no código de HU completa en el hilo)
- [ ] (Recomendado) **Agent** `qa-agent` modo A en paralelo con AC listos
- [ ] Todos los AC cubiertos
- [ ] Mínimo local del alcance en verde (filtrado); CI = gate de suite completa
- [ ] **Skill** `flit-code-review` con veredicto **OK** **antes** del PR (único éxito; `OK-CON-OBSERVACIONES` = retrabajo o waiver, no abre el PR), cargada **en este turno** (no reusada de HUs previas) y amarrada al `SHA revisado`
- [ ] Sin commits post-veredicto sin re-review: el HEAD del PR/merge == `SHA revisado` del veredicto vigente
- [ ] `security-agent` (diff-scoped) si superficie sensible (o "no aplica"); ∥ `db-review` si ambos aplican
- [ ] `db-review-agent` si esquema/migraciones (o "no aplica")
- [ ] Commit sin archivos colados (`git status --short` limpio)
- [ ] PR abierto contra `develop`
- [ ] **Skill** `flit-integration-ado` Modo A → `Custom.Commits` (no solo Discussion / no imitación)
- [ ] **Skill** `flit-gestion-hu` → `Resolved` + plantilla entrega QA (local verde; CI pending OK con monitor activo)
- [ ] **Agent** `qa-agent` invocado con HANDOFF (`PASS` = único éxito / `FAIL` / `SIN-ENTORNO`; `PASS-CON-OBSERVACIONES` se trata como FAIL). Si `FAIL` o CON-OBS sin waiver → HU a `Active` + corregir hasta **PASS**; **sin** modo C
- [ ] Ledger de la HU pegado en el reporte del hilo, con hora de carga de cada Skill (`FAIL-retrabajo` si aplica)
- [ ] Pista A activa: CI monitoreado; con auth → merge al verde **sin** re-preguntar; **Skill** Modo B
- [ ] Pista B: siguiente HU arrancada si aplica (no idle «esperando continúa»)
- [ ] Tras Modo B / fin de ráfaga: **Agent** `devops-agent` M1 (o HANDOFF `SIN-ACCESO`)
- [ ] Siguiente HU solo si `qa=` del ledger es ✅ o `SIN-ENTORNO` (no con `FAIL-retrabajo` ni ❌)
