// TRAM-OPS-02 — utilidades UI rechazo OT (compartidas lista + embudo).

import { ESTADOS_RECHAZO_OT_ELIGIBLE, MOTIVOS_RECHAZO_OT, getMotivoRechazo } from '@operaciones/shared-types';

export { MOTIVOS_RECHAZO_OT, getMotivoRechazo };

export function canRechazarOt(estado: string): boolean {
  return (ESTADOS_RECHAZO_OT_ELIGIBLE as readonly string[]).includes(estado);
}

export function motivoRechazoLabel(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return getMotivoRechazo(codigo)?.label ?? codigo;
}

export interface MotivoRechazoApi {
  codigo: string;
  label: string;
}

export interface RechazarOtResponse {
  ok: boolean;
  tramite: { id: number; estado: string; motivoRechazoCodigo?: string | null };
  checklistSugeridos: string[];
}
