// FLITO — puerto de integración con FLIT 1.0. Portado de packages/server/src/puertos.
//
// Hoy lo implementa un mock con trámites en base de datos (flito_mock_tramite). Cuando
// exista el endpoint real se agrega un adaptador HTTP contra OperationApi/api/OperationLookUp
// y se cambia FLIT_ADAPTER=http. La sincronización solo pide "dame los trámites en este
// estado"; cómo los consigue el adaptador no es asunto suyo.

export interface CompradorFlit {
  nombreCompleto: string;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  porcentajeParticipacion?: number | null;
}

export interface TramiteFlit {
  idFlit: string;
  processStatus: number;
  plateComplete: string | null;
  vin: string;
  placa: string;
  marca: string;
  linea: string;
  cilindraje: number;
  capacidad: number;
  tipoVehiculo: string;
  /** Llaves externas: FLIT no conoce los ids internos de FLITO. */
  companiaNit: string;
  organismoCodigo: string;
  tipoPropiedad: string;
  compradores: CompradorFlit[];
  /** Valor del impuesto ya liquidado por el organismo. FLITO no lo calcula; puede venir nulo. */
  valorImpuestoLiquidado: number | null;
}

export interface FlitPort {
  /** Trámites en estado Asignado: processStatus === 5 y plateComplete con valor. */
  obtenerTramitesAsignados(): Promise<TramiteFlit[]>;
  /** Un trámite puntual, para re-consultar sin traer toda la cola. */
  obtenerTramite(idFlit: string): Promise<TramiteFlit | null>;
  /** Escribe hacia FLIT el paso a Entregado. La compuerta habilita, no ejecuta. */
  marcarEntregado(idFlit: string): Promise<void>;
}

/** Resultado de una corrida de sincronización (para la respuesta del trigger manual y logs). */
export interface ResultadoSync {
  tramitesLeidos: number;
  tramitesNuevos: number;
  tramitesActualizados: number;
  soatCreados: number;
  soatBloqueadosPorVin: number;
  impuestosCreados: number;
  impuestosRetenidos: number;
  impuestosNoAplica: number;
  tramitesReconciliados: number;
  ejecutadoEn: string;
}
