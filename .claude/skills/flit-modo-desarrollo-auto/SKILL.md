---
name: flit-modo-desarrollo-auto
description: Modo de desarrollo auto — ciclo completo y repetible por cada HU de un Feature en el proyecto FLIT - FLITO. Activa la HU en Azure, desarrolla en rama nueva desde develop, corre tests y pipelines, y cierra con commit + push + PR; luego repite con la siguiente HU hasta terminar el Feature. Triggers "modo de desarrollo auto", "modo auto", "implementa el feature completo", "sigue con la siguiente historia", flit-modo-desarrollo-auto.
---

# Modo de desarrollo auto

Ciclo cerrado por HU, repetido hasta que **todas** las historias del Feature quedan entregadas.
Esta skill **orquesta**; no duplica la lógica de las otras:

- `flit-azure-devops` — conexión MCP/REST, encoding, idempotencia
- `flit-gestion-hu` — estados `Active` / `Resolved` y comentarios
- `flit-integration-ado` — registro del PR en `Custom.Commits` y Deploy tras merge

## Entrada

El Feature padre (ej. `#10938`) o una lista de HU. Si solo dan el Feature, obtener sus hijas por
WIQL y ordenarlas por dependencias (las declaradas en *Dependencies* dentro de Acceptance Criteria).

## El ciclo (por cada HU, en orden de dependencias)

### 1. Activar en Azure

- `System.State` → **`Active`** vía `wit_update_work_item`.
- Comentario de inicio en Discussion (plantilla de `flit-gestion-hu`).
- Si la HU ya está `Active` o `Resolved`, **no** rehacer: continuar donde quedó.

### 2. Rama nueva desde develop

**Siempre** una rama por HU, **siempre** basada en `develop` actualizado:

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b feat/flito-hu<ID>-<slug-corto>
```

Convención de nombre: `feat/flito-*` (lo exige la precondición 2 de `flit-integration-ado`).

**Si la HU necesita código de otra HU cuyo PR aún no está en `develop`:**

| Situación | Estrategia |
|---|---|
| La HU previa ya tiene PR abierto sin merge | `git cherry-pick <sha>...<sha>` de los commits necesarios, o `git rebase --onto` |
| Se necesita la rama previa completa | Ramificar de ella: `git checkout -b feat/flito-hu<ID>-... feat/flito-hu<ANTERIOR>-...` y dejarlo dicho en el PR |
| Solo hacen falta tipos/esquema | Cherry-pick únicamente esos commits |

Dejar **constancia en el cuerpo del PR** de qué se trajo y de dónde, para que quien revise entienda
por qué el diff incluye cambios ajenos a la HU. Tras el merge de la HU previa, rebasar sobre
`develop` para que los commits duplicados desaparezcan.

### 3. Desarrollo

Cumplir los Acceptance Criteria de la HU, uno por uno, respetando el stack y las convenciones del
repo (ver `AGENTS.md` / patrones vecinos). No ampliar el alcance a otras HU.

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

Luego `flit-integration-ado` **Modo A**: registrar el PR en `Custom.Commits` y comentario en
Discussion. **Limitación conocida:** `mcp__azure-devops__wit_update_work_item` tipa el `value` como
string, así que **no** admite `op: add` sobre `/relations/-` — el Hyperlink formal al PR no se puede
crear por MCP. Dejar el enlace dentro de `Custom.Commits` y de Discussion, y avisar al usuario si
necesita la relación formal (habría que añadirla a mano o vía REST con PAT).

### 6. Cerrar la HU

`System.State` → **`Resolved`** + comentario de entrega a QA (plantilla de `flit-gestion-hu`), solo
si build y pipeline están en verde.

### 7. Siguiente HU

Volver al paso 1 con la siguiente historia del Feature. Al terminar todas, reportar al usuario el
resumen: HU, rama, PR, estado del pipeline.

## Reglas innegociables

1. **Nunca `git add -A` ni `git add .`** — el working tree puede tener parches de demo que no deben
   commitearse. Listar archivos explícitamente y verificar con `git status --short`.
2. **Nunca hacer merge del PR.** El merge es de un humano o del Líder Técnico. Esta skill llega
   hasta el PR abierto.
3. **Nunca `Resolved` con build o pipeline en rojo.**
4. **Nunca commitear secretos** ni `.env`.
5. **Una rama por HU**, siempre desde `develop` actualizado. No reutilizar la rama de otra HU salvo
   por la estrategia de dependencias del paso 2, y dejándolo escrito en el PR.
6. **No tocar `Custom.Evidences`** aquí (lo llena el rol de tests/QA) ni los campos `Deploy *`
   (los llena `flit-integration-ado` Modo B, post-merge).
7. Si una HU se bloquea (falta un dato de negocio, un permiso, un archivo de muestra), **parar esa
   HU**, dejar comentario en Discussion explicando el bloqueo, y continuar con la siguiente que no
   dependa de ella. Informar al usuario al final.

## Cuándo parar y preguntar

- Un Acceptance Criteria es ambiguo o contradice el código existente.
- Hace falta una decisión de negocio que no está en la HU.
- El cambio exige tocar algo fuera del alcance del Feature.
- Un test que ya existía empieza a fallar por una razón no obvia.

## Checklist de salida por HU

- [ ] HU en `Active` al empezar, `Resolved` al terminar
- [ ] Rama `feat/flito-hu<ID>-*` creada desde `develop` actualizado
- [ ] Todos los AC cubiertos
- [ ] Build, tests y pipeline en verde
- [ ] Commit sin archivos colados (`git status --short` limpio)
- [ ] PR abierto contra `develop`
- [ ] PR registrado en ADO (`flit-integration-ado` Modo A)
- [ ] Sin merge ejecutado
