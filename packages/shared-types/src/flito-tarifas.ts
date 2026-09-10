// FLITO — Tarifas como vigencias (HU #12373, Feature #12365).
//
// Una tarifa negociada ya no es una fila que se sobreescribe: es una SECUENCIA de vigencias
// `[vigente_desde, vigente_hasta)` por (compañía × concepto × tipo). Este archivo fija el catálogo
// CERRADO de tipos de trámite de la tarifa y las reglas del valor, que la API y la web comparten.
//
// El tipo se persiste en MAYÚSCULAS sin tilde (`MATRICULA`), que es la forma que ya tenía la tabla
// vieja y la que casa con el `UPPER(TRIM(...))` del reporte de costos. `normalizarTipoTramite` de
// `flito-estados.ts` NO sirve aquí: acepta cualquier texto, y una tarifa con tipo fuera del catálogo
// es justo lo que este eslabón prohíbe (RN-02).
import type { ConceptoTarifa } from './flito-estados.js';

export const TIPOS_TRAMITE_TARIFA = ['MATRICULA', 'TRASPASO', 'OTROS'] as const;
export type TipoTramiteTarifa = (typeof TIPOS_TRAMITE_TARIFA)[number];

export const TIPO_TRAMITE_TARIFA_LABEL: Record<TipoTramiteTarifa, string> = {
  MATRICULA: 'Matrícula',
  TRASPASO: 'Traspaso',
  OTROS: 'Otros',
};

/**
 * Las filas FIJAS de la vista de tarifas de un cliente, en este orden: los tres tipos de trámite
 * digital y la logística (que va siempre sin tipo: un solo valor por compañía, RN-03).
 */
export const LLAVES_TARIFA: ReadonlyArray<{ concepto: ConceptoTarifa; tipoTramite: TipoTramiteTarifa | null }> = [
  { concepto: 'tramite_digital', tipoTramite: 'MATRICULA' },
  { concepto: 'tramite_digital', tipoTramite: 'TRASPASO' },
  { concepto: 'tramite_digital', tipoTramite: 'OTROS' },
  { concepto: 'logistica', tipoTramite: null },
];

/**
 * El tipo de trámite de una tarifa a partir de un texto libre («matrícula », «Traspaso», «OTROS»).
 * Devuelve `null` si está vacío o NO está en el catálogo: nunca adivina «OTROS» (ante ambigüedad,
 * null antes que adivinar). Quita tildes con NFD y compara en mayúsculas.
 */
export function tipoTramiteTarifaDe(v: string | null | undefined): TipoTramiteTarifa | null {
  const s = (v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  return (TIPOS_TRAMITE_TARIFA as readonly string[]).includes(s) ? (s as TipoTramiteTarifa) : null;
}

/** Tope de `numeric(14,2)`: doce enteros y dos decimales. */
export const TARIFA_VALOR_MAX = 999_999_999_999.99;

/** Un valor de tarifa: número finito, no negativo, dentro del tope y con a lo sumo dos decimales. */
export function valorTarifaValido(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= TARIFA_VALOR_MAX
    && Math.round(v * 100) / 100 === v;
}
