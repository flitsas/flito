// FLITO — bolsa que FLIT precarga para pagar trámites ante las secretarías (HU #11161, ajuste 0124).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web.
//
// Ojo con el sentido, porque es el INVERSO de la bolsa del cliente y confundirlos invierte el signo
// de toda la pantalla:
//
//   · Bolsa del CLIENTE  — el cliente precarga dinero y FLIT se lo consume al liquidar.
//   · Bolsa de TRÁNSITO  — FLIT precarga el dinero y un tercero lo gasta pagando ante la secretaría.
//
// Lo que se persiste aquí es un saldo REAL, no una vista derivada: «a la bolsa de mi sector le
// quedan 8.000.000» es la pregunta que el módulo tiene que responder de un vistazo.
//
// Una bolsa NO es una secretaría. Cubre las parejas (secretaría, concepto) que se le hayan definido
// —Medellín, Envigado y Sabaneta solo para impuestos, por ejemplo— y el par no puede repetirse en
// dos bolsas: es lo que permite que el sellado de la liquidación sepa a dónde va el dinero sin
// preguntarle a nadie.

import { UMBRAL_RIESGO_BAJO, UMBRAL_RIESGO_CRITICO } from './flito-bolsas.js';

/**
 * Conceptos que una bolsa de tránsito puede cubrir.
 *
 * Es un subconjunto de `ConceptoBolsa` (el del libro del cliente) y no una lista paralela: son los
 * tres conceptos que se pagan ANTE una secretaría. El trámite digital y la logística son honorarios
 * de FLIT, y el GMF es un gravamen que el organismo ya incluye en el total de su comprobante; ni
 * unos ni otro salen de este saldo.
 */
export const ConceptoBolsaTransito = {
  DERECHO: 'derecho',
  SOAT: 'soat',
  IMPUESTO: 'impuesto',
} as const;

export type ConceptoBolsaTransito =
  (typeof ConceptoBolsaTransito)[keyof typeof ConceptoBolsaTransito];

/** Los tres, en el orden en que se ofrecen al crear una bolsa. */
export const CONCEPTOS_BOLSA_TRANSITO: readonly ConceptoBolsaTransito[] = [
  ConceptoBolsaTransito.DERECHO,
  ConceptoBolsaTransito.SOAT,
  ConceptoBolsaTransito.IMPUESTO,
];

export const CONCEPTO_BOLSA_TRANSITO_LABEL: Record<ConceptoBolsaTransito, string> = {
  derecho: 'Derechos de tránsito',
  soat: 'SOAT',
  impuesto: 'Impuestos',
};

export function esConceptoBolsaTransito(v: string): v is ConceptoBolsaTransito {
  return (CONCEPTOS_BOLSA_TRANSITO as readonly string[]).includes(v);
}

/** Dirección del movimiento. El valor se guarda positivo; el signo lo da esto. */
export const TipoMovimientoTransito = {
  ENTRADA: 'entrada',
  SALIDA: 'salida',
} as const;

export type TipoMovimientoTransito =
  (typeof TipoMovimientoTransito)[keyof typeof TipoMovimientoTransito];

/**
 * Quién produjo el movimiento.
 *
 *   carga       — dinero que FLIT precarga en la bolsa (entrada)
 *   automatico  — consumo al sellar la liquidación, y su devolución al reversarla
 */
export const OrigenMovimientoTransito = {
  CARGA: 'carga',
  AUTOMATICO: 'automatico',
} as const;

export type OrigenMovimientoTransito =
  (typeof OrigenMovimientoTransito)[keyof typeof OrigenMovimientoTransito];

/**
 * Nivel del saldo de una bolsa de tránsito.
 *
 * `en_prestamo` es lo que distingue esta bolsa de la del cliente y no es un error a corregir: si se
 * siguió pagando después de agotar el saldo, ese gasto ya ocurrió. La deuda no se guarda en ninguna
 * parte — ES el saldo negativo — y la siguiente carga la neta sumando.
 *
 * `sin_cargas` no es mejor ni peor que los demás: es la ausencia de base para calcular el
 * porcentaje. Una bolsa a la que nunca se le ha cargado nada no es una que se quedó sin saldo.
 */
export const NivelBolsaTransito = {
  NORMAL: 'normal',
  BAJO: 'bajo',
  CRITICO: 'critico',
  AGOTADA: 'agotada',
  EN_PRESTAMO: 'en_prestamo',
  SIN_CARGAS: 'sin_cargas',
} as const;

export type NivelBolsaTransito = (typeof NivelBolsaTransito)[keyof typeof NivelBolsaTransito];

export const NIVEL_BOLSA_TRANSITO_LABEL: Record<NivelBolsaTransito, string> = {
  normal: 'Normal',
  bajo: 'Saldo bajo',
  critico: 'Saldo crítico',
  agotada: 'Saldo agotado',
  en_prestamo: 'En préstamo',
  sin_cargas: 'Sin cargas',
};

/**
 * Clasifica el saldo de la bolsa contra el monto de su última carga.
 *
 * Los umbrales son los mismos de la bolsa del cliente (HU #11125) a propósito: son dos lecturas del
 * mismo tablero y que «saldo bajo» significara cosas distintas según la columna sería una trampa.
 *
 * Vive en shared-types porque la pantalla tiene que pintar exactamente el nivel que calcula la API.
 */
export function nivelBolsaTransitoDe(
  saldo: number,
  ultimaCargaValor: number | null,
): NivelBolsaTransito {
  // El préstamo se evalúa ANTES que la ausencia de base: una bolsa en negativo lo está aunque nunca
  // se le haya cargado nada (puede pasar si el consumo histórico entra antes que las cargas).
  if (saldo < 0) return NivelBolsaTransito.EN_PRESTAMO;
  if (ultimaCargaValor === null || ultimaCargaValor <= 0) return NivelBolsaTransito.SIN_CARGAS;
  if (saldo === 0) return NivelBolsaTransito.AGOTADA;

  const porcentaje = (saldo / ultimaCargaValor) * 100;
  if (porcentaje <= UMBRAL_RIESGO_CRITICO) return NivelBolsaTransito.CRITICO;
  if (porcentaje <= UMBRAL_RIESGO_BAJO) return NivelBolsaTransito.BAJO;
  return NivelBolsaTransito.NORMAL;
}

/** Cuánto se debe a quien opera la bolsa, o 0 si el saldo no es negativo. La deuda es el saldo negativo. */
export function deudaBolsaTransito(saldo: number): number {
  return saldo < 0 ? Math.abs(saldo) : 0;
}

/** Una pareja cubierta por la bolsa: qué concepto paga y ante qué secretaría. */
export interface CoberturaBolsaTransito {
  organismoCodigo: string;
  /** Alias del organismo para pintar; el código DIVIPOLA no le dice nada a nadie en pantalla. */
  organismoNombre: string | null;
  concepto: ConceptoBolsaTransito;
}

/** Bolsa de tránsito con su saldo vigente. */
export interface BolsaTransitoDto {
  id: string;
  nombre: string;
  /** Puede ser NEGATIVO: es el préstamo, no un estado inválido. */
  saldo: number;
  /** Base del nivel. `null` mientras no se le haya cargado nada. */
  ultimaCargaValor: number | null;
  ultimaCargaEn: string | null;
  cobertura: CoberturaBolsaTransito[];
}

/** Bolsa de tránsito con su nivel ya clasificado por el servidor. */
export interface BolsaTransitoConNivel extends BolsaTransitoDto {
  nivel: NivelBolsaTransito;
  /** Saldo como porcentaje de la última carga; `null` si nunca se cargó. */
  porcentaje: number | null;
  /** Lo que se le debe a quien opera la bolsa ahora mismo. 0 si el saldo no es negativo. */
  deuda: number;
  totalCargado: number;
  totalConsumido: number;
}

/** Una línea del libro de la bolsa de tránsito. */
export interface MovimientoTransitoDto {
  id: string;
  bolsaId: string;
  /** Secretaría ante la que se pagó. `null` en las cargas: el dinero entra a la bolsa entera. */
  organismoCodigo: string | null;
  /** Concepto que produjo la salida. `null` en las cargas. */
  concepto: ConceptoBolsaTransito | null;
  tipo: TipoMovimientoTransito;
  origen: OrigenMovimientoTransito;
  /** Trámite cuyo pago originó el consumo. `null` en las cargas. */
  tramiteId: string | null;
  /** Identificador legible del trámite; el UUID no le dice nada a nadie en pantalla. */
  idFlit: string | null;
  valor: number;
  /** Saldo después de aplicar este movimiento: permite auditar el libro sin recalcular. */
  saldoResultante: number;
  periodo: string;
  fecha: string;
  observacion: string | null;
  soporteId: string | null;
  registradoPorNombre: string;
  createdAt: string;
}

/** Respuesta del POST de cargas. `duplicado` es el contrato de idempotencia, igual que en recargas. */
export interface RespuestaCargaTransito {
  movimiento: MovimientoTransitoDto;
  saldo: number;
  duplicado: boolean;
}

/** Lo que hace falta para crear o redefinir una bolsa. El producto de ambas listas es su cobertura. */
export interface DatosBolsaTransito {
  nombre: string;
  organismos: string[];
  conceptos: ConceptoBolsaTransito[];
}
