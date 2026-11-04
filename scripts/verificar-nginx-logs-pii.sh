#!/usr/bin/env bash
# HU #14280: comprueba sobre nginx real que los logs no escriben datos de la URL (AC1, AC2, AC3, AC5).
# Usa la plantilla del repo con el entrypoint oficial, sin red (`--network none`) y valores ficticios.
# Uso: scripts/verificar-nginx-logs-pii.sh     Requiere docker y la imagen nginx:1.27-alpine.
# PLANTILLA=<ruta> prueba otra plantilla (control negativo: la versión anterior debe fallar).
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
IMAGEN="nginx:1.27-alpine"
PLANTILLA="${PLANTILLA:-$RAIZ/apps/web/nginx.conf.template}"
TRABAJO="$(mktemp -d)"
ARRIBA="pii-nginx-arriba-$$"
CAIDO="pii-nginx-caido-$$"
trap 'docker rm -f "$ARRIBA" "$CAIDO" >/dev/null 2>&1 || true; rm -rf "$TRABAJO"' EXIT

mkdir -p "$TRABAJO/html"
echo '<!doctype html><title>index</title>' > "$TRABAJO/html/index.html"
echo '<!doctype html><title>validar</title>' > "$TRABAJO/html/validar-identidad.html"
chmod -R a+rX "$TRABAJO"
# API de mentira en el mismo contenedor: la plantilla apunta a 127.0.0.1:4052.
echo 'server { listen 127.0.0.1:4052; access_log off; return 200 "api-ok\n"; }' > "$TRABAJO/api-falsa.conf"

arrancar() { # nombre, montajes extra...
  local nombre="$1"; shift
  docker run -d --name "$nombre" --network none \
    -e NGINX_PORT=8080 -e API_HOST=127.0.0.1 -e API_PORT=4052 \
    -v "$PLANTILLA:/etc/nginx/templates/default.conf.template:ro,z" \
    -v "$TRABAJO/html:/usr/share/nginx/html:ro,z" "$@" "$IMAGEN" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$nombre" wget -q -O /dev/null http://127.0.0.1:8080/ 2>/dev/null && return 0
    sleep 0.2
  done
  docker logs "$nombre"; echo "nginx no arrancó" >&2; exit 1
}
pedir() { # contenedor, url, [cabecera]
  if [ $# -ge 3 ]; then
    docker exec "$1" wget -q -O /dev/null --header "$3" "http://127.0.0.1:8080$2" 2>/dev/null || true
  else
    docker exec "$1" wget -q -O /dev/null "http://127.0.0.1:8080$2" 2>/dev/null || true
  fi
}

arrancar "$ARRIBA" -v "$TRABAJO/api-falsa.conf:/etc/nginx/conf.d/api-falsa.conf:ro,z"
arrancar "$CAIDO"

echo "== Cabeceras de las páginas (AC4) =="
for pagina in / /validar-identidad.html /tramite/portal/TOKENPAGINA777; do
  printf '%s -> ' "$pagina"
  docker exec "$ARRIBA" wget -S -q -O /dev/null "http://127.0.0.1:8080$pagina" 2>&1 | grep -i 'referrer-policy' || echo SIN-CABECERA
done

# AC1, AC2 y AC3
pedir "$ARRIBA" '/api/flito/soat?buscar=VALORQUERY111'
pedir "$ARRIBA" '/api/flito/soat' 'Referer: http://x/validar-identidad.html?t=TOKENREFERER222'
pedir "$ARRIBA" '/validar-identidad.html?t=TOKENPAGINA333'
for ruta in \
  /api/privacy/preview/DOCUMENTO900111 \
  /api/vehicles/VINVALOR900222/historial \
  /api/vehicles/VINVALOR900223/historial/sync \
  /api/vehicles/VINVALOR900224/certificado \
  /api/flito/derechos/candidatos/PLACAVALOR225 \
  /api/public/drive/cuentas-archivo/DIRVALOR226/TOKENVALOR227/PLACAVALOR228.pdf \
  /api/drive/cuentas-archivo/DIRVALOR229/PLACAVALOR230.pdf \
  /api/validacion-identidad/info/TOKENVALOR231 \
  /api/validacion-identidad/completar/TOKENVALOR232 \
  /api/tramite-portal/TOKENVALOR233 \
  /api/tramite-portal/TOKENVALOR234/firma/url \
  /api/tramite-portal/TOKENVALOR235/aceptar-declaracion \
  /api/tramite-portal/TOKENVALOR236/documentos \
  /api/tramite-portal/TOKENVALOR237/finalizar \
  /api/tramite-portal/TOKENVALOR238/firma-simulada \
  /api/public/tramite-verificar/qr-png/TOKENVALOR239 \
  /api/rndc/public/manifiestos/qr/TOKENVALOR240 \
  /api/rndc/public/manifiestos/qr-png/TOKENVALOR241 \
  /api/drivers/checklists/qr/TOKENVALOR242 \
  /API/TRAMITE-PORTAL/TOKENVALOR243 \
  /api/TRAMITE-PORTAL/TOKENVALOR244 \
  //api//tramite-portal//TOKENVALOR245 \
  /api/tramite-portal%2FTOKENVALOR246 \
  /api/flito/soat%3Fbuscar=VALORQUERY247 \
  /tramite/portal/TOKENVALOR248 \
  /m/TOKENVALOR249; do
  pedir "$ARRIBA" "$ruta"
done

# AC5: API caída
pedir "$CAIDO" '/api/flito/soat?buscar=VALORCAIDO555'
pedir "$CAIDO" '/validar-identidad.html?t=TOKENCAIDO556'
pedir "$CAIDO" '/no-existe.png?t=TOKENCAIDO557'
sleep 0.5

docker logs "$ARRIBA" > "$TRABAJO/arriba.log" 2>&1
docker logs "$CAIDO" > "$TRABAJO/caido.log" 2>&1

echo; echo "== Líneas reales: API arriba =="
grep -E '"(GET|POST|HEAD) ' "$TRABAJO/arriba.log" | grep -v '"GET / ' || true
echo; echo "== Líneas reales: API caída (stdout y stderr del contenedor) =="
grep -E 'GET |POST |error|crit' "$TRABAJO/caido.log" | grep -v '"GET / ' || true

fallos=0
if grep -nE 'VALOR[A-Z]*[0-9]{3}|TOKEN[A-Z]*[0-9]{3}|DOCUMENTO[0-9]+' "$TRABAJO/arriba.log" "$TRABAJO/caido.log"; then
  echo "FALLO: algún valor ficticio llegó al log" >&2; fallos=1
fi
grep -q '"GET /api/flito/soat" 200' "$TRABAJO/arriba.log" || { echo "FALLO: AC1 sin método, path y 200" >&2; fallos=1; }
grep -q '"GET /api/flito/soat" 502' "$TRABAJO/caido.log" || { echo "FALLO: AC5 sin 502 en el access log" >&2; fallos=1; }
if grep -q '\[error\]' "$TRABAJO/caido.log"; then echo "FALLO: error_log escribió a nivel error" >&2; fallos=1; fi
if [ "$fallos" -ne 0 ]; then exit 1; fi

echo; echo "OK: ningún valor ficticio en access log ni error log; 200 y 502 conservados."
