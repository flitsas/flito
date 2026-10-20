// Match del índice de Ayuda FLITO (HU #11901). Separado de ayudaFlito.ts: no toca el gate.
// Misma normalización que FlitOrganismoCombobox (`normalizeSearch`).

import type { EntradaAyuda } from '../content/ayuda/catalogo';
import type { FichaParseada } from './ayudaFicha';

export function normalizarBusquedaAyuda(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Subtítulo de la entrada (HU #13703): el `resumen` del encabezado si hay `.md`; si no, el
 * `resumenPendiente` del catálogo. Encabezado inválido en runtime → cadena vacía (tolerante).
 */
export function resumenDeEntrada(entrada: EntradaAyuda, ficha: FichaParseada | null | undefined): string {
  if (ficha) return ficha.encabezado?.resumen ?? '';
  return entrada.resumenPendiente ?? '';
}

export function entradaCoincideBusqueda(
  entrada: EntradaAyuda,
  ficha: FichaParseada | null | undefined,
  consulta: string,
): boolean {
  const q = normalizarBusquedaAyuda(consulta).trim();
  if (!q) return true;
  const haystack =
    normalizarBusquedaAyuda(entrada.etiqueta)
    + normalizarBusquedaAyuda(resumenDeEntrada(entrada, ficha))
    + normalizarBusquedaAyuda(ficha?.cuerpo ?? '');
  return haystack.includes(q);
}
