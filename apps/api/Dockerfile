# Dockerfile — @operaciones/api (Express + TypeScript, monorepo npm workspaces).
#
# CONTEXTO DE BUILD: la RAÍZ del repo (no apps/api), porque npm workspaces
# necesita package-lock.json y los package.json de todos los workspaces.
#   docker build -f apps/api/Dockerfile .
#
# La imagen final incluye:
#   - dist/ compilado (tsc -b + tsc-alias; imports ESM con extensión .js)
#   - node_modules solo de producción (argon2 trae prebuilds → no necesita gcc)
#   - src/db/migrations/*.sql — el runner dist/scripts/db-apply.js los resuelve
#     como ../../src/db/migrations relativo a dist/scripts (ver db-apply.ts).
#
# Migraciones (una vez desplegado):
#   docker compose run --rm --no-deps api node dist/scripts/db-apply.js

# ── Etapa 1: build ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# @playwright/test está en devDeps de apps/web; no se necesitan navegadores.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Manifests primero → capa de npm ci cacheable mientras no cambien deps.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm ci

COPY packages/shared-types packages/shared-types
COPY apps/api apps/api
RUN npm run build -w @operaciones/shared-types && npm run build:api

# ── Etapa 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

# npm ci -w exige que TODOS los manifests del workspace estén presentes para
# validar el lockfile, aunque solo instale las deps de apps/api.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
# Se instala TAMBIÉN packages/shared-types: la API lo importa en runtime
# (ERR_MODULE_NOT_FOUND sin el symlink de node_modules/@operaciones/shared-types).
RUN npm ci --omit=dev -w apps/api -w packages/shared-types && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist
# dist compilado de shared-types (su package.json apunta main → dist/index.js).
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
# SQL plano de migraciones (db-apply.js las lee de src/db/migrations en runtime).
COPY apps/api/src/db/migrations apps/api/src/db/migrations

RUN chown -R node:node /app
USER node

# WORKDIR = apps/api para que dist/scripts/db-apply.js resuelva ../../src/db/migrations.
WORKDIR /app/apps/api

# El puerto real lo fija la var PORT (env.ts). Convención por ambiente:
# DEV 4052 | QA 5052 | PDN 6052.
EXPOSE 4052

CMD ["node", "dist/server.js"]
