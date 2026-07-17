// ADR-OPS-001 — integraciones con modo direct | cea-proxy (+ fallback CEA en SIMIT/ML).

import { loggerFor } from '../../shared/logger.js';
import { useCeaProxy } from './mode.js';
import { consultarSimitDirect } from './simit.direct.js';
import { buscarFasecoldaDirect, type FasecoldaQuery } from './fasecolda.direct.js';
import { precioMercadoLibreDirect } from './mercadolibre.direct.js';
import { consultarSimitProxy, buscarFasecoldaProxy, precioMercadoLibreProxy } from './cea-proxy.js';

const log = loggerFor('integraciones');

export type { FasecoldaQuery };
export type { SimitComparendo } from './simit.direct.js';

export interface SimitResult {
  ok: boolean; total: number; totalMonto: number; comparendos: import('./simit.direct.js').SimitComparendo[]; message?: string;
}

export interface IntegracionCallOpts {
  /** Pre-vuelo operaciones: no encadenar proxy CEA (evita cuelgues 90s+). */
  skipCeaFallback?: boolean;
}

export async function consultarSimit(filtro: string, opts?: IntegracionCallOpts): Promise<SimitResult> {
  if (!filtro) return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: 'Documento o placa requerido' };
  try {
    if (useCeaProxy() && !opts?.skipCeaFallback) return await consultarSimitProxy(filtro);
    const direct = await consultarSimitDirect(filtro);
    if (direct.ok) return direct;
    if (opts?.skipCeaFallback) {
      return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: direct.message || 'SIMIT no disponible' };
    }
    log.warn({ message: direct.message, via: 'cea-fallback' }, 'simit direct falló');
    return await consultarSimitProxy(filtro);
  } catch (e: any) {
    if (!opts?.skipCeaFallback && !useCeaProxy()) {
      try { return await consultarSimitProxy(filtro); } catch { /* sigue error original */ }
    }
    return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: e?.message || 'SIMIT no disponible' };
  }
}

export async function buscarFasecolda(q: FasecoldaQuery): Promise<any> {
  if (!q.marca || !q.anio) return { ok: false, message: 'marca y anio requeridos' };
  try {
    if (useCeaProxy()) return await buscarFasecoldaProxy(q);
    return await buscarFasecoldaDirect(q);
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Fasecolda no disponible' };
  }
}

export async function precioMercadoLibre(marca: string, linea?: string, anio?: string): Promise<any> {
  if (!marca) return { ok: false, message: 'marca requerida' };
  try {
    if (useCeaProxy()) return await precioMercadoLibreProxy(marca, linea, anio);
    const direct = await precioMercadoLibreDirect(marca, linea, anio);
    if (direct.ok) return direct;
    log.warn({ message: direct.message, via: 'cea-fallback' }, 'mercadolibre direct falló');
    return await precioMercadoLibreProxy(marca, linea, anio);
  } catch (e: any) {
    if (!useCeaProxy()) {
      try { return await precioMercadoLibreProxy(marca, linea, anio); } catch { /* sigue error original */ }
    }
    return { ok: false, message: e?.message || 'MercadoLibre no disponible' };
  }
}
