// FLITO — bolsa prepago que FLIT mantiene en un Organismo de Tránsito (HU #11161, Feature #11120 §4).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web.
//
// Ojo con el sentido, porque es el INVERSO de la bolsa del cliente y confundirlos invierte el signo
// de toda la pantalla:
//
//   · Bolsa del CLIENTE  — el cliente precarga dinero y FLIT se lo consume al liquidar.
//   · Bolsa del ORGANISMO — FLIT precarga dinero en la secretaría y ella lo consume cada vez que
//     emite un derecho de trámite.
//
// Lo que se persiste aquí es un saldo REAL, no una vista derivada: «a Medellín le quedan 8.000.000»
// es la pregunta que el módulo tiene que responder de un vistazo.
//
// Solo el DERECHO DE TRÁMITE consume esta bolsa. SOAT e impuesto llevan organismo en el libro del
// cliente porque se gestionan ante uno, pero no salen de este saldo; el trámite digital y la
// logística son honorarios de FLIT; y el GMF es un gravamen que el organismo ya incluye en el total
// de su comprobante. Meter cualquiera de ellos aquí haría que el saldo dejara de cuadrar contra lo
// que la secretaría dice haber cobrado.

import { UMBRAL_RIESGO_BAJO, UMBRAL_RIESGO_CRITICO } from './flito-bolsas.js';

/** Dirección del movimiento. El valor se guarda positivo; el signo lo da esto. */
export const TipoMovimientoOrganismo = {
  ENTRADA: 'entrada',
  SALIDA: 'salida',
} as const;

export type TipoMovimientoOrganismo =
  (typeof TipoMovimientoOrganismo)[keyof typeof TipoMovimientoOrganismo];

/**
 * Quién produjo el movimiento.
 *
 *   carga       — dinero que FLIT precarga en el organismo (entrada)
 *   automatico  — consumo del derecho al sellar la liquidación, y su devolución al reversarla
 */
export const OrigenMovimientoOrganismo = {
  CARGA: 'carga',
  AUTOMATICO: 'automatico',
} as const;

export type OrigenMovimientoOrganismo =
  (typeof OrigenMovimientoOrganismo)[keyof typeof OrigenMovimientoOrganismo];

/**
 * Nivel del saldo de un organismo.
 *
 * `en_prestamo` es lo que distingue esta bolsa de la del cliente y no es un error a corregir: si el
 * organismo siguió emitiendo derechos después de agotar el saldo, ese gasto ya ocurrió. La deuda no
 * se guarda en ninguna parte — ES el saldo negativo — y la siguiente carga la neta sumando.
 *
 * `sin_cargas` no es mejor ni peor que los demás: es la ausencia de base para calcular el
 * porcentaje. Un organismo al que nunca se le ha cargado nada no es uno que se quedó sin saldo.
 */
export const NivelBolsaOrganismo = {
  NORMAL: 'normal',
  BAJO: 'bajo',
  CRITICO: 'critico',
  AGOTADA: 'agotada',
  EN_PRESTAMO: 'en_prestamo',
  SIN_CARGAS: 'sin_cargas',
} as const;

export type NivelBolsaOrganismo = (typeof NivelBolsaOrganismo)[keyof typeof NivelBolsaOrganismo];

export const NIVEL_BOLSA_ORGANISMO_LABEL: Record<NivelBolsaOrganismo, string> = {
  normal: 'Normal',
  bajo: 'Saldo bajo',
  critico: 'Saldo crítico',
  agotada: 'Saldo agotado',
  en_prestamo: 'En préstamo',
  sin_cargas: 'Sin cargas',
};

/**
 * Clasifica el saldo del organismo contra el monto de su última carga.
 *
 * Los umbrales son los mismos de la bolsa del cliente (HU #11125) a propósito: son dos lecturas del
 * mismo tablero y que «saldo bajo» significara cosas distintas según la columna sería una trampa.
 *
 * Vive en shared-types porque la pantalla tiene que pintar exactamente el nivel que calcula la API.
 */
export function nivelBolsaOrganismoDe(
  saldo: number,
  ultimaCargaValor: number | null,
): NivelBolsaOrganismo {
  // El préstamo se evalúa ANTES que la ausencia de base: un organismo en negativo lo está aunque
  // nunca se le haya cargado nada (puede pasar si el consumo histórico entra antes que las cargas).
  if (saldo < 0) return NivelBolsaOrganismo.EN_PRESTAMO;
  if (ultimaCargaValor === null || ultimaCargaValor <= 0) return NivelBolsaOrganismo.SIN_CARGAS;
  if (saldo === 0) return NivelBolsaOrganismo.AGOTADA;

  const porcentaje = (saldo / ultimaCargaValor) * 100;
  if (porcentaje <= UMBRAL_RIESGO_CRITICO) return NivelBolsaOrganismo.CRITICO;
  if (porcentaje <= UMBRAL_RIESGO_BAJO) return NivelBolsaOrganismo.BAJO;
  return NivelBolsaOrganismo.NORMAL;
}

/** Cuánto debe FLIT al organismo, o 0 si el saldo no es negativo. La deuda es el saldo en negativo. */
export function deudaConOrganismo(saldo: number): number {
  return saldo < 0 ? Math.abs(saldo) : 0;
}

/** Bolsa de un organismo con su saldo vigente. */
export interface BolsaOrganismoDto {
  id: string;
  organismoCodigo: string;
  /** Puede ser NEGATIVO: es el préstamo del organismo, no un estado inválido. */
  saldo: number;
  /** Base del nivel. `null` mientras no se le haya cargado nada. */
  ultimaCargaValor: number | null;
  ultimaCargaEn: string | null;
}

/** Bolsa del organismo con su nivel ya clasificado por el servidor. */
export interface BolsaOrganismoConNivel extends BolsaOrganismoDto {
  nivel: NivelBolsaOrganismo;
  /** Saldo como porcentaje de la última carga; `null` si nunca se cargó. */
  porcentaje: number | null;
  /** Lo que FLIT le debe al organismo ahora mismo. 0 si el saldo no es negativo. */
  deuda: number;
  totalCargado: number;
  totalConsumido: number;
}

/** Una línea del libro de la bolsa del organismo. */
export interface MovimientoOrganismoDto {
  id: string;
  organismoCodigo: string;
  tipo: TipoMovimientoOrganismo;
  origen: OrigenMovimientoOrganismo;
  /** Trámite cuyo derecho originó el consumo. `null` en las cargas. */
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
export interface RespuestaCargaOrganismo {
  movimiento: MovimientoOrganismoDto;
  saldo: number;
  duplicado: boolean;
}
