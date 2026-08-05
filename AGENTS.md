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
6. Migraciones: se generan con `npm run db:generate` y no se editan a mano una vez generadas. **Nunca** `drizzle-kit migrate` (ver `apps/api/src/db/migrations/README.md`).
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

- Una rama por HU, **siempre desde `develop` actualizado**: `feat/flito-hu<ID>-<slug-corto>` (lo exige la precondición de merge de `flit-integration-ado`).
- **Nunca `git add -A` ni `git add .`**: el working tree puede tener parches de demo. Archivos explícitos + `git status --short` antes de commitear.
- `.claude/` **sí está versionado** (es el equipo de agentes/skills del repo): sus cambios se commitean como cualquier archivo. Lo que no se commitea: parches locales de demo (stubs de OCR, MinIO local).
- **El merge lo hace siempre un humano** (GitHub UI o Líder Técnico con `gh pr merge` tras "sí" textual). Ningún agente mergea.
- Cerrar un Feature es exclusivo del Product Owner.
- En esta máquina **`gh` no es el CLI de GitHub** (es un visor de ayuda): el PR y sus checks se gestionan con el servidor MCP `github`. Comprobar con `gh --version` antes de asumir.
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
- Ciclo de una HU: `flit-gestion-hu` (Active → Resolved → entrega a QA). Creación de HUs: `flit-crear-hu`. Registro PR ↔ ADO y Deploy DEV/QA/PDN: `flit-integration-ado`. Ciclo completo por Feature: `flit-modo-desarrollo-auto`.
- Nunca escribir en ADO sin un "sí" explícito del humano. Nunca asignar work items al sprint activo — siempre al siguiente.
- Tags por defecto: Features `DOR; adopcion-ia; fase-1-diseño`; User Stories `DOR; adopcion-ia`.
- **`System.Tags` con un tag nuevo va en petición aparte** — mezclarlo con otros campos falla con `TF401289` y tumba el patch completo.

## Equipo de agentes y skills

| Necesidad | Ejecutor |
|---|---|
| Planear un flujo multi-fase | `orchestrator-agent` |
| Features, HUs, DoR/DoD, deuda técnica | `tech-lead-agent` |
| Diseño con alternativas, ADR | `architecture-agent` |
| Código `apps/api` | `backend-agent` |
| Código `apps/web` | `frontend-agent` |
| TCs, ejecución, bugs, regresión | `qa-agent` |
| Auditoría SCA/secretos/PII | `security-agent` |
| Post-deploy, salud de ambientes/crons, rollback | `devops-agent` |
| Revisión de diff pre-PR | skill `flit-code-review` |
| Promoción develop→staging→release | skill `flit-release` |
| ADO (conexión) | skill `flit-azure-devops` |
| ADO (crear HU / ciclo HU / PR ↔ ADO / feature completo) | skills `flit-crear-hu` / `flit-gestion-hu` / `flit-integration-ado` / `flit-modo-desarrollo-auto` |

Los subagentes no pueden invocar a otros subagentes: cada uno devuelve un bloque `HANDOFF` y el hilo principal continúa. Gates humanos que **nunca** se omiten: activar una HU, crear rama/commit/push, abrir PR, mergear, cerrar un Feature, instalar herramientas, desplegar.
