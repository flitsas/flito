// TRAM-TRASPASO-P0 — gates server-side (biometría + permisos dual-actor).

import { eq } from 'drizzle-orm';
import {
  biometriaAmbasAprobadas,
  clasificarPatchTraspaso,
  ESTADO_STT_LABEL,
  extractPartesTraspasoFromTramite,
  gateFurTraspaso,
  isEstadoSttTraspaso,
  mensajeMutacionDenegada,
  puedeMutarTraspaso,
  resolverValidacionTraspasoParte,
  traspasoExpedienteEditable,
  traspasoSttOperativo,
  type TraspasoBiometriaSnapshot,
  type TraspasoGateResult,
  type TraspasoMutacion,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramitesValidaciones } from '../../db/schema.js';

export {
  gateFurTraspaso,
  pasoTraspasoCompleto,
  validateTraspasoComercial,
  type TraspasoGateResult,
} from '@operaciones/shared-types';

export type TraspasoExpedienteGateResult =
  | { ok: true; estado: string }
  | { ok: false; code: 'not_found' | 'gestion_cerrada' | 'stt_cerrado' | 'mutacion_denegada'; message: string };

/** @deprecated Use assertTraspasoMutacion — solo gestión (compat). */
export async function assertTraspasoExpedienteEditable(tramiteId: number): Promise<TraspasoExpedienteGateResult> {
  return assertTraspasoMutacion(tramiteId, 'proveedor', 'gestion_expediente');
}

export async function assertTraspasoMutacion(
  tramiteId: number,
  actorRole: string,
  mutacion: TraspasoMutacion,
  docTipo?: string,
): Promise<TraspasoExpedienteGateResult> {
  const [row] = await db.select({
    modalidad: tramitesDigitales.modalidadEntrada,
    estado: tramitesDigitales.estado,
  }).from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  if (!row) return { ok: false, code: 'not_found', message: 'Trámite no encontrado' };
  if (row.modalidad !== 'traspaso') return { ok: true, estado: row.estado };
  if (puedeMutarTraspaso(actorRole, row.estado, mutacion, docTipo)) {
    return { ok: true, estado: row.estado };
  }
  const label = isEstadoSttTraspaso(row.estado) ? ESTADO_STT_LABEL[row.estado] : row.estado;
  const code = mutacion === 'gestion_expediente' ? 'gestion_cerrada' : 'mutacion_denegada';
  const message = mutacion === 'gestion_expediente' && traspasoExpedienteEditable(row.estado) === false
    ? `La gestión ya fue enviada a STT (${label}). El expediente del gestor está cerrado. Mueva a Subsanación para que el gestor corrija.`
    : mensajeMutacionDenegada(mutacion, label, actorRole);
  return { ok: false, code, message };
}

export async function assertTraspasoPatch(
  tramiteId: number,
  actorRole: string,
  patch: Parameters<typeof clasificarPatchTraspaso>[0],
): Promise<TraspasoExpedienteGateResult> {
  const mutacion = clasificarPatchTraspaso(patch);
  if (!mutacion) return { ok: true, estado: 'radicado' };
  return assertTraspasoMutacion(tramiteId, actorRole, mutacion);
}

export async function loadBiometriaTraspaso(
  tramiteId: number,
  tramite: { vehiculo?: unknown; comprador?: unknown },
): Promise<TraspasoBiometriaSnapshot> {
  const rows = await db.select({
    id: tramitesValidaciones.id,
    parte: tramitesValidaciones.parte,
    documento: tramitesValidaciones.documento,
    estado: tramitesValidaciones.estado,
  }).from(tramitesValidaciones).where(eq(tramitesValidaciones.tramiteId, tramiteId));

  const { vendedor, comprador } = extractPartesTraspasoFromTramite(tramite);
  const valV = resolverValidacionTraspasoParte(rows, { parte: 'vendedor', documento: vendedor.documento });
  const valC = resolverValidacionTraspasoParte(rows, { parte: 'comprador', documento: comprador.documento });
  return {
    vendedor: valV?.estado === 'aprobado',
    comprador: valC?.estado === 'aprobado',
  };
}

export async function validateTraspasoFurBiometria(
  tramiteId: number,
  vehiculo: unknown,
  tramite: { vehiculo?: unknown; comprador?: unknown; estado?: string; furGenerado?: boolean | null },
): Promise<TraspasoGateResult> {
  // Regeneración STT: el gestor ya generó FUR antes del envío — no re-exigir biométrica al reimprimir.
  if (tramite.furGenerado && tramite.estado && traspasoSttOperativo(tramite.estado)) {
    return { ok: true };
  }
  const biometria = await loadBiometriaTraspaso(tramiteId, tramite);
  return gateFurTraspaso(vehiculo, biometria);
}

export { biometriaAmbasAprobadas };
