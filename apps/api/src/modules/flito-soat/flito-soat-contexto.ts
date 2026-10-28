// FLITO SOAT — construye el bloque «ya en FLITO» (`SoatFlitoContexto`) de la preconsulta y de los 409
// de RN-01 (Feature #14012, HU #14016, ADR-0031). Función pura: sin base, sin red, sin reloj propio.

import {
  DIAS_RENOVACION_ANTICIPADA, soatEstaAbierto, type SoatFlitoContexto,
} from '@operaciones/shared-types';
import type { SoatActualDelVin } from './flito-soat-actual.js';

/** Días corridos entre dos 'YYYY-MM-DD' (`hasta` - `desde`); negativo = ya pasó. Sin husos. */
export function diasEntre(desde: string, hasta: string): number {
  const t = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((t(hasta) - t(desde)) / 86_400_000);
}

/**
 * El contexto de un vehículo que YA está en FLITO (y es de la compañía de quien consulta).
 *
 * `venceElRunt`: la fecha que el RUNT acaba de reportar (manda); si no hay, `flito_soat.vence_el` del
 * SOAT actual; si ninguna, `diasVigencia: null` y `renovable: false` (defecto seguro). Un abierto
 * NUNCA es renovable.
 */
export function contextoFlito(
  actual: Pick<SoatActualDelVin, 'id' | 'estado' | 'venceEl'>, hoy: string, venceElRunt: string | null = null,
): SoatFlitoContexto {
  const abierto = soatEstaAbierto(actual.estado);
  const venceEl = venceElRunt ?? actual.venceEl ?? null;
  const diasVigencia = venceEl ? diasEntre(hoy, venceEl) : null;
  return {
    yaEnFlito: true,
    abierto,
    estadoAbierto: abierto ? actual.estado : null,
    soatId: actual.id,
    diasVigencia,
    venceEl,
    fuenteVigencia: venceEl ? (venceElRunt ? 'runt' : 'flito') : null,
    renovable: !abierto && diasVigencia !== null && diasVigencia <= DIAS_RENOVACION_ANTICIPADA,
  };
}

/** El vehículo no está en FLITO: nada que renovar, el RUNT decide si hay SOAT vigente. */
export function contextoSinFlito(hoy: string, venceElRunt: string | null): SoatFlitoContexto {
  return {
    yaEnFlito: false, abierto: false, estadoAbierto: null, soatId: null,
    diasVigencia: venceElRunt ? diasEntre(hoy, venceElRunt) : null,
    venceEl: venceElRunt, fuenteVigencia: venceElRunt ? 'runt' : null,
    renovable: true,
  };
}
