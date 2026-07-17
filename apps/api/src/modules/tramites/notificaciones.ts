// EPIC TRAM-INNOV · A4 — notificaciones de estado del trámite (WhatsApp + email).
//
// Solo a participantes con opt-in (whatsapp_opt_in, A3). Degradación elegante:
// si no hay proveedor configurado, `notifyEstado` no-opera SIN tocar BD (clave
// para no consumir mocks en tests ni golpear red en prod sin config). El cuerpo
// no lleva PII sensible: incluye un enlace de estado (verificación pública A2).

import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramiteParticipantes, tramitesDigitales } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { sendEmail, isSmtpConfigured } from '../../services/email.js';
import { generateVerifyToken } from './eventos.js';
import { emitEvento } from './eventos.js';
import { tramNotifSentTotal } from '../../shared/metrics.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.notif');

export type NotifTipo = 'tramite_creado' | 'preflight_amarillo' | 'enviado_transito' | 'placa_asignada' | 'rechazado_ot';

export function whatsappEnabled(): boolean {
  return Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
}
export function notifConfig() {
  return { whatsapp: whatsappEnabled(), email: isSmtpConfigured() };
}
export function anyChannelEnabled(): boolean {
  return whatsappEnabled() || isSmtpConfigured();
}

const PLANTILLAS: Record<NotifTipo, (placa: string) => { titulo: string; cuerpo: string }> = {
  tramite_creado: (p) => ({ titulo: 'Trámite iniciado', cuerpo: `Iniciamos el trámite del vehículo ${p}. Te avisaremos cada avance.` }),
  preflight_amarillo: (p) => ({ titulo: 'Revisa los requisitos', cuerpo: `El pre-vuelo del vehículo ${p} tiene observaciones. Revisa el estado en el enlace.` }),
  enviado_transito: (p) => ({ titulo: 'Enviado a tránsito', cuerpo: `El trámite del vehículo ${p} fue enviado al organismo de tránsito.` }),
  placa_asignada: (p) => ({ titulo: 'Placa asignada', cuerpo: `¡El vehículo ${p} tiene placa asignada por el organismo de tránsito!` }),
  rechazado_ot: (p) => ({ titulo: 'Trámite con novedad', cuerpo: `El trámite del vehículo ${p} requiere correcciones. Revisa el estado en el enlace.` }),
};

/** Renderiza la plantilla de un tipo de notificación (pura, testeable). */
export function renderPlantilla(tipo: NotifTipo, placa: string) {
  return PLANTILLAS[tipo](placa);
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean }>;

/**
 * Envía un texto por WhatsApp Cloud API. PURA respecto a credenciales/transport
 * (inyectables) → testeable sin tocar env ni red real. No lanza.
 */
export async function sendWhatsAppVia(token: string, phoneId: string, to: string, body: string, fetchImpl: FetchLike = fetch as any): Promise<boolean> {
  try {
    const r = await fetchImpl(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    return r.ok;
  } catch (e: any) {
    log.warn({ err: e?.message }, 'fallo envío WhatsApp');
    return false;
  }
}

/** Envía una plantilla por WhatsApp con las credenciales de entorno. No lanza. */
async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  if (!whatsappEnabled()) return false;
  return sendWhatsAppVia(env.WHATSAPP_TOKEN!, env.WHATSAPP_PHONE_ID!, to, body);
}

/** Enlace de estado (página pública de verificación A2). Genera token si falta. */
async function statusLink(tramiteId: number): Promise<string | null> {
  const [t] = await db.select({ token: tramitesDigitales.verifyToken, expires: tramitesDigitales.verifyTokenExpires })
    .from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  let token = t?.token && t.expires && (t.expires as Date).getTime() > Date.now() ? t.token : null;
  if (!token) {
    const gen = await generateVerifyToken(tramiteId, { userId: 0 });
    if (gen.ok) token = gen.token;
  }
  return token ? `${env.PUBLIC_URL}/tramite/verificar?t=${token}` : null;
}

export interface NotifyResult { enviados: number; canal: 'whatsapp' | 'email' | 'ninguno'; degradado: boolean }

/**
 * Notifica a los participantes con opt-in el cambio de estado del trámite.
 * Best-effort: nunca lanza. No-op (sin tocar BD) si no hay proveedor configurado.
 */
export async function notifyEstado(tramiteId: number, tipo: NotifTipo): Promise<NotifyResult> {
  if (!anyChannelEnabled()) return { enviados: 0, canal: 'ninguno', degradado: true };
  try {
    const participantes = await db.select().from(tramiteParticipantes)
      .where(and(eq(tramiteParticipantes.tramiteId, tramiteId), eq(tramiteParticipantes.whatsappOptIn, true)));
    if (participantes.length === 0) return { enviados: 0, canal: 'ninguno', degradado: false };

    const [t] = await db.select({ placa: tramitesDigitales.placa, vin: tramitesDigitales.vin }).from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
    const placa = t?.placa || t?.vin?.slice(-6) || 'tu vehículo';
    const tpl = PLANTILLAS[tipo](placa);
    const link = await statusLink(tramiteId);
    const cuerpo = link ? `${tpl.cuerpo}\nEstado: ${link}` : tpl.cuerpo;

    let enviados = 0;
    let canal: NotifyResult['canal'] = 'ninguno';
    for (const p of participantes) {
      let ok = false;
      if (whatsappEnabled() && p.telefono) { ok = await sendWhatsApp(p.telefono, cuerpo); if (ok) canal = 'whatsapp'; }
      if (!ok && isSmtpConfigured() && p.email) {
        const r = await sendEmail({ to: p.email, subject: `FLIT · ${tpl.titulo}`, html: `<p>${tpl.cuerpo}</p>${link ? `<p><a href="${link}">Ver estado del trámite</a></p>` : ''}` });
        ok = r.ok; if (ok) canal = 'email';
      }
      if (ok) {
        enviados++;
        tramNotifSentTotal.inc({ tipo, canal });
        emitEvento({ tramiteId, tipo: 'notificacion_enviada', actorRole: p.rol, payload: { notif: tipo, canal, rol: p.rol } });
      }
    }
    return { enviados, canal, degradado: false };
  } catch (e: any) {
    log.warn({ err: e?.message, tramiteId, tipo }, 'fallo notifyEstado');
    return { enviados: 0, canal: 'ninguno', degradado: false };
  }
}
