// FLITO — adaptador simulado de FLIT 1.0. Lee de flito_mock_tramite, que representa el
// sistema externo. Cuando exista el endpoint real se agrega un adaptador HTTP con esta
// misma interfaz y se cambia FLIT_ADAPTER=http; ni la sincronización ni los módulos se enteran.

import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoMockTramite } from '../../db/schema.js';
import { EstadoTramiteFlito, PROCESS_STATUS_ASIGNADO } from '@operaciones/shared-types';
import type { CompradorFlit, FlitPort, RangoSync, TramiteFlit } from './flit.port.js';

// Etiqueta al estilo de FLIT real (texto capitalizado) para poblar estadoFlit desde el mock.
const ESTADO_FLIT_LABEL: Record<EstadoTramiteFlito, string> = {
  [EstadoTramiteFlito.ASIGNADO]: 'Asignado',
  [EstadoTramiteFlito.ENTREGADO]: 'Entregado',
  [EstadoTramiteFlito.APROBADO]: 'Aprobado',
  [EstadoTramiteFlito.RECHAZADO]: 'Rechazado',
  [EstadoTramiteFlito.ANULADO]: 'Anulado',
};

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
  const estado = estadoDesdeProcessStatus(fila.processStatus);
  return {
    idFlit: fila.idFlit,
    estadoFlit: ESTADO_FLIT_LABEL[estado],
    vin: fila.vin,
    placa: fila.placa,
    ciudad: null,
    tipoTramite: null,
    facturaVentaFlitId: null, // el mock no tiene factura de venta en S3.
    companiaNit: fila.companiaNit,
    transitoNombre: null,     // el mock ya trae el código DIVIPOLA.
    organismoCodigo: fila.organismoCodigo,
    fechaAprobacion: null,
    tipoPropiedad: fila.tipoPropiedad,
    compradores: (fila.compradores as CompradorFlit[]) ?? [],
    valorImpuestoLiquidado: fila.valorImpuestoLiquidado === null ? null : Number(fila.valorImpuestoLiquidado),
    raw: fila,
    marca: fila.marca,
    linea: fila.linea,
    processStatus: fila.processStatus,
  };
}

export function createFlitMockAdapter(): FlitPort {
  return {
    // El mock devuelve TODOS los trámites simulados (cualquier estado), como el reporte real.
    async obtenerTramites(_rango: RangoSync): Promise<TramiteFlit[]> {
      const filas = await db.select().from(flitoMockTramite).orderBy(asc(flitoMockTramite.createdAt));
      return filas.map(aDto);
    },

    async obtenerUrlFactura(_facturaId: string): Promise<string | null> {
      return null; // el mock no aloja facturas en S3.
    },

    async marcarEntregado(idFlit: string): Promise<void> {
      // Solo lectura hacia FLIT; en el mock local reflejamos el paso para depurar la demo.
      await db.update(flitoMockTramite)
        .set({ processStatus: PROCESS_STATUS.ENTREGADO, updatedAt: new Date() })
        .where(eq(flitoMockTramite.idFlit, idFlit));
    },
  };
}
