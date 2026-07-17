// EPIC TRAM-INNOV · B1 — Pasaporte vehicular: historial encadenado por VIN.
//
// Cadena de hashes append-only en Postgres (epic §9: sin blockchain on-chain).
// `appendEvento` calcula `hash_self` = SHA-256(hash_prev | vin | tipo | ref |
// payload-canónico | created_at). El primer eslabón usa GENESIS (64 ceros).
// `appendEventoSafe` es best-effort (hooks): nunca lanza. La verificación
// recomputa la cadena y reporta integridad.

import { createHash } from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { and, eq, asc, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehiculoHistorial, tramitesDigitales, vehicles, soatRequests } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('vehiculo.historial');

export const GENESIS_HASH = '0'.repeat(64);

export type VehiculoEventoTipo =
  | 'tramite_creado' | 'tramite_enviado_transito' | 'tramite_placa_asignada'
  | 'documento_registrado' | 'soat_vigente' | 'pesv_incidente' | 'transferencia_registrada'
  | 'vehiculo_registrado';

const ESTADOS_ENVIADO_TRANSITO = new Set([
  'enviado_transito', 'recibido_transito', 'placa_preasignada', 'solicitud_soat',
  'soat_comprado', 'soat_verificado', 'completado',
]);
const ESTADOS_PLACA = new Set([
  'placa_preasignada', 'solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado',
]);

export function normalizeVin(vin: string): string {
  return (vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 17);
}

/** JSON con claves ordenadas recursivamente → hash determinístico. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

/** Hash de un eslabón (puro): mismo cálculo en append y en verificación. */
export function computeHash(input: { hashPrev: string; vin: string; eventoTipo: string; referenciaTramiteId?: number | null; payload?: unknown; createdAtIso: string }): string {
  const material = [
    input.hashPrev,
    input.vin,
    input.eventoTipo,
    input.referenciaTramiteId ?? '',
    stableStringify(input.payload ?? {}),
    input.createdAtIso,
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
}

export interface AppendEventoInput {
  vin: string;
  eventoTipo: VehiculoEventoTipo;
  payload?: Record<string, unknown> | null;
  referenciaTramiteId?: number | null;
}

export interface HistorialRow {
  id: number; vin: string; eventoTipo: string; referenciaTramiteId: number | null;
  payload: unknown; hashPrev: string; hashSelf: string; createdAt: string;
}

/** Agrega un eslabón a la cadena del VIN. Lanza si la BD falla (usar Safe en hooks). */
export async function appendEvento(input: AppendEventoInput): Promise<HistorialRow | null> {
  const vin = normalizeVin(input.vin);
  if (!vin) return null;

  const [last] = await db.select({ hashSelf: vehiculoHistorial.hashSelf })
    .from(vehiculoHistorial).where(eq(vehiculoHistorial.vin, vin))
    .orderBy(desc(vehiculoHistorial.id)).limit(1);
  const hashPrev = last?.hashSelf ?? GENESIS_HASH;

  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const hashSelf = computeHash({ hashPrev, vin, eventoTipo: input.eventoTipo, referenciaTramiteId: input.referenciaTramiteId ?? null, payload: input.payload ?? {}, createdAtIso });

  const [row] = await db.insert(vehiculoHistorial).values({
    vin, eventoTipo: input.eventoTipo, referenciaTramiteId: input.referenciaTramiteId ?? null,
    payload: (input.payload as any) ?? null, hashPrev, hashSelf, createdAt,
  }).returning();
  return row ? mapRow(row) : null;
}

/** Variante best-effort para hooks: nunca lanza. */
export async function appendEventoSafe(input: AppendEventoInput): Promise<void> {
  try { await appendEvento(input); }
  catch (e: any) { log.warn({ err: e?.message, vin: input.vin, tipo: input.eventoTipo }, 'no se pudo registrar evento de pasaporte'); }
}

function mapRow(r: typeof vehiculoHistorial.$inferSelect): HistorialRow {
  return {
    id: r.id, vin: r.vin, eventoTipo: r.eventoTipo, referenciaTramiteId: r.referenciaTramiteId,
    payload: r.payload, hashPrev: r.hashPrev, hashSelf: r.hashSelf,
    createdAt: (r.createdAt as Date).toISOString(),
  };
}

export interface IntegridadResultado { valido: boolean; rotoEnId: number | null }

export interface HistorialResultado {
  vin: string;
  eventos: HistorialRow[];
  integridad: IntegridadResultado;
  ultimoHash: string | null;
  desde: string | null;
  hasta: string | null;
}

/** Verifica la cadena: cada hash_prev enlaza y cada hash_self recomputa. */
export function verificarCadena(eventos: HistorialRow[]): IntegridadResultado {
  let prev = GENESIS_HASH;
  for (const e of eventos) {
    const recomputado = computeHash({ hashPrev: e.hashPrev, vin: e.vin, eventoTipo: e.eventoTipo, referenciaTramiteId: e.referenciaTramiteId, payload: e.payload, createdAtIso: e.createdAt });
    if (e.hashPrev !== prev || recomputado !== e.hashSelf) return { valido: false, rotoEnId: e.id };
    prev = e.hashSelf;
  }
  return { valido: true, rotoEnId: null };
}

async function yaExisteEvento(vin: string, eventoTipo: string, referenciaTramiteId?: number | null): Promise<boolean> {
  const conds = [eq(vehiculoHistorial.vin, vin), eq(vehiculoHistorial.eventoTipo, eventoTipo)];
  if (referenciaTramiteId != null) conds.push(eq(vehiculoHistorial.referenciaTramiteId, referenciaTramiteId));
  const [row] = await db.select({ id: vehiculoHistorial.id }).from(vehiculoHistorial).where(and(...conds)).limit(1);
  return Boolean(row);
}

/**
 * Rellena el pasaporte desde trámites/SOAT/vehículo ya existentes (pre-B1).
 * Idempotente: no duplica por (vin, tipo, referencia_tramite_id).
 */
export async function hydratePasaporteFromLegacy(vin: string): Promise<number> {
  const v = normalizeVin(vin);
  if (!v) return 0;
  let added = 0;

  const vinNormSql = sql`upper(regexp_replace(${tramitesDigitales.vin}, '[^A-Z0-9]', '', 'g'))`;
  const tramRows = await db.select().from(tramitesDigitales).where(sql`${vinNormSql} = ${v}`).orderBy(asc(tramitesDigitales.createdAt));

  for (const t of tramRows) {
    if (!(await yaExisteEvento(v, 'tramite_creado', t.id))) {
      if (await appendEvento({ vin: v, eventoTipo: 'tramite_creado', payload: { placa: t.placa, estado: t.estado, backfill: true }, referenciaTramiteId: t.id })) added++;
    }
    if (ESTADOS_ENVIADO_TRANSITO.has(t.estado) && !(await yaExisteEvento(v, 'tramite_enviado_transito', t.id))) {
      if (await appendEvento({ vin: v, eventoTipo: 'tramite_enviado_transito', payload: { placa: t.placa, estado: t.estado, backfill: true }, referenciaTramiteId: t.id })) added++;
    }
    if ((t.placaAsignadaAt || ESTADOS_PLACA.has(t.estado)) && !(await yaExisteEvento(v, 'tramite_placa_asignada', t.id))) {
      if (await appendEvento({ vin: v, eventoTipo: 'tramite_placa_asignada', payload: { placa: t.placa, backfill: true }, referenciaTramiteId: t.id })) added++;
    }
  }

  const vehVinSql = sql`upper(regexp_replace(${vehicles.vin}, '[^A-Z0-9]', '', 'g'))`;
  const [veh] = await db.select().from(vehicles).where(sql`${vehVinSql} = ${v}`).limit(1);
  if (veh) {
    if (!(await yaExisteEvento(v, 'vehiculo_registrado', null))) {
      if (await appendEvento({
        vin: v, eventoTipo: 'vehiculo_registrado',
        payload: { vehicleId: veh.id, placa: veh.plate, backfill: true },
      })) added++;
    }
    const soats = await db.select().from(soatRequests)
      .where(eq(soatRequests.vehicleId, veh.id))
      .orderBy(asc(soatRequests.id));
    for (const s of soats) {
      const refKey = s.id;
      const tienePoliza = Boolean(s.policyNumber && (s.status === 'verificado' || s.status === 'comprado'));
      if (!tienePoliza) continue;
      const dup = await db.select({ id: vehiculoHistorial.id }).from(vehiculoHistorial)
        .where(and(
          eq(vehiculoHistorial.vin, v),
          eq(vehiculoHistorial.eventoTipo, 'soat_vigente'),
          sql`${vehiculoHistorial.payload}->>'referenciaSoatId' = ${String(refKey)}`,
        )).limit(1);
      if (dup.length) continue;
      if (await appendEvento({
        vin: v, eventoTipo: 'soat_vigente',
        payload: { referenciaSoatId: s.id, policyNumber: s.policyNumber, insurer: s.insurer, expiryDate: s.expiryDate, backfill: true },
        referenciaTramiteId: s.tramiteId ?? null,
      })) added++;
    }
  }

  return added;
}

/** Historial cronológico de un VIN + verificación de integridad. */
export async function getHistorial(vin: string, opts?: { hydrate?: boolean }): Promise<HistorialResultado> {
  const v = normalizeVin(vin);
  if (opts?.hydrate !== false) {
    const pre = await db.select({ id: vehiculoHistorial.id }).from(vehiculoHistorial).where(eq(vehiculoHistorial.vin, v)).limit(1);
    if (!pre.length) await hydratePasaporteFromLegacy(v);
  }
  const rows = await db.select().from(vehiculoHistorial)
    .where(eq(vehiculoHistorial.vin, v))
    .orderBy(asc(vehiculoHistorial.id));
  const eventos = rows.map(mapRow);
  return {
    vin: v,
    eventos,
    integridad: verificarCadena(eventos),
    ultimoHash: eventos.length ? eventos[eventos.length - 1].hashSelf : null,
    desde: eventos.length ? eventos[0].createdAt : null,
    hasta: eventos.length ? eventos[eventos.length - 1].createdAt : null,
  };
}

const EVENTO_LABEL: Record<string, string> = {
  tramite_creado: 'Tramite iniciado',
  tramite_enviado_transito: 'Enviado a transito',
  tramite_placa_asignada: 'Placa asignada',
  documento_registrado: 'Documento registrado',
  soat_vigente: 'SOAT vigente',
  pesv_incidente: 'Incidente PESV',
  transferencia_registrada: 'Transferencia registrada',
  vehiculo_registrado: 'Vehículo registrado en FLIT',
};

/**
 * Certificado FLIT del pasaporte (PDF). Ley 1581: sin cedulas completas — solo
 * VIN, rango de fechas, hash del ultimo evento y la cadena de eventos (tipo +
 * fecha + hash). Cualquiera puede recomputar el hash y verificar integridad.
 */
export async function generarCertificadoPdf(resultado: HistorialResultado): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.18, 0.29, 0.55);
  const muted = rgb(0.49, 0.53, 0.60);
  const ink = rgb(0.09, 0.15, 0.27);
  let y = 800;

  const text = (s: string, x: number, size: number, f = font, color = ink) => { page.drawText(s, { x, y, size, font: f, color }); };

  text('FLIT - Pasaporte vehicular', 40, 20, bold, blue); y -= 14;
  text('Certificado de historial verificable (Res. 20233040017145)', 40, 9, font, muted); y -= 26;

  text(`VIN: ${resultado.vin}`, 40, 12, bold); y -= 16;
  text(`Eventos: ${resultado.eventos.length}`, 40, 10); y -= 14;
  text(`Periodo: ${resultado.desde ? resultado.desde.slice(0, 10) : '-'} a ${resultado.hasta ? resultado.hasta.slice(0, 10) : '-'}`, 40, 10); y -= 14;
  text(`Integridad de la cadena: ${resultado.integridad.valido ? 'VALIDA' : 'ROTA'}`, 40, 10, bold, resultado.integridad.valido ? rgb(0.27, 0.74, 0.13) : rgb(0.89, 0.24, 0.19)); y -= 14;
  text(`Hash ultimo evento: ${resultado.ultimoHash ?? '(sin eventos)'}`, 40, 7, font, muted); y -= 22;

  text('Cadena de eventos', 40, 12, bold, blue); y -= 16;
  for (const e of resultado.eventos) {
    if (y < 60) { page = pdf.addPage([595.28, 841.89]); y = 800; }
    text(`${e.createdAt.slice(0, 16).replace('T', ' ')}  -  ${EVENTO_LABEL[e.eventoTipo] || e.eventoTipo}`, 40, 9, bold); y -= 12;
    text(`hash: ${e.hashSelf}`, 48, 6.5, font, muted); y -= 14;
  }

  y -= 10;
  if (y < 60) { page = pdf.addPage([595.28, 841.89]); y = 800; }
  text(`Emitido: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`, 40, 7, font, muted); y -= 10;
  text('FLIT prepara y orquesta el tramite. La inscripcion oficial se realiza ante el organismo de transito / RUNT.', 40, 7, font, muted);

  return Buffer.from(await pdf.save());
}
