// EPIC TRAM-INNOV · A2 — timeline del expediente + verificación pública por QR.
//
// `emitEvento` es BEST-EFFORT: nunca lanza (un fallo de bitácora no debe tumbar
// la operación de negocio). Se invoca en creación, subida de documento, cambios
// de estado, recepción/placa en tránsito y acceso al portal externo (A3).
//
// La verificación pública (QR) expone integridad (hash + últimos eventos) SIN
// PII completa: solo tipo de evento, timestamp y hash del documento.

import { randomBytes, createHash } from 'crypto';
import { eq, and, asc, gt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramiteEventos, tramitesDigitales } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.eventos');

export type TramiteEventoTipo =
  | 'creado' | 'documento_subido' | 'cambio_paso' | 'cambio_estado'
  | 'enviado_transito' | 'recibido_transito' | 'placa_asignada'
  | 'rechazado_ot' | 'mandato_subido' | 'acceso_portal' | 'verify_token_generado'
  | 'participante_invitado' | 'consentimiento_1581' | 'notificacion_enviada'
  | 'laft_screening'
  // TRAM-COMMS-02: recordatorios de portal a participantes pendientes.
  | 'recordatorio_portal_enviado' | 'recordatorio_portal_omitido'
  // TRAM-INNOV-PRE-02: telemetría de CTA accionable del pre-vuelo.
  | 'preflight_cta_clicked'
  // TRAM-INNOV-EXP-PDF: descarga de expediente certificado.
  | 'expediente_pdf_generado'
  // TRAM-INNOV-B3: firma electrónica del contrato de compraventa.
  | 'firma_solicitada' | 'firma_completada' | 'firma_rechazada';

export interface EmitEventoInput {
  tramiteId: number;
  tipo: TramiteEventoTipo;
  actorUserId?: number | null;
  actorRole?: string | null;
  payload?: Record<string, unknown> | null;
  docHash?: string | null;
}

/** SHA-256 hex de un buffer (hash del documento al subir). */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Inserta un evento en la bitácora. Best-effort: nunca lanza. */
export async function emitEvento(input: EmitEventoInput): Promise<void> {
  try {
    await db.insert(tramiteEventos).values({
      tramiteId: input.tramiteId,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      tipo: input.tipo,
      payload: (input.payload as any) ?? null,
      docHash: input.docHash ?? null,
    });
  } catch (e: any) {
    log.warn({ err: e?.message, tramiteId: input.tramiteId, tipo: input.tipo }, 'no se pudo registrar evento');
  }
}

export interface TimelineEvento {
  id: number;
  tipo: string;
  actorRole: string | null;
  payload: unknown;
  docHash: string | null;
  createdAt: string;
}

/** Línea de tiempo completa del expediente (cronológica ascendente). */
export async function getTimeline(tramiteId: number): Promise<TimelineEvento[]> {
  const rows = await db.select().from(tramiteEventos)
    .where(eq(tramiteEventos.tramiteId, tramiteId))
    .orderBy(asc(tramiteEventos.createdAt));
  return rows.map((r) => ({
    id: r.id,
    tipo: r.tipo,
    actorRole: r.actorRole,
    payload: r.payload,
    docHash: r.docHash,
    createdAt: (r.createdAt as Date).toISOString(),
  }));
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type VerifyTokenResult =
  | { ok: true; token: string; expires: string }
  | { ok: false; code: 'not_found' };

/**
 * Genera (o regenera) el token de verificación pública del trámite, TTL 7d.
 * Revocable: una nueva generación invalida la anterior.
 */
export async function generateVerifyToken(tramiteId: number, actor: { userId: number; role?: string }): Promise<VerifyTokenResult> {
  const token = randomBytes(24).toString('base64url'); // 32 chars url-safe
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  const [row] = await db.update(tramitesDigitales)
    .set({ verifyToken: token, verifyTokenExpires: expires, updatedAt: new Date() })
    .where(eq(tramitesDigitales.id, tramiteId))
    .returning({ id: tramitesDigitales.id });
  if (!row) return { ok: false, code: 'not_found' };
  await emitEvento({ tramiteId, tipo: 'verify_token_generado', actorUserId: actor.userId, actorRole: actor.role ?? null });
  return { ok: true, token, expires: expires.toISOString() };
}

export interface PublicVerification {
  valido: boolean;
  estado: string;
  placa: string | null;
  vinMasked: string | null;
  tipologia: string | null;
  eventos: { tipo: string; docHash: string | null; createdAt: string }[];
  emitido: string;
}

/** Enmascara un VIN dejando solo los últimos 4 caracteres. */
function maskVin(vin: string | null): string | null {
  if (!vin) return null;
  if (vin.length <= 4) return vin;
  return `${'•'.repeat(vin.length - 4)}${vin.slice(-4)}`;
}

/**
 * Verificación pública por token: integridad del expediente sin PII completa.
 * Devuelve null para token inválido/expirado (404 idéntico → no enumera IDs).
 */
export async function verifyByToken(token: string): Promise<PublicVerification | null> {
  if (!VERIFY_TOKEN_RE.test(token)) return null;
  const [t] = await db.select({
    id: tramitesDigitales.id,
    estado: tramitesDigitales.estado,
    placa: tramitesDigitales.placa,
    vin: tramitesDigitales.vin,
    tipologia: tramitesDigitales.tipologiaCodigo,
    expires: tramitesDigitales.verifyTokenExpires,
  }).from(tramitesDigitales)
    .where(and(eq(tramitesDigitales.verifyToken, token), gt(tramitesDigitales.verifyTokenExpires, sql`now()`)))
    .limit(1);
  if (!t) return null;

  // Últimos 3 eventos (sin PII): tipo + hash + timestamp.
  const eventos = await db.select({ tipo: tramiteEventos.tipo, docHash: tramiteEventos.docHash, createdAt: tramiteEventos.createdAt })
    .from(tramiteEventos)
    .where(eq(tramiteEventos.tramiteId, t.id))
    .orderBy(sql`${tramiteEventos.createdAt} DESC`)
    .limit(3);

  return {
    valido: true,
    estado: t.estado,
    placa: t.placa,
    vinMasked: maskVin(t.vin),
    tipologia: t.tipologia ?? null,
    eventos: eventos.map((e) => ({ tipo: e.tipo, docHash: e.docHash, createdAt: (e.createdAt as Date).toISOString() })).reverse(),
    emitido: (t.expires as Date)?.toISOString() ?? new Date().toISOString(),
  };
}
