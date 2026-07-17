#!/usr/bin/env bash
# VERONICA / TRAM-TRASPASO-P0 — smoke gates traspaso en prod (SSH + API localhost).
#
# Uso:
#   npm run smoke:traspaso-gates
#   TRAMITE_ID=21 bash scripts/smoke-traspaso-gates-prod.sh
#
set -euo pipefail

TRAMITE_ID="${TRAMITE_ID:-21}"
SSH_HOST="${SMOKE_SSH_HOST:-root@<PROD_HOST>}"
SSH_KEY="${SMOKE_SSH_KEY:-$HOME/.ssh/<SSH_KEY>}"
BASE_URL="${BASE_URL:-https://operaciones.flitsas.com}"
BASE_URL="${BASE_URL%/}"

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

check_bundle_gates() {
  local html index_js chunk
  html=$(curl -fsS --max-time 20 "${BASE_URL}/") || return 1
  index_js=$(echo "$html" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 | sed 's|^/||') || return 1
  chunk=$(curl -fsS --max-time 25 "${BASE_URL}/${index_js}" | grep -oE 'TramiteTraspaso-[A-Za-z0-9_-]+\.js' | head -1) || return 1
  curl -fsS --max-time 20 "${BASE_URL}/assets/${chunk}" | grep -q 'forzarContinuar' || return 1
}

check_api_dist_gates() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=12 "$SSH_HOST" \
    "grep -q 'biometria_gate' /var/www/operaciones/apps/api/dist/modules/tramites/tramites.service.js" || return 1
}

check_tramite_exists() {
  local cnt
  cnt=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" \
    "sudo -u postgres psql -d operaciones_db -tAc \"SELECT count(*) FROM tramites_digitales WHERE id=${TRAMITE_ID};\"") || return 1
  [[ "$cnt" == "1" ]]
}

# Genera JWT admin (5 min) y ejecuta curls contra localhost:3005 en el VPS.
run_server_api_smoke() {
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" "TRAMITE_ID=${TRAMITE_ID} bash -s" <<'REMOTE'
set -euo pipefail
cd /var/www/operaciones/apps/api
ENV_FILE=.env
[[ -f "$ENV_FILE" ]] || { echo "missing .env"; exit 1; }

node <<'NODE'
import { readFileSync } from 'fs';
import { SignJWT } from 'jose';

const tramiteId = process.env.TRAMITE_ID || '21';
const envText = readFileSync('.env', 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1)]; }),
);
const secret = new TextEncoder().encode(env.JWT_SECRET);
const token = await new SignJWT({ role: 'admin', username: 'smoke-gates' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('1')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(secret);

const base = 'http://127.0.0.1:3005/api';
const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function req(method, path, body) {
  const r = await fetch(`${base}${path}`, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
}

const results = [];

// Gate FUR sin biométrica
const fur = await req('POST', `/tramites/${tramiteId}/generar-fur`, {});
results.push(['fur_biometria_gate', fur.status === 409 && fur.json.code === 'biometria_gate', fur]);

// Gate comercial valor 0 (sin avanzar paso)
const com = await req('PATCH', `/tramites/${tramiteId}`, { vehiculo: { _comercial: { valorVenta: 0 } } });
results.push(['comercial_valor_gate', com.status === 409 && com.json.code === 'comercial_gate', com]);

// Gate paso 3 sin vendedor persistido
const paso = await req('PATCH', `/tramites/${tramiteId}`, { paso: 3 });
results.push(['paso3_vendedor_gate', paso.status === 409 && paso.json.code === 'paso_gate', paso]);

// Auth requerida (sanity)
const anon = await fetch(`${base}/tramites/${tramiteId}/generar-fur`, { method: 'POST' });
results.push(['fur_requires_auth', anon.status === 401, { status: anon.status }]);

let failed = 0;
for (const [name, ok, detail] of results) {
  if (ok) console.log(`OK ${name}`);
  else { failed++; console.log(`FAIL ${name} ${JSON.stringify(detail)}`); }
}
process.exit(failed > 0 ? 1 : 0);
NODE
REMOTE
}

echo "smoke-traspaso-gates → tramite ${TRAMITE_ID} @ ${BASE_URL}"
check "Bundle FE contiene forzarContinuar" check_bundle_gates
check "API dist contiene biometria_gate" check_api_dist_gates
check "Trámite ${TRAMITE_ID} existe en BD prod" check_tramite_exists
check "API gates (FUR/comercial/paso) vía JWT localhost" run_server_api_smoke

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "smoke-traspaso-gates ${pass}/${total} OK"
  exit 0
fi
echo "smoke-traspaso-gates ${pass}/${total} OK — ${fail} fallo(s):"
for e in "${errors[@]}"; do echo "  - $e"; done
exit 1
