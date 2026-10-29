// FLITO Logística — retención: el RECORRIDO de la purga de la cédula a 10 años (HU #14113,
// Feature #14091, Épica #13758, ADR-0030 C8b / Q6 / N6). La regla RN-RET1 completa —qué se borra,
// cuándo, qué se conserva y la base legal— está en la cabecera de `flito-logistica-retencion.cron.ts`
// y en `docs/privacy/retencion-flito-logistica.md`. Aquí vive el CÓMO:
//
//   UPDATE de `documento_cifrado` y `documento_ultimos` a NULL en las dos tablas de firmantes
//   (`flito_logistica_acta_firmas` y `flito_logistica_recogida_firmantes`) cuya entrega
//   (`firmado_en`) ya cumplió 10 años. `nombre` y `firma_storage_key` no entran en el SET.
//
// Idempotencia: el WHERE exige que quede cédula (`documento_cifrado IS NOT NULL OR
// documento_ultimos IS NOT NULL`). Una fila ya purgada no vuelve a cambiarse.
//
// El corte se calcula en el proceso y viaja como PARÁMETRO, no como `now() - interval '10 years'`:
// fija el reloj de la corrida (el mismo `ahora` para las dos tablas) y evita el intervalo de
// calendario de la sesión de Postgres. 10 años UTC = 10 años en Bogotá (Colombia no tiene DST).
//
// Sin índice parcial `(firmado_en) WHERE documento_cifrado IS NOT NULL`: la corrida es diaria y
// toca filas de diez años; un seq scan basta. No hay migración en esta HU.
//
// Logs: solo conteos. Ningún id, cédula ni nombre sale de aquí.

import { and, lte, or, isNotNull, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoLogisticaActaFirmas,
  flitoLogisticaRecogidaFirmantes,
} from '../../db/schema.js';

/** Años de retención de la cédula desde la entrega (RN-RET1). Calendario, no 365 × 24 h. */
export const ANIOS_RETENCION = 10;

/**
 * El instante de corte: una firma con `firmado_en <= corte` ya cumplió los 10 años.
 * Frontera inclusiva: exactamente 10 años sí se purga.
 */
export function corteRetencion(ahora: Date): Date {
  const corte = new Date(ahora.getTime());
  corte.setUTCFullYear(corte.getUTCFullYear() - ANIOS_RETENCION);
  return corte;
}

/** Predicado puro de la frontera (apoyo de los tests): ¿ya cumplió los 10 años? Inclusivo. */
export function esPurgable(firmadoEn: Date, ahora: Date): boolean {
  return firmadoEn.getTime() <= corteRetencion(ahora).getTime();
}

/** Candidatas: con cédula aún presente y entrega en o antes del corte. */
export function condicionCandidatas(
  tabla: typeof flitoLogisticaActaFirmas | typeof flitoLogisticaRecogidaFirmantes,
  corte: Date,
): SQL {
  return and(
    lte(tabla.firmadoEn, corte),
    or(isNotNull(tabla.documentoCifrado), isNotNull(tabla.documentoUltimos)),
  )!;
}

export interface ResultadoRetencionLogistica {
  /** Filas de `flito_logistica_acta_firmas` cuya cédula se anuló en esta corrida. */
  actasPurgadas: number;
  /** Filas de `flito_logistica_recogida_firmantes` cuya cédula se anuló en esta corrida. */
  recogidaPurgadas: number;
}

const SET_PURGA = { documentoCifrado: null, documentoUltimos: null } as const;

async function purgarTabla(
  tabla: typeof flitoLogisticaActaFirmas | typeof flitoLogisticaRecogidaFirmantes,
  corte: Date,
): Promise<number> {
  const filas = await db.update(tabla)
    .set(SET_PURGA)
    .where(condicionCandidatas(tabla, corte))
    .returning({ id: tabla.id });
  return filas.length;
}

/**
 * Una corrida: anula la cédula vencida en las dos tablas. Devuelve conteos: ningún identificador.
 */
export async function ejecutarPurgaRetencionLogistica(
  opts: { ahora?: Date } = {},
): Promise<ResultadoRetencionLogistica> {
  const corte = corteRetencion(opts.ahora ?? new Date());
  const actasPurgadas = await purgarTabla(flitoLogisticaActaFirmas, corte);
  const recogidaPurgadas = await purgarTabla(flitoLogisticaRecogidaFirmantes, corte);
  return { actasPurgadas, recogidaPurgadas };
}
