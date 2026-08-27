// FLITO — adaptador HTTP de FLIT (real). Consume el reporte público de trámites y el file-manager de
// facturas. Solo lectura. Ver docs/integracion/integracionFlit.md.

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
  /**
   * Código DIVIPOLA de la secretaría, que el reporte SÍ trae desde 2026-07. Es la vía autoritativa
   * para emparejar el organismo: hasta ahora había que deducirlo del nombre o la ciudad, que llegan
   * como texto libre ("STRIA TTOyTTE MCPAL FUNZA") y fallan ante cualquier variación de escritura.
   */
  codigoSecretaria?: string;
  /** Fecha de creación del trámite en FLIT. Campo reciente del reporte: puede no venir. */
  fechaCreacion?: string | null;
  /** También nuevos en el reporte; aún sin uso en FLITO, viajan en `raw`. */
  modelo?: string; tipo?: string;
  /**
   * Datos técnicos del vehículo (HU #11906). Medido contra el reporte real el 2026-08-27 (2733
   * items): las tres claves vienen SIEMPRE y siempre como cadena. Se tipan opcionales igual que el
   * resto de este `interface` porque describe JSON de un tercero, no una promesa nuestra: el que
   * afirma que el valor puede faltar y aun así el mapeo no rompe es `TramiteFlit`, con su `null`.
   */
  cilindraje?: string; carroceria?: string; tipoServicio?: string;
}
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Ancho de las columnas de `vehicles` donde aterrizan los tres datos técnicos (migración 0166).
 *
 * Se exporta para que el test de paridad los contraste con `getTableConfig(vehicles)` en vez de
 * dejarlos como números sueltos: un guardián que se separa de su columna no protege de nada.
 */
export const MAX_DATOS_VEHICULO = { cilindraje: 10, carroceria: 60, tipoServicio: 30 } as const;

/**
 * `s()` + tope de longitud. Lo que no cabe en la columna se DESCARTA a `null` con un warn; no se
 * trunca.
 *
 * Los dos motivos, en orden de importancia:
 *   1. Truncar cambia el dato. Un cilindraje recortado es OTRO cilindraje, y saldría en la cola con
 *      el mismo aspecto de dato bueno que los demás. Es el argumento ya escrito para
 *      `owner_document` en `titularDe()` (flito-sync.service.ts).
 *   2. Dejarlo pasar entero sería un `22001 value too long` DENTRO de la transacción de ese trámite
 *      —el sync envuelve uno por transacción con try/catch—, así que ese trámite se caería del sync
 *      en esa corrida y en todas las siguientes, con el único rastro en un `log.error`.
 *
 * El `log.warn` lleva el id del trámite, el campo y la longitud; NO el valor, para que un campo mal
 * alineado por el proveedor (una dirección donde debía ir la carrocería) no acabe en el log.
 */
function acotado(v: unknown, campo: keyof typeof MAX_DATOS_VEHICULO, idFlit: string): string | null {
  const valor = s(v);
  if (valor === null) return null;
  const max = MAX_DATOS_VEHICULO[campo];
  if (valor.length > max) {
    log.warn({ idFlit, campo, longitud: valor.length, max }, 'valor de FLIT más largo que su columna: se descarta');
    return null;
  }
  return valor;
}

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
    // El reporte ya trae el código DIVIPOLA. El sync lo usa primero y solo cae a ciudad/nombre si
    // ese código no corresponde a un organismo configurado en FLITO.
    organismoCodigo: s(it.codigoSecretaria),
    fechaAprobacion: s(it.fecha_aprobacion ?? null),
    fechaCreacionFlit: s(it.fechaCreacion ?? null),
    // HU #11906. Vacío o ausente → null, que es lo que la cola pinta como «—» (AC2): sin error y sin
    // inventar un valor. `tipo` y `modelo` siguen SIN mapear: esta HU no los pide.
    cilindraje: acotado(it.cilindraje, 'cilindraje', it.Id),
    carroceria: acotado(it.carroceria, 'carroceria', it.Id),
    tipoServicio: acotado(it.tipoServicio, 'tipoServicio', it.Id),
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
