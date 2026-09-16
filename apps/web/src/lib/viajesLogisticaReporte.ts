// FLITO — Los viajes de logística tal como los ENSEÑA el reporte de costos (HU #12628, Feature
// #12618, Épica #12244): la celda «Viajes» de la ampliada, el rótulo y el nombre accesible del
// botón de la fila y la línea de origen del panel de solo lectura.
// Diseño: `docs/ux/finanzas-reporte-costos-viajes.md`.
//
// Todo es puro y se prueba sin DOM. Lo que no está aquí es deliberado: el conteo NO se deriva de
// `items.length` (viene en la fila) y el total NO se suma en cliente (viene del servidor).

import type { DesgloseViajesLogistica, ModoPrecioViaje } from '@operaciones/shared-types';
import { pesos } from './pesos.ts';
import { fechaHoraCorta } from './tarifas.ts';

/** La ruta del desglose de solo lectura que el reporte pide por trámite. */
export const rutaViajesDeTramiteReporte = (tramiteId: string): string =>
  `/finanzas/tramites/${tramiteId}/viajes-logistica`;

/** El `title` de «Sin dato»: por qué esa liquidación no sabe cuántos viajes llevaba. */
export const TITULO_SIN_DATO_VIAJES = 'Se liquidó antes de que FLITO cobrara viajes adicionales.';

/**
 * Los tres desenlaces de la celda, que son afirmaciones DISTINTAS y no se confunden (UX §celda):
 *   · `viajes`   — n ≥ 1: el número, con el nombre accesible completo (la cabecera es corta).
 *   · `vacio`    — 0: la compañía autogestiona la logística; el guion del reporte con su `title`.
 *   · `sin_dato` — null: se selló antes del concepto. NUNCA «0»: no se sabe, no se cuenta.
 */
export type CeldaViajes =
  | { clase: 'viajes'; texto: string; accesible: string }
  | { clase: 'vacio'; title: string }
  | { clase: 'sin_dato'; texto: string; title: string };

export function textoCeldaViajes(n: number | null): CeldaViajes {
  if (n === null) return { clase: 'sin_dato', texto: 'Sin dato', title: TITULO_SIN_DATO_VIAJES };
  if (n <= 0) return { clase: 'vacio', title: 'Autogestiona' };
  return { clase: 'viajes', texto: String(n), accesible: `${n} ${n === 1 ? 'viaje' : 'viajes'} de logística` };
}

/** «Viajes · 3» solo con n ≥ 2; «Viajes» con 1, 0 o null. «· 1» sería contar el incluido. */
export const rotuloBotonViajes = (n: number | null): string =>
  n !== null && n >= 2 ? `Viajes · ${n}` : 'Viajes';

/** «autogestiona» · «sin dato» · «1 viaje» · «3 viajes»: lo que va tras «Viajes de logística de FLIT-X: ». */
export function nombreDeCantidadViajes(n: number | null): string {
  if (n === null) return 'sin dato';
  if (n <= 0) return 'autogestiona';
  return n === 1 ? '1 viaje' : `${n} viajes`;
}

/** Empieza por el texto visible (WCAG 2.5.3) y sigue con el trámite y cuántos son. */
export const nombreAccesibleBotonViajes = (idFlit: string, n: number | null): string =>
  `Viajes de logística de ${idFlit}: ${nombreDeCantidadViajes(n)}`;

/** «Viajes de logística · FLIT-10234 · ABC123», sin « · » colgando cuando no hay placa. */
export const tituloPanelViajes = (idFlit: string, placa: string | null): string =>
  ['Viajes de logística', idFlit, placa].filter((p) => p !== null && p !== '').join(' · ');

/**
 * De dónde sale lo que el panel enseña: la estimación viva o el sello. `sin_desglose` es un sello
 * también (solo que sin detalle), así que dice la misma línea que `sellado`.
 */
export function lineaOrigen(datos: Pick<DesgloseViajesLogistica, 'origen' | 'liquidadoEn'>): string {
  if (datos.origen === 'vigente') return 'Estimado con los viajes registrados';
  return `Sellado el ${fechaHoraCorta(datos.liquidadoEn)}`;
}

/**
 * Cómo se fijó el precio, en una palabra: «Tarifa» (copió la vigente) o «Precio manual». La
 * desviación no va aquí sino al lado, en `textoTarifaDelMomento`, para que la fila lea
 * «Precio manual · Tarifa del momento $ 45.000» y no repita la cifra entre paréntesis.
 */
export const etiquetaModoViaje = (modo: ModoPrecioViaje): string => (modo === 'inicial' ? 'Tarifa' : 'Precio manual');

/** «Tarifa del momento $ 45.000» · «Sin tarifa» (manual sin tarifa configurada al registrar). */
export const textoTarifaDelMomento = (tarifaVigente: number | null): string =>
  tarifaVigente === null ? 'Sin tarifa' : `Tarifa del momento ${pesos(tarifaVigente)}`;

/** «Viaje 1 · incluido en la tarifa · $ 35.000», o «Sin tarifa configurada» si no la hay. */
export const textoViajeIncluido = (tarifa: number | null): string =>
  `Viaje 1 · incluido en la tarifa · ${tarifa === null ? 'Sin tarifa configurada' : pesos(tarifa)}`;

/** «1 viaje» · «3 viajes» para el pie del panel. El N viene del servidor: aquí no se suma nada. */
export const textoTotalViajesPanel = (totalViajes: number): string =>
  totalViajes === 1 ? '1 viaje' : `${totalViajes} viajes`;
