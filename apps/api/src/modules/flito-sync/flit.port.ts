// FLITO — puerto de integración con FLIT. Portado de packages/server/src/puertos.
//
// FLIT es de SOLO LECTURA para FLITO: el reporte trae TODOS los trámites en cualquier estado y esa
// es la fuente de verdad. El adaptador `http` consume el endpoint real (público); el `mock` lee de
// flito_mock_tramite para demo/tests. La sincronización solo pide "dame el reporte de este rango";
// cómo lo consigue el adaptador no es asunto suyo. Ver docs/integracion/integracionFlit.md.

export interface CompradorFlit {
  nombreCompleto: string;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  porcentajeParticipacion?: number | null;
}

/**
 * Un trámite tal como lo entrega FLIT. Superset: los campos del reporte real conviven con los que
 * solo produce el mock (marca/línea/processStatus…), marcados opcionales.
 */
export interface TramiteFlit {
  idFlit: string;
  /** Estado CRUDO de FLIT (Borrador, Asignado, Aprobado, …). Fuente de verdad; gating por 'Asignado'. */
  estadoFlit: string;
  vin: string;
  placa: string | null;
  ciudad: string | null;
  tipoTramite: string | null;
  /** Id S3 de la factura de venta en FLIT (campo `factura`). Vacío → null (aún sin factura). */
  facturaVentaFlitId: string | null;
  /** NIT de la compañía gestora (CompaniaGestora). Puede no existir aún en FLITO. */
  companiaNit: string | null;
  /** Nombre de la secretaría en FLIT (real). El match a código DIVIPOLA lo hace el sync por nombre. */
  transitoNombre: string | null;
  /** Código DIVIPOLA si el adaptador ya lo conoce (mock). El http lo deja null y se resuelve por nombre. */
  organismoCodigo: string | null;
  fechaAprobacion: string | null;
  tipoPropiedad: string;
  compradores: CompradorFlit[];
  valorImpuestoLiquidado: number | null;
  /** Payload crudo completo, para trazabilidad (flit_raw). */
  raw: unknown;
  // Solo mock (el reporte real no los trae):
  marca?: string | null;
  linea?: string | null;
  processStatus?: number;
}

export interface RangoSync {
  /** yyyymmdd. Fecha desde la que se piden registros (la elige el usuario). */
  initialDate: string;
  /** yyyymmdd. Siempre hoy. */
  finalDate: string;
}

export interface FlitPort {
  /** Reporte de FLIT en el rango dado: TODOS los trámites, en cualquier estado. */
  obtenerTramites(rango: RangoSync): Promise<TramiteFlit[]>;
  /** URL prefirmada para ver/descargar la factura de venta (S3), o null si el id no es válido. */
  obtenerUrlFactura(facturaId: string): Promise<string | null>;
  /**
   * Paso a Entregado. Integración de SOLO LECTURA: no hay endpoint de escritura en FLIT, así que
   * es un no-op (la entrega se registra localmente). Se conserva por la compuerta.
   */
  marcarEntregado(idFlit: string): Promise<void>;
}

/** Resultado de una corrida de sincronización (para la respuesta del trigger manual y logs). */
export interface ResultadoSync {
  tramitesLeidos: number;
  tramitesNuevos: number;
  tramitesActualizados: number;
  /** Ya existían y llegaron IGUAL (sin diferencias): no dejan rastro de auditoría. */
  tramitesSinCambios: number;
  soatCreados: number;
  soatBloqueadosPorVin: number;
  impuestosCreados: number;
  impuestosRetenidos: number;
  impuestosNoAplica: number;
  companiasFaltantes: number;
  organismosSinEmparejar: number;
  ejecutadoEn: string;
}
