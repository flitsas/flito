import https from 'https';
import { env } from '../../config/env.js';
import { withCircuitBreaker } from '../../services/circuitBreaker.js';
import { loggerFor } from '../../shared/logger.js';
import { useCeaProxy } from '../integraciones/mode.js';
import { consultarVehiculoRuntDirect, consultarPersonaRuntDirect } from './runt-direct.service.js';

const log = loggerFor('runt');

/**
 * Pasarela RUNT de Kyverum. Sustituye a `cea.kyverum.com/api/runt/*`, que dejó de existir —el host
 * responde 404 de nginx a cualquier ruta— y era la causa del «Error comunicando con servicio RUNT»
 * que veía todo lo que consulta el RUNT sin captcha: certificación de impuestos, refresco de SOAT y
 * el pre-vuelo de trámites.
 *
 * Se autentica con `Authorization: Bearer` sobre la MISMA `RUNT_INTERNAL_KEY` (el valor ya es una
 * llave `kr_live_…` de Kyverum); el CEA la mandaba como `x-internal-key`. Sin el header responde 401.
 *
 * Devuelve exactamente la forma que el resto del módulo ya espera —`{ ok, data: { vehiculo,
 * tipoDocPropietario, datosTecnicos, soat… } }` para vehículo y `{ ok, persona, licencias, multas,
 * solicitudes }` para persona—, la misma que produce la vía directa. Por eso el cambio se agota en
 * la URL y el header: ni los consumidores ni `extraerVehiculoRunt` necesitan tocarse.
 *
 * `INTEGRACIONES_MODE` conserva su nombre y sus valores: para el RUNT, `cea-proxy` significa ahora
 * esta pasarela. SIMIT y Fasecolda siguen saliendo por el CEA, así que la bandera no se puede
 * renombrar sin arrastrarlos.
 */
const GATEWAY_RUNT_URL = 'https://runt.kyverum.com/v1/vehiculos:consultar';
const GATEWAY_PERSONA_URL = 'https://runt.kyverum.com/v1/personas:consultar';

const gatewayAuth = () => ({ Authorization: `Bearer ${env.RUNT_INTERNAL_KEY}` });

/**
 * Traduce una respuesta que no es 200 a `{ ok:false }` con el motivo real.
 *
 * La pasarela describe sus rechazos en `error.message` (llave ausente, cuerpo inválido…). Taparlos
 * todos con «Error comunicando con servicio RUNT» es lo que hizo que un 404 de un host muerto
 * llegara a la interfaz como un genérico 502: el mensaje concreto es justo lo que hace falta para
 * saber si hay que revisar la llave, el cuerpo o el servicio.
 */
function fallo(r: HttpResponse): { ok: false; message: string } {
  const msg = typeof r.data === 'object' && r.data ? (r.data as any)?.error?.message : null;
  return { ok: false, message: typeof msg === 'string' && msg ? msg : 'Error comunicando con servicio RUNT' };
}

interface HttpResponse { status: number | undefined; data: any; headers?: any }

function httpsReq(method: string, url: string, body: any, hdrs?: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string | number> = { 'Content-Type': 'application/json', ...hdrs };
    const bs = (method !== 'GET' && body) ? JSON.stringify(body) : null;
    if (bs) h['Content-Length'] = Buffer.byteLength(bs);
    const rq = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (r2) => {
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve({ status: r2.statusCode, data: JSON.parse(d), headers: r2.headers }); }
        catch { resolve({ status: r2.statusCode, data: d, headers: r2.headers }); }
      });
    });
    rq.setTimeout(90000, () => rq.destroy(new Error('Timeout 90s')));
    rq.on('error', reject);
    if (bs) rq.write(bs);
    rq.end();
  });
}

async function consultarVehiculoProxy(placa?: string, vin?: string, documento?: string, tipoDocumento?: string) {
  const body: Record<string, string> = {};
  if (vin) body.vin = vin.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (placa) body.placa = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (documento) body.documento = documento;
  if (tipoDocumento) body.tipoDocumento = tipoDocumento;
  log.info({ tipoDoc: body.tipoDocumento || 'CC', via: 'gateway' }, 'consulta vehiculo');
  const r = await withCircuitBreaker('runt-vehicle', () =>
    httpsReq('POST', GATEWAY_RUNT_URL, body, gatewayAuth()),
  );
  if (r.status !== 200 || typeof r.data === 'string') return fallo(r);
  return r.data;
}

async function consultarPersonaProxy(documento: string, tipoDocumento?: string) {
  const body: Record<string, string> = { documento };
  if (tipoDocumento) body.tipoDocumento = tipoDocumento;
  log.info({ docPrefix: documento.slice(0, 4), via: 'gateway' }, 'consulta persona');
  const r = await withCircuitBreaker('runt-persona', () =>
    httpsReq('POST', GATEWAY_PERSONA_URL, body, gatewayAuth()),
  );
  if (r.status !== 200 || typeof r.data === 'string') return fallo(r);
  return r.data;
}

export interface RuntCallOpts {
  skipCeaFallback?: boolean;
}

export async function consultarVehiculoRunt(placa?: string, vin?: string, documento?: string, tipoDocumento?: string, opts?: RuntCallOpts) {
  if (!placa && !vin) throw new Error('Placa o VIN requerido');
  if (!vin && !documento) throw new Error('Documento del propietario requerido para consulta por placa');
  try {
    if (useCeaProxy() && !opts?.skipCeaFallback) return await consultarVehiculoProxy(placa, vin, documento, tipoDocumento);
    const direct = await consultarVehiculoRuntDirect(placa, vin, documento, tipoDocumento);
    if (direct.ok) return direct;
    if (opts?.skipCeaFallback) return { ok: false, message: direct.message || 'RUNT no disponible' };
    log.warn({ message: direct.message, via: 'cea-fallback' }, 'runt vehiculo direct falló');
    return await consultarVehiculoProxy(placa, vin, documento, tipoDocumento);
  } catch (e: any) {
    if (!opts?.skipCeaFallback && !useCeaProxy()) {
      try { return await consultarVehiculoProxy(placa, vin, documento, tipoDocumento); } catch { /* sigue error original */ }
    }
    log.warn({ err: e?.message || 'unavailable', scope: 'vehiculo' }, 'runt error');
    return { ok: false, message: e?.message || 'Servicio RUNT temporalmente no disponible' };
  }
}

export async function consultarPersonaRunt(documento: string, tipoDocumento?: string, opts?: RuntCallOpts) {
  if (!documento) throw new Error('Documento requerido');
  try {
    if (useCeaProxy() && !opts?.skipCeaFallback) return await consultarPersonaProxy(documento, tipoDocumento);
    const direct = await consultarPersonaRuntDirect(documento, tipoDocumento);
    if (direct.ok) return direct;
    if (opts?.skipCeaFallback) return { ok: false, message: direct.message || 'RUNT no disponible' };
    log.warn({ message: direct.message, via: 'cea-fallback' }, 'runt persona direct falló');
    return await consultarPersonaProxy(documento, tipoDocumento);
  } catch (e: any) {
    if (!opts?.skipCeaFallback && !useCeaProxy()) {
      try { return await consultarPersonaProxy(documento, tipoDocumento); } catch { /* sigue error original */ }
    }
    log.warn({ err: e?.message || 'unavailable', scope: 'persona' }, 'runt error');
    return { ok: false, message: e?.message || 'Servicio RUNT temporalmente no disponible' };
  }
}
