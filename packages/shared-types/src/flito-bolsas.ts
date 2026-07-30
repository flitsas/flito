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
 *   recarga     — dinero que precarga FLIT en la bolsa del cliente (HU #11121)
 *   automatico  — salida generada al sellar la liquidación del trámite (HU #11122)
 *   manual      — contingencia registrada por Financiera con motivo y evidencia (HU #11123)
 */
export const OrigenMovimientoBolsa = {
  RECARGA: 'recarga',
  AUTOMATICO: 'automatico',
  MANUAL: 'manual',
} as const;

export type OrigenMovimientoBolsa = (typeof OrigenMovimientoBolsa)[keyof typeof OrigenMovimientoBolsa];

/**
 * Conceptos que consumen bolsa. Coinciden con los cinco que sella la liquidación
 * (`flito_liquidaciones`), que es la fuente del valor de cada salida.
 */
export const ConceptoBolsa = {
  DERECHO: 'derecho',
  SOAT: 'soat',
  IMPUESTO: 'impuesto',
  TRAMITE_DIGITAL: 'tramite_digital',
  LOGISTICA: 'logistica',
} as const;

export type ConceptoBolsa = (typeof ConceptoBolsa)[keyof typeof ConceptoBolsa];

export const CONCEPTO_BOLSA_LABEL: Record<ConceptoBolsa, string> = {
  derecho: 'Derecho de tránsito',
  soat: 'SOAT',
  impuesto: 'Impuesto',
  tramite_digital: 'Trámite digital',
  logistica: 'Logística',
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
