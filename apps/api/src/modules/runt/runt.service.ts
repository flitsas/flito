import https from 'https';
import { env } from '../../config/env.js';
import { withCircuitBreaker } from '../../services/circuitBreaker.js';
import { loggerFor } from '../../shared/logger.js';
import { useCeaProxy } from '../integraciones/mode.js';
import { consultarVehiculoRuntDirect, consultarPersonaRuntDirect } from './runt-direct.service.js';

const log = loggerFor('runt');

const CEA_RUNT_URL = 'https://cea.kyverum.com/api/runt/consulta-vehiculo-internal';
const CEA_PERSONA_URL = 'https://cea.kyverum.com/api/runt/consulta-persona-internal';

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
  log.info({ tipoDoc: body.tipoDocumento || 'CC', via: 'proxy-cea' }, 'consulta vehiculo');
  const r = await withCircuitBreaker('runt-vehicle', () =>
    httpsReq('POST', CEA_RUNT_URL, body, { 'x-internal-key': env.RUNT_INTERNAL_KEY }),
  );
  if (r.status !== 200 || typeof r.data === 'string') return { ok: false, message: 'Error comunicando con servicio RUNT' };
  return r.data;
}

async function consultarPersonaProxy(documento: string, tipoDocumento?: string) {
  const body: Record<string, string> = { documento };
  if (tipoDocumento) body.tipoDocumento = tipoDocumento;
  log.info({ docPrefix: documento.slice(0, 4), via: 'proxy-cea' }, 'consulta persona');
  const r = await withCircuitBreaker('runt-persona', () =>
    httpsReq('POST', CEA_PERSONA_URL, body, { 'x-internal-key': env.RUNT_INTERNAL_KEY }),
  );
  if (r.status !== 200 || typeof r.data === 'string') return { ok: false, message: 'Error comunicando con servicio RUNT' };
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
