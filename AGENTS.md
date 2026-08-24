# AGENTS.md — Reglas del repositorio FLITO

Fuente única de verdad para cualquier agente (humano o IA) que trabaje en este monorepo.
Los agentes de `.claude/agents/` y las skills de `.claude/skills/` **referencian** este archivo;
si algo en ellos difiere de lo aquí escrito, **manda este documento** y corrige el otro.

---

## El sistema

Monorepo **npm workspaces** (nunca pnpm, nunca yarn, nunca dotnet):

| Workspace | Qué es |
|---|---|
| `apps/api` | Express 4 + TypeScript **ESM** + **Drizzle ORM** + PostgreSQL + **Zod**. Módulos en `src/modules/<modulo>/` con el par `.routes.ts` / `.service.ts` (más `.cron.ts` opcional). Esquema en `src/db/schema.ts`, migraciones en `src/db/migrations/`. Transversales en `src/shared/` (middleware `auth.ts`, `audit.ts`, `rateLimiter.ts`, `errorHandler.ts`, `pii-audit.ts`, `redis.ts`, `logger.ts` con pino, `metrics.ts`). Tests **Vitest + supertest** en `__tests__/` |
| `apps/web` | Vite 5 + React 18.3 + **react-router-dom 6** + **Tailwind CSS 4** (`@tailwindcss/vite`). Páginas en `src/pages/`, cliente HTTP único en `src/lib/api.ts` (`BASE = '/api'`, token en `localStorage`, timeout 90 s). **No hay TanStack Query, ni Vitest, ni RTL**: los tests son **Playwright E2E** en `e2e/tests/` + `tsc --noEmit` |
| `packages/shared-types` | Contrato de tipos entre ambos, importado como `@operaciones/shared-types`. **No hay OpenAPI**: el contrato vive aquí y en los documentos de diseño |

Infra en el repo: `docker-compose.yml`, `docker-compose.prod.yml`, `ecosystem.config.cjs` (PM2), `scripts/`.
Dependencias externas ya integradas (la barra para añadir otra es alta): PostgreSQL, Redis, MinIO/S3, Google Drive API, OCR (Tesseract + motor Anthropic), firma digital (`@signpdf`), RUNT/RNDC.

**No existen aquí:** Next.js / App Router, .NET / C# / EF Core, Prisma / TypeORM, Clean Architecture por capas (`Domain/`, `Application/`), `services/core-api/`, `contracts/openapi/`, `frontend/`, `.cursor/workflows/`. Si un prompt menciona algo de eso, es contexto de otro proyecto: dilo y pide aclaración.

## Convención de módulos FLITO

Los módulos del producto FLITO llevan prefijo `flito-` (`flito-soat`, `flito-derechos`, `flito-impuestos`, `flito-tramites`…) y se montan bajo `/api/flito/<modulo>`. **Coexisten** con módulos legacy sin prefijo (`soat`, `tramites`, `liquidacion`): no los mezcles ni los "unifiques" sin instrucción explícita. Todo diseño o cambio debe decir con cuál de los dos habla.

Las reglas de negocio documentadas viven en comentarios de cabecera de los módulos (llevan `RN-xx`) — respétalas.

## Reglas de código innegociables

### Backend (`apps/api`)

1. Patrón `routes` / `service`: la ruta valida (Zod) y traduce a HTTP; el servicio tiene la lógica y el acceso a datos vía Drizzle, y exporta clases `*Error` propias.
2. Imports relativos **con extensión `.js`** (`'../../shared/middleware/auth.js'`) — sin ella el build ESM falla.
3. SQL solo con el query builder de Drizzle o `sql` parametrizado — nunca concatenando strings.
4. Toda ruta con `authMiddleware` (más `requireRole` si aplica), salvo endpoint público explícito en la HU y comentado en el código.
5. Credenciales, hosts y rutas de bucket por `process.env` / `src/config` — nunca hardcodeadas.
6. Migraciones: **SQL plano escrito a mano** en `apps/api/src/db/migrations/`, numeración secuencial `NNNN_descripcion.sql`, idempotente cuando se pueda. Solo `0001-0004` salieron de `drizzle-kit generate`; de `0005` en adelante no se usa. Se aplican con `npm run db:apply` (runner propio con su tabla de aplicadas).
   - **Nunca** `drizzle-kit generate` ni `drizzle-kit migrate`: el journal se quedó en `0004`, así que el primero emitiría una migración recreando ~120 tablas y el segundo aplicaría 5 de 64, dejando la BD inconsistente.
   - Una migración **ya aplicada en cualquier ambiente no se modifica**: el runner calcula lo pendiente **por nombre de archivo**, así que la edición no se ejecutaría allá y quedaría deriva silenciosa entre el SQL en disco y el esquema real. Se corrige con una migración nueva. Editarla antes de aplicarla en ningún lado sí es seguro.
   - **Aplicarlas es manual fuera de local.** El job one-shot `migrate` de `docker-compose.yml` las corre en cada `up` y la api depende de él; `docker-compose.prod.yml` **no** tiene ese servicio y `cd.yml` no ejecuta `db:apply`. Tras un deploy que trae migración hay que correrla a mano (`docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/db-apply.js`), con `pg_dump` previo en producción. Si no, la app queda esperando un esquema que nadie creó.
   - Detalle y modos del runner en `apps/api/src/db/migrations/README.md`.
7. Cambiar un tipo en `packages/shared-types` exige `grep` obligatorio de sus usos en `apps/web`.

### Frontend (`apps/web`)

8. Datos **solo** vía `src/lib/api.ts` — nunca `fetch` suelto en un componente ni URL del API hardcodeada.
9. Toda vista con datos tiene sus **4 estados**: cargando, error (con reintento), vacío, lleno. Es bloqueante.
10. Toda página nueva se registra en `src/App.tsx` con `lazy()` + guarda de permiso (`hasPage` / `PageSlug`) — nunca import estático post-login.
11. `dangerouslySetInnerHTML` solo con sanitización en la misma expresión.
12. Accesibilidad bloqueante: `<label>` asociado a cada input, botón con texto o `aria-label`, foco visible, contraste ≥ 4.5:1.
13. Sin drift visual: replicar patrones de `components/flit/` y `components/shell/`; colores y espaciados de las utilidades Tailwind ya usadas, no de HEX sueltos.

### Seguridad y datos personales (Ley 1581 — Habeas Data)

14. Nunca loguear passwords, tokens, cédulas ni PII sin redactar (backend ni consola del navegador). **PII en URLs (path o query):**
    - **Prohibido siempre** en URLs de páginas web (`apps/web` rutas/query del router) y en logs de access: cédula, teléfono, dirección, correo personal, tokens, biométricos.
    - **API autenticada — default de diseño:** filtros con PII o cuasi-PII (cédula, NIT de persona/empresa monitoreada, placa, nombre) van en **body** (`POST …/buscar` o equivalente), no en query. IDs opacos (`uuid`) sí pueden ir en path.
    - **Excepción GET+query** solo si un ADR lo declara y `security-agent` lo acepta, con mitigaciones obligatorias: auth + `requireRole`, `logPiiAccess` en la lectura, DTO sin payloads crudos, y sin registrar la query en claro en access logs/logger.
    - Roles canónicos: solo los de `USER_ROLES` en `packages/shared-types/src/permissions.ts`. El rol `operaciones` **ya no existe** (fusionado en `admin`, CF-12): no diseñarlo ni usarlo en `requireRole` / matrices UX.
15. Nunca commitear secretos ni `.env*`. Un secreto real en el diff es **bloqueante absoluto**: se rota y no se mergea. Si un secreto real se **pega en el chat**, advertir de inmediato que quedó comprometido (los transcripts quedan en disco), recomendar rotación si se usa fuera de DEV, y nunca escribirlo a archivos del repo.
16. El producto maneja datos de conductores y propietarios: cifrado en reposo cuando aplica, registro en la auditoría PII (`apps/api/src/shared/pii-audit.ts`), política de retención declarada. Anclas: módulos `laft/` y `privacy/`.
17. `multer` siempre con `fileFilter` y `limits`; validación de MIME real, no solo por extensión.
18. Endpoints sensibles (auth, OCR, cargas masivas) con `rateLimiter`.

### Calidad y tamaño (gate `npm run lint`)

19. Archivos de producto ≤ **800 líneas** (sin contar blanks ni comentarios) — es `error` en ESLint y bloquea CI. Los 11 archivos legacy que hoy lo superan tienen **techo congelado** en `eslint.config.mjs` (ratchet: pueden bajar, no subir; al bajar de 800 se retira la entrada). Tests, specs y assets vendor no tienen límite.
20. `npm run lint` sin errores antes de abrir PR. Los warnings heredados son deuda visible: no sumes nuevos; al limpiar una categoría se sube de `warn` a `error` en `eslint.config.mjs` (ruta de endurecimiento gradual).

## Git flow

- **Trazabilidad estricta: todo desarrollo y todo PR va ligado a una HU o un Bug de Azure DevOps.** No se abre rama ni PR de producto sin work item; si el pedido llega sin él, primero `flit-intake` → `tech-lead-agent` / `flit-crear-hu`. Única vía sin work item: ramas `CHORE/` y `DOCS/`, acotadas a lo que **no es producto** (documentación, `.claude/`, `.cursor/`, tooling, CI, `scripts/`) — merge a `develop` con «sí» humano y CI verde, **sin** Modo A/B en ADO. En cuanto el diff toca `apps/**` o `packages/**` es desarrollo y exige HU o Bug.
- Una rama por HU/Bug, **siempre desde `develop` actualizado** (o de la rama previa en cadena apilada). Formato **obligatorio**, detalle en [`.cursor/rules/convenciones-rama-pr.mdc`](.cursor/rules/convenciones-rama-pr.mdc):

  | Rama | Título del PR |
  |---|---|
  | `HU/<ID>-<desarrollador>-<descripcion-breve>` | `HU <ID>: <descripción>` |
  | `BUG/<ID>-<desarrollador>-<descripcion-breve>` | `BUG <ID>: <descripción>` |
  | `CHORE/` · `DOCS/<desarrollador>-<descripcion-breve>` | `CHORE:` · `DOCS: <descripción>` |
  | Promoción (`develop`→`staging`→`release`) | `RELEASE: <descripción>` |

  Prefijo en MAYÚSCULAS, ID de ADO sin `#`, descripción en kebab-case sin acentos, rama ≤ 80 caracteres. **Sin sufijo de ambiente** (`-dev`/`-qa`/`-pdn`): la rama de trabajo siempre va a `develop` y el ambiente ya se registra en ADO (`Deploy DEV/QA/PDN`). Título ≤ 100 caracteres, descriptivo del cambio y su para qué (un «Ajustes» no cumple), sin punto final. La convención vieja `feat/flito-hu<ID>-*` queda **derogada** para ramas nuevas. Verificación local antes del push y del PR: `node scripts/check-naming.mjs --branch "$(git branch --show-current)" --title "<título>"`.
- **Nunca `git add -A` ni `git add .`**: el working tree puede tener parches de demo. Archivos explícitos + `git status --short` antes de commitear.
- `.claude/` **sí está versionado** (es el equipo de agentes/skills del repo): sus cambios se commitean como cualquier archivo. Lo que no se commitea: parches locales de demo (stubs de OCR, MinIO local).
- **Monitoreo del PR:** tras **cada** `create_pull_request`, el hilo principal invoca el subagente **`pr-monitor-agent`** (recomendado en background). Él vigila los checks, lee el log de los jobs rojos (clasificando flake de infraestructura —relanza **uno** solo— vs código), detecta conflictos (**no** los resuelve: nombra al agente dueño) y ejecuta el merge a `develop` si se cumplen las precondiciones. Termina en el merge: `flit-integration-ado` Modo B y `devops-agent` M1 los sigue ejecutando el hilo principal.
- **Merge a `develop`:** el agente (hilo principal, o el **`pr-monitor-agent`** por delegación) **puede** mergear vía MCP `github` (`merge_pull_request`) cuando el humano autorizó el Feature (o dio "sí" textual) **y** se cumplen las precondiciones de `flit-integration-ado` (base exactamente `develop`, CI `build + test` + `dependency-audit` + `secret-scan` en verde, sin conflictos; rama y título del PR con el formato de la tabla de arriba — check CI `naming` en verde; **HEAD a mergear = `SHA revisado` del veredicto vigente de `flit-code-review`** — commits post-veredicto exigen re-review; **gate `qa-agent` B en `PASS`** tras `Resolved` — nunca mergear con QA pendiente, `FAIL` o `PASS-CON-OBSERVACIONES` sin retrabajo/waiver). Estrategia: merge commit. Tras merge de HU → `flit-integration-ado` Modo B (Deploy DEV). En **cadena apilada**, si el CI de merges intermedios queda `cancelled` por concurrency, el gate de Deploy es el tip de `develop` que ya incluye la cadena (detalle en la skill).
- **Merge a `staging` / `release`:** siempre humano (`flit-release`). Ningún agente mergea promociones.
- Cerrar un Feature es exclusivo del Product Owner.
- **GitHub:** MCP `github` es la vía canónica (PR, checks, merge). En esta máquina **`gh` no es el CLI de GitHub** (visor de ayuda): comprobar con `gh --version` antes de asumir; si no es el CLI real, no usarlo.
- **Hook `pre-push` (versionado en `scripts/git-hooks/`, activo vía `core.hooksPath`)**: bloquea el push si gitleaks encuentra secretos en los commits que suben, o si hay vulnerabilidades **Critical** en dependencias de producción. High/Moderate avisan (CI `dependency-audit` bloquea el merge), y un nombre de rama fuera de convención también avisa (CI `naming` bloquea el PR). En un clone nuevo, activarlo una vez con `git config core.hooksPath scripts/git-hooks`. Escape manual documentado: `git push --no-verify`. Falsos positivos de gitleaks: justificados en `.gitleaks.toml` con scope estricto (nunca allowlist global).

## Verificación (salida real, nunca inventada)

**Mínimo local filtrado al alcance; suite completa en CI** salvo umbral transversal.

| Toque | Local mínimo (salida real obligatoria) | CI |
|---|---|---|
| API módulo | `npm test -w apps/api -- <paths>` (+ `build:api` si tipos) | suite API |
| Web página | `typecheck -w apps/web` + E2E del spec si entorno | build + e2e smoke |
| shared-types / `shared/` API / schema transversal | build shared-types + greps + tests afectados o suite API | completo |
| Shell / router / login | typecheck + `test:e2e:smoke` si entorno | completo |

Comandos de referencia:

```bash
npm run build -w packages/shared-types   # si se tocó shared-types (tsc -b)
npm run test:shared-types                # idem
npm run check:hooks                      # gate de Rules-of-Hooks (si aplica)
npm run lint                             # ESLint: max-lines 800 + react-hooks (errores bloquean)
NODE_OPTIONS=--max-old-space-size=8192 npm run build:api   # tsc -b && tsc-alias — ver nota de heap
npm test -w apps/api -- <paths>          # default filtrado
npm run test -w apps/api                 # solo umbral transversal o pedido explícito
npm run build:web                        # tsc --noEmit && vite build
npm run check:bundle                     # presupuesto de bundle (chunk de /login)
npx playwright test e2e/tests/<spec>.spec.ts  # E2E filtrado
npm run test:e2e:smoke -w apps/web       # shell/login o pedido explícito; entorno up
npm run smoke:prod / synthetic:check     # producción — SOLO con autorización explícita
```

**Heap de `build:api`.** El flag no es opcional ni una manía de una máquina: con el heap por defecto de Node (~2 GB en un equipo de 16 GB) `tsc -b` de `apps/api` muere con `FATAL ERROR: … JavaScript heap out of memory` y `npm` devuelve 134. El fallo NO es del código —con `--max-old-space-size=8192` el mismo árbol compila en ~30 s—, así que quien copie el gate sin el flag reporta un rojo que no existe. Verificado el 2026-08-20 (HU #11652, AC6): sin flag, OOM a los 56 s; con flag, verde. **Solo se reproduce con el árbol FRÍO:** `tsc -b` es incremental, y con los `.tsbuildinfo` calientes el comando sale en menos de un segundo con exit 0 y parece desmentir todo lo anterior. Para comprobarlo hay que borrarlos antes (`find apps packages -name '*.tsbuildinfo' -delete`). En CI y en la imagen (`apps/api/Dockerfile`, `NODE_OPTIONS=--max-old-space-size=4096`) el techo lo pone el entorno, no este comando.

Migraciones contra la BD demo local: exportar `DATABASE_URL` (`set -a; source apps/api/.env; set +a`), aplicar la migración sola con `docker exec -i flito-postgres psql …` y **correrla dos veces** para comprobar idempotencia. Avisar al usuario de que se tocó su BD.

En CI (`.github/workflows/ci.yml`) existen cuatro checks de gate: **`build + test`**, **`dependency-audit`**, **`secret-scan`** y **`naming`** (rama, título del PR y trazabilidad HU/Bug; solo corre en PRs) — los cuatro deben estar en verde para mergear (precondiciones de `flit-integration-ado`). La suite completa de tests en CI **no** se sustituye por el mínimo filtrado local.

Prohibido declarar una HU terminada sin la salida real pegada de los comandos del **mínimo aplicable**. Prohibido inventar tablas de resultados. Si el entorno no está levantado, se dice y se para (`SIN-ENTORNO` vía `qa-agent` cuando aplique).

Prohibido **atribuir al humano** instrucciones, decisiones o autorizaciones que no constan en la sesión (fabricación). Si una omisión o desviación fue decisión del agente, se declara como tal — nunca se justifica con un «el supervisor/humano lo pidió» inventado.

## Gestión del trabajo (Azure DevOps + GitHub)

- **Código:** GitHub `flitsas/flito` (`origin`). **Work items:** Azure DevOps Boards, proyecto **`FLIT - FLITO`** (con espacios; codificar en URLs REST).
- Toda lectura/escritura en ADO pasa por la skill `flit-azure-devops`: MCP servidor **`ado`** primero → REST (PAT) como fallback → borrador `.md` local. Nunca usar el id legado `azure-devops`.
- Ciclo de un work item de desarrollo (**HU o Bug** — ver «Paridad HU ↔ Bug»): `flit-gestion-hu` (Active → Resolved → entrega a QA). Creación: `flit-crear-hu` (HU y Bug). Registro PR ↔ ADO y Deploy DEV/QA/PDN: `flit-integration-ado`. Ciclo completo por Feature: `flit-modo-desarrollo-auto` (**cadena apilada por defecto**; merge a `develop` bajo gates tras autorización del Feature — ver Git flow). **Anti-estancamiento:** tras abrir el PR, delegar el monitoreo de CI y el merge al verde en `pr-monitor-agent` (con auth); en paralelo arrancar la siguiente HU — **prohibido** quedarse idle pidiendo «continúa» solo porque el CI está en curso.
- Features/HUs en ADO: audiencia PO + Tech Lead + desarrollo. **Funcional primero** (objetivo, flujo, criterios); **técnico al final** (módulos, esquema). Dueño de la redacción: `tech-lead-agent` (A/B) + `flit-crear-hu`.
- Nunca escribir en ADO sin un "sí" explícito del humano. Nunca asignar work items al sprint activo — siempre al siguiente.
- **`System.AssignedTo` obligatorio al crear** cualquier work item (Feature, User Story, Bug, Task): el humano de la sesión que pide desde Cursor — identidad del usuario autenticado en MCP `ado` (la que figura como `CreatedBy`; resolver con `core_get_identity_ids` si hace falta; si no está clara, preguntarla). **Prohibido** dejar el campo vacío o con placeholder. No confundir con `IterationPath` (sprint): “asignar al sprint” ≠ `AssignedTo`. Detalle operativo: skill `flit-azure-devops`.
- **Activar una HU exige que su Feature padre esté `Active`**: la skill que activa la HU (`flit-gestion-hu` / `flit-modo-desarrollo-auto`) pasa el padre de `New` a `Active` con comentario de inicio en su Discussion (si ya está `Active`, no rehacer; si la HU no tiene padre, se declara en el comentario). Un **Bug** con padre sigue la misma regla; un Bug **sin** padre se activa igual y se declara la ausencia. Lo valida `tech-lead-agent` modo C en el DoR. El cierre del Feature sigue siendo exclusivo del Product Owner.
- Tags por defecto: Features `DOR; adopcion-ia; fase-1-diseño`; User Stories `DOR; adopcion-ia`.
- **`System.Tags` con un tag nuevo va en petición aparte** — mezclarlo con otros campos falla con `TF401289` y tumba el patch completo.

### Paridad HU ↔ Bug (regla de proceso)

**Un Bug se trabaja exactamente igual que una Historia de Usuario.** Donde este documento, una
skill o un agente digan «HU», léase **work item de desarrollo = User Story (HU) *o* Bug**, salvo
que la línea diga explícitamente lo contrario. Mismo ciclo de estados, mismos gates, mismos
campos de trazabilidad, mismas menciones:

`New → Active` (con comentario de inicio) `→` implementación por `backend-agent`/`frontend-agent`
`→` `flit-code-review` `→` PR `→` `flit-integration-ado` Modo A `→` **`Resolved`** (con comentario
de entrega a QA) `→` `qa-agent` gate B `→` merge `→` Modo B (`Deploy *`) `→` `devops-agent` M1.
**`Closed` lo pone el PO/QA**, nunca un agente.

**Hard-stop — Bug huérfano:** ningún Bug queda en `Active` después de que su corrección se mergea,
ni pasa a `Resolved` sin el comentario de cierre y sin el gate `qa-agent`. «Ninguna skill mueve el
State de un Bug» dejó de ser cierto: lo mueve `flit-gestion-hu`, igual que en una HU. Un Bug
mergeado y sin `Resolved` es fallo de proceso, no una zona gris.

Las **diferencias** son de campos y de origen del criterio de prueba, no de ciclo (verificado
contra el proyecto real el 2026-08-22 sobre los Bugs #11518, #11599, #11604, #11622, #11649,
#11694, #11711 y #11720):

| Aspecto | User Story (HU) | Bug |
|---|---|---|
| Narrativa | `System.Description` (Como / quiero / para) | `Microsoft.VSTS.TCM.ReproSteps` (qué pasa · cómo reproducirlo · corrección esperada) |
| Criterio de prueba del gate QA | `Microsoft.VSTS.Common.AcceptanceCriteria` (Gherkin) | **El tipo Bug no tiene Acceptance Criteria**: el criterio es el repro (debe pasar de rojo a verde) + regresión del módulo tocado |
| Dimensionamiento | Story Points + `Custom.Refinement` | `Microsoft.VSTS.Common.Severity` + `Priority` (Story Points opcional: existe en el tipo) |
| Padre | Feature (se activa antes que la HU) | Feature o HU **opcional** — si no tiene, declararlo en el comentario de inicio |
| Trazabilidad del PR | `Custom.Commits` | **el mismo campo**, mismo HTML canónico |
| Deploy | `Custom.DeployDEV` / `DeployQA` / `DeployPDN` | **los mismos campos** |
| Evidencias | `Custom.Evidences` | mismo campo; si el PATCH lo rechaza en el tipo Bug, registrar la evidencia en Discussion y **decirlo** — nunca omitirla en silencio |
| Rama y PR | `HU/<ID>-…` · `HU <ID>: …` | `BUG/<ID>-…` · `BUG <ID>: …` (check CI `naming`) |

## Equipo de agentes y skills

| Necesidad | Ejecutor |
|---|---|
| Requerimiento informal → borrador canónico | skill `flit-intake` (+ [`docs/dominio.md`](docs/dominio.md)) |
| Planear un flujo multi-fase | `orchestrator-agent` |
| Features, HUs, DoR/DoD, deuda técnica | `tech-lead-agent` |
| Diseño técnico (slim\|full) | `architecture-agent` |
| Diseño UX/UI (slim\|full\|omit) | `ux-agent` |
| Código `apps/api` | `backend-agent` |
| Código `apps/web` | `frontend-agent` |
| TCs, gate post-Resolved (de HU **y de Bug**), regresión; radicar Bugs nuevos solo con pedido explícito del QA | `qa-agent` |
| Auditoría SCA/secretos/PII | `security-agent` |
| Auditoría del esquema de BD (normalización, FKs circulares, índices, drift de migraciones) | `db-review-agent` |
| Post-deploy, salud de ambientes/crons, rollback | `devops-agent` |
| Monitoreo del PR abierto (checks CI, conflictos) y merge a `develop` | `pr-monitor-agent` |
| Revisión de diff pre-PR | skill `flit-code-review` |
| Promoción develop→staging→release | skill `flit-release` |
| ADO (conexión) | skill `flit-azure-devops` |
| ADO (crear HU o Bug / ciclo del work item / PR ↔ ADO / feature completo) | skills `flit-crear-hu` / `flit-gestion-hu` / `flit-integration-ado` / `flit-modo-desarrollo-auto` |

Glosario de producto: [`docs/dominio.md`](docs/dominio.md). Pedido sin Feature/HU en ADO → skill `flit-intake` antes de crear work items o código.

### Matriz de invocación (obligatoria para el hilo principal)

El hilo principal **debe** invocar al ejecutor de la fila cuando se cumple el disparador, usando la
herramienta de delegación del runtime (`Agent` / `Task` / `Skill` con el **nombre exacto**). No
sustituir al especialista haciendo su trabajo «de paso» (salvo fix trivial de ≤~20 líneas en un solo
archivo, o pedido explícito del humano de no usar subagentes). Cada subagente cierra con `HANDOFF`;
el hilo principal es quien encadena.

**Qué cuenta como invocación (prueba mínima):**
- **Skill:** herramienta `Skill` con el nombre exacto **o** `Read` de su `SKILL.md` en el mismo turno **y** ejecución de sus pasos/plantillas/veredicto canónico (no solo citar el nombre).
- **Agent:** herramienta `Agent`/`Task` con `subagent_type` exacto **y** bloque `HANDOFF` en la salida del subagente.
- **Vigencia de la carga de Skill:** **una operación** (una activación/cierre de HU, un code-review, un Modo A, un Modo B). En cadena apilada cada eslabón recarga la skill en su turno; una carga de la HU anterior o de hace horas en la misma sesión no cuenta (detalle: `.cursor/rules/skill-no-imitation.mdc`).

**Qué no cuenta (imitación — prohibida):** checklist improvisado en el chat; comentario ADO «usando @flit-…» / branded **sin** haber cargado la skill; `wit_*` / `curl` sueltos; «gates cerrados» en prosa; reutilizar el veredicto de otra HU; abrir PR y «revisar después»; tests del `backend-agent` presentados como certificación QA; plan del hilo que diga «el hilo hace de paso» un rol de la matriz.

| Momento | Disparador (sí → invocar) | Ejecutor | Si se omite |
|---|---|---|---|
| Pedido informal sin Feature/HU | No hay WI en ADO; «hay unos bugs» / «termina Siigo» sin IDs | `flit-intake` | Trabajo sin trazabilidad |
| Alcance multi-fase / «por dónde empiezo» | Varias fases o duda de orden | `orchestrator-agent` (plan con Skill/Agent reales + ledger) | Fases saltadas / orquestación improvisada |
| ≥2 Features Active / varias sesiones en paralelo | Siigo + conciliación + comparendos a la vez; «retoma X» con Y también en vuelo | `orchestrator-agent` (bloque `DUEÑOS`) **antes de codear** | Deriva de alcance (un hilo codea el Feature del otro) |
| Feature / descomponer HUs / DoR | Planear o refinar backlog | `tech-lead-agent` | HUs mal cortadas |
| Retomar / «continúa» / «sigue con» un Feature | El Feature ya existía; la sesión es nueva o se reanudó | **Skill** `flit-modo-desarrollo-auto` **otra vez** (carga de hace horas no cuenta) | Ciclo de memoria / saltar gates |
| Antes de código no trivial | **full:** módulo/modelo/contrato nuevo o tradeoff (PII/auth/ext). **slim:** extensión de patrón vecino. **omit:** cambio mecánico (declarar en PR) | `architecture-agent` | Diseño implícito en el diff |
| Antes de UI nueva significativa | **full:** nueva ruta/PageSlug/wizard/bandeja o FRONTEND sin `docs/ux/`. **slim:** extensión de pantalla. **omit:** copy/a11y menor (declarar en PR) | `ux-agent` | UI inventada en el agent de código |
| Implementar `apps/api` | HU **o Bug** BACKEND, o diff en API/esquema/migración (**también la 1.ª HU / «solo esquema»**); tests filtrados al módulo por defecto | `backend-agent` | Lógica fuera de patrón / HU codeada en el hilo |
| Implementar `apps/web` | HU **o Bug** FRONTEND, o diff en páginas/componentes; E2E del spec por defecto | `frontend-agent` | 4 estados / permisos rotos |
| Pre-PR (siempre, **cada** PR) | Antes de `create_pull_request` (aunque el humano diga «crea el PR»); `security-agent` **no** lo sustituye | **Skill** `flit-code-review` | PR sin checklist / veredicto inventado |
| Pre-PR (sensible) | Auth, PII, multer, rutas nuevas, `package*.json`, laft/privacy — modo **diff-scoped**; ∥ `db-review` si ambos aplican | `security-agent` | Riesgo de seguridad |
| Pre-PR (esquema) | Toca `schema.ts` o `src/db/migrations/` — en paralelo con security si ambos aplican | `db-review-agent` | Drift / FKs / índices |
| Ciclo ADO Active→Resolved | Activar **o** cerrar **cada** HU **y cada Bug** que se trabaje (plantillas) | **Skill** `flit-gestion-hu` | Estados huérfanos / **Bugs huérfanos** / plantillas rotas |
| HU o Bug `Active` con criterio listo (ideal, en paralelo al dev) | Generar TCs temprano (AC Gherkin en HU; repro + regresión en Bug) | `qa-agent` **modo A** | TCs improvisados al cierre |
| Tras `Resolved` (Gherkin, UI, BACKEND-only **o corrección de Bug**) | Gate B con **alcance AC** — en Bug, alcance = repro que debe pasar de rojo a verde + regresión del módulo (re-run propio filtrado; suite completa en D/release/shell). Invocar aunque entorno falle (`SIN-ENTORNO` fast-path). FAIL → `Active` + corregir; **sin** Bug nuevo/modo C | `qa-agent` **modo B** (A si aún faltan TCs) | «Entregada a QA» sin HANDOFF |
| Hallazgo formal / novedad (ambiente QA u otra etapa post-entrega) | Radicar Bug **nuevo** solo con **pedido explícito del QA** | `qa-agent` **modo C** | Bug inventado en el ciclo de desarrollo |
| Al abrir PR / post-merge | PR↔ADO; Discussion **no** sustituye `Custom.Commits` | **Skill** `flit-integration-ado` A/B | Commits/Deploy vacíos |
| Tras `create_pull_request` (**cada** PR, incluidos `CHORE/`/`DOCS/`) | Vigilar checks, triage del log rojo (infra→1 relanzamiento / código→agente dueño), conflictos (solo informa) y **merge a `develop`** bajo precondiciones. Lanzarlo en background y seguir con la siguiente HU | `pr-monitor-agent` | PR a la deriva / turno cerrado con «avísame cuando pase el CI» |
| Tras Modo B con `Deploy*=true` | Ambiente desplegado o **fin de ráfaga** (una M1 al tip; curl del hilo no cuenta) | `devops-agent` M1 | Deploy sin smoke formal |
| Promoción staging/release | Pedido de promover | `flit-release` (+ qa D + devops post-merge) | Promoción sin gates |
| Feature completo en cadena | «modo auto» / feature completo | **Skill** `flit-modo-desarrollo-auto` (encadena la matriz **por HU o Bug** con Skill/Agent reales) | Ciclo improvisado |

#### Anti-patrones (prohibidos)

| Hacer esto… | …en lugar de | Gravedad |
|---|---|---|
| Codear la HU (o su migración) con `Edit`/`Write` del hilo | `backend-agent` / `frontend-agent` | Alta |
| Tabla «mi review» en el chat | Skill `flit-code-review` | Alta |
| Solo `security-agent` y abrir PR | Skill `flit-code-review` + security si aplica | Alta |
| Comentario ADO «usando @flit-gestion-hu» + `wit_*` sin cargar la Skill | Skill `flit-gestion-hu` | **Alta (imitación)** |
| Comentario «PR registrado» / branded integration sin `Custom.Commits` vía Skill | Skill `flit-integration-ado` | **Alta (imitación)** |
| Improvisar el ciclo del Feature sin `flit-modo-desarrollo-auto` | Skill `flit-modo-desarrollo-auto` | Alta |
| Plan que diga «el hilo hace de paso» roles de la matriz | `orchestrator-agent` con invocaciones reales | Alta |
| Comentario «listo para QA» y seguir / Vitest del backend como «QA» sin re-run del qa-agent | `qa-agent` (HANDOFF real) | **Alta** |
| Exigir suite monorepo local completa en cada HU «por costumbre» cuando el umbral es filtrado | Mínimo local de `AGENTS.md` + CI | Media |
| Architecture/UX **full** en extensión trivial de patrón/pantalla | slim u omit declarado | Media |
| Saltar `ux-agent` / `architecture-agent` y codear UI o módulo nuevo «porque ya sabemos» | disparador de la matriz (slim\|full\|omit **declarado**) | Alta |
| Crear Bug hijo / modo C porque falló el gate B de la HU recién `Resolved`, **o preguntar** «¿radico un Bug?» en desarrollo | Re-trabajo (`Active` + backend/frontend); modo C solo con pedido explícito del QA | **Alta** |
| Codear un Feature que no es el dueño de esta sesión (Siigo implementando conciliación) | `orchestrator-agent` bloque `DUEÑOS` | **Alta** |
| Decir que DEV/QA «está roto» con `/api/health` 200 | `devops-agent` M1: DESFASE o esperar CD, no rotura | Alta |
| Preguntar «qué debo hacer» / «qué sigue» cuando la matriz tiene el siguiente ejecutor | seguir el siguiente Skill/Agent; no devolver el trabajo al humano | Media |
| Retomar un Feature sin recargar `flit-modo-desarrollo-auto` | cargar la skill en ese turno | Alta |
| Dejar el Bug en `Active` tras mergear su corrección, o preguntar «¿lo paso a Resolved?» como si no hubiera proceso | Skill `flit-gestion-hu` cierra el Bug igual que una HU (Paridad HU ↔ Bug) | **Alta (Bug huérfano)** |
| Tratar un Bug como «work item de segunda»: sin comentario de inicio/cierre, sin `Custom.Commits`, sin gate `qa-agent` | Mismo ciclo y mismos campos que la HU | **Alta** |
| `curl /health` del hilo como «M1» | `devops-agent` M1 | Alta |
| Abrir el PR y cerrar el turno con «avísame cuando el CI pase», o vigilar los checks a mano con `pull_request_read` suelto | `pr-monitor-agent` (HANDOFF real) | Alta |
| Relanzar un job rojo «por si acaso», o dejar que un agente de código resuelva el conflicto sin que nadie lo diagnostique | `pr-monitor-agent`: relanza solo con señal de infra citada y **una** vez; el conflicto lo corrige el agente dueño que él nombra | Media |

**Ledger por HU o Bug (recomendado en modo auto):** al cerrar cada eslabón, listar en el reporte del hilo: `gestion ✅|❌ · impl-agent ✅|❌ · code-review ✅|❌ · security/db ✅|N/A · integration-A ✅|❌ · qa HANDOFF ✅|SIN-ENTORNO|FAIL-retrabajo|❌ · pr-monitor ✅|CI-EN-CURSO|CI-ROJO|❌ · merge · integration-B ✅|❌ · M1 tip ✅|N/A`. `code-review=✅` solo con veredicto **OK**; `security=✅` solo con **PASS**; `db=✅` solo con **SANO**; `qa=✅` solo con **PASS**. `*-CON-OBSERVACIONES` **no** es ✅ — es `FAIL-retrabajo` hasta el pase limpio (o waiver humano y re-gate). Sin fila `qa` en ✅/SIN-ENTORNO → la HU **no** está «entregada a QA». `FAIL-retrabajo` = gate rojo sin Bug; corregir antes de seguir.

**Operación solo-merge** («mergea los PRs», Modo B en lote): no inventar arquitectura/código; sí completar `flit-integration-ado` Modo B y **después** `devops-agent` M1 sobre el tip. Si las HUs o Bugs mergeados no tienen evidencia de `qa-agent`, o quedaron sin `Resolved`, declararlo en el reporte final («QA pendiente en: …», «sin cerrar: …») — no fingir que se ejecutó.

Los subagentes no pueden invocar a otros subagentes: cada uno devuelve un bloque `HANDOFF` y el hilo principal continúa. Gates humanos que **nunca** se omiten: activar una HU o Bug, crear rama/commit/push, abrir PR, **autorizar merge a `develop` del Feature** (una vez por Feature o "sí" por PR), merge a `staging`/`release`, cerrar un Feature, instalar herramientas, desplegar. El merge a `develop` bajo gates, tras esa autorización, lo ejecuta el agente **sin re-preguntar** cuando el CI esté verde. **No es gate** pedir al humano que despierte el hilo tras abrir el PR o mientras el CI está `pending` — ver Anti-estancamiento en `flit-modo-desarrollo-auto`.

**Éxito de una revisión final = limpio.** `flit-code-review`, `security-agent`, `db-review-agent` y `qa-agent` (B/D) **solo desbloquean** con `OK` / `PASS` / `SANO`. Heurística: si el hallazgo merece escribirse, se corrige en este WI y se re-ejecuta el gate hasta el veredicto limpio; si no merece corregirse (límite del repo, fuera de alcance por decisión humana, deuda preexistente que este diff no empeora, scanner ausente que ya era baseline), va a **Notas** y el veredicto sigue siendo limpio. `*-CON-OBSERVACIONES` **no es éxito ni el default** — en 21–24 ago fue ~80 % de los HANDOFF y dejó de distinguir un pase real. Sin waiver humano explícito en esta sesión, CON-OBSERVACIONES se trata como FAIL: retrabajo, no PR, no merge, no «entregada a QA».

**«Crea / abre el PR» no salta la matriz.** Ese pedido solo autoriza abrir el PR *después* de evaluar y ejecutar los gates Pre-PR de la tabla (`flit-code-review` siempre; `security-agent` / `db-review-agent` si el diff lo dispara). Veredicto distinto de `OK` / `PASS` / `SANO` (`BLOQUEADO`, `FAIL`, `*-CON-OBSERVACIONES` sin waiver, hallazgos críticos de esquema) → no llamar a `create_pull_request`. Si un gate no aplica, declararlo explícitamente (nunca omitirlo en silencio). Detalle operativo: `.cursor/rules/pre-pr-gates.mdc` y skill `flit-code-review`.
