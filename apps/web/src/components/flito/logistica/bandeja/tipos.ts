// HU #14149 — bandeja «LT pendientes de trámite». Tipos, copy y utilidades puras.
// Contrato del API: apps/api/src/modules/flito-logistica/flito-logistica.pendientes.ts (HU #14143/#14160).
import { ApiError } from '../../../../lib/api';

export interface CandidatoLt {
  tramiteId: string; idFlit: string; companiaId: number; companiaNombre: string | null; organismoCodigo: string | null;
  fechaAprobacion: string | null; tipoTramite: string | null;
}
export interface PendienteLt {
  documentoId: string; placa: string | null; organismoCodigo: string; estado: string; firmada: boolean;
  recogidoEn: string; recogidoPorNombre: string | null; antiguedadDias: number; candidatos: CandidatoLt[];
}

/** Función que habilita pestaña, aviso y llamadas al API. */
export const FUNCION_RESOLVER_TRAMITE = 'logistica.documento.resolver_tramite';
export const TOPE_BANDEJA = 500;

export const fechaHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fechaCorta = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-CO', { dateStyle: 'short' }) : null);

export function textoAntiguedad(dias: number): string {
  return dias <= 0 ? 'Hoy' : dias === 1 ? '1 día' : `${dias} días`;
}
export function textoCandidatos(n: number): string {
  return n === 0 ? 'Sin candidatos' : n === 1 ? '1 candidato' : `${n} candidatos`;
}

/** Código de negocio del cuerpo del error (`codigo`), nunca el texto del API. */
export function codigoDeError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.rawDetails as { codigo?: unknown } | undefined;
  return typeof d?.codigo === 'string' ? d.codigo : null;
}

export const COPY = {
  LT_NO_PENDIENTE: 'Esta LT ya no está pendiente: alguien le asignó su trámite. Actualizamos la lista.',
  LT_NO_ENCONTRADA: 'No encontramos esta LT. Actualizamos la lista.',
  TRAMITE_NO_CANDIDATO: 'Ese trámite ya no es una opción para esta LT. Elige otro de la lista actualizada.',
  TRAMITE_YA_TIENE_LT: 'Ese trámite ya tiene otra LT. Elige otro de la lista actualizada.',
  GENERICO: 'No pudimos asignar el trámite. Inténtalo de nuevo; si sigue fallando, avisa a soporte.',
} as const;
