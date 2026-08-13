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

14. Nunca loguear passwords, tokens, cédulas ni PII sin redactar (backend ni consola del navegador). Nunca PII en URLs.
15. Nunca commitear secretos ni `.env*`. Un secreto real en el diff es **bloqueante absoluto**: se rota y no se mergea.
16. El producto maneja datos de conductores y propietarios: cifrado en reposo cuando aplica, registro en la auditoría PII (`apps/api/src/shared/pii-audit.ts`), política de retención declarada. Anclas: módulos `laft/` y `privacy/`.
17. `multer` siempre con `fileFilter` y `limits`; validación de MIME real, no solo por extensión.
18. Endpoints sensibles (auth, OCR, cargas masivas) con `rateLimiter`.

### Calidad y tamaño (gate `npm run lint`)

19. Archivos de producto ≤ **800 líneas** (sin contar blanks ni comentarios) — es `error` en ESLint y bloquea CI. Los 11 archivos legacy que hoy lo superan tienen **techo congelado** en `eslint.config.mjs` (ratchet: pueden bajar, no subir; al bajar de 800 se retira la entrada). Tests, specs y assets vendor no tienen límite.
20. `npm run lint` sin errores antes de abrir PR. Los warnings heredados son deuda visible: no sumes nuevos; al limpiar una categoría se sube de `warn` a `error` en `eslint.config.mjs` (ruta de endurecimiento gradual).

## Git flow

- Una rama por HU, **siempre desde `develop` actualizado**: `feat/flito-hu<ID>-<slug-corto>` (lo exige la precondición de merge de `flit-integration-ado`). Ramas `docs/*` / `chore/*` sin HU: merge a `develop` con «sí» humano y CI verde; **sin** Modo A/B en ADO.
- **Nunca `git add -A` ni `git add .`**: el working tree puede tener parches de demo. Archivos explícitos + `git status --short` antes de commitear.
- `.claude/` **sí está versionado** (es el equipo de agentes/skills del repo): sus cambios se commitean como cualquier archivo. Lo que no se commitea: parches locales de demo (stubs de OCR, MinIO local).
- **Merge a `develop`:** el agente (hilo principal) **puede** mergear vía MCP `github` (`merge_pull_request`) cuando el humano autorizó el Feature (o dio "sí" textual) **y** se cumplen las precondiciones de `flit-integration-ado` (base exactamente `develop`, CI `build + test` + `dependency-audit` + `secret-scan` en verde, sin conflictos; HU → rama `feat/flito-*`). Estrategia: merge commit. Tras merge de HU → `flit-integration-ado` Modo B (Deploy DEV). En **cadena apilada**, si el CI de merges intermedios queda `cancelled` por concurrency, el gate de Deploy es el tip de `develop` que ya incluye la cadena (detalle en la skill).
- **Merge a `staging` / `release`:** siempre humano (`flit-release`). Ningún agente mergea promociones.
- Cerrar un Feature es exclusivo del Product Owner.
- **GitHub:** MCP `github` es la vía canónica (PR, checks, merge). En esta máquina **`gh` no es el CLI de GitHub** (visor de ayuda): comprobar con `gh --version` antes de asumir; si no es el CLI real, no usarlo.
- **Hook `pre-push` (versionado en `scripts/git-hooks/`, activo vía `core.hooksPath`)**: bloquea el push si gitleaks encuentra secretos en los commits que suben, o si hay vulnerabilidades **Critical** en dependencias de producción. High/Moderate avisan (CI `dependency-audit` bloquea el merge). En un clone nuevo, activarlo una vez con `git config core.hooksPath scripts/git-hooks`. Escape manual documentado: `git push --no-verify`. Falsos positivos de gitleaks: justificados en `.gitleaks.toml` con scope estricto (nunca allowlist global).

## Verificación (salida real, nunca inventada)

En local, según lo tocado, y **cada uno debe pasar antes de seguir**:

```bash
npm run build -w packages/shared-types   # si se tocó shared-types (tsc -b)
npm run test:shared-types                # idem
npm run check:hooks                      # gate de Rules-of-Hooks
npm run lint                             # ESLint: max-lines 800 + react-hooks (errores bloquean)
npm run build:api                        # tsc -b && tsc-alias
npm test -w apps/api                     # vitest run
npm run build:web                        # tsc --noEmit && vite build
npm run check:bundle                     # presupuesto de bundle (chunk de /login)
npm run test:e2e:smoke -w apps/web       # solo si toca UI y hay entorno levantado
npm run smoke:prod / synthetic:check     # producción — SOLO con autorización explícita
```

Migraciones contra la BD demo local: exportar `DATABASE_URL` (`set -a; source apps/api/.env; set +a`), aplicar la migración sola con `docker exec -i flito-postgres psql …` y **correrla dos veces** para comprobar idempotencia. Avisar al usuario de que se tocó su BD.

En CI (`.github/workflows/ci.yml`) existen tres checks de gate: **`build + test`**, **`dependency-audit`** y **`secret-scan`** — los tres deben estar en verde para mergear (precondiciones de `flit-integration-ado`).

Prohibido declarar una HU terminada sin la salida real pegada de los comandos anteriores. Prohibido inventar tablas de resultados. Si el entorno no está levantado, se dice y se para.

## Gestión del trabajo (Azure DevOps + GitHub)

- **Código:** GitHub `flitsas/flito` (`origin`). **Work items:** Azure DevOps Boards, proyecto **`FLIT - FLITO`** (con espacios; codificar en URLs REST).
- Toda lectura/escritura en ADO pasa por la skill `flit-azure-devops`: MCP `azure-devops` primero → REST (PAT) como fallback → borrador `.md` local.
- Ciclo de una HU: `flit-gestion-hu` (Active → Resolved → entrega a QA). Creación de HUs: `flit-crear-hu`. Registro PR ↔ ADO y Deploy DEV/QA/PDN: `flit-integration-ado`. Ciclo completo por Feature: `flit-modo-desarrollo-auto` (**cadena apilada por defecto**; merge a `develop` bajo gates tras autorización del Feature — ver Git flow).
- Nunca escribir en ADO sin un "sí" explícito del humano. Nunca asignar work items al sprint activo — siempre al siguiente.
- **Activar una HU exige que su Feature padre esté `Active`**: la skill que activa la HU (`flit-gestion-hu` / `flit-modo-desarrollo-auto`) pasa el padre de `New` a `Active` con comentario de inicio en su Discussion (si ya está `Active`, no rehacer; si la HU no tiene padre, se declara en el comentario). Lo valida `tech-lead-agent` modo C en el DoR. El cierre del Feature sigue siendo exclusivo del Product Owner.
- Tags por defecto: Features `DOR; adopcion-ia; fase-1-diseño`; User Stories `DOR; adopcion-ia`.
- **`System.Tags` con un tag nuevo va en petición aparte** — mezclarlo con otros campos falla con `TF401289` y tumba el patch completo.

## Equipo de agentes y skills

| Necesidad | Ejecutor |
|---|---|
| Requerimiento informal → borrador canónico | skill `flit-intake` (+ [`docs/dominio.md`](docs/dominio.md)) |
| Planear un flujo multi-fase | `orchestrator-agent` |
| Features, HUs, DoR/DoD, deuda técnica | `tech-lead-agent` |
| Diseño con alternativas, ADR | `architecture-agent` |
| Diseño UX/UI — flujos, wireframes, spec de interacción | `ux-agent` |
| Código `apps/api` | `backend-agent` |
| Código `apps/web` | `frontend-agent` |
| TCs, ejecución, bugs, regresión | `qa-agent` |
| Auditoría SCA/secretos/PII | `security-agent` |
| Auditoría del esquema de BD (normalización, FKs circulares, índices, drift de migraciones) | `db-review-agent` |
| Post-deploy, salud de ambientes/crons, rollback | `devops-agent` |
| Revisión de diff pre-PR | skill `flit-code-review` |
| Promoción develop→staging→release | skill `flit-release` |
| ADO (conexión) | skill `flit-azure-devops` |
| ADO (crear HU / ciclo HU / PR ↔ ADO / feature completo) | skills `flit-crear-hu` / `flit-gestion-hu` / `flit-integration-ado` / `flit-modo-desarrollo-auto` |

Glosario de producto: [`docs/dominio.md`](docs/dominio.md). Pedido sin Feature/HU en ADO → skill `flit-intake` antes de crear work items o código.

### Matriz de invocación (obligatoria para el hilo principal)

El hilo principal **debe** invocar al ejecutor de la fila cuando se cumple el disparador. No sustituir al especialista haciendo su trabajo «de paso» (salvo fix trivial de ≤~20 líneas en un solo archivo, o pedido explícito del humano de no usar subagentes). Cada subagente cierra con `HANDOFF`; el hilo principal es quien encadena.

| Momento | Disparador (sí → invocar) | Ejecutor | Si se omite |
|---|---|---|---|
| Pedido informal sin Feature/HU | No hay WI en ADO | `flit-intake` | Trabajo sin trazabilidad |
| Alcance multi-fase / «por dónde empiezo» | Varias fases o duda de orden | `orchestrator-agent` | Fases saltadas |
| Feature / descomponer HUs / DoR | Planear o refinar backlog | `tech-lead-agent` | HUs mal cortadas |
| Antes de código no trivial | Módulo nuevo, modelo de datos nuevo, contrato nuevo, decisión técnica con tradeoffs | `architecture-agent` | Diseño implícito en el diff |
| Antes de UI nueva significativa | Pantalla/wizard/bandeja nueva o HU FRONTEND sin spec de interacción | `ux-agent` | UI inventada en el agent de código |
| Implementar `apps/api` | HU BACKEND o diff en API/esquema/migración | `backend-agent` | Lógica fuera de patrón |
| Implementar `apps/web` | HU FRONTEND o diff en páginas/componentes | `frontend-agent` | 4 estados / permisos rotos |
| Pre-PR (siempre) | Antes de `create_pull_request` (aunque el humano diga «crea el PR») | `flit-code-review` | PR sin checklist |
| Pre-PR (sensible) | Auth, PII, multer, rutas nuevas, `package*.json`, laft/privacy | `security-agent` | Riesgo de seguridad |
| Pre-PR (esquema) | Toca `schema.ts` o `src/db/migrations/` | `db-review-agent` | Drift / FKs / índices |
| Ciclo ADO Active→Resolved | Activar o cerrar HU | `flit-gestion-hu` | Estados huérfanos |
| Tras `Resolved` (HU con AC Gherkin o UI) | Entrega a QA | `qa-agent` (modo A TCs si faltan; modo B ejecución) | Deploy sin certificación |
| Al abrir PR / post-merge | PR↔ADO, Deploy * | `flit-integration-ado` A/B | Commits/Deploy vacíos |
| Tras Modo B con `DeployDEV/QA/PDN=true` | Ambiente desplegado o ráfaga de merges a `develop` | `devops-agent` M1 (una vez por tip/ambiente, no por cada PR de la ráfaga) | Deploy sin smoke |
| Promoción staging/release | Pedido de promover | `flit-release` (+ qa D + devops post-merge) | Promoción sin gates |
| Feature completo en cadena | «modo auto» / feature completo | `flit-modo-desarrollo-auto` (ya encadena la matriz por HU) | — |

**Operación solo-merge** («mergea los PRs», Modo B en lote): no inventar arquitectura/código; sí completar `flit-integration-ado` Modo B y **después** `devops-agent` M1 sobre el tip. Si las HUs mergeadas no tienen evidencia de `qa-agent`, declararlo en el reporte final («QA pendiente en HUs: …») — no fingir que se ejecutó.

Los subagentes no pueden invocar a otros subagentes: cada uno devuelve un bloque `HANDOFF` y el hilo principal continúa. Gates humanos que **nunca** se omiten: activar una HU, crear rama/commit/push, abrir PR, **autorizar merge a `develop` del Feature** (una vez por Feature o "sí" por PR), merge a `staging`/`release`, cerrar un Feature, instalar herramientas, desplegar. El merge a `develop` bajo gates, tras esa autorización, lo ejecuta el agente.

**«Crea / abre el PR» no salta la matriz.** Ese pedido solo autoriza abrir el PR *después* de evaluar y ejecutar los gates Pre-PR de la tabla (`flit-code-review` siempre; `security-agent` / `db-review-agent` si el diff lo dispara). Veredicto `BLOQUEADO` / `FAIL` / hallazgos críticos de esquema → no llamar a `create_pull_request`. Si un gate no aplica, declararlo explícitamente (nunca omitirlo en silencio). Detalle operativo: `.cursor/rules/pre-pr-gates.mdc` y skill `flit-code-review`.
