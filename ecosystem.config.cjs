// Configuración PM2 — operaciones-system.
//
// SECRETOS: este archivo NO debe contener credenciales. Todas las variables
// sensibles (DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY, PII_ENC_KEY,
// PII_HMAC_KEY, S3_*, RUNT_INTERNAL_KEY, RNDC_ENC_KEY, etc.) viven en
// `apps/api/.env` en el servidor (permisos 0600, fuera de git). El loader
// `apps/api/src/config/env.ts` (dotenv) las carga al boot y las valida con Zod.
// Plantilla pública: `apps/api/.env.example`. Procedimiento: `docs/runbook/DEPLOY.md`.
//
// Aquí solo se declaran marcadores de entorno NO secretos (NODE_ENV, PORT),
// para que PM2 fije el entorno aunque se arranque sin `--update-env`.
module.exports = {
  apps: [{
    name: 'operaciones-system',
    script: './apps/api/dist/server.js',
    cwd: '/var/www/operaciones',
    node_args: '--experimental-specifier-resolution=node',
    env: {
      NODE_ENV: 'production',
      PORT: 3005,
    },
    max_memory_restart: '512M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/var/log/pm2/operaciones-error.log',
    out_file: '/var/log/pm2/operaciones-out.log',
  }],
};
