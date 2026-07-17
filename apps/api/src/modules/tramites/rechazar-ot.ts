// TRAM-PRODUCTO · TRAM-OPS-02 — Rechazo OT con motivo tipificado.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramitesDocumentos } from '../../db/schema.js';
import {
  isValidMotivoRechazo,
  isEstadoRechazoOtEligible,
  computeChecklistSugeridos,
  type MotivoRechazoCodigo,
} from '@operaciones/shared-types';
import { patchTramite } from './tramites.service.js';

type TramiteRow = typeof tramitesDigitales.$inferSelect;

export interface RechazarOtInput {
  codigo: MotivoRechazoCodigo;
  nota?: string;
}

export type RechazarOtResult =
  | { ok: true; tramite: TramiteRow; checklistSugeridos: string[] }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid_codigo' }
  | { ok: false; code: 'estado_no_elegible'; estado: string }
  | { ok: false; code: 'invalid_transition'; from: string; to: string }
  | { ok: false; code: 'conflict' };

async function uploadedDocTipos(tramiteId: number): Promise<string[]> {
  const rows = await db.select({ tipo: tramitesDocumentos.tipo }).from(tramitesDocumentos).where(eq(tramitesDocumentos.tramiteId, tramiteId));
  return rows.map((r) => r.tipo);
}

export async function rechazarOtTramite(id: number, input: RechazarOtInput, userId: number): Promise<RechazarOtResult> {
  if (!isValidMotivoRechazo(input.codigo)) return { ok: false, code: 'invalid_codigo' };

  const [t] = await db.select({
    estado: tramitesDigitales.estado,
    tipologiaCodigo: tramitesDigitales.tipologiaCodigo,
    checklistEstado: tramitesDigitales.checklistEstado,
  }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1) as any;
  if (!t) return { ok: false, code: 'not_found' };
  if (!isEstadoRechazoOtEligible(t.estado)) return { ok: false, code: 'estado_no_elegible', estado: t.estado };

  const docTipos = await uploadedDocTipos(id);
  const checklistSugeridos = computeChecklistSugeridos(input.codigo, t.tipologiaCodigo, t.checklistEstado, docTipos);

  const patched = await patchTramite(id, { estado: 'rechazado' }, userId);
  if (!patched.ok) {
    if (patched.code === 'not_found') return { ok: false, code: 'not_found' };
    if (patched.code === 'invalid_transition') return { ok: false, code: 'invalid_transition', from: patched.from, to: patched.to };
    return { ok: false, code: 'conflict' };
  }

  const [updated] = await db.update(tramitesDigitales)
    .set({ motivoRechazoCodigo: input.codigo, updatedAt: new Date() })
    .where(eq(tramitesDigitales.id, id))
    .returning();

  return { ok: true, tramite: updated, checklistSugeridos };
}
