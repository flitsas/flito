// Arranque de SOAT e impuesto de un trámite YA guardado que acaba de quedar en condición de arrancar sin
// pasar por un sync: al activar su compañía (`liberar-retenidos.ts`, HU #13946) o al vincularle la empresa
// (`crearEmpresaDesdeTramite`, Bug #14414). Las condiciones viven aquí para que los dos flujos no se desalineen.
//
//   · Estado FLIT «Asignado», organismo emparejado, vehículo con VIN, no `retenido`, compañía no inactiva
//     (`companiaRetiene`, RN-RET-3).
//   · FLIT 2 exige además compradores no enmascarados (RN-19) y comprador principal guardado (RN-17).
//   · Autogestión y bloqueos por VIN/vehículo los resuelve `arrancarSoatEImpuesto`.
//
// La migración 0291 replicó estas condiciones en SQL para reparar lo que dejó el Bug #14414 (corre una sola vez).
import { and, eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { flitoCompradores, flitoTramites, vehicles } from '../../db/schema.js';
import type { CompaniaRow } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { arrancarSoatEImpuesto, companiaRetiene, esAsignado, type ContadoresArranque } from './flito-sync.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Columnas del trámite que necesita el arranque; sirven igual para un `select` o un `returning`. */
export const COLUMNAS_TRAMITE_GUARDADO = {
  id: flitoTramites.id, idFlit: flitoTramites.idFlit, flitEstado: flitoTramites.flitEstado,
  organismoCodigo: flitoTramites.organismoCodigo, vehiculoId: flitoTramites.vehiculoId, soatId: flitoTramites.soatId,
  valorImpuestoLiquidado: flitoTramites.valorImpuestoLiquidado, fuente: flitoTramites.fuente,
  flit2PiiEnmascarada: flitoTramites.flit2PiiEnmascarada, retenido: flitoTramites.retenido,
};

export interface TramiteGuardado {
  id: string; idFlit: string; flitEstado: string | null; organismoCodigo: string | null; vehiculoId: number | null;
  soatId: string | null; valorImpuestoLiquidado: string | null; fuente: string;
  flit2PiiEnmascarada: boolean; retenido: boolean;
}

/** Arranca el trámite si cumple las condiciones; si no, no hace nada. Un fallo se propaga: revierte la tx de quien llama. */
export async function arrancarTramiteGuardado(
  tx: Tx, t: TramiteGuardado, compania: CompaniaRow, r: ContadoresArranque,
): Promise<void> {
  if (t.retenido || companiaRetiene(compania)) return;
  if (!esAsignado(t.flitEstado ?? '') || !t.organismoCodigo || t.vehiculoId === null) return;
  if (t.fuente === 'flit2') {
    if (t.flit2PiiEnmascarada) return; // RN-19: espera la relectura
    const [principal] = await tx.select({ id: flitoCompradores.id }).from(flitoCompradores)
      .where(and(eq(flitoCompradores.tramiteId, t.id), eq(flitoCompradores.orden, 0))).limit(1);
    if (!principal) return; // RN-17: sin comprador principal, espera
  }
  const [vehiculo] = await tx.select({ vin: vehicles.vin }).from(vehicles).where(eq(vehicles.id, t.vehiculoId)).limit(1);
  if (!vehiculo?.vin) return;
  await arrancarSoatEImpuesto(
    tx,
    { vin: vehiculo.vin, idFlit: t.idFlit, valorImpuestoLiquidado: t.valorImpuestoLiquidado === null ? null : Number(t.valorImpuestoLiquidado) },
    { tramiteId: t.id, soatId: t.soatId, vehiculoId: t.vehiculoId, compania, organismoCodigo: t.organismoCodigo },
    r,
  );
}
