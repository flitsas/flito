#!/usr/bin/env bash
# Dry-run / execute reconciliación paso traspaso en prod (lee .env del VPS).
set -euo pipefail
SSH_KEY="${SMOKE_SSH_KEY:-$HOME/.ssh/<SSH_KEY>}"
HOST="${SMOKE_SSH_HOST:-root@<PROD_HOST>}"
REMOTE="cd /var/www/operaciones/apps/api && node dist/scripts/reconcile-traspaso-paso.js"
exec ssh -i "$SSH_KEY" -o BatchMode=yes "$HOST" "$REMOTE $(printf '%q ' "$@")"
