#!/usr/bin/env bash
# Rollback de dist pre-deploy — ejecutar EN el VPS (/var/www/operaciones).
#
# Uso:
#   ./scripts/rollback-dist.sh --dry-run          # muestra backup a restaurar
#   ./scripts/rollback-dist.sh --verify           # drill: valida tgz sin tocar prod
#   ./scripts/rollback-dist.sh --execute          # restaura último tgz + pm2 restart
#   ./scripts/rollback-dist.sh --execute --tgz /path/to/dist-pre-....tgz
#
# Gate biométrico: no reinicia PM2 si hay validaciones en_proceso (salvo --force).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/operaciones}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/operaciones-deploy}"
PM2_APP="${PM2_APP:-operaciones-system}"
DB_NAME="${DB_NAME:-operaciones_db}"
MODE=""
TGZ=""
FORCE=0

usage() {
  echo "Usage: rollback-dist.sh --dry-run | --verify | --execute [--tgz PATH] [--force]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --verify) MODE=verify ;;
    --execute) MODE=execute ;;
    --tgz) TGZ="${2:-}"; shift ;;
    --force) FORCE=1 ;;
    -h|--help) usage ;;
    *) echo "Opción desconocida: $1"; usage ;;
  esac
  shift
done

[[ -n "$MODE" ]] || usage

if [[ -z "$TGZ" ]]; then
  TGZ=$(ls -t "$BACKUP_DIR"/dist-pre-*.tgz 2>/dev/null | head -1 || true)
fi

if [[ -z "$TGZ" || ! -f "$TGZ" ]]; then
  echo "ERROR: no hay backup dist-pre-*.tgz en $BACKUP_DIR"
  exit 1
fi

echo "Backup seleccionado: $TGZ ($(du -h "$TGZ" | cut -f1))"

if [[ "$MODE" == "dry-run" ]]; then
  echo "DRY-RUN: se restaurarían paths dentro de $APP_ROOT:"
  tar tzf "$TGZ" | head -20
  count=$(tar tzf "$TGZ" | wc -l | tr -d ' ')
  echo "... ($count entradas total)"
  echo "DRY-RUN: luego pm2 restart $PM2_APP"
  exit 0
fi

if [[ "$MODE" == "verify" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  tar xzf "$TGZ" -C "$tmp"
  echo "VERIFY OK: extracción en $tmp"
  test -f "$tmp/apps/api/dist/server.js" || { echo "VERIFY FAIL: falta server.js"; exit 1; }
  test -f "$tmp/apps/web/dist/index.html" || { echo "VERIFY FAIL: falta index.html"; exit 1; }
  test -f "$tmp/packages/shared-types/dist/index.js" || { echo "VERIFY FAIL: falta shared-types"; exit 1; }
  echo "VERIFY OK: artefactos mínimos presentes"
  exit 0
fi

# execute
if [[ "$FORCE" -eq 0 ]]; then
  en_proc=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
    "SELECT count(*) FROM tramites_validaciones WHERE estado='en_proceso';" 2>/dev/null || echo "0")
  en_proc=$(echo "$en_proc" | tr -d '[:space:]')
  if [[ "${en_proc:-0}" != "0" ]]; then
    echo "ERROR: gate biométrico — $en_proc validación(es) en_proceso. Esperar o usar --force."
    exit 2
  fi
fi

cd "$APP_ROOT"
echo "Restaurando $TGZ → $APP_ROOT"
tar xzf "$TGZ" -C "$APP_ROOT"
pm2 restart "$PM2_APP" --update-env
pm2 save
echo "ROLLBACK OK — ejecutar smoke: npm run smoke:prod (desde estación con repo)"
