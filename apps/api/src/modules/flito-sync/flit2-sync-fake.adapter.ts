// FLITO sync — adaptador FAKE del feed de FLIT 2 (HU #13091). Páginas en memoria con datos
// FICTICIOS y deterministas (VIN `9FKTEST…`, placas `ZZZ…`, NIT de ejemplo): sirve para dev y demo
// sin salir a la red. `FLIT2_SYNC_ADAPTER=fake` está prohibido en producción (`config/env.ts`).
//
// `crearFlit2SyncFake(paginas)` acepta páginas a medida (los tests). Cada página se sirve cuando la
// posición pedida es su `desde` (`null` = la primera, pedida con `since`). Registra las llamadas.

import { aItemFlit2 } from './flit2-sync-http.adapter.js';
import type { Flit2SyncPort, ItemFlit2, PaginaFlit2, PosicionLectura } from './flit2-sync.port.js';

export interface PaginaFake {
  /** Cursor con el que se pide esta página; `null` = primera página (con `since`). */
  desde: string | null;
  items: unknown[];
  nextCursor: string;
  hasMore: boolean;
}

const uuidFicticio = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function itemFicticio(n: number, estado: string, familia: string): Record<string, unknown> {
  const sufijo = String(n).padStart(2, '0');
  return {
    id: uuidFicticio(n), radicado: `FT9-00000${sufijo}`, consecutivo: n, syncVersion: 1000 + n,
    fechaUltimoCambio: '2026-09-29T10:00:00-05:00', eliminado: false, estado,
    tramite: { codigo: 'EJEMPLO', nombre: 'Trámite de ejemplo', familia },
    fechaCreacion: '2026-09-01T08:00:00-05:00', fechaRadicacion: '2026-09-01T09:00:00-05:00', fechaAprobacion: null,
    vehiculo: {
      vin: `9FKTEST0000000${sufijo}`.slice(0, 17), placa: `ZZZ0${sufijo}`, clase: 'AUTOMOVIL', marca: 'MARCA EJEMPLO',
      linea: 'LINEA EJEMPLO', modeloAno: 2026, carroceria: 'SEDAN', cilindraje: 1600, cilindrajeTexto: null, capacidad: 5,
      numeroMotor: `MTR${sufijo}`, numeroSerie: `SER${sufijo}`, tipoServicio: { codigo: 'PARTICULAR', nombre: 'Particular' },
    },
    organismo: { codigoTransito: '11001000', nombre: 'SECRETARIA DE EJEMPLO', codigoSecretaria: '11001', ciudad: 'BOGOTA', departamento: 'BOGOTA' },
    compradores: [],
    factura: null,
    companiaGestora: { tenantId: uuidFicticio(900), nit: '900000000', nombre: 'TRAMITADORA EJEMPLO SAS' },
  };
}

/** Dos páginas por defecto: un caso por desenlace (nuevo, tombstone, sin vehículo, revocado, familias). */
function paginasPorDefecto(): PaginaFake[] {
  const sinVehiculo = { ...itemFicticio(3, 'preasignacion', 'MATRICULAS'), vehiculo: null };
  return [
    {
      desde: null, nextCursor: 'fake-c1', hasMore: true,
      items: [itemFicticio(1, 'asignado', 'MATRICULAS'), itemFicticio(2, 'entregado', 'TRASPASO'), sinVehiculo],
    },
    {
      desde: 'fake-c1', nextCursor: 'fake-c2', hasMore: false,
      items: [
        itemFicticio(4, 'revocado', 'OTROS'),
        { id: uuidFicticio(5), radicado: 'FT9-0000005', syncVersion: 1005, eliminado: true, estado: 'anulado', vehiculo: null, organismo: null, factura: null, compradores: [] },
      ],
    },
  ];
}

export interface Flit2SyncFake extends Flit2SyncPort {
  llamadas: { cursor?: string; since?: string; pageSize: number }[];
}

export function crearFlit2SyncFake(paginas: PaginaFake[] = paginasPorDefecto()): Flit2SyncFake {
  const llamadas: Flit2SyncFake['llamadas'] = [];
  return {
    llamadas,
    async verificarAcceso() { /* sin red */ },
    async leerPagina(pos: PosicionLectura, pageSize: number): Promise<PaginaFlit2> {
      const desde = 'cursor' in pos ? pos.cursor : null;
      llamadas.push('cursor' in pos ? { cursor: pos.cursor, pageSize } : { since: pos.since.toISOString(), pageSize });
      const pagina = paginas.find((p) => p.desde === desde);
      // Cursor que el fake no conoce: el feed está al día (contrato §3: página vacía, mismo cursor).
      if (!pagina) return { items: [], invalidos: 0, nextCursor: desde ?? 'fake-c0', hasMore: false };
      const items: ItemFlit2[] = [];
      let invalidos = 0;
      for (const crudo of pagina.items) {
        const item = aItemFlit2(crudo);
        if (item) items.push(item);
        else invalidos += 1;
      }
      return { items, invalidos, nextCursor: pagina.nextCursor, hasMore: pagina.hasMore };
    },
  };
}
