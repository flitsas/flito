---
name: flit-modo-desarrollo-auto
description: |
  Modo auto por Feature (FLIT - FLITO): cadena apilada. Cargar ESTA Skill al arrancar el Feature — no improvisar el ciclo.
  Por CADA HU **o Bug** (mismo ciclo — paridad de AGENTS.md): Skill flit-gestion-hu (Active) → architecture/ux slim|full si aplica → Agent backend/frontend (prompt denso; NUNCA codear la HU/Bug en el hilo) → verificación P1 (archivos de este WI, no glob del módulo; impl no muta) → Agent qa-agent B + Skill flit-code-review + Skill flit-ayuda-flito (si aplica) ANTES del PR (+ security diff-scoped ∥ db-review si disparan) → PR → Skill flit-integration-ado Modo A → monitor CI + merge al verde → Skill flit-gestion-hu Resolved (comentario al QA humano; NO relanzar qa-agent) → Modo B → devops M1 una vez al tip.
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
- `flit-ayuda-flito` — delta de ficha in-app o N/A declarado (paso 4b); gate duro si el módulo ya tiene ficha
- `security-agent` / `db-review-agent` — gates pre-PR cuando el diff lo dispara (paso 4b)
- `qa-agent` — TCs (A, en `Active`) + gate B **pre-PR** (**Agent en cada HU que aplique**); **prohibido** modo C por FAIL del gate; **prohibido** relanzarlo tras el PR
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
<HU|Bug> #<id> ledger: gestion=Skill✅(HH:MM)|❌ · impl=Agent✅|❌ · code-review=Skill✅(HH:MM)|❌ · security=✅|N/A · db=✅|N/A · integration-A=Skill✅(HH:MM)|❌ · qa=HANDOFF✅|SIN-ENTORNO|FAIL-retrabajo|❌ · estado=Resolved✅|❌ · pr-monitor=Agent MERGED|CI-EN-CURSO|CI-ROJO|CONFLICTO|❌ · integration-B=Skill✅(HH:MM)|N/A · M1=Agent✅|N/A
```

`estado=Resolved` es la casilla que delata al **Bug huérfano**: si el work item se mergeó y el
ledger no puede marcarla, el ciclo no está cerrado.

Cada ✅ de Skill lleva la **hora de su carga en el turno de esa operación**. Una carga tiene
vigencia de **una operación** (una activación/cierre de HU, un code-review, un Modo A, un Modo B):
en cadena apilada cada eslabón **recarga** la skill en su turno. Una carga de la HU anterior o de
hace horas en la misma sesión **no cuenta** — es la imitación más frecuente (veredicto «de
memoria»). Ver `.cursor/rules/skill-no-imitation.mdc`.

**Sin `qa=HANDOFF✅` (`PASS`) o `qa=SIN-ENTORNO` → no abrir el PR** ni presentar la HU como
verificada. `qa=FAIL-retrabajo` = gate B rojo **o** `PASS-CON-OBSERVACIONES` sin waiver: corregir
hasta **PASS**, **sin** Bug/modo C y **sin** abrir el PR. En ráfaga, la invocación de `qa-agent`
es el gate pre-PR; `SIN-ENTORNO` (QA pendiente de entorno) no finge PASS, pero el Agent **debe**
haberse lanzado. Tras el PR el ledger de QA ya no se toca: sigue el `pr-monitor-agent`.

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

**Qué no cambia:** una rama por HU; gates por HU (tests, `qa-agent` B, `flit-code-review`, `security-agent` /
`db-review-agent` si aplica — **todos pre-PR**); HU a `Resolved` **tras el merge**; post-Deploy
`devops-agent` M1; merge a `staging`/`release` siempre humano (`flit-release`).

### Anti-estancamiento post-PR (obligatorio — rompe la agilidad si se viola)

Abrir el PR **no** es un gate humano de “espera a que te digan sigue”. Tras `create_pull_request`
+ Modo A (+ Resolved/qa según ciclo), el hilo **debe** mantener el Feature en movimiento.

| Pista | Qué hace | No hace |
|---|---|---|
| **A — CI → merge** | **Delegada al `Agent pr-monitor-agent`** (en background) con el **número del PR**: él monitorea los checks, hace triage del log rojo, detecta conflictos y **mergea a `develop`** cuando CI está verde. Éxito = `MERGED`. | No termina el turno con «PR abierto, avísame cuando CI pase»; no vigila los checks a mano con `pull_request_read` suelto; no relanza `qa-agent` B (ese gate ya es pre-PR); no retiene el merge por falta de SHA/QA/«sí» en el prompt |
| **B — Siguiente HU** | En cadena apilada, **arranca la siguiente HU** (Active → diseño si aplica → impl) desde la rama previa **mientras** corre el CI de la actual, si el ledger `qa=` de la actual ya es ✅ o `SIN-ENTORNO` (cerrado **antes** del PR) | No se queda idle solo porque el merge aún no ocurrió |

**Prohibido (anti-patrones de estancamiento):**

1. Terminar el turno pidiendo al humano que diga «continúa» **solo** porque el PR está abierto o el CI está `pending`/`in_progress`.
2. Bloquear toda la ráfaga esperando CI en un bucle vacío sin avanzar la pista B (siguiente HU apilada).
3. Re-preguntar si se puede mergear a `develop` un PR cuyo CI ya está verde (salvo opt-out «no mergees»).
4. Tratar “PR creado” como fin del trabajo de la HU cuando aún faltan monitor CI, merge a `develop` o la siguiente HU del Feature.
5. Quedar idle tras un merge con la **cola post-merge pendiente** (Modo B, `devops-agent` M1, QA retro de la ráfaga): esa cola se ejecuta **en el mismo ciclo**, no es trabajo diferible.
6. Mantener subagentes vivos con mensajes de «espera» (p. ej. qa-agent modo A retenido esperando la implementación): cada modo es una invocación acotada que cierra con HANDOFF.
7. Preguntar al humano «qué debo hacer», «qué te queda», «qué sigue» cuando el siguiente paso está en la matriz de `AGENTS.md` (22 ago: varias sesiones lo devolvieron a David). El siguiente ejecutor se invoca; no se consulta.
8. Codear un WI de **otro** Feature porque ADO lo muestra como siguiente. Dueño = esta sesión + bloque orchestrator si hay paralelo.

**Espera legítima (NO es estancamiento ni ineficiencia):** detenerse a esperar al humano ante una
decisión de negocio, un gate humano (promoción, despliegue, opt-out «no mergees»), un
AC ambiguo o un permiso faltante es **obligatorio** — las decisiones importantes las toma el
humano, no los agentes. El anti-estancamiento aplica solo a trabajo **ya autorizado y ejecutable**
(CI verde sin merge hecho, Modo B/M1 pendientes, siguiente HU lista).

**Cómo monitorear CI sin congelar el hilo:**

1. Tras el push/PR + Modo A: lanzar `Agent pr-monitor-agent` **en background** (contrato: el número del PR basta; cadena apilada u opt-out «no mergees» solo si aplican — ver `.claude/agents/pr-monitor-agent.md`).
2. Arrancar de inmediato la pista B (siguiente HU/Bug). El hilo **no** hace polling propio de check-runs: eso es trabajo del subagente, que espera el CI hasta estado terminal (~90 min).
3. Su HANDOFF decide: `MERGED` → cola post-merge (Modo B + M1 + rebase de la pila) en el **mismo ciclo**, sin preguntar de nuevo · `CI-EN-CURSO` → **relanzarlo ya** (mismo PR) · `CI-ROJO` / `CONFLICTO` → delegar al agente dueño que él nombra · `LISTO-PARA-MERGE` solo si GitHub rechazó el merge (permisos / branch protection), no por un dato que el prompt no trajo.
4. Si el veredicto es `CI-ROJO` con causa `CODIGO` → **sí** pausar esa HU/pila, delegar la corrección al agente dueño, comentar en Discussion e informar al humano (única pausa legítima por CI). Con causa `INFRA` el subagente ya relanzó el job una vez: no relanzarlo otra vez a mano.

**Cuándo sí se pausa** (única excepción al continuo): CI rojo de la HU actual, veredicto
`BLOQUEADO`/`FAIL` en el paso 4b, cambios pedidos en revisión de un PR de la pila, AC ambiguo o
decisión de negocio pendiente. En esos casos se para **esa** HU (o la pila afectada), se deja
comentario en Discussion y se informa al humano — no se sigue construyendo encima de rojo.

**Modo secuencial (opt-in):** solo si el humano pide explícitamente "una HU a la vez", "espera el
merge" o "secuencial". Entonces cada HU nace de `develop` actualizado; el `pr-monitor-agent`
mergea tras CI verde antes de arrancar la siguiente. **Aun así**, no pide
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
   - Oficio: `docs/ux/_principios-flito.md` (FLITO, claridad, una primaria, sin efectos). El prompt nombra el **público** (operador vs Cliente) y una análoga del mismo público.

El prompt del Task debe ser **denso** (AC pegados, paths, modo slim|full, público). No empezar el paso 3 sin entregables cuando el disparador exige full/slim. Un UX HANDOFF sin oficio (jerarquía / primaria / vacío útil) no desbloquea al `frontend-agent`.

### 2b. Merge a `develop` (tras CI verde)

El **`Agent pr-monitor-agent`** ya lanzado en el anti-estancamiento **mergea** cuando el CI está
verde y no hay conflictos. No hay un segundo «sí». Opt-out: el humano dijo «no mergees».

1. El subagente verifica las condiciones GitHub de `flit-integration-ado` (base = `develop`,
   checks CI en `success` — incluido `naming` —, sin conflictos) y mergea con MCP `github`
   (`merge_pull_request`, merge commit) — **nunca** a `staging`/`release`. El hilo solo mergea
   por su cuenta si el subagente devolvió `CI-EN-CURSO` (relanzarlo ya) o GitHub rechazó el merge.
2. Del HANDOFF del subagente se toma el **SHA del merge commit** para el Modo B.
3. **`Skill flit-integration-ado` Modo B** (Deploy DEV + Commits integrado en `Custom.Commits`).
4. Tras Modo B (o al cerrar una ráfaga de merges de la pila): invocar **`Agent devops-agent` M1** una vez
   sobre el tip/ambiente DEV — no por cada PR intermedio, **tampoco cero**. El prompt lleva el **SHA
   esperado** (tip). Un `curl` del hilo no sustituye el Agent. Correlación: SSH **o** CD de GitHub
   Actions (`cd.yml`); **prohibido** decir que DEV «está roto» si `/api/health` está 200 (eso es
   DESFASE o CD en curso). Si no hay acceso, HANDOFF `SIN-ACCESO` (no fingir VERDE).
5. Rebasar las ramas pendientes de la pila sobre `origin/develop` y
   `git push --force-with-lease` solo de la rama propia.

**Tras cada merge (agente o humano) de un eslabón:** rebasar las ramas pendientes sobre `develop`
(`git fetch origin && git rebase origin/develop`) y force-with-lease solo de la rama propia.

### 3. Desarrollo

Invocar **`backend-agent`** y/o **`frontend-agent`** (`Agent`/`Task`) según el tipo de HU.
**Prohibido** implementar una HU completa «de paso» en el hilo principal — también la primera HU
del Feature y las de «solo esquema/migración/seeds». Excepción única: fix ≤~20 líneas en un
archivo tras HANDOFF, o pedido explícito del humano. Cumplir los AC uno a uno (`AGENTS.md`).
No ampliar el alcance a otras HU. Pasar prompt denso (AC + paths + decisión de diseño +
prohibiciones operativas: **no** `git add -A`/`.` ni staging masivo, **no** commits, verificación
**P1** — archivos de este WI, no glob del módulo ni mutantes; no suite completa local salvo umbral
transversal).

### 4. Tests y pipelines

**Mínimo local vs CI** (cada comando del mínimo debe pasar con salida real; prohibido inventar). Alcance = **P1** de `AGENTS.md` (archivos de este WI, no el directorio del módulo):

| Toque | Local mínimo | CI (gate suite completa) |
|---|---|---|
| API de este WI | `npm test -w apps/api -- <archivos *.test.ts de este WI>` + `build:api` si tipos | suite API completa |
| Web página | `typecheck -w apps/web` + E2E del spec de la HU si entorno up | `build:web` + e2e smoke |
| shared-types / shared API / schema transversal | build shared-types + greps + tests afectados / suite API | completo |
| Shell / router / login | typecheck + `test:e2e:smoke` si entorno | completo |

Comandos de referencia (aplicar según la fila; no correr la lista entera «por costumbre»):

```bash
npm run build -w packages/shared-types   # si shared-types
npm run test:shared-types                # si shared-types
npm run check:hooks                      # si hooks
npm run build:api                        # si tipos API
npm test -w apps/api -- <archivos *.test.ts de este WI>  # default P1
npm run test -w apps/api                 # solo umbral transversal
npm run build:web / typecheck -w apps/web
npx playwright test e2e/tests/<spec>.spec.ts   # spec de esta HU
npm run test:e2e:smoke -w apps/web       # shell/login o pedido explícito
```

Migraciones de BD: exportar `DATABASE_URL` (`set -a; source apps/api/.env; set +a`). Validar **el archivo nuevo** contra BD demo ya migrada y **correrla dos veces** (P6). **Prohibido** `CREATE DATABASE` + cadena histórica.

```bash
docker exec -i flito-postgres psql -U flito -d flito_demo -v ON_ERROR_STOP=1 < <migracion>.sql
```

**Nunca** `drizzle-kit migrate`. Avisar al usuario de que se tocó su BD local.

Tras el push y el PR, **Anti-estancamiento post-PR**: lanzar `Agent pr-monitor-agent` (background);
en paralelo avanzar la siguiente HU si el ledger lo permite; al verde él mergea.

**Si CI falla: arreglarlo y repetir. No apilar encima de rojo.**

### 4b. Revisión, QA y seguridad pre-PR (gate obligatorio)

Con el diff (`git diff origin/develop...HEAD`), **antes** de abrir PR (**cada HU**).
**El PR significa desarrollo completo y verificado.** Tras abrirlo solo corre el `pr-monitor-agent`.

1. **`Agent qa-agent` modo B** (re-run P1; mutantes ≤3). `FAIL` → corregir; **no** abrir PR; **no** Bug.
2. **`Skill flit-code-review`** (veredicto canónico). `BLOQUEADO` → corregir; no abrir PR.
3. **`Skill flit-ayuda-flito`** si HU FRONTEND o Bug cambia el comportamiento visible de un módulo **con ficha**. Sin delta de ayuda → **no** abrir PR. N/A (declarar): BACKEND-only, copy/a11y, CHORE/DOCS, Bug que no cambia lo que se ve/hace, módulos sin ficha aún.
4. **`security-agent` (diff-scoped)** si superficie sensible (P5: no en copy/CSS/tests-only). `FAIL` → corregir **en el mismo hilo**.
5. **`db-review-agent`** si toca `schema.ts` o migraciones. Críticos → corregir vía backend. No re-auditar por una Nota.
6. 1+2+3 y, si aplican, 4+5: lanzar en el mismo turno lo que sea independiente (QA ∥ code-review; security ∥ db-review).
7. Si un gate no aplica → declararlo en el cuerpo del PR.
8. Hallazgo de **este** diff → se corrige aquí (veredicto limpio). Deuda preexistente → Nota (P4/P9), nunca Bug.

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

### 6. Cerrar la HU o el Bug (**tras el merge**)

**`Skill flit-gestion-hu` Paso 3:** `System.State` → **`Resolved`** + comentario de entrega al QA
**humano** de ambiente (plantillas de la skill; la de Bug añade causa, corrección y repro verificado).
Condición mínima: PR **mergeado** a `develop` (HANDOFF `pr-monitor=MERGED`) y `qa-agent` B ya
pasó **antes** del PR. **Un Bug no se salta este paso**: cerrar el ciclo sin `Resolved` es dejarlo
huérfano. **Prohibido** lanzar `qa-agent` B en este paso. No cerrar con `wit_*` sueltos sin la skill.

### 6b. QA (obligatorio — **pre-PR**, no post-Resolved)

El gate `qa-agent` modo B vive en el **paso 4b**, no aquí. Esta sección solo recuerda:

**Temprano (recomendado):** con la HU en `Active` y AC Gherkin listos, lanzar `qa-agent` **modo A**
en paralelo al paso 3 (TCs / Tasks hijas). El modo A **cierra con HANDOFF al entregar los TCs**.

**Antes del PR (no negociable):** paso 4b. FAIL = retrabajo, **sin** abrir el PR, **sin** Bug/modo C.

**Prohibido:** comentario HTML de entrega como sustituto del gate; relanzar modo B tras
`create_pull_request`; copiar stdout del impl; glob del módulo; segundo qa-agent para una Nota (P4);
inventar HUs/Bugs por hallazgos (P9).

### 7. Siguiente HU (sin esperar merge humano ni “continúa”)

En **modo continuo** (defecto):

1. Tras PR + Modo A + qa del ledger en ✅/`SIN-ENTORNO` → **arrancar la siguiente HU de inmediato**
   (pista B), aunque el CI/merge de la actual aún no hayan terminado.
2. En paralelo, pista A: cuando CI esté verde → `pr-monitor-agent` mergea + Modo B + rebase pila
   **sin** preguntar.
3. Un «no mergees» explícito: igual se apila la siguiente desde la rama previa; ese PR queda
   abierto — **sin** quedarse idle.

En **modo secuencial** (opt-in): no arrancar la siguiente hasta merge de la actual; durante la
espera de CI, **monitorear y mergear**, no pedir al humano que despierte el hilo.

Al terminar todas, reportar: HU, rama, PR, eslabón, estado del pipeline, merges hechos y PRs
pendientes.

## Reglas innegociables

1. **Nunca `git add -A` ni `git add .`** — el working tree puede tener parches de demo que no deben
   commitearse. Listar archivos explícitamente y verificar con `git status --short`.
2. **Merge solo a `develop`**, cuando CI verde y sin conflictos, vía `pr-monitor-agent`.
   Opt-out: el humano dijo «no mergees». **Nunca** mergear a `staging` ni `release`.
3. **Nunca `Resolved` antes del merge** ni con CI remoto ya fallido. CI remoto `pending` no
   bloquea la siguiente HU en cadena; sí obliga a seguir el `pr-monitor` hasta `MERGED` o rojo.
   `Resolved` es el Paso 3 **después** de `MERGED`.
4. **Nunca abrir el PR sin el paso 4b en verde** — `qa-agent` B, `flit-code-review`, `flit-ayuda-flito`
   (si aplica) y, cuando aplique, `security-agent` y/o `db-review-agent`. Un «crea el PR» del humano **no** salta el 4b.
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
    **`qa-agent` B pre-PR (no tras el PR ni en paralelo al monitor)**; **`devops-agent` M1 al tip tras Modo B / ráfaga**.
    Sustituir cualquiera por prosa, curl o PATCH ADO suelto = fallo de proceso (ver Contrato de
    invocación).
11. **Nunca crear Feature/HU/Bug/Task sin `System.AssignedTo`** (identidad de sesión — `AGENTS.md` /
    `flit-azure-devops`). Vacío = FAIL de proceso; corregir antes de seguir.
12. **Nunca estancar tras abrir el PR** pidiendo al humano «continúa» solo porque CI está en curso.
    Pistas A (monitor→merge) y B (siguiente HU) según Anti-estancamiento post-PR.

## Cuándo parar y preguntar

Estas preguntas **sí** (P9). Distinto de «qué sigue» / «puedo mergear» (prohibido).

- Un Acceptance Criteria es ambiguo o contradice el código/spec existente (centinelas, RN, ADR).
- Hace falta una decisión de negocio que no está en la HU (vacío vs error, persistir vs mostrar).
- El cambio exige tocar algo fuera del alcance del pedido — **preguntar**, no inventar HU/Bug.
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
- [ ] Mínimo local P1 en verde (archivos de este WI, no glob del módulo); CI = gate de suite completa
- [ ] **Agent** `qa-agent` modo B **antes del PR** con HANDOFF (`PASS` / `FAIL` / `SIN-ENTORNO`). `FAIL` → retrabajo, **no** abrir PR, **sin** modo C
- [ ] **Skill** `flit-code-review` con veredicto **OK** **antes** del PR (único éxito; `OK-CON-OBSERVACIONES` = retrabajo o waiver, no abre el PR), cargada **en este turno** (no reusada de HUs previas) y amarrada al `SHA revisado`
- [ ] **Skill** `flit-ayuda-flito` si el diff cambia UI de un módulo con ficha (delta o N/A declarado). Gate duro: sin delta no se abre el PR
- [ ] `security-agent` (diff-scoped) si superficie sensible (o "no aplica"); ∥ `db-review` si ambos aplican
- [ ] `db-review-agent` si esquema/migraciones (o "no aplica")
- [ ] Commit sin archivos colados (`git status --short` limpio)
- [ ] PR abierto contra `develop` **después** de qa B + code-review en verde
- [ ] **Skill** `flit-integration-ado` Modo A → `Custom.Commits` (no solo Discussion / no imitación)
- [ ] **Agent** `pr-monitor-agent` invocado tras el PR (éxito = `MERGED`; `CI-EN-CURSO` → relanzar ya). **No** relanzar qa-agent
- [ ] **Skill** `flit-gestion-hu` → `Resolved` **tras `MERGED`** + plantilla al QA humano (el agente QA ya corrió pre-PR)
- [ ] Ledger de la HU pegado en el reporte del hilo, con hora de carga de cada Skill (`FAIL-retrabajo` si aplica)
- [ ] Pista A activa: merge al verde **sin** re-preguntar; **Skill** Modo B tras `MERGED`
- [ ] Pista B: siguiente HU arrancada si aplica (no idle «esperando continúa»)
- [ ] Tras Modo B / fin de ráfaga: **Agent** `devops-agent` M1 (o HANDOFF `SIN-ACCESO`)
- [ ] Siguiente HU solo si `qa=` del ledger es ✅ o `SIN-ENTORNO` (no con `FAIL-retrabajo` ni ❌)
