// HU #14280: reglas de la plantilla de nginx que se pueden comprobar sin Docker, en CI. La prueba sobre
// nginx real (líneas de log de verdad, 502, envsubst) es `scripts/verificar-nginx-logs-pii.sh`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const PLANTILLA = readFileSync(
  fileURLToPath(new URL('../../../web/nginx.conf.template', import.meta.url)),
  'utf8',
);

/** Las reglas de `map $uri $ruta_log`, en orden: nginx se queda con la primera que encaja. */
function reglasDelMap(): Array<{ patron: RegExp; valor: string }> {
  const bloque = PLANTILLA.slice(PLANTILLA.indexOf('map $uri $ruta_log {'));
  const cuerpo = bloque.slice(0, bloque.indexOf('\n}'));
  return cuerpo.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('~'))
    .map((l) => {
      const [crudo, valor] = l.replace(/;$/, '').split(/\s+/) as [string, string];
      const insensible = crudo.startsWith('~*');
      return { patron: new RegExp(crudo.slice(insensible ? 2 : 1), insensible ? 'i' : ''), valor };
    });
}

function rutaLog(uri: string): string {
  for (const { patron, valor } of reglasDelMap()) {
    const m = uri.match(patron);
    if (m) return valor.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? '');
  }
  return uri;
}

describe('HU #14280: la plantilla no escribe datos de la URL', () => {
  it.each([
    ['G1', '/api/privacy/preview/VALOR', '/api/privacy/preview/*'],
    ['G6', '/api/vehicles/VALOR/historial', '/api/vehicles/*/historial'],
    ['G6', '/api/vehicles/VALOR/historial/sync', '/api/vehicles/*/historial/sync'],
    ['G6', '/api/vehicles/VALOR/certificado', '/api/vehicles/*/certificado'],
    ['G6', '/api/flito/derechos/candidatos/VALOR', '/api/flito/derechos/candidatos/*'],
    ['G7', '/api/public/drive/cuentas-archivo/VALOR/VALOR/VALOR.pdf', '/api/public/drive/cuentas-archivo/*'],
    ['G7', '/api/drive/cuentas-archivo/VALOR/VALOR.pdf', '/api/drive/cuentas-archivo/*'],
    ['G8', '/api/validacion-identidad/info/VALOR', '/api/validacion-identidad/info/*'],
    ['G8', '/api/validacion-identidad/completar/VALOR', '/api/validacion-identidad/completar/*'],
    ['G8', '/api/tramite-portal/VALOR', '/api/tramite-portal/*'],
    ['G8', '/api/tramite-portal/VALOR/firma/url', '/api/tramite-portal/*/firma/url'],
    ['G8', '/api/tramite-portal/VALOR/aceptar-declaracion', '/api/tramite-portal/*/aceptar-declaracion'],
    ['G8', '/api/tramite-portal/VALOR/documentos', '/api/tramite-portal/*/documentos'],
    ['G8', '/api/tramite-portal/VALOR/finalizar', '/api/tramite-portal/*/finalizar'],
    ['G8', '/api/tramite-portal/VALOR/firma-simulada', '/api/tramite-portal/*/firma-simulada'],
    ['G9', '/api/public/tramite-verificar/qr-png/VALOR', '/api/public/tramite-verificar/qr-png/*'],
    ['G9', '/api/rndc/public/manifiestos/qr/VALOR', '/api/rndc/public/manifiestos/qr/*'],
    ['G9', '/api/rndc/public/manifiestos/qr-png/VALOR', '/api/rndc/public/manifiestos/qr-png/*'],
    ['G9', '/api/drivers/checklists/qr/VALOR', '/api/drivers/checklists/qr/*'],
    ['página', '/tramite/portal/VALOR', '/tramite/portal/*'],
    ['página', '/m/VALOR', '/m/*'],
    ['mayúsculas', '/api/TRAMITE-PORTAL/VALOR', '/api/TRAMITE-PORTAL/*'],
    ['%3F decodificado', '/api/flito/soat?buscar=VALOR', '/api/flito/soat'],
  ])('%s: %s → %s', (_grupo, uri, esperada) => {
    expect(rutaLog(uri)).toBe(esperada);
  });

  it('una ruta sin dato queda igual', () => {
    expect(rutaLog('/api/flito/soat')).toBe('/api/flito/soat');
    expect(rutaLog('/assets/app-abc.js')).toBe('/assets/app-abc.js');
  });

  it('el formato no usa ninguna variable con query ni Referer', () => {
    const formato = PLANTILLA.slice(PLANTILLA.indexOf('log_format'), PLANTILLA.indexOf('server {'));
    expect(formato).toContain('$request_method $ruta_log');
    expect(formato).toContain('$status');
    for (const prohibida of ['$request ', '$request"', '$request_uri', '$args', '$query_string', '$http_referer']) {
      expect(formato, prohibida).not.toContain(prohibida);
    }
  });

  it('access_log y error_log van dentro de `server`: a nivel http el primero se sumaría a `main`', () => {
    const server = PLANTILLA.indexOf('server {');
    expect(PLANTILLA.indexOf('access_log /var/log/nginx/access.log flito_saneado;')).toBeGreaterThan(server);
    expect(PLANTILLA.indexOf('error_log /var/log/nginx/error.log crit;')).toBeGreaterThan(server);
  });

  it('Referrer-Policy vive en `location /`, sin otro add_header que la pise', () => {
    const desde = PLANTILLA.slice(PLANTILLA.indexOf('location / {'));
    let profundidad = 0;
    let fin = 0;
    for (let i = 0; i < desde.length; i += 1) {
      if (desde[i] === '{') profundidad += 1;
      if (desde[i] === '}' && (profundidad -= 1) === 0) { fin = i; break; }
    }
    const directivas = desde.slice(0, fin).split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('add_header'));
    expect(directivas).toEqual(['add_header Referrer-Policy "strict-origin" always;']);
  });
});
