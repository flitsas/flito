// HU #14132 (Feature #14013, ADR-0032) — reclamo de filas de la cola en Postgres, recuperación de huérfanas y
// cierre de lotes (terminar + anonimizar PII, vigilante de 2 h). Solo acceso a datos; sin RUNT.
//
// Reclamo: se bloquea el LOTE con `FOR UPDATE SKIP LOCKED` (hay un lote activo por compañía, así que el lote ES
// el tope por compañía): dos procesos nunca reclaman a la vez sobre el mismo lote, y el que llega segundo pasa
// al siguiente. Dentro, las filas `pendiente` se toman también con SKIP LOCKED. Transacción de milisegundos:
// la llamada al RUNT va FUERA de toda transacción.
//
// Nada de PII en logs: solo ids de lote/fila y conteos.

import { and, asc, eq, inArray, lte, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSoatMasivoFilas as F, flitoSoatMasivoLotes as L } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-soat-masivo-worker');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Filas `consultando` simultáneas por compañía contra el RUNT. */
export const TOPE_POR_COMPANIA = 2;
/** Arrendamiento: > timeout del RUNT. Vencido, la fila vuelve a `pendiente`. */
export const LEASE_MS = 3 * 60_000;
/** Un lote sin avance en este tiempo lo cierra el vigilante. */
export const SIN_AVANCE_MS = 2 * 60 * 60_000;

export interface FilaReclamada {
  id: string;
  loteId: string;
  nFila: number;
  companiaId: number;
  creadoPorId: number | null;
  creadoPorNombre: string;
  soatIdReservado: string;
  intentos: number;
  placa: string | null;
  documento: string | null;
  nombre: string | null;
  correo: string | null;
  celular: string | null;
  /** HU #14135: tipo del lote y VIN de la fila (plantilla Inicial). Ausentes = Renovación. */
  tipoSoat?: 'renovacion' | 'inicial';
  vin?: string | null;
}

export async function reclamarFilas(cupoLocal: number, ahora: Date = new Date()): Promise<FilaReclamada[]> {
  if (cupoLocal <= 0) return [];
  return db.transaction(async (tx) => {
    const lotes = await tx.select({
      id: L.id, companiaId: L.companiaId, creadoPorId: L.creadoPorId, creadoPorNombre: L.creadoPorNombre, tipoSoat: L.tipoSoat,
    }).from(L)
      .where(inArray(L.estado, ['en_cola', 'procesando']))
      .orderBy(asc(L.creadoEn))
      .for('update', { skipLocked: true });

    const reclamadas: FilaReclamada[] = [];
    for (const lote of lotes) {
      const restante = cupoLocal - reclamadas.length;
      if (restante <= 0) break;
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(F)
        .where(and(eq(F.loteId, lote.id), eq(F.estado, 'consultando')));
      const cupo = Math.min(TOPE_POR_COMPANIA - n, restante);
      if (cupo <= 0) continue;
      const ids = await tx.select({ id: F.id }).from(F)
        .where(and(eq(F.loteId, lote.id), eq(F.estado, 'pendiente'), lte(F.proximoIntentoEn, ahora)))
        .orderBy(asc(F.nFila)).limit(cupo)
        .for('update', { skipLocked: true });
      if (ids.length === 0) continue;
      const filas = await tx.update(F).set({
        estado: 'consultando', reclamadaEn: ahora,
        soatIdReservado: sql`coalesce(${F.soatIdReservado}, gen_random_uuid())`,
      }).where(inArray(F.id, ids.map((x) => x.id)))
        .returning({
          id: F.id, nFila: F.nFila, soatIdReservado: F.soatIdReservado, intentos: F.intentos,
          placa: F.placa, documento: F.documento, nombre: F.nombre, correo: F.correo, celular: F.celular, vin: F.vin,
        });
      await tx.update(L).set({ estado: 'procesando', iniciadoEn: sql`coalesce(${L.iniciadoEn}, now())` })
        .where(eq(L.id, lote.id));
      for (const f of filas) {
        reclamadas.push({
          ...f, soatIdReservado: f.soatIdReservado as string, loteId: lote.id, companiaId: lote.companiaId,
          creadoPorId: lote.creadoPorId, creadoPorNombre: lote.creadoPorNombre,
          tipoSoat: lote.tipoSoat === 'inicial' ? 'inicial' : 'renovacion',
        });
      }
    }
    return reclamadas;
  });
}

/** AC9: filas `consultando` con el arrendamiento vencido (el proceso murió) vuelven a la cola. Conserva `soat_id_reservado`. */
export async function recuperarHuerfanas(ahora: Date = new Date()): Promise<number> {
  const r = await db.update(F).set({ estado: 'pendiente', reclamadaEn: null })
    .where(and(eq(F.estado, 'consultando'), lt(F.reclamadaEn, new Date(ahora.getTime() - LEASE_MS))))
    .returning({ id: F.id });
  if (r.length > 0) log.warn({ filas: r.length }, 'carga masiva SOAT: filas huérfanas recuperadas');
  return r.length;
}

const SIN_PENDIENTES = (loteId: string) =>
  sql`not exists (select 1 from ${F} where ${F.loteId} = ${loteId} and ${F.estado} in ('pendiente','consultando'))`;

async function terminarEnTx(tx: Tx, loteId: string, ahora: Date): Promise<boolean> {
  const cuenta = (estado: string) =>
    sql<number>`(select count(*)::smallint from ${F} where ${F.loteId} = ${loteId} and ${F.estado} = ${estado})`;
  const r = await tx.update(L).set({
    estado: 'terminado', terminadoEn: ahora, ultimoAvanceEn: ahora,
    nAceptadas: cuenta('aceptada'), nPorValidar: cuenta('por_validar'), nRechazadas: cuenta('rechazada'),
  }).where(and(eq(L.id, loteId), inArray(L.estado, ['en_cola', 'procesando']), SIN_PENDIENTES(loteId)))
    .returning({ id: L.id });
  if (r.length === 0) return false;
  // Misma transacción: la PII de las filas aceptadas y por validar se anonimiza al terminar (ADR-0032).
  // Las rechazadas la conservan hasta la purga de la descarga (A3).
  await tx.update(F).set({ placa: null, documento: null, nombre: null, correo: null, celular: null, vin: null })
    .where(and(eq(F.loteId, loteId), inArray(F.estado, ['aceptada', 'por_validar'])));
  return true;
}

/** Cierra el lote si ya no quedan filas `pendiente`/`consultando`. Idempotente: el segundo cierre no hace nada. */
export async function cerrarLoteSiTermino(loteId: string, ahora: Date = new Date()): Promise<boolean> {
  const cerrado = await db.transaction((tx) => terminarEnTx(tx, loteId, ahora));
  if (cerrado) log.info({ loteId }, 'carga masiva SOAT: lote terminado y PII de aceptadas/por validar anonimizada');
  return cerrado;
}

/** Lotes activos sin una sola fila por procesar (p. ej. nacieron sin filas válidas): los cierra el worker. */
export async function cerrarLotesSinPendientes(ahora: Date = new Date()): Promise<number> {
  const ids = await db.select({ id: L.id }).from(L)
    .where(and(inArray(L.estado, ['en_cola', 'procesando']), sql`not exists (select 1 from ${F} where ${F.loteId} = ${L.id} and ${F.estado} in ('pendiente','consultando'))`));
  let n = 0;
  for (const { id } of ids) if (await cerrarLoteSiTermino(id, ahora)) n++;
  return n;
}

/**
 * Vigilante: un lote activo sin avance en 2 h se cierra. Sus filas sin procesar pasan a `rechazada`
 * (`no_procesada`: «vuelva a subir el archivo») y el lote a `terminado`: la compañía queda libre.
 */
export async function cerrarLotesSinAvance(ahora: Date = new Date()): Promise<number> {
  const limite = new Date(ahora.getTime() - SIN_AVANCE_MS);
  const ids = await db.select({ id: L.id }).from(L)
    .where(and(inArray(L.estado, ['en_cola', 'procesando']), lt(L.ultimoAvanceEn, limite)));
  let n = 0;
  for (const { id } of ids) {
    const cerrado = await db.transaction(async (tx) => {
      await tx.update(F).set({ estado: 'rechazada', motivoRechazo: 'no_procesada', reclamadaEn: null })
        .where(and(eq(F.loteId, id), inArray(F.estado, ['pendiente', 'consultando'])));
      return terminarEnTx(tx, id, ahora);
    });
    if (cerrado) { n++; log.warn({ loteId: id }, 'carga masiva SOAT: lote sin avance cerrado por el vigilante'); }
  }
  return n;
}
