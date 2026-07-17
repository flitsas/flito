// EPIC TRAM-INNOV · B4 — trámites en lote (CSV de flota).
//
// Admin sube CSV (VIN/placa/tipología) → preview con pre-vuelo A1 por fila (sin
// persistir trámites) → confirma y se crean N trámites en borrador (chunks ≤50).
// Reutiliza A1 (`computePreflight`) y A5 (tipología). No duplica lógica RUNT.

import { createHash } from 'node:crypto';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramiteLotes, tramiteLoteFilas } from '../../db/schema.js';
import { isValidTipologia, vendedorRequerido } from '@operaciones/shared-types';
import { createTramite } from './tramites.service.js';
import { computePreflight } from './preflight.js';
import { emitEvento } from './eventos.js';
import { appendEventoSafe } from '../vehicles/vehiculo-historial.js';
import { docLast4 } from './laft-screening.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.lote');

export const MAX_FILAS = 200;
export const CHUNK = 50;
const CONCURRENCY = 5;
export const TIPOLOGIA_DEFAULT = 'flota_corporativa';
export const LOTE_ESTADOS = ['procesando', 'listo', 'error'] as const;
export type LoteEstadoValor = typeof LOTE_ESTADOS[number];

const activeLoteJobs = new Set<number>();

export const PLANTILLA_CSV =
  'vin,placa,tipologia_codigo,comprador_doc,comprador_nombre,vendedor_doc,vendedor_nombre\n' +
  '9BWZZZ377VT004251,ABC123,traspaso_standard,1020304050,Empresa Flota SAS,80123456,Juan Vendedor\n' +
  'KMHCT41DAFU123456,,flota_corporativa,,,,\n';

/** Normaliza CSV para hash estable (BOM, CRLF, trim). */
export function normalizeCsvForHash(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

/** SHA-256 del CSV normalizado — idempotencia LOTE-PLUS-05. */
export function computeCsvSha256(text: string): string {
  return createHash('sha256').update(normalizeCsvForHash(text), 'utf8').digest('hex');
}

function normalizeVin(v: string): string {
  return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 17);
}
// LOTE-PLUS-02: documento solo dígitos, máx 15 (no exponer/loguear completo).
function normalizeDoc(v: string): string {
  return (v || '').replace(/\D/g, '').slice(0, 15);
}
const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface FilaParseada {
  fila: number;
  vin: string;
  placa: string | null;
  tipologiaCodigo: string;
  valido: boolean;
  error?: string;
  // LOTE-PLUS-02: comprador opcional (habilita screening LAFT por fila).
  compradorDoc?: string;
  compradorNombre?: string;
  // LOTE-PLUS-05: vendedor opcional (pre-vuelo comparendos + prefill _vendedor).
  vendedorDoc?: string;
  vendedorNombre?: string;
}

export interface ParseResultado { ok: boolean; error?: string; filas: FilaParseada[] }

/** Parsea el CSV (separador `,` o `;`, UTF-8) y valida columnas/filas. */
export function parseCsv(text: string): ParseResultado {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return { ok: false, error: 'CSV vacío', filas: [] };
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { ok: false, error: 'El CSV debe tener encabezado y al menos una fila', filas: [] };

  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const headers = lines[0].split(sep).map((h) => stripAccents(h.trim().toLowerCase()));
  const idxVin = headers.indexOf('vin');
  const idxPlaca = headers.indexOf('placa');
  const idxTip = headers.findIndex((h) => h === 'tipologia_codigo' || h === 'tipologia');
  const idxCompDoc = headers.findIndex((h) => h === 'comprador_doc' || h === 'comprador_documento');
  const idxCompNom = headers.findIndex((h) => h === 'comprador_nombre');
  const idxVendDoc = headers.findIndex((h) => h === 'vendedor_doc' || h === 'vendedor_documento');
  const idxVendNom = headers.findIndex((h) => h === 'vendedor_nombre');
  if (idxVin === -1) return { ok: false, error: 'Falta la columna obligatoria "vin"', filas: [] };

  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_FILAS) {
    return { ok: false, error: `Máximo ${MAX_FILAS} filas por lote (recibidas ${dataLines.length}). Divide el archivo.`, filas: [] };
  }

  // LOTE-PLUS: detectar VIN duplicado DENTRO del archivo. Sin esto, dos filas con
  // el mismo VIN crean dos trámites. Se conserva la primera ocurrencia; las demás
  // se marcan inválidas (no se crean) — el operador limpia el archivo.
  const vinVistos = new Set<string>();
  const filas: FilaParseada[] = dataLines.map((line, i) => {
    const cols = line.split(sep);
    const vinRaw = (cols[idxVin] ?? '').trim();
    const vin = normalizeVin(vinRaw);
    const placa = idxPlaca >= 0 ? ((cols[idxPlaca] ?? '').trim().toUpperCase() || null) : null;
    let tipologiaCodigo = (idxTip >= 0 ? (cols[idxTip] ?? '').trim() : '') || TIPOLOGIA_DEFAULT;
    const compradorDoc = idxCompDoc >= 0 ? (normalizeDoc(cols[idxCompDoc] ?? '') || undefined) : undefined;
    const compradorNombre = idxCompNom >= 0 ? ((cols[idxCompNom] ?? '').trim() || undefined) : undefined;
    const vendedorDoc = idxVendDoc >= 0 ? (normalizeDoc(cols[idxVendDoc] ?? '') || undefined) : undefined;
    const vendedorNombre = idxVendNom >= 0 ? ((cols[idxVendNom] ?? '').trim() || undefined) : undefined;
    const base: FilaParseada = { fila: i + 1, vin, placa, tipologiaCodigo, valido: true, compradorDoc, compradorNombre, vendedorDoc, vendedorNombre };

    if (!vin) return { ...base, valido: false, error: 'VIN vacío o inválido' };
    if (vin.length < 5) return { ...base, valido: false, error: 'VIN demasiado corto' };
    if (vinVistos.has(vin)) return { ...base, valido: false, error: 'VIN duplicado en el archivo' };
    vinVistos.add(vin);
    if (!isValidTipologia(tipologiaCodigo)) {
      // Tipología desconocida → cae al default (no bloquea la fila).
      tipologiaCodigo = TIPOLOGIA_DEFAULT;
      return { ...base, tipologiaCodigo };
    }
    return base;
  });

  return { ok: true, filas };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface LaftFila { status: string; matches: number }
export interface FilaPreview extends FilaParseada {
  preflight: { overall: string; checks: unknown[]; laftComprador?: LaftFila | null } | null;
}
export interface PreviewResultado {
  resumen: { total: number; validas: number; errores: number };
  filas: FilaPreview[];
}

/** Pre-vuelo A1 por fila (concurrencia acotada). No persiste trámites. */
export async function previewLote(filas: FilaParseada[], userId: number | null): Promise<PreviewResultado> {
  const conPreflight = await mapLimit(filas, CONCURRENCY, async (f): Promise<FilaPreview> => {
    if (!f.valido) return { ...f, preflight: null };
    try {
      // TRAM-TIPO-02: solo consultar RUNT/SIMIT del vendedor si la tipología lo
      // exige (traspaso_standard). Importación/remate/sucesión/flota → sin vendedor.
      const conVendedor = vendedorRequerido(f.tipologiaCodigo);
      const snap = await computePreflight({
        vin: f.vin, placa: f.placa ?? undefined,
        compradorDoc: f.compradorDoc, compradorNombre: f.compradorNombre,
        vendedorDoc: conVendedor ? f.vendedorDoc : undefined,
        vendedorNombre: conVendedor ? f.vendedorNombre : undefined,
      }, userId);
      const laft = snap.laftComprador ? { status: snap.laftComprador.status, matches: snap.laftComprador.matches } : null;
      return { ...f, preflight: { overall: snap.overall, checks: snap.checks, laftComprador: laft } };
    } catch (e: any) {
      log.warn({ err: e?.message, vin: f.vin }, 'preflight fila falló');
      return { ...f, preflight: null };
    }
  });
  const validas = conPreflight.filter((f) => f.valido).length;
  return {
    resumen: { total: filas.length, validas, errores: filas.length - validas },
    filas: conPreflight,
  };
}

export interface ConfirmFila {
  vin: string; placa?: string | null; tipologiaCodigo?: string | null; preflightOverall?: string | null; fila?: number;
  // LOTE-PLUS-02
  compradorDoc?: string | null; compradorNombre?: string | null;
  vendedorDoc?: string | null; vendedorNombre?: string | null;
  laftStatus?: string | null; laftMatches?: number | null;
}

type PreflightSnapshotInput = Pick<ConfirmFila, 'preflightOverall' | 'laftStatus' | 'laftMatches' | 'compradorDoc' | 'vendedorDoc'>;

// Snapshot que se guarda en `tramite_lote_filas.preflight` (JSONB): NO incluye
// la cédula completa — solo overall, estado LAFT y últimos 4 del doc (Ley 1581).
function filaPreflightSnapshot(f: PreflightSnapshotInput): Record<string, unknown> | null {
  const snap: Record<string, unknown> = {};
  if (f.preflightOverall) snap.overall = f.preflightOverall;
  if (f.laftStatus) snap.laftComprador = { status: f.laftStatus, matches: f.laftMatches ?? 0 };
  const last4 = docLast4(f.compradorDoc);
  if (last4) snap.compradorDocLast4 = last4;
  const vend4 = docLast4(f.vendedorDoc);
  if (vend4) snap.vendedorDocLast4 = vend4;
  return Object.keys(snap).length ? snap : null;
}

async function buscarLoteIdempotente(csvSha256: string, userId: number) {
  const [row] = await db.select({
    id: tramiteLotes.id, estado: tramiteLotes.estado, totalFilas: tramiteLotes.totalFilas,
    ok: tramiteLotes.ok, errores: tramiteLotes.errores,
  }).from(tramiteLotes)
    .where(and(eq(tramiteLotes.csvSha256, csvSha256), eq(tramiteLotes.creadoPor, userId)))
    .orderBy(desc(tramiteLotes.createdAt))
    .limit(1);
  return row ?? null;
}
export interface ConfirmResultado { loteId: number; total: number; ok: number; errores: number }

async function recalcLoteContadores(loteId: number): Promise<{ ok: number; errores: number }> {
  const filas = await db.select({ estado: tramiteLoteFilas.estado }).from(tramiteLoteFilas).where(eq(tramiteLoteFilas.loteId, loteId));
  const ok = filas.filter((f) => f.estado === 'ok').length;
  const errores = filas.filter((f) => f.estado === 'error').length;
  await db.update(tramiteLotes).set({ ok, errores }).where(eq(tramiteLotes.id, loteId));
  return { ok, errores };
}

/** Crea N trámites en borrador (chunks ≤50) y registra el lote. */
export async function confirmarLote(input: { nombre?: string; tipologiaDefault?: string; filas: ConfirmFila[]; csvSha256?: string }, userId: number): Promise<ConfirmResultado> {
  const filas = input.filas.slice(0, MAX_FILAS);
  const tipoDefault = isValidTipologia(input.tipologiaDefault) ? input.tipologiaDefault! : TIPOLOGIA_DEFAULT;

  const [lote] = await db.insert(tramiteLotes).values({
    nombre: input.nombre?.slice(0, 120) || null, creadoPor: userId, totalFilas: filas.length, ok: 0, errores: 0, estado: 'listo',
    csvSha256: input.csvSha256 ?? null,
  }).returning({ id: tramiteLotes.id });
  const loteId = lote.id;

  let ok = 0, errores = 0;
  for (let start = 0; start < filas.length; start += CHUNK) {
    const chunk = filas.slice(start, start + CHUNK);
    for (let j = 0; j < chunk.length; j++) {
      const f = chunk[j];
      const filaNum = f.fila ?? start + j + 1;
      const vin = normalizeVin(f.vin || '');
      const tipologiaCodigo = isValidTipologia(f.tipologiaCodigo) ? f.tipologiaCodigo! : tipoDefault;
      if (!vin) {
        errores++;
        await db.insert(tramiteLoteFilas).values({ loteId, fila: filaNum, vin: null, placa: f.placa ?? null, tipologiaCodigo, estado: 'error', errorMsg: 'VIN vacío o inválido' });
        continue;
      }
      try {
        const comprador = f.compradorDoc ? { documento: f.compradorDoc, nombre: f.compradorNombre ?? undefined } : undefined;
        const vendedor = f.vendedorDoc ? { documento: f.vendedorDoc, nombre: f.vendedorNombre ?? undefined } : undefined;
        const tramite = await createTramite({ vin, placa: f.placa ?? undefined, tipologiaCodigo, comprador, vendedor }, userId);
        emitEvento({ tramiteId: tramite.id, tipo: 'creado', actorUserId: userId, actorRole: 'admin', payload: { vin, lote: loteId } });
        await appendEventoSafe({ vin, eventoTipo: 'tramite_creado', payload: { placa: tramite.placa, lote: loteId }, referenciaTramiteId: tramite.id });
        await db.insert(tramiteLoteFilas).values({
          loteId, fila: filaNum, vin, placa: f.placa ?? null, tipologiaCodigo, estado: 'ok',
          tramiteId: tramite.id, preflight: filaPreflightSnapshot(f) as any,
        });
        ok++;
      } catch (e: any) {
        errores++;
        await db.insert(tramiteLoteFilas).values({ loteId, fila: filaNum, vin, placa: f.placa ?? null, tipologiaCodigo, estado: 'error', errorMsg: String(e?.message ?? 'error').slice(0, 300) });
      }
    }
  }

  await db.update(tramiteLotes).set({ ok, errores, estado: 'listo' }).where(eq(tramiteLotes.id, loteId));
  log.info({ loteId, ok, errores, total: filas.length }, 'lote confirmado');
  return { loteId, total: filas.length, ok, errores };
}

// ---------------------------------------------------------------------------
// LOTE-PLUS-01 — lote asíncrono (202 + worker in-process + polling)
// ---------------------------------------------------------------------------

export interface LoteEstadoResp {
  loteId: number;
  estado: LoteEstadoValor;
  totalFilas: number;
  ok: number;
  errores: number;
  procesadas: number;
  pct: number;
}

export type IniciarLoteAsyncResult =
  | { ok: true; loteId: number; estado: LoteEstadoValor; totalFilas: number; idempotente?: boolean }
  | { ok: false; error: string };

function pendingPreflightPayload(f: FilaParseada): Record<string, unknown> {
  const p: Record<string, unknown> = { _pending: true };
  if (f.compradorDoc) p.compradorDoc = f.compradorDoc;
  if (f.compradorNombre) p.compradorNombre = f.compradorNombre;
  if (f.vendedorDoc) p.vendedorDoc = f.vendedorDoc;
  if (f.vendedorNombre) p.vendedorNombre = f.vendedorNombre;
  return p;
}

async function procesarFilaPendiente(
  fila: typeof tramiteLoteFilas.$inferSelect,
  loteId: number,
  userId: number,
  tipoDefault: string,
): Promise<void> {
  const vin = normalizeVin(fila.vin || '');
  const tipologiaCodigo = isValidTipologia(fila.tipologiaCodigo) ? fila.tipologiaCodigo! : tipoDefault;
  const pending = (fila.preflight ?? {}) as {
    compradorDoc?: string; compradorNombre?: string; vendedorDoc?: string; vendedorNombre?: string;
  };
  let preflightOverall: string | null = null;
  let laftStatus: string | null = null;
  let laftMatches: number | null = null;
  try {
    const snap = await computePreflight({
      vin, placa: fila.placa ?? undefined,
      compradorDoc: pending.compradorDoc, compradorNombre: pending.compradorNombre,
      vendedorDoc: pending.vendedorDoc, vendedorNombre: pending.vendedorNombre,
    }, userId);
    preflightOverall = snap.overall;
    if (snap.laftComprador) {
      laftStatus = snap.laftComprador.status;
      laftMatches = snap.laftComprador.matches;
    }
    const comprador = pending.compradorDoc
      ? { documento: pending.compradorDoc, nombre: pending.compradorNombre ?? undefined }
      : undefined;
    const vendedor = pending.vendedorDoc
      ? { documento: pending.vendedorDoc, nombre: pending.vendedorNombre ?? undefined }
      : undefined;
    const tramite = await createTramite({ vin, placa: fila.placa ?? undefined, tipologiaCodigo, comprador, vendedor }, userId);
    emitEvento({ tramiteId: tramite.id, tipo: 'creado', actorUserId: userId, actorRole: 'admin', payload: { vin, lote: loteId } });
    await appendEventoSafe({ vin, eventoTipo: 'tramite_creado', payload: { placa: tramite.placa, lote: loteId }, referenciaTramiteId: tramite.id });
    const snapFila = filaPreflightSnapshot({
      preflightOverall, laftStatus, laftMatches,
      compradorDoc: pending.compradorDoc ?? null,
      vendedorDoc: pending.vendedorDoc ?? null,
    });
    await db.update(tramiteLoteFilas).set({
      estado: 'ok', tramiteId: tramite.id, errorMsg: null, preflight: snapFila as any,
    }).where(eq(tramiteLoteFilas.id, fila.id));
  } catch (e: any) {
    await db.update(tramiteLoteFilas).set({
      estado: 'error', errorMsg: String(e?.message ?? 'error').slice(0, 300),
      preflight: filaPreflightSnapshot({
        preflightOverall, laftStatus, laftMatches,
        compradorDoc: pending.compradorDoc ?? null, vendedorDoc: pending.vendedorDoc ?? null,
      }) as any,
    }).where(eq(tramiteLoteFilas.id, fila.id));
  }
}

/** Worker in-process: pre-vuelo + createTramite por fila pendiente. */
export async function procesarLoteAsync(loteId: number, userId: number): Promise<void> {
  const [lote] = await db.select().from(tramiteLotes).where(eq(tramiteLotes.id, loteId)).limit(1);
  if (!lote || lote.estado !== 'procesando') return;
  try {
    const pendientes = await db.select().from(tramiteLoteFilas)
      .where(and(eq(tramiteLoteFilas.loteId, loteId), eq(tramiteLoteFilas.estado, 'pendiente')))
      .orderBy(asc(tramiteLoteFilas.fila));
    const tipoDefault = TIPOLOGIA_DEFAULT;
    for (let start = 0; start < pendientes.length; start += CHUNK) {
      const chunk = pendientes.slice(start, start + CHUNK);
      for (const fila of chunk) {
        await procesarFilaPendiente(fila, loteId, userId, tipoDefault);
      }
      await recalcLoteContadores(loteId);
    }
    await db.update(tramiteLotes).set({ estado: 'listo' }).where(eq(tramiteLotes.id, loteId));
    const { ok, errores } = await recalcLoteContadores(loteId);
    log.info({ loteId, ok, errores }, 'lote async completado');
  } catch (e: any) {
    log.error({ err: e?.message, loteId }, 'lote async job falló');
    await db.update(tramiteLotes).set({ estado: 'error' }).where(eq(tramiteLotes.id, loteId));
  }
}

function scheduleProcesarLote(loteId: number, userId: number): void {
  if (activeLoteJobs.has(loteId)) return;
  activeLoteJobs.add(loteId);
  setImmediate(() => {
    procesarLoteAsync(loteId, userId).finally(() => activeLoteJobs.delete(loteId));
  });
}

/**
 * G4 + LOTE-PLUS-01: re-parsea CSV en servidor, crea lote en `procesando` y
 * devuelve de inmediato; el worker corre en background (sin bloquear HTTP).
 */
export async function iniciarLoteAsync(csvText: string, nombre: string | undefined, userId: number): Promise<IniciarLoteAsyncResult> {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return { ok: false, error: parsed.error ?? 'CSV inválido' };
  const invalidas = parsed.filas.filter((f) => !f.valido);
  const validas = parsed.filas.filter((f) => f.valido);
  if (validas.length === 0) return { ok: false, error: 'Ninguna fila válida en el CSV' };

  const csvSha256 = computeCsvSha256(csvText);
  const existente = await buscarLoteIdempotente(csvSha256, userId);
  if (existente) {
    log.info({ loteId: existente.id, csvSha256: csvSha256.slice(0, 8) }, 'lote async idempotente (CSV duplicado)');
    return {
      ok: true,
      loteId: existente.id,
      estado: existente.estado as LoteEstadoValor,
      totalFilas: existente.totalFilas,
      idempotente: true,
    };
  }

  const [lote] = await db.insert(tramiteLotes).values({
    nombre: nombre?.slice(0, 120) || null,
    creadoPor: userId,
    totalFilas: parsed.filas.length,
    ok: 0,
    errores: invalidas.length,
    estado: 'procesando',
    csvSha256,
  }).returning({ id: tramiteLotes.id });

  for (const f of invalidas) {
    await db.insert(tramiteLoteFilas).values({
      loteId: lote.id, fila: f.fila, vin: f.vin || null, placa: f.placa, tipologiaCodigo: f.tipologiaCodigo,
      estado: 'error', errorMsg: (f.error || 'Inválida').slice(0, 300),
    });
  }
  for (const f of validas) {
    await db.insert(tramiteLoteFilas).values({
      loteId: lote.id, fila: f.fila, vin: f.vin, placa: f.placa, tipologiaCodigo: f.tipologiaCodigo,
      estado: 'pendiente', preflight: pendingPreflightPayload(f) as any,
    });
  }

  scheduleProcesarLote(lote.id, userId);
  log.info({ loteId: lote.id, totalFilas: parsed.filas.length, pendientes: validas.length }, 'lote async iniciado');
  return { ok: true, loteId: lote.id, estado: 'procesando', totalFilas: parsed.filas.length };
}

/** Estado + progreso para polling (`GET /lote/:id/estado`). */
export async function getLoteEstado(id: number): Promise<LoteEstadoResp | null> {
  const [lote] = await db.select().from(tramiteLotes).where(eq(tramiteLotes.id, id)).limit(1);
  if (!lote) return null;
  const procesadas = lote.ok + lote.errores;
  const pct = lote.totalFilas > 0 ? Math.round((procesadas / lote.totalFilas) * 100) : 0;
  return {
    loteId: lote.id,
    estado: lote.estado as LoteEstadoValor,
    totalFilas: lote.totalFilas,
    ok: lote.ok,
    errores: lote.errores,
    procesadas,
    pct,
  };
}

export interface LoteDetalle {
  lote: { id: number; nombre: string | null; totalFilas: number; ok: number; errores: number; estado: LoteEstadoValor; createdAt: string };
  filas: { fila: number; vin: string | null; placa: string | null; tipologiaCodigo: string | null; estado: string; tramiteId: number | null; preflight: unknown; errorMsg: string | null }[];
}

/** Resumen + filas de un lote. */
export async function getLote(id: number): Promise<LoteDetalle | null> {
  const [lote] = await db.select().from(tramiteLotes).where(eq(tramiteLotes.id, id)).limit(1);
  if (!lote) return null;
  const filas = await db.select().from(tramiteLoteFilas).where(eq(tramiteLoteFilas.loteId, id)).orderBy(asc(tramiteLoteFilas.fila));
  return {
    lote: { id: lote.id, nombre: lote.nombre, totalFilas: lote.totalFilas, ok: lote.ok, errores: lote.errores, estado: lote.estado as LoteEstadoValor, createdAt: (lote.createdAt as Date).toISOString() },
    filas: filas.map((f) => ({ fila: f.fila, vin: f.vin, placa: f.placa, tipologiaCodigo: f.tipologiaCodigo, estado: f.estado, tramiteId: f.tramiteId, preflight: f.preflight, errorMsg: f.errorMsg })),
  };
}

// ---------------------------------------------------------------------------
// LOTE-PLUS-03 — reproceso de errores + export de resultados
// ---------------------------------------------------------------------------

export interface ReprocesoResultado {
  loteId: number;
  reintentadas: number;   // filas en error que se intentaron de nuevo (con VIN)
  recuperadas: number;    // pasaron de error → ok
  noReintentables: number; // filas en error SIN VIN (no se pueden reprocesar)
  ok: number;             // total ok del lote tras reproceso
  errores: number;        // total error del lote tras reproceso
}

/**
 * Reintenta las filas del lote con `estado='error'` que tienen VIN. Las que pasan
 * se actualizan a `ok` con su `tramite_id`; las que vuelven a fallar conservan
 * `error` con el nuevo motivo. Las filas en error SIN VIN no son reintentables.
 * Recalcula los totales `ok/errores` del lote. Idempotente: si no hay errores
 * reintentables, no hace nada destructivo.
 */
export async function reprocesarErroresLote(loteId: number, userId: number): Promise<ReprocesoResultado | null> {
  const [lote] = await db.select({ id: tramiteLotes.id }).from(tramiteLotes).where(eq(tramiteLotes.id, loteId)).limit(1);
  if (!lote) return null;

  const errorFilas = await db.select().from(tramiteLoteFilas)
    .where(and(eq(tramiteLoteFilas.loteId, loteId), eq(tramiteLoteFilas.estado, 'error')))
    .orderBy(asc(tramiteLoteFilas.fila));

  let reintentadas = 0, recuperadas = 0, noReintentables = 0;
  for (const fila of errorFilas) {
    const vin = normalizeVin(fila.vin || '');
    if (!vin) { noReintentables++; continue; }
    reintentadas++;
    const tipologiaCodigo = isValidTipologia(fila.tipologiaCodigo) ? fila.tipologiaCodigo! : TIPOLOGIA_DEFAULT;
    try {
      const tramite = await createTramite({ vin, placa: fila.placa ?? undefined, tipologiaCodigo }, userId);
      emitEvento({ tramiteId: tramite.id, tipo: 'creado', actorUserId: userId, actorRole: 'admin', payload: { vin, lote: loteId, reproceso: true } });
      await appendEventoSafe({ vin, eventoTipo: 'tramite_creado', payload: { placa: tramite.placa, lote: loteId, reproceso: true }, referenciaTramiteId: tramite.id });
      await db.update(tramiteLoteFilas).set({ estado: 'ok', tramiteId: tramite.id, errorMsg: null }).where(eq(tramiteLoteFilas.id, fila.id));
      recuperadas++;
    } catch (e: any) {
      await db.update(tramiteLoteFilas).set({ errorMsg: String(e?.message ?? 'error').slice(0, 300) }).where(eq(tramiteLoteFilas.id, fila.id));
    }
  }

  // Recalcular totales desde la verdad (las filas), no incrementos.
  const filas = await db.select({ estado: tramiteLoteFilas.estado }).from(tramiteLoteFilas).where(eq(tramiteLoteFilas.loteId, loteId));
  const ok = filas.filter((f) => f.estado === 'ok').length;
  const errores = filas.filter((f) => f.estado === 'error').length;
  await db.update(tramiteLotes).set({ ok, errores }).where(eq(tramiteLotes.id, loteId));

  log.info({ loteId, reintentadas, recuperadas, noReintentables, ok, errores }, 'lote reprocesado');
  return { loteId, reintentadas, recuperadas, noReintentables, ok, errores };
}

/** Escapa un campo CSV (comillas + comas + saltos de línea). */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV de resultados del lote (una fila por registro). `null` si el lote no existe. */
export async function exportResultadosCsv(loteId: number): Promise<string | null> {
  const detalle = await getLote(loteId);
  if (!detalle) return null;
  const header = 'fila,vin,placa,tipologia,estado,tramite_id,comprador_doc,vendedor_doc,laft_status,error_msg';
  const rows = detalle.filas.map((f) => {
    const pf = (f.preflight ?? {}) as { compradorDocLast4?: string; vendedorDocLast4?: string; laftComprador?: { status?: string } };
    const compradorDoc = pf.compradorDocLast4 ? `…${pf.compradorDocLast4}` : '';
    const vendedorDoc = pf.vendedorDocLast4 ? `…${pf.vendedorDocLast4}` : '';
    const laftStatus = pf.laftComprador?.status ?? '';
    return [f.fila, f.vin ?? '', f.placa ?? '', f.tipologiaCodigo ?? '', f.estado, f.tramiteId ?? '', compradorDoc, vendedorDoc, laftStatus, f.errorMsg ?? ''].map(csvCell).join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// LOTE-PLUS-04 — historial de lotes (G5) + confirm desde CSV en servidor (G4)
// ---------------------------------------------------------------------------

export interface LoteResumen { id: number; nombre: string | null; totalFilas: number; ok: number; errores: number; estado: LoteEstadoValor; createdAt: string }
export interface ListaLotes { items: LoteResumen[]; total: number; page: number; limit: number }

/** Lista paginada de lotes (más recientes primero). */
export async function listLotes(opts: { page?: number; limit?: number }): Promise<ListaLotes> {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 20));
  const offset = (page - 1) * limit;
  const rows = await db.select().from(tramiteLotes).orderBy(desc(tramiteLotes.createdAt)).limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(tramiteLotes);
  return {
    items: rows.map((l) => ({ id: l.id, nombre: l.nombre, totalFilas: l.totalFilas, ok: l.ok, errores: l.errores, estado: l.estado as LoteEstadoValor, createdAt: (l.createdAt as Date).toISOString() })),
    total: count ?? 0, page, limit,
  };
}

export type ConfirmCsvResultado =
  | { ok: true; result: ConfirmResultado }
  | { ok: false; error: string };

/**
 * G4: confirma un lote re-parseando el CSV EN EL SERVIDOR (no confía en las
 * filas[] del cliente). Re-corre el pre-vuelo (A1 + LAFT) y crea los trámites
 * desde la fuente confiable. El cliente solo envía el archivo.
 */
export async function confirmarLoteDesdeCsv(csvText: string, nombre: string | undefined, userId: number): Promise<ConfirmCsvResultado> {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return { ok: false, error: parsed.error ?? 'CSV inválido' };
  const csvSha256 = computeCsvSha256(csvText);
  const dup = await buscarLoteIdempotente(csvSha256, userId);
  if (dup) {
    return { ok: true, result: { loteId: dup.id, total: dup.totalFilas, ok: dup.ok, errores: dup.errores } };
  }
  const preview = await previewLote(parsed.filas, userId);
  const filas: ConfirmFila[] = preview.filas.filter((f) => f.valido).map((f) => ({
    vin: f.vin, placa: f.placa, tipologiaCodigo: f.tipologiaCodigo, fila: f.fila,
    compradorDoc: f.compradorDoc ?? null, compradorNombre: f.compradorNombre ?? null,
    vendedorDoc: f.vendedorDoc ?? null, vendedorNombre: f.vendedorNombre ?? null,
    preflightOverall: f.preflight?.overall ?? null,
    laftStatus: f.preflight?.laftComprador?.status ?? null,
    laftMatches: f.preflight?.laftComprador?.matches ?? null,
  }));
  if (filas.length === 0) return { ok: false, error: 'Ninguna fila válida en el CSV' };
  const result = await confirmarLote({ nombre, filas, csvSha256 }, userId);
  return { ok: true, result };
}
