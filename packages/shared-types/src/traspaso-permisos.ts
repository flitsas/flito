// TRAM-TRASPASO-P0 — permisos dual-actor (gestor CEA ↔ operador STT), alineado a CEA TransitosModule.

import { traspasoExpedienteEditable, type TramiteWorkflowEvent } from './tramite-workflow.js';

/** Capa funcional (no confundir con user.role de BD). */
export type TraspasoCapa = 'gestor' | 'stt';

export type TraspasoMutacion = 'gestion_expediente' | 'stt_datos' | 'stt_documento' | 'generar_legal';

/** Tipos documentales cargados por el organismo STT (no checklist gestor). */
export const TRASPASO_STT_DOC_TIPOS = [
  'comprobante_derechos',
  'acta_entrega',
  'runt_respuesta',
  'stt_anexo',
] as const;

export type TraspasoSttDocTipo = (typeof TRASPASO_STT_DOC_TIPOS)[number];

export function esDocTipoStt(tipo: string): tipo is TraspasoSttDocTipo {
  return (TRASPASO_STT_DOC_TIPOS as readonly string[]).includes(tipo);
}

/** Mapeo user.role → capa principal. Admin opera ambas capas. */
export function traspasoCapaPrincipal(role: string): TraspasoCapa | 'admin' {
  if (role === 'transito') return 'stt';
  if (role === 'admin') return 'admin';
  return 'gestor';
}

/** Gestor edita wizard (radicado | subsanacion) — alias explícito del workflow CEA. */
export function traspasoGestionEditable(estado: string): boolean {
  return traspasoExpedienteEditable(estado);
}

/** STT opera validación/trámite (en_validacion → en_tramite → aprobado). */
export function traspasoSttOperativo(estado: string): boolean {
  return estado === 'en_validacion' || estado === 'en_tramite' || estado === 'aprobado';
}

function capaPuede(capa: TraspasoCapa | 'admin', capaRequerida: TraspasoCapa): boolean {
  return capa === 'admin' || capa === capaRequerida;
}

export function puedeMutarTraspaso(role: string, estado: string, mutacion: TraspasoMutacion, docTipo?: string): boolean {
  const capa = traspasoCapaPrincipal(role);
  switch (mutacion) {
    case 'gestion_expediente':
      return capaPuede(capa, 'gestor') && traspasoGestionEditable(estado);
    case 'stt_datos':
      return capaPuede(capa, 'stt') && traspasoSttOperativo(estado);
    case 'stt_documento':
      if (!docTipo || !esDocTipoStt(docTipo)) return false;
      return capaPuede(capa, 'stt') && traspasoSttOperativo(estado);
    case 'generar_legal':
      if (capa === 'admin') {
        return traspasoGestionEditable(estado) || traspasoSttOperativo(estado);
      }
      if (capa === 'stt') return traspasoSttOperativo(estado);
      return traspasoGestionEditable(estado);
    default:
      return false;
  }
}

/** PATCH vehiculo contiene solo `_stt` (datos operador STT). */
export function esPatchVehiculoSoloStt(vehPatch: Record<string, unknown>): boolean {
  const keys = Object.keys(vehPatch);
  return keys.length > 0 && keys.every((k) => k === '_stt');
}

/** Clasifica mutación de un PATCH parcial de traspaso. */
export function clasificarPatchTraspaso(d: {
  vehiculo?: unknown;
  comprador?: unknown;
  paso?: number;
  checklistEstado?: unknown;
  tipologiaCodigo?: unknown;
}): TraspasoMutacion | null {
  if (d.comprador !== undefined || d.paso !== undefined
    || d.checklistEstado !== undefined || d.tipologiaCodigo !== undefined) {
    return 'gestion_expediente';
  }
  if (d.vehiculo !== undefined) {
    const vp = d.vehiculo as Record<string, unknown>;
    if (esPatchVehiculoSoloStt(vp)) return 'stt_datos';
    return 'gestion_expediente';
  }
  return null;
}

/** Última nota al pasar a subsanación (visible al gestor CEA). */
export function ultimaNotaSubsanacion(workflow: TramiteWorkflowEvent[] | null | undefined): string | null {
  if (!Array.isArray(workflow)) return null;
  for (let i = workflow.length - 1; i >= 0; i--) {
    const w = workflow[i];
    if (w.a === 'subsanacion' && w.nota?.trim()) return w.nota.trim();
  }
  return null;
}

export function mensajeMutacionDenegada(mutacion: TraspasoMutacion, estado: string, role: string): string {
  const capa = traspasoCapaPrincipal(role);
  if (mutacion === 'gestion_expediente') {
    if (capa === 'stt') {
      return 'Este expediente está en flujo STT. Use la bandeja Traspasos STT para validar, cargar soportes o mover a Subsanación si el gestor debe corregir.';
    }
    return `La gestión ya fue enviada a STT (${estado}). El expediente del gestor está cerrado. El organismo debe mover a Subsanación para reabrir la edición.`;
  }
  if (mutacion === 'stt_datos' || mutacion === 'stt_documento') {
    return `Los cargues STT solo están permitidos en En validación, En trámite o Aprobado (estado actual: ${estado}).`;
  }
  return `No puede generar documentos legales en el estado ${estado}.`;
}

export interface TraspasoSttDatos {
  numeroRunt?: string;
  notasStt?: string;
  pago?: { valor?: number; metodo?: string; ref?: string };
  asignadoA?: string;
}
