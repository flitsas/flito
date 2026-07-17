// TRAM-TRASPASO-F1 — modalidad de entrada + workflow STT del traspaso.

export type TramiteModalidadEntrada = 'matricula_inicial' | 'traspaso';

export interface TramiteWorkflowEvent {
  de: string | null;
  a: string;
  usuario: string;
  timestamp: string;
  nota?: string;
}

// Estados STT del traspaso (alineados a CEA).
export type TramiteEstadoStt =
  | 'radicado' | 'en_validacion' | 'subsanacion' | 'en_tramite'
  | 'aprobado' | 'rechazado' | 'entregado' | 'anulado';

export const ESTADOS_STT_TRASPASO: readonly TramiteEstadoStt[] = [
  'radicado', 'en_validacion', 'subsanacion', 'en_tramite', 'aprobado', 'rechazado', 'entregado', 'anulado',
];

export const ESTADO_STT_LABEL: Record<TramiteEstadoStt, string> = {
  radicado: 'Radicado', en_validacion: 'En validación', subsanacion: 'Subsanación', en_tramite: 'En trámite',
  aprobado: 'Aprobado', rechazado: 'Rechazado', entregado: 'Entregado', anulado: 'Anulado',
};

// Grafo de transiciones válidas. Terminales: entregado, anulado.
const TRANSICIONES: Record<TramiteEstadoStt, TramiteEstadoStt[]> = {
  radicado: ['en_validacion', 'subsanacion', 'anulado'],
  en_validacion: ['subsanacion', 'en_tramite', 'rechazado', 'anulado'],
  subsanacion: ['en_validacion', 'anulado'],
  en_tramite: ['aprobado', 'subsanacion', 'rechazado', 'anulado'],
  aprobado: ['entregado', 'anulado'],
  rechazado: ['subsanacion', 'anulado'],
  entregado: [],
  anulado: [],
};

export function isEstadoSttTraspaso(e: string): e is TramiteEstadoStt {
  return (ESTADOS_STT_TRASPASO as readonly string[]).includes(e);
}

/** Estados en los que el gestor CEA puede editar el expediente del traspaso. */
export function traspasoExpedienteEditable(estado: string): boolean {
  return estado === 'radicado' || estado === 'subsanacion';
}

/** Gestión CEA cerrada → wizard y anexos en solo lectura (salvo subsanación). */
export function traspasoGestionCerrada(estado: string): boolean {
  return isEstadoSttTraspaso(estado) && !traspasoExpedienteEditable(estado);
}

/** ¿Se permite la transición STT `from`→`to`? */
export function puedeTransicionarStt(from: string, to: string): boolean {
  if (!isEstadoSttTraspaso(from) || !isEstadoSttTraspaso(to)) return false;
  return TRANSICIONES[from].includes(to);
}

/** Estados a los que se puede mover desde `from` (para UI). */
export function transicionesDesde(from: string): TramiteEstadoStt[] {
  return isEstadoSttTraspaso(from) ? TRANSICIONES[from] : [];
}

/** Número de radicado TD-YYYY-NNNNN a partir de un consecutivo + año. */
export function formatRadicado(seq: number, year: number): string {
  return `TD-${year}-${String(seq).padStart(5, '0')}`;
}
