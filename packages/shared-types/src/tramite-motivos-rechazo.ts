// TRAM-PRODUCTO · TRAM-OPS-02 — Catálogo de motivos de rechazo OT + sugerencias checklist.
//
// Fuente única API/web. El evento `rechazado_ot` persiste `codigo` en payload;
// la columna `motivo_rechazo_codigo` en tramites_digitales es denormalización para query.

import { computeChecklist, type ChecklistEstado } from './tramite-tipologias.js';

export type MotivoRechazoCodigo = 'doc_faltante' | 'comparendo' | 'laft' | 'datos_runt' | 'otro';

export interface MotivoRechazoOt {
  codigo: MotivoRechazoCodigo;
  label: string;
  /** IDs de checklist sugeridos (estáticos; doc_faltante se calcula dinámico). */
  checklistIdsEstaticos: string[];
}

export const MOTIVOS_RECHAZO_OT: MotivoRechazoOt[] = [
  { codigo: 'doc_faltante', label: 'Documentación incompleta', checklistIdsEstaticos: [] },
  { codigo: 'comparendo', label: 'Comparendos / paz y salvo', checklistIdsEstaticos: ['paz_salvo', 'paz_salvo_dian', 'paz_salvo_remate'] },
  { codigo: 'laft', label: 'Novedad LAFT / listas', checklistIdsEstaticos: [] },
  { codigo: 'datos_runt', label: 'Datos no coinciden con RUNT', checklistIdsEstaticos: [] },
  { codigo: 'otro', label: 'Otro (nota libre)', checklistIdsEstaticos: [] },
];

const MOTIVO_BY_CODE = new Map(MOTIVOS_RECHAZO_OT.map((m) => [m.codigo, m]));

export function isValidMotivoRechazo(codigo: string): codigo is MotivoRechazoCodigo {
  return MOTIVO_BY_CODE.has(codigo as MotivoRechazoCodigo);
}

export function getMotivoRechazo(codigo: string): MotivoRechazoOt | undefined {
  return MOTIVO_BY_CODE.get(codigo as MotivoRechazoCodigo);
}

/** Estados desde los que se puede registrar un rechazo OT (pre y post envío a tránsito). */
export const ESTADOS_RECHAZO_OT_ELIGIBLE = [
  'radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado',
  'enviado_transito', 'recibido_transito', 'placa_preasignada',
] as const;

export type EstadoRechazoOtEligible = typeof ESTADOS_RECHAZO_OT_ELIGIBLE[number];

export function isEstadoRechazoOtEligible(estado: string): estado is EstadoRechazoOtEligible {
  return (ESTADOS_RECHAZO_OT_ELIGIBLE as readonly string[]).includes(estado);
}

/**
 * Sugerencias de checklist según motivo y tipología del trámite.
 * `doc_faltante` devuelve obligatorios pendientes; otros usan mapeo estático filtrado por tipología.
 */
export function computeChecklistSugeridos(
  codigo: MotivoRechazoCodigo,
  tipologiaCodigo: string | null | undefined,
  checklistEstado: ChecklistEstado | null | undefined,
  docTipos: string[] = [],
): string[] {
  if (codigo === 'doc_faltante') {
    const res = computeChecklist(tipologiaCodigo, checklistEstado, docTipos);
    return res?.faltanObligatorios ?? [];
  }
  const motivo = getMotivoRechazo(codigo);
  if (!motivo?.checklistIdsEstaticos.length) return [];
  const res = computeChecklist(tipologiaCodigo, checklistEstado, docTipos);
  if (!res) return motivo.checklistIdsEstaticos;
  const idsTipologia = new Set(res.items.map((i) => i.id));
  return motivo.checklistIdsEstaticos.filter((id) => idsTipologia.has(id));
}
