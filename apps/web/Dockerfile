# Dockerfile — @operaciones/web (Vite + React → estático servido por nginx).
#
# CONTEXTO DE BUILD: la RAÍZ del repo (no apps/web), porque npm workspaces
# necesita package-lock.json y los package.json de todos los workspaces.
#   docker build -f apps/web/Dockerfile .
#
# El frontend consume la API con rutas RELATIVAS (/api). En dev lo resuelve el
# proxy de Vite; aquí lo resuelve nginx con proxy_pass al contenedor `api`
# (ver nginx.conf.template). Por eso NO se necesitan build-args de URL de API
# y la MISMA imagen sirve para DEV/QA/PDN (el ambiente se decide por tag/puerto).

# ── Etapa 1: build ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# @playwright/test está en devDeps de apps/web; no se necesitan navegadores.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm ci

# El tsconfig de web incluye ../../packages/shared-types/src directamente.
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
RUN npm run build:web

# ── Etapa 2: runtime (nginx) ────────────────────────────────────────────────
FROM nginx:1.27-alpine

# El entrypoint oficial renderiza /etc/nginx/templates/*.template con envsubst
# (solo variables de entorno definidas; $host/$uri de nginx quedan intactas).
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# Defaults DEV; el compose los sobrescribe por ambiente:
#   NGINX_PORT: DEV 4051 | QA 5051 | PDN 6051 (mismo puerto host == interno)
#   API_HOST/API_PORT: destino del proxy /api dentro de la red de compose.
ENV NGINX_PORT=4051 \
    API_HOST=api \
    API_PORT=4052

EXPOSE 4051
