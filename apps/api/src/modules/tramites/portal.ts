// EPIC TRAM-INNOV · A3 — portal de comprador/vendedor por magic link.
//
// Participantes externos (sin cuenta FLIT) completan pasos vía enlace. Seguridad
// (epic §3): token por rol, TTL ≤ 24h, revocable, lookup por SHA-256 (el token
// crudo solo viaja en el enlace), 404 genérico para inválido (no enumera IDs),
// rate-limit en las rutas públicas. Consentimiento Ley 1581 registrado con
// versión fechada + IP/UA reducidos como prueba de autorización (art. 9).

import { randomBytes, createHash } from 'crypto';
import type { Request } from 'express';
import { eq, and, gt, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramiteParticipantes, tramitesDigitales, tramiteFirmas } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { emitEvento } from './eventos.js';
import { completarFirma } from '../firma/firma.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.portal');

// TRAM-INNOV-B3: el consentimiento ahora cubre la firma electrónica del contrato.
// Texto DRAFT — hector revisa async (contrato ZapSign + cláusula firma).
export const CONSENT_VERSION = '2026-06-07-firma';
export const CONSENT_TEXT =
  'Autorizo a FLIT (Kyverum) y al organismo de tránsito a tratar mis datos personales ' +
  '(identificación, contacto y documentos cargados) con la finalidad de preparar y radicar ' +
  'el trámite vehicular, conforme a la Ley 1581 de 2012 y la política de tratamiento de datos. ' +
  'Cuando el trámite requiera firma electrónica del contrato de compraventa, autorizo el uso ' +
  'de firma electrónica (Ley 527 de 1999) a través del proveedor habilitado por FLIT, con plena ' +
  'validez y equivalencia funcional. Conozco mi derecho a conocer, actualizar, rectificar y suprimir mis datos.';

const FIRMA_ESTADOS_PENDIENTES = ['pendiente_envio', 'enviada'];

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const PORTAL_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const VALID_ROLES = ['comprador', 'vendedor', 'mandatario'] as const;
export type ParticipanteRol = typeof VALID_ROLES[number];

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

function reducedUa(req: Request): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 120);
}
function clientIp(req: Request): string | null {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xff || req.ip || null;
}

export interface InvitarItem { rol: ParticipanteRol; nombre?: string; email?: string; telefono?: string; whatsappOptIn?: boolean }
export interface InvitacionLink { rol: ParticipanteRol; email: string | null; url: string; expires: string }

/** Crea invitaciones (una por rol) y devuelve los enlaces. */
export async function crearInvitaciones(tramiteId: number, items: InvitarItem[], actor: { userId: number; role?: string }): Promise<InvitacionLink[] | null> {
  const [t] = await db.select({ id: tramitesDigitales.id }).from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  if (!t) return null;

  const links: InvitacionLink[] = [];
  for (const it of items) {
    if (!VALID_ROLES.includes(it.rol)) continue;
    const raw = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + TOKEN_TTL_MS);
    await db.insert(tramiteParticipantes).values({
      tramiteId, rol: it.rol, nombre: it.nombre ?? null, email: it.email ?? null, telefono: it.telefono ?? null,
      tokenHash: hash(raw), whatsappOptIn: !!it.whatsappOptIn, expiresAt: expires, createdBy: actor.userId,
    });
    await emitEvento({ tramiteId, tipo: 'participante_invitado', actorUserId: actor.userId, actorRole: actor.role ?? null, payload: { rol: it.rol, canal: it.email ? 'email' : it.telefono ? 'whatsapp' : 'link' } });
    links.push({ rol: it.rol, email: it.email ?? null, url: `${env.PUBLIC_URL}/tramite/portal/${raw}`, expires: expires.toISOString() });
  }
  return links;
}

type ParticipanteRow = typeof tramiteParticipantes.$inferSelect;

/** Resuelve un participante por token crudo (válido = no completado y no expirado). */
async function resolveParticipante(rawToken: string): Promise<ParticipanteRow | null> {
  if (!PORTAL_TOKEN_RE.test(rawToken)) return null;
  const [p] = await db.select().from(tramiteParticipantes)
    .where(and(eq(tramiteParticipantes.tokenHash, hash(rawToken)), isNull(tramiteParticipantes.completedAt), gt(tramiteParticipantes.expiresAt, sql`now()`)))
    .limit(1);
  return p ?? null;
}

export interface PortalView {
  rol: string;
  consentDado: boolean;
  consentVersion: string;
  consentText: string;
  tramite: { estado: string; placa: string | null; vehiculo: { marca?: string; linea?: string } | null };
  pasosPendientes: string[];
}

/** Vista mínima del portal para el participante (sin PII de terceros). */
export async function getPortalView(rawToken: string, req: Request): Promise<PortalView | null> {
  const p = await resolveParticipante(rawToken);
  if (!p) return null;
  const [t] = await db.select({ estado: tramitesDigitales.estado, placa: tramitesDigitales.placa, vehiculo: tramitesDigitales.vehiculo }).from(tramitesDigitales).where(eq(tramitesDigitales.id, p.tramiteId)).limit(1);
  if (!t) return null;

  // Evento de acceso con IP/UA reducidos (best-effort).
  emitEvento({ tramiteId: p.tramiteId, tipo: 'acceso_portal', actorRole: p.rol, payload: { rol: p.rol, ip: clientIp(req), ua: reducedUa(req) } });

  const consentDado = !!p.consent1581At;
  const v = (t.vehiculo || {}) as any;
  const pasosPendientes = consentDado
    ? ['Cargar documentos requeridos']
    : ['Aceptar tratamiento de datos (Ley 1581)', 'Cargar documentos requeridos'];

  return {
    rol: p.rol,
    consentDado,
    consentVersion: CONSENT_VERSION,
    consentText: CONSENT_TEXT,
    tramite: { estado: t.estado, placa: t.placa, vehiculo: { marca: v.marca, linea: v.linea } },
    pasosPendientes,
  };
}

export type PortalActionResult = { ok: true } | { ok: false; code: 'invalid_token' | 'sin_consentimiento' };

/** Registra el consentimiento Ley 1581 del participante. */
export async function aceptarDeclaracion(rawToken: string, req: Request): Promise<PortalActionResult> {
  const p = await resolveParticipante(rawToken);
  if (!p) return { ok: false, code: 'invalid_token' };
  await db.update(tramiteParticipantes).set({
    consent1581At: new Date(), consentVersion: CONSENT_VERSION, consentIp: clientIp(req), consentUserAgent: reducedUa(req),
  }).where(eq(tramiteParticipantes.id, p.id));
  await emitEvento({ tramiteId: p.tramiteId, tipo: 'consentimiento_1581', actorRole: p.rol, payload: { rol: p.rol, version: CONSENT_VERSION, ip: clientIp(req) } });
  log.info({ tramiteId: p.tramiteId, rol: p.rol, version: CONSENT_VERSION }, 'consentimiento 1581 registrado');
  return { ok: true };
}

export interface PortalParticipanteCtx { tramiteId: number; rol: string; consentDado: boolean }

/** Valida el token para una subida de documento; exige consentimiento previo. */
export async function authorizeUpload(rawToken: string): Promise<{ ok: true; ctx: PortalParticipanteCtx } | { ok: false; code: 'invalid_token' | 'sin_consentimiento' }> {
  const p = await resolveParticipante(rawToken);
  if (!p) return { ok: false, code: 'invalid_token' };
  if (!p.consent1581At) return { ok: false, code: 'sin_consentimiento' };
  return { ok: true, ctx: { tramiteId: p.tramiteId, rol: p.rol, consentDado: true } };
}

// TRAM-INNOV-B3 — firma desde el portal del participante (token-based, sin auth).
const ROLES_FIRMA = new Set(['comprador', 'vendedor']);

async function firmaPendienteDeParticipante(rawToken: string) {
  const p = await resolveParticipante(rawToken);
  if (!p || !ROLES_FIRMA.has(p.rol)) return null;
  const [f] = await db.select().from(tramiteFirmas)
    .where(and(
      eq(tramiteFirmas.tramiteId, p.tramiteId),
      eq(tramiteFirmas.rol, p.rol),
      inArray(tramiteFirmas.estado, FIRMA_ESTADOS_PENDIENTES),
    )).limit(1);
  return f ? { participante: p, firma: f } : { participante: p, firma: null };
}

/** URL de firma para el rol del token. 404 si no hay firma pendiente. */
export async function getFirmaPortalUrl(rawToken: string): Promise<
  { ok: true; url: string | null; proveedor: string; estado: string } | { ok: false }
> {
  const r = await firmaPendienteDeParticipante(rawToken);
  if (!r || !r.firma) return { ok: false };
  const meta = (r.firma.metadata ?? {}) as { signUrl?: string };
  return { ok: true, url: meta.signUrl ?? null, proveedor: r.firma.proveedor, estado: r.firma.estado };
}

/** Mock-only: completa la firma del participante (solo proveedor `mock`). */
export async function simularFirmaPortal(rawToken: string): Promise<
  { ok: true } | { ok: false; code: 'invalid_token' | 'sin_firma' | 'no_mock' }
> {
  const r = await firmaPendienteDeParticipante(rawToken);
  if (!r) return { ok: false, code: 'invalid_token' };
  if (!r.firma) return { ok: false, code: 'sin_firma' };
  if (r.firma.proveedor !== 'mock' || !r.firma.envelopeId) return { ok: false, code: 'no_mock' };
  await completarFirma({ envelopeId: r.firma.envelopeId, resultado: 'firmada' });
  return { ok: true };
}

/**
 * TRAM-COMMS-02 — Rota el token de un participante NO completado: genera un nuevo
 * raw + hash + expiración, invalidando el enlace anterior (el token solo vive como
 * hash). Devuelve el nuevo magic link y su expiración, o null si el participante no
 * existe o ya completó. Reutilizable por el cron de recordatorios y un re-invite manual.
 */
export async function rotarTokenParticipante(participanteId: number): Promise<{ url: string; expires: string } | null> {
  const raw = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  const [u] = await db.update(tramiteParticipantes)
    .set({ tokenHash: hash(raw), expiresAt: expires })
    .where(and(eq(tramiteParticipantes.id, participanteId), isNull(tramiteParticipantes.completedAt)))
    .returning({ id: tramiteParticipantes.id });
  if (!u) return null;
  return { url: `${env.PUBLIC_URL}/tramite/portal/${raw}`, expires: expires.toISOString() };
}

export interface ParticipantePendiente {
  id: number;
  rol: string;
  /** Disponibilidad de canal (sin exponer el dato completo de terceros). */
  tieneEmail: boolean;
  whatsappOptIn: boolean;
  tieneTelefono: boolean;
  expiresAt: string;
  vencido: boolean;
  lastReminderAt: string | null;
  createdAt: string;
}

/** Lista los participantes NO completados de un trámite, con su último recordatorio. */
export async function listarParticipantesPendientes(tramiteId: number): Promise<ParticipantePendiente[]> {
  const rows = await db.select({
    id: tramiteParticipantes.id, rol: tramiteParticipantes.rol,
    email: tramiteParticipantes.email, telefono: tramiteParticipantes.telefono,
    whatsappOptIn: tramiteParticipantes.whatsappOptIn,
    expiresAt: tramiteParticipantes.expiresAt, lastReminderAt: tramiteParticipantes.lastReminderAt,
    createdAt: tramiteParticipantes.createdAt,
  }).from(tramiteParticipantes)
    .where(and(eq(tramiteParticipantes.tramiteId, tramiteId), isNull(tramiteParticipantes.completedAt)))
    .orderBy(tramiteParticipantes.createdAt);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    rol: r.rol,
    tieneEmail: !!r.email,
    whatsappOptIn: !!r.whatsappOptIn,
    tieneTelefono: !!r.telefono,
    expiresAt: (r.expiresAt as Date).toISOString(),
    vencido: (r.expiresAt as Date).getTime() < now,
    lastReminderAt: r.lastReminderAt ? (r.lastReminderAt as Date).toISOString() : null,
    createdAt: (r.createdAt as Date).toISOString(),
  }));
}

/** Revoca el token (un solo uso completado). */
export async function finalizarParticipacion(rawToken: string): Promise<PortalActionResult> {
  const p = await resolveParticipante(rawToken);
  if (!p) return { ok: false, code: 'invalid_token' };
  await db.update(tramiteParticipantes).set({ completedAt: new Date() }).where(eq(tramiteParticipantes.id, p.id));
  return { ok: true };
}
