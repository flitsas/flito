// FLITO Bolsas — dominio del saldo prepago del cliente (HU #11121, Feature #11120).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web. La bolsa es UNA por cliente y su
// consumo se reparte entre organismos por movimiento, no abriendo una bolsa por OT.

import { ConceptoCosto } from './flito-conceptos.js';

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
  /** HU #13902 (ADR-0029 D7): descuento al aplicar un comprobante de pago, y su reversión enlazada. */
  COMPROBANTE: 'comprobante',
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
 *
 * `servicios_adicionales` es el séptimo (HU #12546) y va por la SUMA de los servicios asignados al
 * trámite, no uno por servicio: la bolsa lleva el dinero y el desglose por tipo vive en el detalle
 * sellado de la liquidación. Sin él, los servicios entrarían en la base del GMF y en el total
 * facturado pero no se asentarían en ninguna salida, y la bolsa descontaría `total − Σ servicios`
 * en cada trámite con servicios. Tampoco lleva organismo: es un honorario de FLIT, como el trámite
 * digital y la logística.
 *
 * A diferencia de `origen`, `flito_bolsa_movimientos.concepto` es un `varchar(30)` SIN CHECK en la
 * base, así que un valor nuevo aquí NO necesita migración: el único CHECK que enumera conceptos es
 * el de la bolsa de TRÁNSITO (0124), y este concepto no llega a ella (no lleva organismo).
 */
export const ConceptoBolsa = {
  // Los seis conceptos de costo del trámite (flito-conceptos.ts, Épica #12245) más el GMF, que es un
  // movimiento de la bolsa y no un costo del trámite. Mismos literales: una lista, no dos.
  ...ConceptoCosto,
  GMF: 'gmf',
} as const;

export type ConceptoBolsa = (typeof ConceptoBolsa)[keyof typeof ConceptoBolsa];

export const CONCEPTO_BOLSA_LABEL: Record<ConceptoBolsa, string> = {
  derecho: 'Derecho de tránsito',
  soat: 'SOAT',
  impuesto: 'Impuesto',
  tramite_digital: 'Trámite digital',
  logistica: 'Logística',
  servicios_adicionales: 'Servicios adicionales',
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
  /** HU #13899 (ADR-0029): bolsa del libro único a la que pertenece el movimiento. */
  bolsaId: string;
  /** Compañía de la bolsa. `null` solo en bolsas de alcance tránsito (modelo único, ADR-0029). */
  companiaId: number | null;
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
  /** Comprobante que originó el movimiento (HU-C de #13886); `null` en todo lo demás. */
  comprobanteId: string | null;
  /** Movimiento original que esta entrada revierte (D13); `null` si no es una reversión. */
  revierteMovimientoId: string | null;
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

// ── Modelo único de bolsa (HU #13899, Feature #13886, ADR-0029) ──────────────

export const AlcanceBolsa = { COMPANIA: 'compania', TRANSITO: 'transito' } as const;
export type AlcanceBolsa = (typeof AlcanceBolsa)[keyof typeof AlcanceBolsa];

/**
 * HU #13902: por qué el descuento de un comprobante no movió una bolsa. Ninguno genera alerta (D10).
 * `autogestionado` (D15): la compañía autogestiona el concepto y el trámite no tiene excepción vigente
 * (ni es un SOAT del canal cliente).
 */
export type MotivoOmisionDescuento =
  | 'antes_del_corte' | 'sin_compania' | 'sin_organismo' | 'sin_bolsa' | 'inactiva' | 'concepto_no_cubierto'
  | 'cubierto_por_liquidacion' | 'cubierto_por_conciliacion' | 'no_es_pago' | 'autogestionado';

/** Lo que el descuento devuelve a quien aplica el comprobante (y el detalle muestra). Alertas: saldo < 0 (D11). */
export interface DescuentoBolsaDto {
  movimientos: Array<{ bolsaId: string; alcance: AlcanceBolsa; movimientoId: string; valor: number; saldoResultante: number }>;
  omitidos: Array<{ alcance: AlcanceBolsa; motivo: MotivoOmisionDescuento }>;
  /** `bolsaNombre` (HU #13904): nombre visible de la bolsa (el suyo, o el del cliente en una de compañía). */
  alertas: Array<{ bolsaId: string; bolsaNombre: string; alcance: AlcanceBolsa; saldoResultante: number }>;
}

/** Forma fijada con #13407. `activa` es false cuando `existe` es false. */
export interface EstadoBolsaCompaniaDto { existe: boolean; activa: boolean }

/** Códigos de error de negocio de bolsas (cuerpo `{ error, codigo }`). */
export const CodigoErrorBolsa = {
  BOLSA_INEXISTENTE: 'bolsa_inexistente',
  BOLSA_INACTIVA: 'bolsa_inactiva',
  BOLSA_COMPANIA_EXISTE: 'bolsa_compania_existe',
  COBERTURA_OCUPADA: 'cobertura_ocupada',
  NOMBRE_EN_USO: 'nombre_en_uso',
  YA_ACTIVA: 'ya_activa',
  YA_INACTIVA: 'ya_inactiva',
  PERIODO_CERRADO: 'periodo_cerrado',
  /** HU #13900: cuerpo de alta/edición inválido (sin conceptos, GMF, motivo corto…). */
  DATOS_INVALIDOS: 'datos_invalidos',
} as const;
export type CodigoErrorBolsa = (typeof CodigoErrorBolsa)[keyof typeof CodigoErrorBolsa];

// ─── HU #13900 (Feature #13886, ADR-0029) — catálogo de bolsas: crear, editar, inactivar, reactivar ───

/**
 * Conceptos que puede marcar una bolsa de COMPAÑÍA: los seis de `ConceptoBolsa`. El GMF no es
 * seleccionable (es un costo financiero, no un concepto que se descuente de la bolsa).
 * Tránsito sigue usando `CONCEPTOS_BOLSA_TRANSITO` (derecho | soat | impuesto).
 */
export const CONCEPTOS_BOLSA_COMPANIA: readonly ConceptoCosto[] = Object.values(ConceptoCosto);

/** Alta de una bolsa. La rama `transito` llega en la HU-G (#13907): hoy el API la rechaza con 400. */
export type CrearBolsaDto =
  | { alcance: 'compania'; companiaId: number; conceptos: ConceptoCosto[] }
  | { alcance: 'transito'; nombre: string; organismos: string[]; conceptos: string[] };

/** Edición: NO cambia el alcance ni la compañía. */
export type EditarBolsaDto =
  | { alcance: 'compania'; conceptos: ConceptoCosto[] }
  | { alcance: 'transito'; nombre: string; organismos: string[]; conceptos: string[] };

/** Filtros del listado. Van SIEMPRE en el body de `POST /buscar` (Ley 1581: NIT y nombre nunca en la URL). */
export interface BuscarBolsasDto {
  alcance?: AlcanceBolsa;
  activa?: boolean;
  /** Nombre de la compañía o de la bolsa, o NIT. */
  texto?: string;
}

/** Inactivar / reactivar: el motivo es obligatorio (≥ 5 caracteres). */
export interface MotivoBolsaDto { motivo: string }

/** Par (secretaría, concepto) de una bolsa de tránsito. `[]` en las de compañía. */
export interface CoberturaBolsaDto { organismoCodigo: string; concepto: string }

export interface BolsaResumenDto {
  id: string;
  alcance: AlcanceBolsa;
  /** Nombre a mostrar: el de la compañía (alcance compañía) o el de la bolsa (tránsito). */
  nombre: string;
  /** No nulo ⇔ alcance === 'compania'. Contrato (c) con #13407. */
  companiaId: number | null;
  companiaNombre: string | null;
  activa: boolean;
  conceptos: string[];
  cobertura: CoberturaBolsaDto[];
  saldo: number;
  ultimaEntradaValor: number | null;
  ultimaEntradaEn: string | null;
  nivel: NivelRiesgoBolsa;
  porcentaje: number | null;
}

export interface BolsaDetalleDto extends BolsaResumenDto {
  inactivadaEn: string | null;
  inactivadaPorNombre: string | null;
  motivoInactivacion: string | null;
  /**
   * AC11 (HU #13900): conceptos que la compañía AUTOGESTIONA hoy (`clients.*_autogestionable`), calculados en
   * lectura, no guardados en la bolsa. Marcarlos no se bloquea: la UI avisa. Tránsito: `[]` (HU-G).
   */
  conceptosAutogestionados: ConceptoBolsa[];
}

/**
 * Respuesta de `GET /api/flito/bolsas/compania/:companiaId/estado` (AC8 + AC11). Extiende el contrato (d)
 * con #13407 SOLO en la ruta: `estadoBolsaDeCompania()` sigue devolviendo `{ existe, activa }`.
 */
export interface EstadoBolsaCompaniaConAutogestionDto extends EstadoBolsaCompaniaDto {
  conceptosAutogestionados: ConceptoBolsa[];
}
