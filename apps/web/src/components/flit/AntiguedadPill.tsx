// AntiguedadPill — cuánto lleva algo esperando, con semáforo (HU #10960, Feature #10940 §3.2).
//
// Es el gemelo invertido de VencimientoPill (components/pesv/shared.tsx) y EstadoPill
// (components/fleet/DocumentsPanel.tsx), que cuentan hacia ADELANTE hasta una fecha de vencimiento.
// Aquí interesa lo contrario: cuánto tiempo ha pasado DESDE una fecha, porque lo que envejece sin
// avanzar es el riesgo operativo.
//
// Los umbrales salen de SLA_OPERATIVO (shared-types) para que API y web no discrepen.

import { SLA_OPERATIVO } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from './StatusChip';

const MS_DIA = 86_400_000;

/** Días transcurridos desde `iso`. null si la fecha falta o no parsea. */
export function diasDesde(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / MS_DIA);
}

/**
 * Tono según la edad. Verde solo para lo recién ingresado: un trámite de tres días no está "bien",
 * simplemente aún no es tarde, y pintarlo de verde invita a ignorarlo.
 */
export function tonoAntiguedad(dias: number, horas: number): ChipTone {
  if (dias >= SLA_OPERATIVO.ATRASADO_DIAS) return 'danger';
  if (dias >= SLA_OPERATIVO.POR_VENCER_DIAS) return 'warning';
  if (horas <= SLA_OPERATIVO.RECIEN_INGRESADO_HORAS) return 'success';
  return 'neutral';
}

/** Etiqueta corta: «Hoy», «1 día», «N días». */
export function etiquetaAntiguedad(dias: number, horas: number): string {
  if (horas <= SLA_OPERATIVO.RECIEN_INGRESADO_HORAS) return 'Hoy';
  return dias === 1 ? '1 día' : `${dias} días`;
}

/**
 * Pastilla de antigüedad. Sin fecha no se pinta nada: un indicador sobre un dato que no existe
 * miente más de lo que informa (AC5).
 */
export default function AntiguedadPill({ desde }: { desde: string | null | undefined }) {
  const dias = diasDesde(desde);
  if (dias === null) return null;
  const horas = (Date.now() - new Date(desde as string).getTime()) / 3_600_000;
  // Una fecha futura (reloj desfasado entre FLIT y FLITO) se trata como recién ingresado, no como
  // días negativos.
  const d = Math.max(0, dias);
  return <StatusChip tone={tonoAntiguedad(d, horas)}>{etiquetaAntiguedad(d, horas)}</StatusChip>;
}
