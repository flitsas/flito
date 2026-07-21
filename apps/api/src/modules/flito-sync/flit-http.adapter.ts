// FLITO — adaptador HTTP de FLIT (real). Consume el reporte público de trámites y el file-manager de
// facturas. Solo lectura. Ver docs/integracion/integracionFlit.md. Se activa con FLIT_ADAPTER=http.

import { loggerFor } from '../../shared/logger.js';
import type { FlitPort, RangoSync, TramiteFlit } from './flit.port.js';

const log = loggerFor('flit-http');

// Host del API de FLIT. Configurable por si cambia de ambiente; default = el del doc de integración.
const BASE = (process.env.FLIT_BASE_URL ?? 'https://1qmxln7fa7.execute-api.us-east-1.amazonaws.com/pdn').replace(/\/$/, '');
const REPORT_TYPE_ID = 18; // SIEMPRE 18 (doc §parámetros).

// Item crudo del reporte. Solo tipamos lo que usamos; el resto viaja en `raw`.
export interface ItemFlit {
  Id: string; Vin?: string; Placa?: string; Ciudad?: string; Estado?: string; Tramite?: string;
  factura?: string; nombres?: string; apellidos?: string; cedulanit?: string; direccion?: string;
  celular?: string; correoelectronico?: string; Transito?: string; CompaniaGestora?: string;
  fecha_aprobacion?: string | null;
}
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function aTramite(it: ItemFlit): TramiteFlit {
  const nombre = `${it.nombres ?? ''} ${it.apellidos ?? ''}`.trim();
  return {
    idFlit: it.Id,
    estadoFlit: s(it.Estado) ?? 'Desconocido',
    vin: s(it.Vin) ?? '',
    placa: s(it.Placa),
    ciudad: s(it.Ciudad),
    tipoTramite: s(it.Tramite),
    facturaVentaFlitId: s(it.factura),
    companiaNit: s(it.CompaniaGestora),
    transitoNombre: s(it.Transito),
    organismoCodigo: null, // el reporte da el nombre; el sync resuelve el código por nombre.
    fechaAprobacion: s(it.fecha_aprobacion ?? null),
    tipoPropiedad: 'unico_propietario', // el reporte trae un titular por trámite.
    compradores: [{
      nombreCompleto: nombre || '(sin nombre)',
      numeroDocumento: s(it.cedulanit) ?? '',
      correo: s(it.correoelectronico),
      celular: s(it.celular),
      direccion: s(it.direccion),
    }],
    valorImpuestoLiquidado: null, // el reporte no lo trae.
    raw: it,
  };
}

export function createFlitHttpAdapter(): FlitPort {
  return {
    async obtenerTramites(rango: RangoSync): Promise<TramiteFlit[]> {
      const qs = new URLSearchParams({
        'filter.initialDate': `$gte:${rango.initialDate}`,
        'filter.finalDate': `$lt:${rango.finalDate}`,
        'filter.reportTypeId': `$eq:${REPORT_TYPE_ID}`,
        'filter.trafficSecretary': '$eq:-1',
        'filter.companyRegistered': '$eq:-1',
        'filter.procedure': '$eq:-1',
      });
      const url = `${BASE}/api/v1/report/vehicle-report?${qs.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FLIT report ${res.status}: ${await res.text().catch(() => '')}`);
      const body = await res.json() as { data?: ItemFlit[] };
      const items = Array.isArray(body.data) ? body.data : [];
      log.info({ total: items.length, rango }, 'reporte FLIT recibido');
      return items.filter((it) => it && it.Id).map(aTramite);
    },

    async obtenerUrlFactura(facturaId: string): Promise<string | null> {
      if (!facturaId) return null;
      const url = `${BASE}/api/v1/file-manager/${encodeURIComponent(facturaId)}/presigned-url`;
      const res = await fetch(url);
      if (!res.ok) { log.warn({ facturaId, status: res.status }, 'factura no disponible'); return null; }
      const body = await res.json() as { presignedUrl?: { url?: string } };
      return body.presignedUrl?.url ?? null;
    },

    async marcarEntregado(idFlit: string): Promise<void> {
      // Solo lectura: FLIT no expone escritura. La entrega se registra localmente.
      log.debug({ idFlit }, 'marcarEntregado no-op (integración de solo lectura)');
    },
  };
}
