// MercadoLibre precio vehículos Colombia — port CEA services.cjs.

import { httpsGetJson } from './http.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('mercadolibre-direct');

export async function precioMercadoLibreDirect(marca: string, linea?: string, anio?: string): Promise<any> {
  if (!marca) return { ok: false, message: 'marca requerida' };
  try {
    const q = [marca, linea, anio].filter(Boolean).join(' ');
    const url = `https://api.mercadolibre.com/sites/MCO/search?category=MCO1744&q=${encodeURIComponent(q)}&limit=50`;
    const r = await httpsGetJson(url);
    if (r.status !== 200 || !r.data) {
      return { ok: false, message: `MercadoLibre no respondió (HTTP ${r.status})` };
    }
    const items = Array.isArray(r.data.results) ? r.data.results : [];
    if (items.length === 0) return { ok: false, message: `Sin resultados en MercadoLibre para ${q}`, total: 0 };
    const precios = items.map((i: any) => Number(i.price) || 0).filter((p: number) => p > 1_000_000);
    if (precios.length === 0) return { ok: false, message: 'Sin precios válidos' };
    precios.sort((a: number, b: number) => a - b);
    const p10 = precios[Math.floor(precios.length * 0.1)];
    const p90 = precios[Math.floor(precios.length * 0.9)];
    const filtrados = precios.filter((p: number) => p >= p10 && p <= p90);
    const promedio = Math.round(filtrados.reduce((s: number, p: number) => s + p, 0) / filtrados.length);
    log.info({ q, total: items.length, via: 'direct' }, 'mercadolibre');
    return {
      ok: true, total: items.length, precioPromedio: promedio,
      precioMin: precios[0], precioMax: precios[precios.length - 1],
      precioMediana: precios[Math.floor(precios.length / 2)],
      ejemplos: items.slice(0, 5).map((i: any) => ({
        titulo: (i.title || '').slice(0, 80), precio: i.price,
        anio: i.attributes?.find((a: any) => a.id === 'VEHICLE_YEAR')?.value_name || null,
        kilometraje: i.attributes?.find((a: any) => a.id === 'KILOMETERS')?.value_name || null,
        ubicacion: [i.address?.city_name, i.address?.state_name].filter(Boolean).join(', '),
        url: i.permalink,
      })),
      consulta: { marca, linea, anio },
      fuente: 'MercadoLibre Vehículos Colombia',
    };
  } catch (e: any) {
    log.warn({ err: e?.message }, 'mercadolibre direct');
    return { ok: false, message: e?.message || 'MercadoLibre no disponible' };
  }
}
