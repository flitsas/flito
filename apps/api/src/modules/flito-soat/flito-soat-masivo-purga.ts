// HU #14133 (Feature #14013, ADR-0032) — vida de la PII de las filas RECHAZADAS de un lote terminado.
//
// RN-MASD1  Las rechazadas conservan la PII tecleada solo para poder descargarlas (con su «Motivo») y corregirlas.
// RN-MASD2  Se purga a las 24 h de terminado el lote, o a los 15 min de la PRIMERA descarga (lo que ocurra antes);
//           entre tanto la descarga es repetible. Aceptadas y «Por validar» ya se anonimizaron al terminar el lote
//           (las «Por validar» viven como incompletas y no se tocan aquí).
// RN-MASD3  La purga borra columnas personales, NO la fila: el lote conserva conteos y motivos.

import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSoatMasivoFilas as F, flitoSoatMasivoLotes as L } from '../../db/schema.js';

export const VENTANA_DESCARGA_MS = 15 * 60 * 1000;
export const VIDA_MAXIMA_RECHAZADAS_MS = 24 * 60 * 60 * 1000;

/** ¿Venció el plazo de descarga de un lote terminado? */
export function descargaVencida(l: { terminadoEn: Date | null; primeraDescargaEn: Date | null }, ahora: Date): boolean {
  if (!l.terminadoEn) return false;
  if (ahora.getTime() - l.terminadoEn.getTime() >= VIDA_MAXIMA_RECHAZADAS_MS) return true;
  return !!l.primeraDescargaEn && ahora.getTime() - l.primeraDescargaEn.getTime() >= VENTANA_DESCARGA_MS;
}

const SIN_PII = { placa: null, documento: null, nombre: null, correo: null, celular: null, vin: null };
const CON_PII = or(isNotNull(F.placa), isNotNull(F.documento), isNotNull(F.nombre), isNotNull(F.correo), isNotNull(F.celular), isNotNull(F.vin));

/** Purga los lotes vencidos (o solo `loteId`). Devuelve las filas depuradas. Idempotente. */
export async function purgarPiiRechazadas(ahora: Date = new Date(), loteId?: string): Promise<number> {
  const vencidos = db.select({ id: L.id }).from(L).where(and(
    eq(L.estado, 'terminado'),
    loteId ? eq(L.id, loteId) : undefined,
    or(
      lte(L.terminadoEn, new Date(ahora.getTime() - VIDA_MAXIMA_RECHAZADAS_MS)),
      lte(L.primeraDescargaEn, new Date(ahora.getTime() - VENTANA_DESCARGA_MS)),
    ),
  ));
  const r = await db.update(F).set(SIN_PII)
    .where(and(eq(F.estado, 'rechazada'), CON_PII, inArray(F.loteId, vencidos)))
    .returning({ id: F.id });
  return r.length;
}

