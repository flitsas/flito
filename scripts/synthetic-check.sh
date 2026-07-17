#!/usr/bin/env bash
# Synthetic check periódico — cron en VPS o Uptime Kuma externo (TOM).
#
# Cron prod (cada 5 min):
#   */5 * * * * /var/www/operaciones/scripts/synthetic-check.sh >> /var/log/operaciones-synthetic.log 2>&1
#
# Alertas: /etc/operaciones-synthetic.env (ver scripts/operaciones-synthetic.env.example)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SYNTHETIC_ENV_FILE:-/etc/operaciones-synthetic.env}"
COOLDOWN_FILE="${SYNTHETIC_COOLDOWN_FILE:-/var/run/operaciones-synthetic-alert.last}"
[[ -f "$ENV_FILE" ]] && set -a && source "$ENV_FILE" && set +a

BASE_URL="${BASE_URL:-https://operaciones.flitsas.com}"
export BASE_URL
LOG_PREFIX="[$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
COOLDOWN_MIN="${SYNTHETIC_ALERT_COOLDOWN_MIN:-30}"
TEST_ALERT=0

for arg in "$@"; do
  case "$arg" in
    --test-alert) TEST_ALERT=1 ;;
  esac
done

should_notify() {
  [[ "$TEST_ALERT" -eq 1 ]] && return 0
  [[ ! -f "$COOLDOWN_FILE" ]] && return 0
  local last now
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  (( now - last >= COOLDOWN_MIN * 60 ))
}

mark_notified() {
  mkdir -p "$(dirname "$COOLDOWN_FILE")"
  date +%s > "$COOLDOWN_FILE"
}

notify_webhook() {
  local msg="$1"
  [[ -n "${SYNTHETIC_ALERT_WEBHOOK:-}" ]] || return 0
  curl -fsS -X POST "$SYNTHETIC_ALERT_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "$(node -e "console.log(JSON.stringify({text:process.argv[1]}))" "$msg")" \
    >/dev/null 2>&1 || echo "$LOG_PREFIX webhook alert failed (non-fatal)"
}

notify_email() {
  local msg="$1"
  [[ -n "${SYNTHETIC_ALERT_EMAIL:-}" ]] || return 0
  node "$ROOT/scripts/synthetic-alert.mjs" "$msg" \
    && echo "$LOG_PREFIX email alert sent" \
    || echo "$LOG_PREFIX email alert failed (non-fatal)"
}

send_alerts() {
  local msg="$1"
  if ! should_notify; then
    echo "$LOG_PREFIX alert suppressed (cooldown ${COOLDOWN_MIN}m)"
    return 0
  fi
  notify_webhook "$msg"
  notify_email "$msg"
  mark_notified
}

if [[ "$TEST_ALERT" -eq 1 ]]; then
  echo "$LOG_PREFIX synthetic-check --test-alert"
  send_alerts "TEST: alerta synthetic operaciones — verificación manual $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi

echo "$LOG_PREFIX synthetic-check start → $BASE_URL"
set +e
out=$(bash "$ROOT/scripts/smoke-prod.sh" 2>&1)
code=$?
set -e

if [[ "$code" -eq 0 ]]; then
  echo "$out"
  echo "$LOG_PREFIX synthetic-check OK"
  exit 0
fi

echo "$LOG_PREFIX synthetic-check FAIL"
echo "$out"
send_alerts "operaciones synthetic FAIL ($BASE_URL): $(echo "$out" | tail -5 | tr '\n' ' ')"
exit 1
