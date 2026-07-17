# FLIT Operaciones

Sistema de operaciones para organismos de tránsito / CEA: trámites digitales
(matrícula inicial, traspaso), validación de identidad biométrica, integración
RUNT/SIMIT, SOAT, RNDC, flota, PESV y cumplimiento.

Monorepo con workspaces de npm:

```
apps/api        Backend  — Node + TypeScript + Express + Drizzle (PostgreSQL)
apps/web        Frontend — React + Vite + TypeScript + Tailwind
packages/
  shared-types  Tipos y lógica de dominio compartida (con tests)
scripts/        Operación (deploy, smoke, backup) — requieren infraestructura propia
```

> **Sin secretos.** Este repositorio NO incluye credenciales. Todas las variables
> sensibles viven en `apps/api/.env` (local, fuera de git). Usa `apps/api/.env.example`
> como plantilla. Los datos de infraestructura de producción están parametrizados
> como `<PROD_HOST>` / `<SSH_KEY>` — reemplázalos con los de tu entorno.

## Requisitos

- Node.js 20+ y npm 10+
- PostgreSQL 15+ (local o contenedor)
- (Opcional) MinIO/S3 para almacenamiento de evidencias; SMTP para correos

## Puesta en marcha (desarrollo)

```bash
# 1. Instalar dependencias (todos los workspaces)
npm ci

# 2. Configurar variables de entorno del backend
cp apps/api/.env.example apps/api/.env
#   Edita apps/api/.env y completa los valores (ver "Variables" abajo).

# 3. Migrar la base de datos
npm run db:migrate            # aplica las migraciones Drizzle

# 4. Levantar en desarrollo (dos terminales)
npm run dev:api               # API  → http://localhost:3005
npm run dev:web               # Web  → http://localhost:5173 (proxy /api → :3005)
```

## Variables de entorno

La fuente de verdad es **`apps/api/.env.example`** (plantilla comentada). Mínimas
requeridas para arrancar (el backend valida con Zod al boot y aborta si falta alguna):

| Variable | Para qué |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL |
| `JWT_SECRET` (≥32) | Firma de sesión |
| `PII_ENC_KEY` (≥32) / `PII_HMAC_KEY` (64 hex) | Cifrado/HMAC de datos personales |
| `RUNT_INTERNAL_KEY` (≥20) | Integración RUNT |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Almacenamiento de evidencias |
| `ANTHROPIC_API_KEY` | OCR/validación biométrica (opcional para dev) |

Genera secretos nuevos para tu entorno (no reutilices valores de ejemplo).

## Scripts útiles

```bash
npm run build                 # build api + web (tsc + vite)
npm run test:shared-types     # tests de dominio compartido (vitest)
npm test -w apps/api          # tests del backend (vitest)
npm run typecheck -w apps/web # typecheck del frontend
npm run check:hooks           # lint de Rules of Hooks (React)
```

## Pruebas

- **Backend / dominio:** vitest (`apps/api`, `packages/shared-types`).
- **Frontend E2E:** Playwright (`apps/web`, `npm run test:e2e`).
- CI (`.github/workflows/ci.yml`): build + tests unitarios.

## Despliegue

Los scripts en `scripts/` (`smoke-prod.sh`, `rollback-dist.sh`, `backup-operaciones.sh`,
etc.) describen el proceso de despliegue, con host/llave/paths **parametrizados**
(`<PROD_HOST>`, `<SSH_KEY>`). Configúralos con la infraestructura de tu entorno antes de usarlos.

## Estructura de carpetas (resumen)

- `apps/api/src/modules/` — dominios: `tramites`, `soat`, `runt`, `rndc`, `laft`, `pesv`, `vehicles`, `drivers`…
- `apps/web/src/pages/` — vistas; `components/` — UI compartida; `lib/` — cliente API y auth.
- `packages/shared-types/src/` — tipos, catálogos y lógica de dominio (tipologías, validaciones, motivos de rechazo).
