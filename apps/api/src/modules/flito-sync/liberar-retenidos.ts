// HU #13946 (Feature #13939) — Liberar los trámites retenidos de una compañía al activarla.
//
//   · RN-RET-4 — Corre DENTRO de la transacción de la activación (`cambiarEstadoCliente`, módulo `clients`): los
//     trámites `retenido = true` de la compañía pasan a `false` y se les arranca SOAT/impuesto con las MISMAS reglas
//     que a un trámite recién llegado de FLIT 1 (`arrancarSoatEImpuesto`, estado FLIT «Asignado» y organismo
//     emparejado). Un fallo se propaga: la activación entera se revierte (el cliente sigue inactivo y los trámites
//     siguen retenidos).
//   · Dirección de imports: `clients` importa de `flito-sync`, nunca al revés.
//   · FLIT 1 y FLIT 2 retienen (predicado `companiaRetiene`). A un trámite de FLIT 2 se le exigen además sus dos
//     condiciones propias: comprador principal guardado (RN-17) y compradores no enmascarados (RN-19).
import { and, eq } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { clients, flitoCompradores, flitoTramites, vehicles } from '../../db/schema.js';
import { arrancarSoatEImpuesto, esAsignado, type ContadoresArranque } from './flito-sync.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ResultadoLiberacion extends ContadoresArranque {
  /** Trámites que dejaron de estar retenidos. */
  liberados: number;
}

export async function liberarTramitesRetenidos(tx: Tx, companiaId: number): Promise<ResultadoLiberacion> {
  const r: ResultadoLiberacion = {
    liberados: 0, soatCreados: 0, soatBloqueadosPorVin: 0, impuestosCreados: 0, impuestosBloqueadosPorVehiculo: 0,
  };
  const [compania] = await tx.select().from(clients).where(eq(clients.id, companiaId)).limit(1);
  if (!compania) return r;

  const liberados = await tx.update(flitoTramites).set({ retenido: false, updatedAt: new Date() })
    .where(and(eq(flitoTramites.companiaId, companiaId), eq(flitoTramites.retenido, true)))
    .returning({
      id: flitoTramites.id, idFlit: flitoTramites.idFlit, flitEstado: flitoTramites.flitEstado,
      organismoCodigo: flitoTramites.organismoCodigo, vehiculoId: flitoTramites.vehiculoId, soatId: flitoTramites.soatId,
      valorImpuestoLiquidado: flitoTramites.valorImpuestoLiquidado, fuente: flitoTramites.fuente,
      flit2PiiEnmascarada: flitoTramites.flit2PiiEnmascarada,
    });
  r.liberados = liberados.length;

  for (const t of liberados) {
    if (!esAsignado(t.flitEstado ?? '') || !t.organismoCodigo || t.vehiculoId === null) continue;
    if (t.fuente === 'flit2') {
      if (t.flit2PiiEnmascarada) continue; // RN-19: espera la relectura
      const [principal] = await tx.select({ id: flitoCompradores.id }).from(flitoCompradores)
        .where(and(eq(flitoCompradores.tramiteId, t.id), eq(flitoCompradores.orden, 0))).limit(1);
      if (!principal) continue; // RN-17: sin comprador principal, espera
    }
    const [vehiculo] = await tx.select({ vin: vehicles.vin }).from(vehicles).where(eq(vehicles.id, t.vehiculoId)).limit(1);
    if (!vehiculo?.vin) continue;
    await arrancarSoatEImpuesto(
      tx,
      { vin: vehiculo.vin, idFlit: t.idFlit, valorImpuestoLiquidado: t.valorImpuestoLiquidado === null ? null : Number(t.valorImpuestoLiquidado) },
      { tramiteId: t.id, soatId: t.soatId, vehiculoId: t.vehiculoId, compania, organismoCodigo: t.organismoCodigo },
      r,
    );
  }
  return r;
}
