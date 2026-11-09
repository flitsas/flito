// FLITO Logística — copy de los errores HTTP de la consola y de Mi ruta (HU #14353, ADR-0039 §7.2).
// Un solo punto de traducción, y solo por estado: nunca se lee el cuerpo del error ni se usa
// `errorMessage(e)`. Así un registro ajeno y uno inexistente se ven idénticos, porque el cliente no
// tiene con qué distinguirlos. Quien añada aquí una rama por `rawDetails` rompe esa garantía.
import { ApiError } from './api';

export type RecursoLogistica = 'tramite' | 'acta';

const statusDe = (e: unknown): number => (e instanceof ApiError ? e.status : 0);

/** Se pudo responder y dijo que no: se recarga la lista, porque lo que se ve quedó viejo. */
export const esRechazoDeAlcance = (e: unknown): boolean => {
  const s = statusDe(e);
  return s === 403 || s === 404;
};

const NO_ENCONTRADO: Record<RecursoLogistica, string> = {
  tramite: 'No encontramos este trámite. Revise la lista actualizada.',
  acta: 'No encontramos esta acta. Revise la lista actualizada.',
};

/** Abrir un detalle: 404 por recurso, 403 único. Lo demás es red o servidor y admite reintento. */
export function mensajeLecturaLogistica(e: unknown, recurso: RecursoLogistica): { texto: string; reintentar: boolean; recargar: boolean } {
  const s = statusDe(e);
  if (s === 404) return { texto: NO_ENCONTRADO[recurso], reintentar: false, recargar: true };
  if (s === 403) return { texto: 'No tiene permiso para ver este detalle.', reintentar: false, recargar: false };
  return { texto: 'No se pudo abrir el detalle. Inténtelo de nuevo.', reintentar: true, recargar: false };
}

/** Descargar el PDF del acta: comparte los textos de lectura; solo cambia el de red o servidor. */
export function mensajePdfLogistica(e: unknown): { texto: string; reintentar: boolean; recargar: boolean } {
  const lectura = mensajeLecturaLogistica(e, 'acta');
  return lectura.reintentar ? { ...lectura, texto: 'No se pudo descargar el PDF. Inténtelo de nuevo.' } : lectura;
}

export const MENSAJE_ESCRITURA_RECHAZADA = 'No se pudo hacer este cambio sobre este registro. Revise la lista actualizada.';

/** Una acción de la consola: 403 y 404 con el mismo texto. */
export function mensajeEscrituraLogistica(e: unknown): string {
  return esRechazoDeAlcance(e) ? MENSAJE_ESCRITURA_RECHAZADA : 'No se pudo guardar el cambio. Inténtelo de nuevo.';
}

/** Mi ruta (tú): entregar o devolver un viaje que dejó de ser del mensajero. Recarga la lista. */
export const MENSAJE_VIAJE_FUERA_DE_RUTA = 'Este viaje ya no está en tu ruta. Revisa la lista actualizada.';
