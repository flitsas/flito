#!/usr/bin/env bash
# Post-deploy smoke — operaciones.flitsas.com (TOM / runbook DEPLOY.md)
#
# Uso:
#   npm run smoke:prod
#   BASE_URL=https://operaciones.flitsas.com bash scripts/smoke-prod.sh
#   bash scripts/smoke-prod.sh --with-ssh   # incluye PM2 online vía SSH
#
# Salida: "smoke N/N OK" (exit 0) o lista de fallos (exit 1)
set -euo pipefail

BASE_URL="${BASE_URL:-https://operaciones.flitsas.com}"
BASE_URL="${BASE_URL%/}"
SSH_HOST="${SMOKE_SSH_HOST:-root@<PROD_HOST>}"
SSH_KEY="${SMOKE_SSH_KEY:-$HOME/.ssh/<SSH_KEY>}"
WITH_SSH=0

for arg in "$@"; do
  case "$arg" in
    --with-ssh) WITH_SSH=1 ;;
    -h|--help)
      echo "Usage: smoke-prod.sh [--with-ssh]"
      echo "  BASE_URL          default https://operaciones.flitsas.com"
      echo "  SMOKE_SSH_HOST    default root@<PROD_HOST>"
      echo "  SMOKE_SSH_KEY     default ~/.ssh/<SSH_KEY>"
      exit 0
      ;;
  esac
done

pass=0
fail=0
total=0
errors=()

check() {
  local name="$1"
  shift
  total=$((total + 1))
  if "$@"; then
    pass=$((pass + 1))
    echo "  ✓ $name"
  else
    fail=$((fail + 1))
    errors+=("$name")
    echo "  ✗ $name"
  fi
}

check_api_health() {
  local body
  body=$(curl -fsS --max-time 15 "${BASE_URL}/api/health") || return 1
  echo "$body" | grep -q '"status":"ok"' || return 1
  echo "$body" | grep -q '"db":"up"' || return 1
}

check_web_root() {
  local code
  code=$(curl -fsS --max-time 15 -o /dev/null -w '%{http_code}' "${BASE_URL}/") || return 1
  [[ "$code" == "200" ]]
}

check_traspaso_bundle() {
  local html index_js chunk code
  html=$(curl -fsS --max-time 20 "${BASE_URL}/") || return 1
  index_js=$(echo "$html" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 | sed 's|^/||') || return 1
  [[ -n "$index_js" ]] || return 1
  chunk=$(curl -fsS --max-time 25 "${BASE_URL}/${index_js}" | grep -oE 'TramiteTraspaso-[A-Za-z0-9_-]+\.js' | head -1) || return 1
  [[ -n "$chunk" ]] || return 1
  code=$(curl -fsS --max-time 20 -o /dev/null -w '%{http_code}' "${BASE_URL}/assets/${chunk}") || return 1
  [[ "$code" == "200" ]]
}

check_validar_identidad_html() {
  local code
  code=$(curl -fsS --max-time 15 -o /dev/null -w '%{http_code}' "${BASE_URL}/validar-identidad.html") || return 1
  [[ "$code" == "200" ]]
}

check_pm2_online() {
  local status
  status=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    "pm2 jlist 2>/dev/null | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).find(x=>x.name==='operaciones-system');process.stdout.write(p&&p.pm2_env&&p.pm2_env.status||'missing')}catch{process.stdout.write('error')}})\"") \
    || return 1
  [[ "$status" == "online" ]]
}

echo "smoke-prod → ${BASE_URL}"
check "API /api/health (status ok, db up)" check_api_health
check "Web / (HTTP 200)" check_web_root
check "Asset TramiteTraspaso (desde index.html)" check_traspaso_bundle
check "Página validar-identidad.html (HTTP 200)" check_validar_identidad_html

if [[ "$WITH_SSH" -eq 1 ]]; then
  check "PM2 operaciones-system online (SSH)" check_pm2_online
fi

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "smoke ${pass}/${total} OK"
  exit 0
fi

echo "smoke ${pass}/${total} OK — ${fail} fallo(s):"
for e in "${errors[@]}"; do echo "  - $e"; done
exit 1
