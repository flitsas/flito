// Torre de Control Gerencial (Épica #14590) — piezas comunes de los cuatro tableros: contexto, rango, porcentajes,
// caché y condiciones sobre `flito_tramites` (siempre vía `condicionesTorre`, RN-TOR-F1).
import type { SQL } from 'drizzle-orm';
import type { FiltroTorre } from '@operaciones/shared-types';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';
import { DIMS_TRAMITE } from './flito-torre.catalogo.js';
import {
  condicionesTorre, diasDeRango, exigirTopesRango, resolverRango, type FechaBase, type RangoResuelto,
} from './flito-torre.filtro.js';
import { claveCache, guardarCache, leerCache } from './flito-torre.metricas.service.js';

export interface ContextoTablero {
  filtro: FiltroTorre;
  alcance: AlcanceResuelto;
  /** ¿Tiene `FUNCION_TORRE_DINERO`? Sin ella, los campos de dinero salen `null`. */
  dinero: boolean;
  /** Día de hoy en Bogotá (tests). */
  hoy?: string;
}

export const hoyDe = (ctx: ContextoTablero): string => ctx.hoy ?? hoyColombia();

/** Rango del filtro con los topes del motor. */
export function rangoTablero(ctx: ContextoTablero): RangoResuelto {
  const r = resolverRango(ctx.filtro.rango, hoyDe(ctx));
  exigirTopesRango(r);
  return r;
}

export const diasDe = diasDeRango;
export const r1 = (v: number): number => Math.round(v * 10) / 10;
export const pct = (parte: number, total: number): number => (total ? r1((parte / total) * 100) : 0);
export const pctONull = (parte: number, total: number): number | null => (total ? r1((parte / total) * 100) : null);
export const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Condiciones del filtro + alcance sobre trámites. */
export const condTramites = (
  ctx: ContextoTablero, rango: RangoResuelto | null, fecha?: FechaBase, ignorar?: readonly (keyof FiltroTorre)[],
): SQL[] => condicionesTorre(ctx.filtro, ctx.alcance, DIMS_TRAMITE, { rango, fecha, ignorar });

/** RN-TOR-M8 aplicado a un tablero entero (clave = tablero + filtro + rango + alcance + dinero + día). */
export async function conCacheTablero<T>(nombre: string, ctx: ContextoTablero, calcular: () => Promise<T>): Promise<T> {
  const clave = claveCache(`tablero-${nombre}`, ctx.filtro, ctx.alcance, ctx.dinero, hoyDe(ctx));
  const cacheado = await leerCache<T>(clave);
  if (cacheado) return cacheado;
  const valor = await calcular();
  await guardarCache(clave, valor);
  return valor;
}
