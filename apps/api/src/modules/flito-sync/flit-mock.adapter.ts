// FLITO — adaptador simulado de FLIT 1.0. Lee de flito_mock_tramite, que representa el
// sistema externo. Cuando exista el endpoint real se agrega un adaptador HTTP con esta
// misma interfaz y se cambia FLIT_ADAPTER=http; ni la sincronización ni los módulos se enteran.

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoMockTramite } from '../../db/schema.js';
import { EstadoTramiteFlito, PROCESS_STATUS_ASIGNADO } from '@operaciones/shared-types';
import type { CompradorFlit, FlitPort, TramiteFlit } from './flit.port.js';

/**
 * Códigos de processStatus del FLIT simulado. Solo el 5 (Asignado) viene de la
 * documentación real (SOAT_IMPUESTOS_TRAMITES.txt); los demás los inventa este mock para
 * representar el resto del ciclo y hay que reemplazarlos por los reales al conectar FLIT.
 * El mapeo vive aquí, en la frontera, no en el dominio.
 */
export const PROCESS_STATUS = {
  ASIGNADO: PROCESS_STATUS_ASIGNADO,
  ENTREGADO: 6,
  APROBADO: 7,
  RECHAZADO: 8,
  ANULADO: 9,
} as const;

const POR_ESTADO: Record<EstadoTramiteFlito, number> = {
  [EstadoTramiteFlito.ASIGNADO]: PROCESS_STATUS.ASIGNADO,
  [EstadoTramiteFlito.ENTREGADO]: PROCESS_STATUS.ENTREGADO,
  [EstadoTramiteFlito.APROBADO]: PROCESS_STATUS.APROBADO,
  [EstadoTramiteFlito.RECHAZADO]: PROCESS_STATUS.RECHAZADO,
  [EstadoTramiteFlito.ANULADO]: PROCESS_STATUS.ANULADO,
};

export function processStatusDesdeEstado(estado: EstadoTramiteFlito): number {
  return POR_ESTADO[estado];
}

/**
 * Un processStatus desconocido NO se traduce a Asignado. Asumir "asignado" por defecto
 * metería un trámite de estado desconocido en las colas y en la compuerta como si
 * estuviera vivo (el peor error, §6.1 Impuestos). Es preferible fallar y enterarse.
 */
export function estadoDesdeProcessStatus(processStatus: number): EstadoTramiteFlito {
  const estado = (Object.keys(POR_ESTADO) as EstadoTramiteFlito[]).find(
    (candidato) => POR_ESTADO[candidato] === processStatus,
  );
  if (!estado) {
    throw new Error(
      `FLIT devolvió processStatus=${processStatus}, que FLITO no conoce. ` +
        'Agrega el código a PROCESS_STATUS antes de sincronizar estos trámites.',
    );
  }
  return estado;
}

type MockRow = typeof flitoMockTramite.$inferSelect;

function aDto(fila: MockRow): TramiteFlit {
  return {
    idFlit: fila.idFlit,
    processStatus: fila.processStatus,
    plateComplete: fila.plateComplete,
    vin: fila.vin,
    placa: fila.placa,
    marca: fila.marca,
    linea: fila.linea,
    cilindraje: fila.cilindraje,
    capacidad: fila.capacidad,
    tipoVehiculo: fila.tipoVehiculo,
    companiaNit: fila.companiaNit,
    organismoCodigo: fila.organismoCodigo,
    tipoPropiedad: fila.tipoPropiedad,
    compradores: (fila.compradores as CompradorFlit[]) ?? [],
    valorImpuestoLiquidado: fila.valorImpuestoLiquidado === null ? null : Number(fila.valorImpuestoLiquidado),
  };
}

export function createFlitMockAdapter(): FlitPort {
  return {
    // El filtro reproduce la regla literal: estado asignado Y plateComplete con valor. Un
    // trámite asignado sin placa completa no sirve para adquirir SOAT ni liquidar impuestos.
    async obtenerTramitesAsignados(): Promise<TramiteFlit[]> {
      const filas = await db
        .select()
        .from(flitoMockTramite)
        .where(and(eq(flitoMockTramite.processStatus, PROCESS_STATUS.ASIGNADO), isNotNull(flitoMockTramite.plateComplete)))
        .orderBy(asc(flitoMockTramite.createdAt));
      return filas.map(aDto);
    },

    async obtenerTramite(idFlit: string): Promise<TramiteFlit | null> {
      const [fila] = await db.select().from(flitoMockTramite).where(eq(flitoMockTramite.idFlit, idFlit)).limit(1);
      return fila ? aDto(fila) : null;
    },

    async marcarEntregado(idFlit: string): Promise<void> {
      const [updated] = await db
        .update(flitoMockTramite)
        .set({ processStatus: PROCESS_STATUS.ENTREGADO, updatedAt: new Date() })
        .where(eq(flitoMockTramite.idFlit, idFlit))
        .returning();
      if (!updated) throw new Error(`El trámite ${idFlit} no existe en FLIT`);
    },
  };
}
