// Proxy legacy a cea.kyverum.com — se elimina en Fase 3 del desacople.

import https from 'https';
import { env } from '../../config/env.js';
import { withCircuitBreaker } from '../../services/circuitBreaker.js';
import type { FasecoldaQuery } from './fasecolda.direct.js';
import type { SimitComparendo } from './simit.direct.js';

const CEA_SIMIT_URL = 'https://cea.kyverum.com/api/simit/consulta-internal';
const CEA_FASECOLDA_URL = 'https://cea.kyverum.com/api/fasecolda/buscar-internal';
const CEA_ML_URL = 'https://cea.kyverum.com/api/mercadolibre/precio-internal';

interface HttpResponse { status: number | undefined; data: any }

function httpsReq(method: string, url: string, body: any, hdrs?: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string | number> = { 'Content-Type': 'application/json', ...hdrs };
    const bs = method !== 'GET' && body ? JSON.stringify(body) : null;
    if (bs) h['Content-Length'] = Buffer.byteLength(bs);
    const rq = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (r2) => {
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve({ status: r2.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: r2.statusCode, data: d }); }
      });
    });
    rq.setTimeout(90_000, () => rq.destroy(new Error('Timeout 90s')));
    rq.on('error', reject);
    if (bs) rq.write(bs);
    rq.end();
  });
}

const KEY = () => ({ 'x-internal-key': env.RUNT_INTERNAL_KEY });

export async function consultarSimitProxy(filtro: string) {
  const r = await withCircuitBreaker('simit', () => httpsReq('POST', CEA_SIMIT_URL, { numDoc: filtro }, KEY()));
  if (r.status !== 200 || typeof r.data === 'string' || !r.data?.ok) {
    return { ok: false, total: 0, totalMonto: 0, comparendos: [] as SimitComparendo[], message: 'No se pudo consultar SIMIT' };
  }
  const comparendos: SimitComparendo[] = Array.isArray(r.data.data) ? r.data.data : [];
  const totalMonto = comparendos.reduce((s, c) => s + (Number(c.monto) || 0), 0);
  return { ok: true, total: comparendos.length, totalMonto, comparendos };
}

export async function buscarFasecoldaProxy(q: FasecoldaQuery) {
  const qs = new URLSearchParams();
  qs.set('marca', q.marca); qs.set('anio', q.anio);
  if (q.linea) qs.set('linea', q.linea);
  if (q.cilindraje) qs.set('cilindraje', q.cilindraje);
  if (q.combustible) qs.set('combustible', q.combustible);
  if (q.puertas) qs.set('puertas', q.puertas);
  if (q.clase) qs.set('clase', q.clase);
  const r = await withCircuitBreaker('fasecolda', () => httpsReq('GET', `${CEA_FASECOLDA_URL}?${qs.toString()}`, null, KEY()));
  if (r.status !== 200 || typeof r.data === 'string') return { ok: false, message: 'No se pudo consultar Fasecolda' };
  return r.data;
}

export async function precioMercadoLibreProxy(marca: string, linea?: string, anio?: string) {
  const qs = new URLSearchParams();
  qs.set('marca', marca);
  if (linea) qs.set('linea', linea);
  if (anio) qs.set('anio', anio);
  const r = await withCircuitBreaker('mercadolibre', () => httpsReq('GET', `${CEA_ML_URL}?${qs.toString()}`, null, KEY()));
  if (r.status !== 200 || typeof r.data === 'string') return { ok: false, message: 'No se pudo consultar MercadoLibre' };
  return r.data;
}
