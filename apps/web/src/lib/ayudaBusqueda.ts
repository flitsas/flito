// Match del índice de Ayuda FLITO (HU #11901). Separado de ayudaFlito.ts: no toca el gate.
// Misma normalización que FlitOrganismoCombobox (`normalizeSearch`).

import type { EntradaAyuda } from '../content/ayuda/catalogo';

export function normalizarBusquedaAyuda(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function entradaCoincideBusqueda(
  entrada: EntradaAyuda,
  cuerpo: string | null | undefined,
  consulta: string,
): boolean {
  const q = normalizarBusquedaAyuda(consulta).trim();
  if (!q) return true;
  const haystack =
    normalizarBusquedaAyuda(entrada.etiqueta)
    + normalizarBusquedaAyuda(entrada.resumen)
    + normalizarBusquedaAyuda(cuerpo ?? '');
  return haystack.includes(q);
}
