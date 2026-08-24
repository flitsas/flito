// FLITO Bolsas — dominio del saldo prepago del cliente (HU #11121, Feature #11120).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web. La bolsa es UNA por cliente y su
// consumo se reparte entre organismos por movimiento, no abriendo una bolsa por OT.

/** Dirección del movimiento. El valor siempre se guarda positivo; el signo lo da esto. */
export const TipoMovimientoBolsa = {
  ENTRADA: 'entrada',
  SALIDA: 'salida',
} as const;

export type TipoMovimientoBolsa = (typeof TipoMovimientoBolsa)[keyof typeof TipoMovimientoBolsa];

/**
 * Quién produjo el movimiento.
 *
 *   recarga      — dinero que precarga FLIT en la bolsa del cliente (HU #11121)
 *   automatico   — salida generada al sellar la liquidación del trámite (HU #11122)
 *   manual       — contingencia registrada por Financiera con motivo y evidencia (HU #11123)
 *   conciliacion — descuento asentado al conciliar una boleta de pago externo (Feature #11623).
 *                  **NO reversible por el ciclo de la liquidación**: el barrido de
 *                  `reversarSalidasLiquidacion` filtra por `origen = 'automatico'`, así que un
 *                  movimiento de conciliación queda fuera y su dinero NO vuelve cuando el trámite
 *                  retrocede (CF-07). Es el único origen que significa «esto ya se pagó de verdad
 *                  en un portal externo, y el ciclo del trámite no lo deshace».
 *
 * Añadir un valor aquí NO basta: `flito_bolsa_movimientos.origen` lleva un CHECK en la base
 * (`flito_bolsa_mov_origen_valido`) que `schema.ts` no declara, y sin ensancharlo el INSERT muere
 * con 23514. Lo ensancha la migración 0157.
 */
export const OrigenMovimientoBolsa = {
  RECARGA: 'recarga',
  AUTOMATICO: 'automatico',
  MANUAL: 'manual',
  CONCILIACION: 'conciliacion',
} as const;

export type OrigenMovimientoBolsa = (typeof OrigenMovimientoBolsa)[keyof typeof OrigenMovimientoBolsa];

/**
 * Conceptos que consumen bolsa. Los cinco primeros coinciden con los que sella la liquidación
 * (`flito_liquidaciones`), que es la fuente del valor de cada salida.
 *
 * `gmf` es el sexto y no es un concepto del tarifario: es el gravamen del 4x1000 que la liquidación
 * calcula sobre la suma de los otros cinco. Consume bolsa igual que ellos porque al cliente se le
 * factura el total CON gravamen (HU #11160); si no se descontara, el saldo mostraría un 0,4 % de
 * más en cada trámite. No lleva organismo: es un gravamen, no un desembolso a una secretaría.
 */
export const ConceptoBolsa = {
  DERECHO: 'derecho',
  SOAT: 'soat',
  IMPUESTO: 'impuesto',
  TRAMITE_DIGITAL: 'tramite_digital',
  LOGISTICA: 'logistica',
  GMF: 'gmf',
} as const;

export type ConceptoBolsa = (typeof ConceptoBolsa)[keyof typeof ConceptoBolsa];

export const CONCEPTO_BOLSA_LABEL: Record<ConceptoBolsa, string> = {
  derecho: 'Derecho de tránsito',
  soat: 'SOAT',
  impuesto: 'Impuesto',
  tramite_digital: 'Trámite digital',
  logistica: 'Logística',
  gmf: 'GMF (4x1000)',
};

/** Bolsa de un cliente con su saldo vigente. */
export interface BolsaDto {
  id: string;
  companiaId: number;
  companiaNombre: string;
  /** Puede ser negativo: el descuento se aplica aunque no alcance (decisión de negocio). */
  saldo: number;
  /** Base del nivel de riesgo. `null` mientras el cliente no haya recargado nunca. */
  ultimaRecargaValor: number | null;
  ultimaRecargaEn: string | null;
}

/** Una línea del libro de la bolsa. */
export interface MovimientoBolsaDto {
  id: string;
  companiaId: number;
  tipo: TipoMovimientoBolsa;
  origen: OrigenMovimientoBolsa;
  /** `null` en las recargas: el dinero entra sin pasar por un concepto. */
  concepto: ConceptoBolsa | null;
  organismoCodigo: string | null;
  tramiteId: string | null;
  /**
   * Identificador del trámite en FLIT, que es como lo nombra Operaciones. El UUID no le dice nada a
   * nadie en pantalla; sin esto la tabla tendría que enseñar un identificador truncado.
   */
  idFlit: string | null;
  valor: number;
  /** Saldo de la bolsa después de aplicar este movimiento (permite auditar sin recalcular). */
  saldoResultante: number;
  /** Periodo contable 'YYYY-MM' al que se imputa. */
  periodo: string;
  fecha: string;
  observacion: string | null;
  soporteId: string | null;
  registradoPorNombre: string;
  createdAt: string;
}

/**
 * Clave con la que se agrupa lo que no tiene organismo ni concepto.
 *
 * Las recargas no pasan por un concepto, y el trámite digital y la logística no tienen organismo
 * por ser honorarios de FLIT: son agrupaciones legítimas, no filas rotas. La constante vive aquí
 * porque la API la produce y la web la rotula, y con el literal repetido a los dos lados bastaría
 * con que uno cambiara para que el desglose enseñara «sin_asignar» crudo.
 */
export const CLAVE_AGRUPACION_SIN_ASIGNAR = 'sin_asignar';

/** Periodo contable ('YYYY-MM') de una fecha. */
export function periodoDe(fecha: Date): string {
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  return `${fecha.getUTCFullYear()}-${mes}`;
}

/**
 * Nivel de riesgo del saldo (HU #11125).
 *
 * `sin_recargas` no es un nivel peor ni mejor: es la ausencia de base para calcularlo. Distinguirlo
 * de `agotada` importa — un cliente que nunca ha recargado no es lo mismo que uno que se quedó sin
 * saldo, y confundirlos llenaría el panel de alertas de clientes que no han empezado a operar.
 */
export const NivelRiesgoBolsa = {
  NORMAL: 'normal',
  BAJO: 'bajo',
  CRITICO: 'critico',
  AGOTADA: 'agotada',
  SIN_RECARGAS: 'sin_recargas',
} as const;

export type NivelRiesgoBolsa = (typeof NivelRiesgoBolsa)[keyof typeof NivelRiesgoBolsa];

export const NIVEL_RIESGO_BOLSA_LABEL: Record<NivelRiesgoBolsa, string> = {
  normal: 'Normal',
  bajo: 'Saldo bajo',
  critico: 'Saldo crítico',
  agotada: 'Bolsa agotada',
  sin_recargas: 'Sin recargas',
};

/** Umbrales, en porcentaje de la última recarga. Decisión de negocio del refinamiento del Feature. */
export const UMBRAL_RIESGO_BAJO = 30;
export const UMBRAL_RIESGO_CRITICO = 10;

/**
 * Clasifica el saldo contra el monto de la última recarga.
 *
 * Vive en shared-types y no en el backend porque el tablero (HU #11127) tiene que pintar el mismo
 * nivel que calcula la API; duplicar los umbrales en la web sería garantizar que un día divergen.
 */
export function nivelRiesgoDe(saldo: number, ultimaRecargaValor: number | null): NivelRiesgoBolsa {
  // Sin recarga previa no hay porcentaje que calcular. Devolverlo explícito evita además la división
  // por cero que produciría un `ultimaRecargaValor` en 0.
  if (ultimaRecargaValor === null || ultimaRecargaValor <= 0) return NivelRiesgoBolsa.SIN_RECARGAS;
  if (saldo <= 0) return NivelRiesgoBolsa.AGOTADA;

  const porcentaje = (saldo / ultimaRecargaValor) * 100;
  if (porcentaje <= UMBRAL_RIESGO_CRITICO) return NivelRiesgoBolsa.CRITICO;
  if (porcentaje <= UMBRAL_RIESGO_BAJO) return NivelRiesgoBolsa.BAJO;
  return NivelRiesgoBolsa.NORMAL;
}

/** Porcentaje del saldo sobre la última recarga, o `null` si no hay base. */
export function porcentajeSaldo(saldo: number, ultimaRecargaValor: number | null): number | null {
  if (ultimaRecargaValor === null || ultimaRecargaValor <= 0) return null;
  return Math.round((saldo / ultimaRecargaValor) * 1000) / 10;
}

// ─────────────────────────── Lo que devuelve la API ──────────────────────────
//
// Estas formas nacieron dentro de `flito-bolsas.service.ts`, que es donde se construyen. Se suben
// aquí porque el tablero, el extracto y el estado de cuenta (HU #11127–#11130) las pintan tal cual:
// tenerlas redeclaradas en la web significaría que un campo nuevo en la API no rompe la compilación
// del front, solo deja de verse — que es la peor forma de enterarse. El servicio las importa de
// vuelta y las re-exporta, así que sigue habiendo un único sitio donde cambiarlas.

/** Bolsa del cliente con su nivel de riesgo ya clasificado por el servidor. */
export interface BolsaConRiesgo extends BolsaDto {
  nivel: NivelRiesgoBolsa;
  /** Saldo como porcentaje de la última recarga; `null` si el cliente nunca ha recargado. */
  porcentaje: number | null;
  /**
   * Totales del periodo consultado. `null` cuando no se pidió periodo — distinto de cero, que sí
   * significa «ese mes no hubo movimientos».
   */
  entradasPeriodo: number | null;
  salidasPeriodo: number | null;
}

/** Saldo prepago agregado de todos los clientes. */
export interface SaldoConsolidado {
  clientes: number;
  saldoTotal: number;
}

/** Una bolsa que dejó de estar en nivel normal. */
export interface AlertaBolsa {
  tipo: 'saldo';
  nivel: NivelRiesgoBolsa;
  companiaId: number;
  companiaNombre: string;
  saldo: number;
  porcentaje: number | null;
  mensaje: string;
}

export interface AlertasConciliacion {
  /** Soportes cargados que no cruzaron con ningún trámite. */
  soportesSinTramite: number;
  /** Movimientos automáticos asentados sin soporte del organismo detrás. */
  movimientosSinSoporte: number;
  /**
   * Boletas ya conciliadas a las que todavía les falta el comprobante del pago PSE (HU #11678, AC6).
   *
   * Va como contador PROPIO y no sumado a `movimientosSinSoporte` por lo mismo que explica la
   * cabecera de `alertasDeConciliacion`: el comprobante cuelga de la BOLETA y no de cada uno de los
   * N movimientos que asentó, así que contarlo movimiento a movimiento daría N alertas para un solo
   * archivo que falta — y ninguna de ellas se cerraría al subirlo. Una boleta, una alerta, y se
   * apaga en cuanto el comprobante existe.
   */
  boletasSinComprobante: number;
}

/** Respuesta de `GET /flito/bolsas/alertas`. */
export interface AlertasBolsas {
  saldo: AlertaBolsa[];
  conciliacion: AlertasConciliacion;
}

/** Una fila del desglose del extracto. `clave` es un organismo, un concepto o `sin_asignar`. */
export interface LineaAgrupada {
  clave: string;
  entradas: number;
  salidas: number;
  movimientos: number;
}

/** Extracto del cliente: el saldo con su consumo repartido por dos dimensiones. */
export interface ExtractoCliente {
  companiaId: number;
  saldoActual: number;
  totalEntradas: number;
  totalSalidas: number;
  porOrganismo: LineaAgrupada[];
  porConcepto: LineaAgrupada[];
}

/** Respuesta de los endpoints que resuelven un soporte a una URL firmada y caducable. */
export interface SoporteFirmado {
  url: string;
  nombreArchivo: string;
  contentType: string;
}

/** Reporte sellado de un periodo cerrado. El cierre es irreversible: no hay forma de reabrirlo. */
export interface CierreDto {
  id: string;
  companiaId: number;
  periodo: string;
  saldoInicial: number;
  totalEntradas: number;
  totalSalidas: number;
  saldoFinal: number;
  movimientos: number;
  observaciones: string | null;
  cerradoPorNombre: string;
  cerradoEn: string;
}

/**
 * Respuesta del POST de recargas.
 *
 * `duplicado` es el contrato de idempotencia: `false` con 201 es una recarga nueva, `true` con 200
 * es el reenvío de una `Idempotency-Key` ya vista y trae el movimiento ORIGINAL. La pantalla que
 * reciba `true` no puede anunciar un registro nuevo ni volver a sumar nada al saldo.
 */
export interface RespuestaRecarga {
  movimiento: MovimientoBolsaDto;
  saldo: number;
  duplicado: boolean;
}

/** Respuesta del POST de movimientos manuales y de correcciones. */
export interface RespuestaMovimiento {
  movimiento: MovimientoBolsaDto;
  saldo: number;
}
