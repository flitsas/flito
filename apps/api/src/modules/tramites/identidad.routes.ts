import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { maskName } from '../../shared/utils/pii.js';
import nodemailer from 'nodemailer';
import { uploadPhoto, getPhoto, ensureBucket } from '../../services/storage.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramitesValidaciones } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { env } from '../../config/env.js';
import rateLimit from 'express-rate-limit';
import { loggerFor } from '../../shared/logger.js';
import { anthropicMessages } from './anthropic.js';
import { extractAnthropicText, parseBiometricJson } from './biometric-json.js';
import { recoverStaleByToken } from './validacion-recovery.js';
import {
  extractPartesTraspasoFromTramite,
  mensajePartesTraspasoDuplicadas,
  parteTraspasoRequiereReenvio,
  partesTraspasoDuplicadas,
  resolverValidacionTraspasoParte,
} from '@operaciones/shared-types';

const log = loggerFor('tramites-identidad');

const router = Router();

// #13: SSE — conexiones activas de admins esperando notificaciones de validación
const sseClients = new Set<any>();

// VUL-03: Cifrado AES-256-GCM para datos biométricos
function encryptPII(plaintext: string): string {
  const key = crypto.scryptSync(env.PII_ENC_KEY, 'kyverum-pii-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('base64');
}

function decryptPII(ciphertext: string): string {
  try {
    const [ivHex, tagHex, data] = ciphertext.split(':');
    if (!ivHex || !tagHex || !data) return ciphertext; // legacy sin cifrar
    const key = crypto.scryptSync(env.PII_ENC_KEY, 'kyverum-pii-salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(data, 'base64', 'utf8') + decipher.final('utf8');
  } catch { return ciphertext; } // fallback para datos legacy
}

function genToken(): string { return crypto.randomBytes(32).toString('hex'); }

// TRAM-F3 — Firma electrónica avanzada (Ley 527/1999) generada al aprobar la
// biométrica. Espejo de CEA: documento canónico → SHA-256 → serie KYV-FEA-...
// El sello (serie+hash) viaja luego al contrato/FUR (proxy CEA con override).
function generarSelloFirma(input: { tramiteId: number; parte: string | null; nombre: string; tipoDoc: string; documento: string; email: string; placa: string; vehiculo: string; score: number; bio: any }) {
  try {
    const ts = new Date().toISOString();
    const canonico = JSON.stringify({
      tipoDocumento: 'FIRMA_ELECTRONICA_AVANZADA_TRASPASO_VEHICULO',
      ley: 'Ley 527 de 1999 / Decreto 2364 de 2012',
      tramiteId: input.tramiteId,
      rolFirmante: (input.parte || '').toUpperCase(),
      firmante: { nombre: input.nombre, tipoDocumento: input.tipoDoc, numeroDocumento: input.documento, email: input.email },
      objeto: { placa: input.placa, vehiculo: input.vehiculo },
      identidadBiometrica: { scoreFacial: input.score, documentoOficial: input.bio?.documento_ocr?.es_documento_oficial === true, livenessOk: input.bio?.liveness?.es_persona_real === true },
      firmadoEn: ts,
    });
    const hash = crypto.createHash('sha256').update(canonico).digest('hex');
    const serie = 'KYV-FEA-' + ts.replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    return { firmaSerie: serie, firmaHash: hash, firmaTimestamp: new Date(ts) };
  } catch {
    return { firmaSerie: null, firmaHash: null, firmaTimestamp: null };
  }
}

// SMTP singleton optimizado para Office 365 / Hotmail
let smtpTransport: any = null;
function getSmtp() {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      tls: { minVersion: 'TLSv1.2' },
      pool: true,
      maxConnections: 3,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      dnsTimeout: 10000,
    });
  }
  return smtpTransport;
}

// S3/F10: Sanitizar HTML (incluye single quotes para atributos)
const escHtml = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// S2: Validar formato email básico
const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const ROL_TRASPASO_EMAIL: Record<string, { intro: string; personLabel: string }> = {
  vendedor: {
    intro: 'Se ha iniciado un tr&aacute;mite de <strong>traspaso de veh&iacute;culo</strong> en el que usted figura como <strong>vendedor (titular saliente)</strong>. Para continuar, debe verificar su identidad.',
    personLabel: 'Vendedor (titular saliente)',
  },
  comprador: {
    intro: 'Se ha iniciado un tr&aacute;mite de <strong>traspaso de veh&iacute;culo</strong> en el que usted figura como <strong>comprador (adquirente)</strong>. Para continuar, debe verificar su identidad.',
    personLabel: 'Comprador (adquirente)',
  },
};

function emailHtmlTraspaso(p: { nombre: string; documento: string; link: string; placa: string; vehInfo: string; expiraTxt: string; parte: string }) {
  const rol = ROL_TRASPASO_EMAIL[p.parte] || ROL_TRASPASO_EMAIL.comprador;
  const n = escHtml(p.nombre);
  const pl = escHtml(p.placa);
  const vi = escHtml(p.vehInfo);
  const doc = escHtml(p.documento);
  const link = escHtml(p.link);
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Validaci&oacute;n de identidad FLIT</title></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Verifique su identidad para el traspaso del veh&iacute;culo ${pl}. Enlace v&aacute;lido 24 horas.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.10);">

<tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 55%,#2563eb 100%);padding:32px 36px;text-align:center;">
  <p style="margin:0 0 6px;font-size:10px;font-weight:700;color:#93c5fd;letter-spacing:2.5px;text-transform:uppercase;">FLIT Operaciones</p>
  <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;line-height:1.25;">Validaci&oacute;n de identidad</h1>
  <p style="margin:10px 0 0;font-size:12px;color:#bfdbfe;">Traspaso de veh&iacute;culo &middot; Res. 12379/2012</p>
</td></tr>

<tr><td style="background:#ffffff;padding:32px 36px;">
  <p style="margin:0 0 16px;font-size:16px;color:#0f172a;line-height:1.5;">Hola, <strong>${n}</strong></p>
  <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.7;">${rol.intro}</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <tr><td style="padding:16px 20px;">
      <p style="margin:0 0 12px;font-size:10px;font-weight:800;color:#64748b;letter-spacing:1px;text-transform:uppercase;">Datos del tr&aacute;mite</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-size:12px;color:#64748b;padding:4px 0;width:42%;">Placa</td><td style="font-size:13px;color:#0f172a;font-weight:800;padding:4px 0;text-align:right;">${pl}</td></tr>
        <tr><td style="font-size:12px;color:#64748b;padding:4px 0;">Veh&iacute;culo</td><td style="font-size:13px;color:#0f172a;font-weight:600;padding:4px 0;text-align:right;">${vi || '&mdash;'}</td></tr>
        <tr><td style="font-size:12px;color:#64748b;padding:4px 0;">Su rol</td><td style="font-size:13px;color:#1d4ed8;font-weight:700;padding:4px 0;text-align:right;">${escHtml(rol.personLabel)}</td></tr>
        <tr><td style="font-size:12px;color:#64748b;padding:4px 0;">Documento</td><td style="font-size:13px;color:#0f172a;font-weight:600;padding:4px 0;text-align:right;">${doc}</td></tr>
        <tr><td style="font-size:12px;color:#64748b;padding:4px 0;">Vigencia</td><td style="font-size:13px;color:#0f172a;font-weight:600;padding:4px 0;text-align:right;">${escHtml(p.expiraTxt)}</td></tr>
      </table>
    </td></tr>
  </table>

  <p style="margin:0 0 8px;font-size:14px;color:#334155;font-weight:700;">&iquest;Qu&eacute; debe hacer?</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 22px;">
    <tr><td style="padding:3px 0;vertical-align:top;width:22px;color:#10b981;font-weight:800;">1.</td><td style="padding:3px 0;">Pulse el bot&oacute;n verde (funciona mejor desde el celular).</td></tr>
    <tr><td style="padding:3px 0;vertical-align:top;color:#10b981;font-weight:800;">2.</td><td style="padding:3px 0;">Tome una selfie con buena luz, sin gafas ni gorras.</td></tr>
    <tr><td style="padding:3px 0;vertical-align:top;color:#10b981;font-weight:800;">3.</td><td style="padding:3px 0;">Fotograf&iacute;e el frente y el reverso de su c&eacute;dula f&iacute;sica original.</td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td align="center">
    <a href="${link}" style="display:inline-block;padding:16px 36px;background-color:#059669;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;letter-spacing:0.4px;mso-padding-alt:0;">
      <!--[if mso]><i style="letter-spacing:25px;mso-font-width:-100%;mso-text-raise:30pt">&nbsp;</i><![endif]-->
      <span style="mso-text-raise:15pt;">Verificar mi identidad</span>
      <!--[if mso]><i style="letter-spacing:25px;mso-font-width:-100%">&nbsp;</i><![endif]-->
    </a>
  </td></tr></table>

  <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;text-align:center;">Si el bot&oacute;n no abre, copie este enlace en Chrome o Safari:</p>
  <p style="margin:0 0 20px;font-size:10px;color:#2563eb;text-align:center;word-break:break-all;line-height:1.5;">${link}</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin:0 0 18px;">
    <tr><td style="padding:12px 16px;font-size:11px;color:#92400e;line-height:1.6;">
      <strong>Importante:</strong> el enlace es personal e intransferible. Tratamiento de datos conforme a la Ley 1581 de 2012.
    </td></tr>
  </table>

  <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;text-align:center;">
    Si no reconoce este tr&aacute;mite, ignore este mensaje.
  </p>
</td></tr>

<tr><td style="background:#0f172a;padding:22px 36px;text-align:center;">
  <p style="margin:0 0 4px;font-size:12px;color:#e2e8f0;font-weight:700;">FLIT Operaciones</p>
  <p style="margin:0;font-size:10px;color:#64748b;">Mensaje autom&aacute;tico &middot; No responda a este correo</p>
  <p style="margin:8px 0 0;font-size:9px;color:#475569;">operaciones.flitsas.com</p>
</td></tr>

</table></td></tr></table></body></html>`;
}

function emailHtml(p: { nombre: string; documento: string; link: string; placa: string; vehInfo: string; expiraTxt: string }) {
  const n = escHtml(p.nombre);
  const pl = escHtml(p.placa);
  const vi = escHtml(p.vehInfo);
  const doc = escHtml(p.documento);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:32px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 50%,#3b82f6 100%);padding:36px 40px;text-align:center;">
  <p style="margin:0;font-size:11px;font-weight:600;color:#93c5fd;letter-spacing:2px;text-transform:uppercase;">FLIT Operaciones</p>
  <h1 style="margin:10px 0 0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.3px;">Validaci&oacute;n de Identidad</h1>
</td></tr>

<!-- Body -->
<tr><td style="background:#ffffff;padding:36px 40px;">
  <p style="margin:0 0 18px;font-size:15px;color:#0f172a;line-height:1.5;">Estimado(a) <strong>${n}</strong>,</p>
  <p style="margin:0 0 18px;font-size:13px;color:#475569;line-height:1.7;">
    Se ha iniciado un tr&aacute;mite de <strong>matr&iacute;cula inicial</strong> en el que usted figura como propietario del veh&iacute;culo. Para continuar con el proceso, es necesario verificar su identidad.
  </p>

  <!-- Datos del tramite -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
    <tr><td style="padding:14px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-size:11px;color:#64748b;padding:3px 0;">Veh&iacute;culo:</td>
          <td style="font-size:12px;color:#0f172a;font-weight:700;padding:3px 0;text-align:right;">${pl}${vi ? ' &mdash; ' + vi : ''}</td>
        </tr>
        <tr>
          <td style="font-size:11px;color:#64748b;padding:3px 0;">Propietario:</td>
          <td style="font-size:12px;color:#0f172a;font-weight:600;padding:3px 0;text-align:right;">${n}</td>
        </tr>
        <tr>
          <td style="font-size:11px;color:#64748b;padding:3px 0;">Documento:</td>
          <td style="font-size:12px;color:#0f172a;font-weight:600;padding:3px 0;text-align:right;">${doc}</td>
        </tr>
        <tr>
          <td style="font-size:11px;color:#64748b;padding:3px 0;">Vigencia del enlace:</td>
          <td style="font-size:12px;color:#0f172a;font-weight:600;padding:3px 0;text-align:right;">${escHtml(p.expiraTxt)}</td>
        </tr>
      </table>
    </td></tr>
  </table>

  <p style="margin:0 0 8px;font-size:13px;color:#475569;line-height:1.6;">
    Haga clic en el siguiente bot&oacute;n para iniciar la verificaci&oacute;n. El proceso tomar&aacute; menos de 2 minutos.
  </p>

  <!-- CTA Button -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td align="center">
    <a href="${p.link}" style="display:inline-block;padding:16px 40px;background:linear-gradient(135deg,#10b981,#059669);color:#ffffff;text-decoration:none;border-radius:10px;font-weight:800;font-size:15px;letter-spacing:0.3px;">VERIFICAR IDENTIDAD</a>
  </td></tr></table>

  <p style="margin:0 0 6px;font-size:10px;color:#94a3b8;text-align:center;">Si el bot&oacute;n no funciona, copie y pegue este enlace en su navegador:</p>
  <p style="margin:0 0 20px;font-size:9px;color:#3b82f6;text-align:center;word-break:break-all;font-family:monospace;">${p.link}</p>

  <hr style="margin:0 0 18px;border:none;border-top:1px solid #e2e8f0;">

  <!-- Requisitos -->
  <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#334155;">Requisitos para la verificaci&oacute;n:</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:11px;color:#64748b;line-height:1.7;">
    <tr><td style="padding:2px 0;vertical-align:top;width:18px;">1.</td><td style="padding:2px 0;">Tenga a la mano su documento de identidad f&iacute;sico (c&eacute;dula original).</td></tr>
    <tr><td style="padding:2px 0;vertical-align:top;">2.</td><td style="padding:2px 0;">Aseg&uacute;rese de estar en un lugar con buena iluminaci&oacute;n.</td></tr>
    <tr><td style="padding:2px 0;vertical-align:top;">3.</td><td style="padding:2px 0;">Ret&iacute;rese las gafas, gorras o cualquier accesorio que cubra su rostro.</td></tr>
    <tr><td style="padding:2px 0;vertical-align:top;">4.</td><td style="padding:2px 0;">El enlace tiene una vigencia de <strong>24 horas</strong>.</td></tr>
  </table>

  <p style="margin:18px 0 0;font-size:10px;color:#94a3b8;line-height:1.5;">
    Si usted no solicit&oacute; este tr&aacute;mite o no reconoce esta operaci&oacute;n, puede ignorar este mensaje de forma segura.
  </p>
</td></tr>

<!-- Footer -->
<tr><td style="background:#0f172a;padding:20px 40px;text-align:center;">
  <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:600;">FLIT Operaciones</p>
  <p style="margin:0;font-size:9px;color:#475569;">Este es un mensaje autom&aacute;tico. No responda a este correo.</p>
</td></tr>

</table></td></tr></table></body></html>`;
}

// F2/S1: Rate limits para endpoints publicos
const publicLimiter = rateLimit({ windowMs: 60000, max: 10, message: { ok: false, message: 'Demasiadas solicitudes' } });
const completarLimiter = rateLimit({ windowMs: 60000, max: 5, message: { ok: false, message: 'Demasiadas solicitudes' } });

// #13: GET /sse — Admin se suscribe a notificaciones de validación biométrica en tiempo real
router.get('/sse', authMiddleware, requireRole('admin'), (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// POST /iniciar — Admin envia email
router.post('/iniciar', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  const { tramiteId } = req.body;
  if (!tramiteId) { res.status(400).json({ error: 'tramiteId requerido' }); return; }

  const [tramite] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  if (!tramite) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }

  const comp = tramite.comprador as any;
  if (!comp?.email || !isValidEmail(comp.email)) { res.status(400).json({ error: 'El comprador no tiene email válido' }); return; }

  // C2: Invalidar tokens previos de forma atómica (sin SELECT+UPDATE separado)
  await db.update(tramitesValidaciones).set({ estado: 'rechazado' })
    .where(and(eq(tramitesValidaciones.tramiteId, tramiteId), eq(tramitesValidaciones.estado, 'enviado')));

  const token = genToken();
  const expiraAt = new Date(Date.now() + 24 * 3600 * 1000);
  const veh = tramite.vehiculo as any;
  const vehInfo = [veh?.marca, veh?.linea, veh?.modelo].filter(Boolean).join(' ');

  await db.insert(tramitesValidaciones).values({
    tramiteId, token,
    nombre: comp.nombre || '', tipoDoc: comp.tipoDoc || 'CC',
    documento: comp.documento || '', email: comp.email,
    placa: (tramite.placa || '').toUpperCase(), vehiculoInfo: vehInfo,
    estado: 'enviado', intentos: 0,
    enviadoAt: new Date(), expiraAt,
  });

  const link = `${env.PUBLIC_URL}/validar-identidad.html?t=${token}`;
  const expiraTxt = expiraAt.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const smtp = getSmtp();

  // Modo "enlace manual" (fallback): el token y el enlace YA están creados, así que
  // el comprador puede validar aunque el correo no salga. Si el SMTP no está
  // configurado o el envío falla, NO bloqueamos el trámite: devolvemos el enlace al
  // admin (autenticado, dueño del trámite) para que lo envíe manualmente (WhatsApp,
  // etc.) y lo registramos en logs. Controlable con TRAMITES_EMAIL_FALLBACK=false.
  const fallbackHabilitado = env.TRAMITES_EMAIL_FALLBACK !== false;
  const responderConEnlaceManual = (motivo: string) => {
    log.warn({ tramiteId, motivo, link }, 'email de validación no enviado — modo enlace manual');
    res.json({
      ok: true, email: comp.email, expiraAt: expiraAt.toISOString(),
      emailEnviado: false, fallback: true, motivo, link,
    });
  };

  if (!smtp) {
    if (fallbackHabilitado) { responderConEnlaceManual('SMTP no configurado'); return; }
    res.status(500).json({ error: 'SMTP no configurado' }); return;
  }

  try {
    await smtp.sendMail({
      from: { name: env.SMTP_FROM_NAME, address: env.SMTP_USER! },
      replyTo: env.SMTP_USER,
      to: comp.email,
      subject: `Verificación de Identidad - Matrícula Vehículo ${tramite.placa || ''}`,
      html: emailHtml({ nombre: comp.nombre, documento: comp.documento || '', link, placa: tramite.placa || '', vehInfo, expiraTxt }),
      text: `Estimado(a) ${comp.nombre}, se ha iniciado un trámite de matrícula inicial del vehículo ${tramite.placa || ''}. Verifique su identidad en: ${link} — Este enlace expira el ${expiraTxt}. FLIT Operaciones.`,
      headers: {
        'List-Unsubscribe': `<mailto:${env.SMTP_USER}?subject=unsubscribe>`,
        'Precedence': 'bulk',
      },
    });
    await db.update(tramitesDigitales).set({ updatedAt: new Date() }).where(eq(tramitesDigitales.id, tramiteId));
    await audit(req, { action: 'create', resource: 'validacion_identidad', resourceId: String(tramiteId), detail: `Email a ${comp.email ? comp.email.replace(/^(.).*(.@.+)$/, '$1***$2') : '(sin email)'}` });
    res.json({ ok: true, email: comp.email, expiraAt: expiraAt.toISOString(), emailEnviado: true });
  } catch (err: any) {
    // Mensaje más claro: incluye el código SMTP (p.ej. 535) cuando existe.
    const code = err?.responseCode ?? err?.code ?? '';
    const motivo = `Error SMTP${code ? ` ${code}` : ''}: ${err?.message || 'desconocido'}`;
    if (fallbackHabilitado) { responderConEnlaceManual(motivo); return; }
    res.status(500).json({ error: 'Error enviando email: ' + (err?.message || 'desconocido') });
  }
});

// POST /iniciar-partes — Traspaso: validación biométrica vendedor + comprador (paridad CEA).
router.post('/iniciar-partes', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  const { tramiteId } = req.body;
  if (!tramiteId) { res.status(400).json({ error: 'tramiteId requerido' }); return; }

  const [tramite] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  if (!tramite) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }

  const { vendedor: venParte, comprador: comParte } = extractPartesTraspasoFromTramite(tramite);
  const partes = [venParte, comParte];

  const validacionesExistentes = await db.select({
    id: tramitesValidaciones.id,
    parte: tramitesValidaciones.parte,
    documento: tramitesValidaciones.documento,
    email: tramitesValidaciones.email,
    estado: tramitesValidaciones.estado,
  }).from(tramitesValidaciones).where(eq(tramitesValidaciones.tramiteId, tramiteId)).orderBy(desc(tramitesValidaciones.id));

  const valVendedor = resolverValidacionTraspasoParte(validacionesExistentes, { parte: 'vendedor', documento: venParte.documento });
  const valComprador = resolverValidacionTraspasoParte(validacionesExistentes, { parte: 'comprador', documento: comParte.documento });

  // Fallback: si el JSONB vehiculo perdió _vendedor/_comprador (PATCH legacy pre-merge),
  // recuperar el email desde la última validación registrada de cada parte.
  for (const p of partes) {
    if (p.email && isValidEmail(p.email)) continue;
    const val = p.parte === 'vendedor' ? valVendedor : valComprador;
    if (val?.email && isValidEmail(val.email)) p.email = val.email;
  }

  const sinEmail = partes.filter((p) => !p.email || !isValidEmail(p.email));
  if (sinEmail.length > 0) {
    res.status(400).json({ error: `Falta email válido: ${sinEmail.map((p) => p.parte).join(', ')}` });
    return;
  }

  const dupMsg = mensajePartesTraspasoDuplicadas(partesTraspasoDuplicadas(partes[0], partes[1]));
  if (dupMsg) {
    res.status(400).json({ error: dupMsg });
    return;
  }

  const veh = (tramite.vehiculo || {}) as Record<string, unknown>;
  const vehInfo = [veh.marca, veh.linea, veh.modelo].filter(Boolean).join(' ');
  const smtp = getSmtp();
  const fallbackHabilitado = env.TRAMITES_EMAIL_FALLBACK !== false;
  const resultados: { parte: string; email: string; emailEnviado: boolean; link?: string }[] = [];
  const partesAEnviar = partes.filter((p) => {
    const val = p.parte === 'vendedor' ? valVendedor : valComprador;
    return parteTraspasoRequiereReenvio(val);
  });

  if (partesAEnviar.length === 0) {
    res.json({
      ok: true,
      partes: [],
      message: 'No hay partes pendientes de reenvío. Las identidades ya están validadas o los enlaces siguen activos.',
    });
    return;
  }

  for (const p of partesAEnviar) {
    // Expirar intentos previos de la misma parte (rechazado queda obsoleto al reenviar).
    await db.update(tramitesValidaciones).set({ estado: 'expirado' })
      .where(and(
        eq(tramitesValidaciones.tramiteId, tramiteId),
        eq(tramitesValidaciones.parte, p.parte),
        sql`estado IN ('enviado', 'rechazado', 'en_proceso')`,
      ));

    const token = genToken();
    const expiraAt = new Date(Date.now() + 24 * 3600 * 1000);
    await db.insert(tramitesValidaciones).values({
      tramiteId, token, parte: p.parte,
      nombre: p.nombre, tipoDoc: p.tipoDoc, documento: p.documento, email: p.email,
      placa: (tramite.placa || '').toUpperCase(), vehiculoInfo: vehInfo,
      estado: 'enviado', intentos: 0, enviadoAt: new Date(), expiraAt,
    });
    const link = `${env.PUBLIC_URL}/validar-identidad.html?t=${token}`;
    const expiraTxt = expiraAt.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    let emailEnviado = false;
    if (smtp) {
      try {
        await smtp.sendMail({
          from: { name: env.SMTP_FROM_NAME, address: env.SMTP_USER! },
          replyTo: env.SMTP_USER,
          to: p.email,
          subject: `Verificación de Identidad - Traspaso ${tramite.placa || ''} (${p.parte === 'vendedor' ? 'Vendedor' : 'Comprador'})`,
          html: emailHtmlTraspaso({ nombre: p.nombre || '', documento: p.documento || '', link, placa: tramite.placa || '', vehInfo, expiraTxt, parte: p.parte }),
          text: `Hola ${p.nombre},\n\nDebe verificar su identidad como ${p.parte === 'vendedor' ? 'vendedor (titular saliente)' : 'comprador (adquirente)'} en el traspaso del vehículo ${tramite.placa || ''}${vehInfo ? ' (' + vehInfo + ')' : ''}.\n\n1. Abra el enlace en su celular\n2. Tome una selfie (sin gafas)\n3. Fotografíe frente y reverso de su cédula\n\nEnlace (válido 24 h): ${link}\n\nFLIT Operaciones — operaciones.flitsas.com`,
        });
        emailEnviado = true;
      } catch (err: any) {
        log.warn({ tramiteId, parte: p.parte, err: err?.message }, 'email validación traspaso no enviado');
        if (!fallbackHabilitado) {
          res.status(500).json({ error: `Error enviando email a ${p.parte}` });
          return;
        }
      }
    } else if (!fallbackHabilitado) {
      res.status(500).json({ error: 'SMTP no configurado' });
      return;
    }
    resultados.push({ parte: p.parte, email: p.email || '', emailEnviado, link: emailEnviado ? undefined : link });
  }

  await audit(req, { action: 'create', resource: 'validacion_identidad', resourceId: String(tramiteId), detail: 'iniciar-partes traspaso' });
  res.json({ ok: true, partes: resultados });
});

// GET /info/:token — Publico con rate limit
router.get('/info/:token', publicLimiter, async (req: Request, res: Response) => {
  const [record] = await db.select().from(tramitesValidaciones).where(eq(tramitesValidaciones.token, req.params.token)).limit(1);
  if (!record) { res.json({ ok: false, message: 'Enlace inválido' }); return; }
  if (new Date() > new Date(record.expiraAt!)) { res.json({ ok: false, message: 'Enlace expirado', estado: 'expirado' }); return; }
  if (record.estado === 'aprobado') { res.json({ ok: false, message: 'Validación completada', estado: 'aprobado' }); return; }

  res.json({
    ok: true, nombre: record.nombre, tipoDoc: record.tipoDoc, documento: record.documento,
    placa: record.placa, vehiculo: record.vehiculoInfo, estado: record.estado, expiraAt: record.expiraAt,
    parte: record.parte || null, modalidad: record.parte ? 'traspaso' : 'matricula',
  });
});

// POST /completar/:token — Publico con rate limit
router.post('/completar/:token', completarLimiter, async (req: Request, res: Response) => {
  await recoverStaleByToken(req.params.token);

  // C1: Usar UPDATE atomico para prevenir race condition
  const [record] = await db.update(tramitesValidaciones).set({
    estado: 'en_proceso',
    procesandoDesde: new Date(),
    intentos: sql`intentos + 1`,
    ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
  }).where(and(
    eq(tramitesValidaciones.token, req.params.token),
    sql`estado IN ('enviado', 'rechazado')`,
    sql`intentos < 5`,
    sql`expira_at > NOW()`,
  )).returning();

  if (!record) {
    // Verificar causa especifica
    const [check] = await db.select({ estado: tramitesValidaciones.estado, intentos: tramitesValidaciones.intentos, expiraAt: tramitesValidaciones.expiraAt })
      .from(tramitesValidaciones).where(eq(tramitesValidaciones.token, req.params.token)).limit(1);
    if (!check) { res.status(400).json({ ok: false, message: 'Token inválido' }); return; }
    if (check.estado === 'aprobado') { res.json({ ok: true, aprobado: true, score: null }); return; }
    if (check.intentos! >= 5) { res.status(429).json({ ok: false, message: 'Máximo de intentos' }); return; }
    if (new Date() > new Date(check.expiraAt!)) { res.status(400).json({ ok: false, message: 'Enlace expirado' }); return; }
    if (check.estado === 'en_proceso') {
      res.status(409).json({ ok: false, message: 'Hay una validación en curso. Espere 1 minuto y pulse Reintentar.' });
      return;
    }
    res.status(400).json({ ok: false, message: 'No se pudo procesar. Recargue la página e intente de nuevo.' }); return;
  }

  const { fotoRostro, fotoCedula, fotoCedulaReverso } = req.body;
  if (!fotoRostro || !fotoCedula || !fotoCedulaReverso) {
    await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null }).where(eq(tramitesValidaciones.id, record.id));
    res.status(400).json({ ok: false, message: 'Las 3 fotos son requeridas' }); return;
  }
  // F3: Validar tamaño max 5MB por foto (base64 ~ 1.37x del binario)
  const MAX_B64 = 7 * 1024 * 1024;
  if (fotoRostro.length > MAX_B64 || fotoCedula.length > MAX_B64 || fotoCedulaReverso.length > MAX_B64) {
    await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null }).where(eq(tramitesValidaciones.id, record.id));
    res.status(400).json({ ok: false, message: 'Cada foto debe pesar máximo 5MB' }); return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null }).where(eq(tramitesValidaciones.id, record.id));
    res.status(500).json({ ok: false, message: 'API key no configurada' }); return;
  }

  try {
    const prompt = buildPrompt(record.documento || '');
    const clean = (b64: string) => b64.replace(/^data:image\/[a-z]+;base64,/, '');

    // TRAM-11: Anthropic vía helper resiliente (timeout+retry+métrica, op=biometric).
    const ai = await anthropicMessages({
      model: 'claude-sonnet-4-6', max_tokens: 2500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: clean(fotoRostro) } },
        { type: 'text', text: 'SELFIE' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: clean(fotoCedula) } },
        { type: 'text', text: 'CEDULA FRONTAL' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: clean(fotoCedulaReverso) } },
        { type: 'text', text: 'CEDULA REVERSO' },
        { type: 'text', text: prompt },
      ] }],
    }, 'biometric');

    if (!ai.ok) {
      // Revertir intentos: es fallo de servicio (IA), no del usuario.
      await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null, intentos: sql`GREATEST(intentos - 1, 0)` }).where(eq(tramitesValidaciones.id, record.id));
      res.status(ai.status).json({ ok: false, message: ai.message }); return;
    }
    const r: any = ai.data;

    const text = extractAnthropicText(r);
    const bio: any = parseBiometricJson(text);
    if (!bio) {
      log.warn({ validacionId: record.id, textLen: text.length, hasBrace: text.includes('{') }, 'biometric json parse failed');
      await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null, intentos: sql`GREATEST(intentos - 1, 0)` }).where(eq(tramitesValidaciones.id, record.id));
      res.status(503).json({
        ok: false,
        retryable: true,
        message: 'No se pudo interpretar el análisis biométrico. Pulse Reintentar y capture las fotos con buena luz.',
      });
      return;
    }

    // Extra validations
    const rechazos: string[] = [];
    let scoreMin = bio.resultado_general?.score_total || 0;
    const docOCR = (bio.documento_ocr?.numero || '').replace(/[\s.-]/g, '');
    const docReg = (record.documento || '').replace(/[\s.-]/g, '');
    if (docReg && docOCR && docOCR !== docReg) { rechazos.push(`El número de documento presentado (${docOCR}) no coincide con el registrado en el trámite (${docReg}). Verifique que esté usando la cédula correcta.`); scoreMin = Math.min(scoreMin, 20); }
    if (bio.documento_ocr?.es_documento_oficial === false) { rechazos.push('El documento presentado no es un documento de identidad oficial colombiano.'); scoreMin = Math.min(scoreMin, 10); }
    if (bio.documento_ocr?.documento_integro === false) { rechazos.push('El documento presenta obstrucciones o no es completamente legible.'); scoreMin = Math.min(scoreMin, 15); }
    if (bio.documento_ocr?.frente_y_reverso_coherentes === false) { rechazos.push('El frente y reverso no corresponden al mismo documento.'); scoreMin = Math.min(scoreMin, 10); }
    if (bio.documento_ocr?.documento_es_foto_fisica === false) { rechazos.push('El documento parece ser una foto de pantalla o fotocopia. Debe fotografiar el documento físico original.'); scoreMin = 0; }
    if (bio.liveness?.rostro_visible === false) { rechazos.push('El rostro no es completamente visible. Retírese gafas, gorras o cualquier accesorio.'); scoreMin = 0; }
    if (bio.liveness?.es_persona_real === false) { rechazos.push('No se detectó una persona real. No se aceptan fotos de fotos ni capturas de pantalla.'); scoreMin = 0; }
    if ((bio.comparacion_facial?.score || 0) < 60) { rechazos.push(`La coincidencia facial es insuficiente (${bio.comparacion_facial?.score}/100). El mínimo requerido es 60/100.`); scoreMin = Math.min(scoreMin, bio.comparacion_facial?.score || 0); }

    if (rechazos.length > 0) bio.resultado_general = { aprobado: false, score_total: scoreMin, motivo: rechazos.join('. ') };

    const aprobado = bio.resultado_general?.aprobado === true;
    const score = aprobado ? (bio.resultado_general?.score_total || 0) : scoreMin;

    // Subir fotos a S3 (MinIO). Sin fallback BD — si MinIO falla retornamos 503 y revertimos.
    // El fallback `encryptPII` legacy fragmentaba el formato de la columna y enmascaraba
    // outages reales. Con MinIO en SLA, fail-fast es la opción correcta (Ola C-2).
    let rostroKey = '', frontalKey = '', reversoKey = '';
    try {
      await ensureBucket();
      rostroKey = await uploadPhoto(record.tramiteId, 'rostro', fotoRostro);
      frontalKey = await uploadPhoto(record.tramiteId, 'frontal', fotoCedula);
      reversoKey = await uploadPhoto(record.tramiteId, 'reverso', fotoCedulaReverso);
    } catch (storageErr: any) {
      log.warn({ err: storageErr.message }, 'falla MinIO, revirtiendo intento');
      // Revertir intentos para no agotar al usuario por culpa de infra.
      await db.update(tramitesValidaciones)
        .set({ estado: 'enviado', procesandoDesde: null, intentos: sql`GREATEST(intentos - 1, 0)` })
        .where(eq(tramitesValidaciones.id, record.id));
      res.status(503).json({ ok: false, message: 'Almacenamiento de evidencias no disponible. Reintente en unos minutos.' });
      return;
    }

    // Actualizar validacion en BD — guardar fotos + metadata
    const ipAddr = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
    // TRAM-F3: sello de firma electrónica al aprobar (para sellos del contrato/FUR).
    const sello = aprobado
      ? generarSelloFirma({ tramiteId: record.tramiteId, parte: record.parte, nombre: record.nombre || '', tipoDoc: record.tipoDoc || 'CC', documento: record.documento || '', email: record.email || '', placa: record.placa || '', vehiculo: record.vehiculoInfo || '', score, bio })
      : { firmaSerie: null, firmaHash: null, firmaTimestamp: null };
    await db.update(tramitesValidaciones).set({
      estado: aprobado ? 'aprobado' : 'rechazado',
      procesandoDesde: null,
      score, detalle: bio,
      validadoAt: aprobado ? new Date() : null,
      firmaSerie: sello.firmaSerie,
      firmaHash: sello.firmaHash,
      firmaTimestamp: sello.firmaTimestamp,
      fotoRostro: rostroKey,
      fotoCedulaFrontal: frontalKey,
      fotoCedulaReverso: reversoKey,
      ciudadGeo: req.body.ciudadGeo || null,
      lat: req.body.lat ? String(req.body.lat) : null,
      lng: req.body.lng ? String(req.body.lng) : null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
    }).where(eq(tramitesValidaciones.id, record.id));

    // S5: No guardar token en tramite — solo resultado
    // El admin decide manualmente cuándo avanzar el estado del trámite
    await db.update(tramitesDigitales).set({
      validacionIdentidad: { aprobado, score, motivo: bio.resultado_general?.motivo },
      updatedAt: new Date(),
    }).where(eq(tramitesDigitales.id, record.tramiteId));

    log.info({ validacionId: record.id, resultado: aprobado ? 'aprobado' : 'rechazado', score }, 'biometrica decidida');

    // #13: Notificar via SSE a admins conectados
    sseClients.forEach((client: any) => {
      try { client.write(`data: ${JSON.stringify({ tipo: 'validacion_completada', tramiteId: record.tramiteId, estado: aprobado ? 'aprobado' : 'rechazado', nombre: record.nombre })}\n\n`); } catch {}
    });

    res.json({ ok: true, aprobado, score, motivo: bio.resultado_general?.motivo });
  } catch (err: any) {
    await db.update(tramitesValidaciones).set({ estado: 'enviado', procesandoDesde: null, intentos: sql`GREATEST(intentos - 1, 0)` }).where(eq(tramitesValidaciones.id, record.id));
    res.status(500).json({ ok: false, message: err.message });
  }
});

// GET /estado/:tramiteId — Admin polling
router.get('/estado/:tramiteId', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  const tramiteId = parseInt(req.params.tramiteId, 10);
  if (!Number.isFinite(tramiteId)) { res.status(400).json({ ok: false }); return; }
  const records = await db.select({
    id: tramitesValidaciones.id, parte: tramitesValidaciones.parte,
    nombre: tramitesValidaciones.nombre,
    documento: tramitesValidaciones.documento, email: tramitesValidaciones.email,
    estado: tramitesValidaciones.estado, score: tramitesValidaciones.score,
    intentos: tramitesValidaciones.intentos, enviadoAt: tramitesValidaciones.enviadoAt,
    procesandoDesde: tramitesValidaciones.procesandoDesde,
    validadoAt: tramitesValidaciones.validadoAt, expiraAt: tramitesValidaciones.expiraAt,
  }).from(tramitesValidaciones).where(eq(tramitesValidaciones.tramiteId, tramiteId))
    .orderBy(desc(tramitesValidaciones.id));
  res.json({ ok: true, validaciones: records });
});

// GET /documentos/:tramiteId — Obtener fotos y detalle de validación
router.get('/documentos/:tramiteId', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  const tramiteId = parseInt(req.params.tramiteId, 10);
  if (!Number.isFinite(tramiteId)) { res.status(400).json({ ok: false }); return; }
  const records = await db.select().from(tramitesValidaciones).where(eq(tramitesValidaciones.tramiteId, tramiteId));

  // Resolver foto: key S3 (validaciones/...) o legacy cifrado en BD
  const resolvePhoto = async (val: string | null): Promise<string | null> => {
    if (!val) return null;
    if (val.startsWith('data:') || val.includes(':')) return decryptPII(val); // legacy cifrado o base64
    try { return await getPhoto(val); } catch { return null; } // key S3
  };

  const documentos = await Promise.all(records.map(async (r) => ({
    id: r.id, contexto: 'COMPRADOR', nombre: r.nombre, tipoDoc: r.tipoDoc,
    documento: r.documento, estado: r.estado, score: r.score,
    fotoRostro: await resolvePhoto(r.fotoRostro),
    fotoCedulaFrontal: await resolvePhoto(r.fotoCedulaFrontal),
    fotoCedulaReverso: await resolvePhoto(r.fotoCedulaReverso),
    detalle: r.detalle, validadoAt: r.validadoAt, ipAddress: r.ipAddress,
    ciudadGeo: r.ciudadGeo, lat: r.lat, lng: r.lng,
    intentos: r.intentos, enviadoAt: r.enviadoAt,
  })));

  res.json({ ok: true, documentos });
});

// POST /recortar-cedula — Detecta y recorta solo el documento de la foto
const recorteLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: 'Demasiadas solicitudes' } });
router.post('/recortar-cedula', authMiddleware, recorteLimiter, async (req: Request, res: Response) => {
  const { imagen } = req.body;
  if (!imagen || typeof imagen !== 'string') { res.status(400).json({ ok: false }); return; }
  if (!env.ANTHROPIC_API_KEY) { res.status(500).json({ ok: false, message: 'API key no configurada' }); return; }

  try {
    const clean = imagen.replace(/^data:image\/[a-z]+;base64,/, '');
    const cropPrompt = `Mira esta foto donde una persona sostiene un documento de identidad (cedula colombiana, tarjeta de identidad, pasaporte, etc).

Tu tarea: encontrar las coordenadas EXACTAS del rectangulo que contiene SOLO el documento, excluyendo los dedos, manos y cara de la persona.

Responde UNICAMENTE un JSON asi (sin markdown, sin explicacion):
{"x":number,"y":number,"w":number,"h":number}

Donde x, y, w, h son PORCENTAJES (0 a 100) de la imagen total:
- x = borde izquierdo del documento
- y = borde superior del documento
- w = ancho del documento
- h = alto del documento

IMPORTANTE: El recorte debe mostrar SOLO la tarjeta/cedula. Si los dedos tapan un borde, incluye hasta donde se ve la tarjeta pero NO incluyas la cara de la persona. Se generoso con el borde del documento (incluye 2-3% extra) pero estricto excluyendo la cara y el cuerpo.`;

    // TRAM-11: recorte de cédula vía helper resiliente (op=biometric).
    const ai = await anthropicMessages({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: clean } },
        { type: 'text', text: cropPrompt },
      ] }],
    }, 'biometric');
    if (!ai.ok) { res.status(ai.status).json({ ok: false, message: ai.message }); return; }
    const r: any = ai.data;

    const text = extractAnthropicText(r);
    let coords: any = parseBiometricJson(text);
    if (!coords) {
      try { coords = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
      catch { coords = { x: 0, y: 0, w: 100, h: 100 }; }
    }

    // Sanitizar
    const x = Math.max(0, Math.min(95, coords.x || 0));
    const y = Math.max(0, Math.min(95, coords.y || 0));
    const w = Math.max(5, Math.min(100 - x, coords.w || 100));
    const h = Math.max(5, Math.min(100 - y, coords.h || 100));

    res.json({ ok: true, crop: { x, y, w, h } });
  } catch (e: any) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

function buildPrompt(docRegistrado: string): string {
  const ref = docRegistrado ? `\nDATOS REGISTRADOS del comprador (para cruzar con OCR):\n- Numero de documento registrado: ${docRegistrado}\n` : '';
  return `Eres un sistema de validacion biometrica ESTRICTO para el RUNT (Registro Unico Nacional de Transito) de Colombia. Analiza las imagenes:

IMAGEN 1: Selfie en vivo de la persona
IMAGEN 2: Foto FRONTAL de un documento de identidad colombiano
IMAGEN 3: Foto del REVERSO del documento
${ref}
=== DOCUMENTOS VALIDOS (solo estos son aceptados por el RUNT) ===

1. CEDULA DE CIUDADANIA AMARILLA (CC): Fondo AMARILLO/gris/rosa. Texto: "REPUBLICA DE COLOMBIA / IDENTIFICACION PERSONAL / CEDULA DE CIUDADANIA". Foto a la izquierda. Holograma. REVERSO: amarillo-rosa, huella dactilar izquierda, PDF417 rectangular abajo. FECHA DE NACIMIENTO en el REVERSO (formato DD-MMM-AAAA, ej: 19-FEB-1983). NO confundir con FECHA DE EXPEDICION que es otra fecha diferente.

2. CEDULA DIGITAL (CC Digital): Fondo CELESTE/AMARILLO. "REPUBLICA DE COLOMBIA / CEDULA DE CIUDADANIA". Policarbonato. Mariposa OVI dorado/verde esquina inferior derecha. Ghost image. FECHA DE NACIMIENTO en el FRENTE. REVERSO: QR, MRZ 3 lineas, iglesia.

3. TARJETA DE IDENTIDAD AZUL (TI): Fondo AZUL. "REPUBLICA DE COLOMBIA / TARJETA DE IDENTIDAD". Menores 7-17 anos. PDF417 en el FRENTE. FECHA DE NACIMIENTO en el frente.

4. CEDULA DE EXTRANJERIA (CE): Tonos VERDES/AZULES. "REPUBLICA DE COLOMBIA / CEDULA DE EXTRANJERIA / MIGRACION COLOMBIA". Holograma con mapa de Colombia. OVI "COL". REVERSO: codigo barras, MRZ.

5. PPT: Tonos VERDES/azules/dorados. "REPUBLICA DE COLOMBIA / PERMISO POR PROTECCION TEMPORAL / MIGRACION COLOMBIA". Solo venezolanos. REVERSO: QR, MRZ.

6. PASAPORTE COLOMBIANO: Pagina de datos con foto, MRZ 2 lineas.

=== VALIDACIONES (en este orden estricto) ===

VALIDACION 1 — SELFIE:
- Rostro COMPLETAMENTE VISIBLE (ambos ojos, nariz, boca sin cubrir).
- RECHAZAR si: mascara, pasamontanas, casco, CUALQUIER tipo de lentes o gafas (de sol, de formula, de lectura, deportivos, de proteccion — NINGUNO es aceptable), manos cubriendo cara.
- Los OJOS deben estar completamente visibles SIN NINGUN cristal o montura de gafas encima. Si la persona lleva gafas de cualquier tipo = rostro_visible=false y RECHAZAR con motivo "Debe retirarse las gafas para la captura biometrica".
- Debe ser foto real en vivo (no foto de pantalla, no foto impresa, no foto de otra foto).
- Manos cerca del rostro sin cubrirlo NO son motivo de rechazo.

VALIDACION 2 — DOCUMENTO (CRITICA):
- DEBE ser uno de los 6 documentos listados arriba.
- RECHAZAR si: no es documento oficial, es fotocopia, tiene alteraciones, tachaduras.
- Verificar que dice "REPUBLICA DE COLOMBIA" o es documento oficial de Migracion Colombia.
- LA FOTO DEL TITULAR EN EL DOCUMENTO DEBE SER COMPLETAMENTE VISIBLE. Si hay dedos, manos, objetos, brillos o cualquier obstruccion cubriendo parcial o totalmente la FOTO impresa en el documento = RECHAZAR. Sin la foto visible NO se puede hacer comparacion facial.
- El NUMERO DE DOCUMENTO debe ser completamente legible. Si hay dedos cubriendo digitos = RECHAZAR.
- Los NOMBRES Y APELLIDOS deben ser legibles. Si estan cubiertos = RECHAZAR.
- VERIFICAR que el REVERSO corresponde al MISMO documento que el FRENTE (mismo tipo, mismo color, coherencia visual).
- Si CUALQUIER dato critico (foto, numero, nombres) esta obstruido por dedos, manos u objetos = documento_integro=false y RECHAZAR.

VALIDACION 2B — ANTI-SPOOFING DEL DOCUMENTO (CRITICA — DEBES EVALUAR):
El documento DEBE ser una foto EN VIVO del documento FISICO ORIGINAL (plastico), NO puede ser:
- Foto de una pantalla (celular, computador, tablet mostrando la cedula)
- Foto de una fotocopia impresa
- Foto de otra foto
- Screenshot o captura digital
- Imagen digital sin textura de plastico
SENALES DE ALARMA QUE DEBES DETECTAR (si ves CUALQUIERA = documento_es_foto_fisica=false):
1. PATRONES MOIRE: lineas diagonales de interferencia, bandas onduladas sobre el documento (efecto pantalla LCD/LED).
2. PIXELACION DE PANTALLA: puedes ver puntos RGB/subpixeles, el documento se ve "digital" no plastico.
3. REFLEJOS DE PANTALLA: brillos rectangulares planos (tipo spotlight de pantalla retroiluminada), bordes rectos brillantes.
4. BORDES DE DISPOSITIVO: marco negro, borde de celular/monitor visible alrededor o encima del documento.
5. BARRAS NEGRAS: notch, barra de estado del celular (hora, bateria, senal) aparecen en la foto.
6. INTERFAZ DE APP: iconos, botones, controles de reproductor sobre o junto al documento.
7. AUSENCIA DE TEXTURA FISICA: la cedula real tiene relieve, plastico brillante, holograma que CAMBIA de color con el angulo. Si se ve plana como papel digital o pantalla = sospechoso.
8. FONDO DIGITAL: el fondo detras del documento es una pantalla, interfaz, o elemento digital (no superficie fisica como mesa, mano, mostrador).
9. HOLOGRAMA PLANO: el holograma de la cedula real tiene efecto iridiscente. Si se ve estatico como una imagen = es foto de pantalla.
10. OVI PLANO: el "COL" en cedula amarilla cambia de color. Si se ve monocromatico = foto digital.

SI DETECTAS CUALQUIER SENAL DE LAS ANTERIORES:
- documento_es_foto_fisica = false
- documento_integro = false
- RECHAZAR con motivo especifico ("Documento parece foto de pantalla/impresion, no documento fisico")

En caso de duda (foto de buena calidad sin senales claras de pantalla) = documento_es_foto_fisica=true.

VALIDACION 3 — SEXO:
- Determina sexo de la persona en selfie vs foto del documento.
- Si son de SEXO DIFERENTE = RECHAZAR con score facial 0 (son personas distintas).

VALIDACION 4 — DATOS (extraer con MAXIMA precision):
- Numero de documento: LEER EXACTAMENTE cada digito. Esta junto a "C.C. No." o "NUIP" o "No.".
- Nombres y apellidos: como aparecen en el documento.
- FECHA DE NACIMIENTO: ATENCION CRITICA:
  * En CEDULA AMARILLA: esta en el REVERSO, campo con label "FECHA DE NACIMIENTO" arriba a la derecha. Formato DD-MMM-AAAA (ej: 19-FEB-1983).
  * NO confundir con "FECHA Y LUGAR DE EXPEDICION" que es OTRA fecha diferente ubicada mas abajo.
  * En CEDULA DIGITAL: esta en el FRENTE.
- Sexo: M o F como aparece en el documento.
- Si algun dato critico NO coincide con los registrados = RECHAZAR.

VALIDACION 5 — COMPARACION FACIAL:
- PREREQUISITO: La foto del titular en el documento DEBE ser visible y sin obstrucciones. Si la foto del documento esta tapada, cubierta por dedos, borrosa o no visible = score facial DEBE ser 0 y coincidencia=false. NO PUEDES dar un score > 0 si no puedes ver claramente la cara en el documento.
- Comparar ESTRUCTURA FACIAL del selfie vs foto del documento.
- La foto del documento puede tener 10-20 anos de antiguedad. TOLERAR: envejecimiento, cambio de peso, calvicie, canas, barba nueva/removida.
- ENFOCARSE en rasgos ESTRUCTURALES que NO cambian: estructura osea craneal, distancia interocular, forma de la nariz, forma de las orejas, arco superciliar, linea de la mandibula.
- Score 65-85: misma persona con cambios por edad.
- Score 40-64: posible coincidencia pero con dudas significativas.
- Score < 30: personas CLARAMENTE diferentes (diferente estructura osea, diferente sexo, rasgos incompatibles).
- Score 0: foto del documento NO visible, tapada por dedos/objetos, o completamente ilegible.

Responde SOLO en formato JSON valido (sin markdown, sin texto adicional):

{"comparacion_facial":{"coincidencia":true,"score":0-100,"observaciones":"descripcion profesional breve"},"documento_ocr":{"tipo_documento":"cc_amarilla/cc_digital/tarjeta_identidad/cedula_extranjeria/ppt/pasaporte/no_aceptado","numero":"numero extraido CON PRECISION","nombres":"nombres","apellidos":"apellidos","fecha_nacimiento":"YYYY-MM-DD. En AMARILLA esta en REVERSO. NUNCA confundir con FECHA DE EXPEDICION.","sexo":"M/F","es_documento_oficial":true,"documento_integro":true,"documento_es_foto_fisica":true,"senales_spoofing":"senales detectadas o vacio","frente_y_reverso_coherentes":true,"observaciones_documento":"problemas si los hay"},"liveness":{"es_persona_real":true,"rostro_visible":true,"observaciones":"cara tapada, mascara, etc."},"resultado_general":{"aprobado":true,"score_total":0-100,"motivo":"resumen profesional"}}

IMPORTANTE: Tus observaciones deben ser profesionales y neutras.
NUNCA describas caracteristicas fisicas de las personas (calvo, gordo, gafas, color de piel, etc.).
Solo indica si coinciden o no con lenguaje tecnico:
- "Coincidencia facial positiva" o "No se establece coincidencia facial"
- "Rasgos biometricos consistentes" o "Rasgos biometricos no coincidentes"
- NUNCA menciones: calvicie, peso, gafas, color, edad, genero, etnia, discapacidad

Criterios de aprobacion:
- Rostro completamente visible en selfie (sin mascara, sin lentes oscuros, sin obstrucciones criticas)
- Documento es uno de los 6 tipos aceptados por el RUNT, original, integro, sin alteraciones
- Reverso coherente con el frente (mismo documento)
- Score facial >= 60 (tolerante con edad del documento pero ESTRICTO con identidad — personas diferentes = score < 30)
- Numero de documento extraido coincide EXACTAMENTE con el registrado
- Sexo coincide entre selfie y documento
- Persona real en vivo (no foto de foto, no pantalla, no documento impreso)
- Score total: promedio ponderado (facial 40%, documento 30%, integridad 15%, liveness 15%)
- aprobado=true SOLO si TODAS las validaciones pasan

REGLA ANTI-FRAUDE: Si la persona del selfie y la persona del documento son VISIBLEMENTE de diferente sexo, diferente estructura craneal, o diferente complexion general = score facial DEBE ser < 20. No tolerar discrepancias graves como "diferencia de edad".`;
}

// POST /certificado/:tramiteId — Genera PDF de certificación de identidad
router.post('/certificado/:tramiteId', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const tramiteId = parseInt(req.params.tramiteId, 10);
    if (!Number.isFinite(tramiteId)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const allRows = await db.select().from(tramitesValidaciones)
      .where(eq(tramitesValidaciones.tramiteId, tramiteId));
    if (!allRows.length) { res.status(404).json({ error: 'Sin validaciones para este trámite' }); return; }
    // El certificado de identidad debe incluir SOLO las validaciones APROBADAS
    // (en matrícula = comprador; en traspaso = vendedor + comprador). Incluir
    // intentos rechazados (p.ej. un comprador equivocado) o reenvíos 'enviado'
    // sin fotos producía páginas con la cédula de otra persona o sin capturas.
    // Fallback a todas si no hay ninguna aprobada (no romper el caso sin aprobación).
    const aprobadas = allRows.filter((r) => r.estado === 'aprobado');
    const rows = aprobadas.length ? aprobadas : allRows;

    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

    const meta = req.body || {};
    const placa = meta.placa || rows[0].placa || '—';
    const vehiculoTxt = meta.vehiculo || rows[0].vehiculoInfo || '—';
    const orgN = meta.orgNombre || 'Organismo de Tránsito';

    const hashInput = rows.map(r => `${r.id}|${r.documento}|${r.estado}|${r.score}|${r.validadoAt}`).join('||');
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
    const radicado = 'CERT-VID-' + Date.now().toString(36).toUpperCase();

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
    const BLACK = rgb(0, 0, 0);
    const NAVY = rgb(0.12, 0.23, 0.54);
    const GRAY = rgb(0.45, 0.45, 0.45);
    const GREEN = rgb(0.06, 0.55, 0.34);
    const RED = rgb(0.86, 0.15, 0.15);

    const SAN: Record<string, string> = { '—': '-', '–': '-', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '…': '...', '✓': 'OK', '°': 'o' };
    const san = (t: any) => { if (t == null) return ''; let s = String(t); for (const [k, v] of Object.entries(SAN)) s = s.split(k).join(v); return s.replace(/[^\x00-\xFF]/g, '?'); };

    const embedImg = async (b64: string | null, label?: string) => {
      if (!b64) { log.debug({ label: label || 'img' }, 'imagen NULL'); return null; }
      try {
        const clean = String(b64).replace(/^data:image\/[a-z]+;base64,/, '');
        log.debug({ label: label || 'img', chars: clean.length }, 'imagen cargada');
        const buf = Buffer.from(clean, 'base64');
        return await pdfDoc.embedJpg(buf).catch(async () => await pdfDoc.embedPng(buf));
      } catch (e: any) { log.warn({ label: label || 'img', err: e.message }, 'falla cargando imagen'); return null; }
    };

    // Resolver foto para PDF: key S3 o legacy cifrado en BD
    const resolvePhotoCert = async (val: string | null): Promise<string | null> => {
      if (!val) return null;
      if (val.startsWith('data:') || val.includes(':')) return decryptPII(val);
      try { return await getPhoto(val); } catch { return null; }
    };

    let pageIdx = 0;
    for (const v of rows) {
      let page = pdfDoc.addPage([612, 792]);
      const PW = 612, PH = 792, M = 40;
      let y = 36;

      const text = (t: string, x: number, opts: any = {}) => {
        const sz = opts.size || 9;
        const f = opts.bold ? fontBold : (opts.mono ? fontMono : font);
        page.drawText(san(t), { x, y: PH - y - sz, size: sz, font: f, color: opts.color || BLACK });
      };
      const textC = (t: string, opts: any = {}) => {
        const sz = opts.size || 9;
        const f = opts.bold ? fontBold : font;
        const w = f.widthOfTextAtSize(san(t), sz);
        page.drawText(san(t), { x: (PW - w) / 2, y: PH - y - sz, size: sz, font: f, color: opts.color || BLACK });
      };
      const rect = (x: number, yt: number, w: number, h: number, opts: any = {}) => {
        page.drawRectangle({ x, y: PH - yt - h, width: w, height: h, color: opts.fill, borderColor: opts.borderColor, borderWidth: opts.borderWidth || 0 });
      };

      /* ENCABEZADO */
      rect(M, 30, PW - 2 * M, 4, { fill: NAVY });
      y = 44;
      textC('CERTIFICACION DE VALIDACION DE IDENTIDAD', { size: 14, bold: true, color: NAVY });
      y += 18;
      textC('Verificacion biometrica forense - Sistema Kyverum', { size: 8, color: GRAY });
      y += 18;
      textC(`Radicado: ${radicado}  -  Pagina ${pageIdx + 1} de ${rows.length}`, { size: 8, color: GRAY });
      y += 18;

      /* INFO DEL TRAMITE */
      rect(M, y, PW - 2 * M, 40, { fill: rgb(0.95, 0.96, 0.99), borderColor: NAVY, borderWidth: 0.7 });
      const yInfo = y;
      text('TRAMITE', M + 10, { size: 8, bold: true, color: NAVY });
      y += 11;
      text(`Placa: ${placa}    Vehiculo: ${vehiculoTxt}`, M + 10, { size: 9 });
      y += 11;
      text(`Organismo: ${orgN}    Tipo: MATRICULA INICIAL`, M + 10, { size: 9 });
      y = yInfo + 46;

      /* PERSONA */
      const ctxLabel = 'COMPRADOR (SOLICITANTE MATRICULA)';
      rect(M, y, PW - 2 * M, 22, { fill: NAVY });
      text(ctxLabel, M + 10, { size: 11, bold: true, color: rgb(1, 1, 1) });
      y += 12;
      const aprobada = v.estado === 'aprobado';
      const estadoTxt = aprobada ? 'VALIDADO' : (v.estado || 'PENDIENTE').toUpperCase();
      text(estadoTxt, PW - M - 70, { size: 11, bold: true, color: rgb(1, 1, 1) });
      y += 18;

      /* Datos personales grid */
      const colData = [
        ['Nombre completo', v.nombre || '-'],
        ['Tipo de documento', v.tipoDoc || 'CC'],
        ['Numero de documento', v.documento || '-'],
        ['Correo electronico', v.email || '-'],
        ['Placa del vehiculo', v.placa || '-'],
        ['Score de coincidencia', v.score != null ? v.score + '/100' : '-']
      ];
      const colW = (PW - 2 * M) / 2;
      colData.forEach((row, i) => {
        const col = i % 2;
        const r = Math.floor(i / 2);
        const xc = M + col * colW;
        const yc = y + r * 20;
        rect(xc, yc, colW - 4, 18, { fill: i % 4 < 2 ? rgb(0.97, 0.97, 0.97) : rgb(1, 1, 1) });
        page.drawText(san(row[0]), { x: xc + 6, y: PH - yc - 7, size: 6.5, font: fontBold, color: NAVY });
        page.drawText(san(row[1]), { x: xc + 6, y: PH - yc - 15, size: 8.5, font, color: BLACK });
      });
      y += Math.ceil(colData.length / 2) * 20 + 8;

      /* FOTOS */
      rect(M, y, PW - 2 * M, 16, { fill: rgb(0.92, 0.93, 0.97) });
      text('CAPTURAS BIOMETRICAS', M + 10, { size: 9, bold: true, color: NAVY });
      y += 22;
      const fotoW = (PW - 2 * M - 20) / 3;
      const fotoH = 110;
      const yFotos = y;
      const labels = ['SELFIE', 'DOC. FRONTAL', 'DOC. REVERSO'];
      log.info({ tramiteId, validacionId: v.id, nombre: maskName(v.nombre), rostro: !!v.fotoRostro, frontal: !!v.fotoCedulaFrontal, reverso: !!v.fotoCedulaReverso }, 'cert-vid: contexto validacion');
      const fotos = [
        await embedImg(await resolvePhotoCert(v.fotoRostro), 'rostro'),
        await embedImg(await resolvePhotoCert(v.fotoCedulaFrontal), 'frontal'),
        await embedImg(await resolvePhotoCert(v.fotoCedulaReverso), 'reverso')
      ];
      for (let i = 0; i < 3; i++) {
        const xf = M + i * (fotoW + 10);
        rect(xf, yFotos, fotoW, fotoH, { borderColor: GRAY, borderWidth: 0.7 });
        if (fotos[i]) {
          const img = fotos[i]!;
          const ratio = Math.min((fotoW - 6) / img.width, (fotoH - 6) / img.height);
          const dw = img.width * ratio;
          const dh = img.height * ratio;
          const dx = xf + (fotoW - dw) / 2;
          const dy = PH - yFotos - fotoH + (fotoH - dh) / 2;
          page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
        } else {
          const lbl = '(sin imagen)';
          const lw = font.widthOfTextAtSize(lbl, 7);
          page.drawText(lbl, { x: xf + (fotoW - lw) / 2, y: PH - yFotos - fotoH / 2, size: 7, font, color: GRAY });
        }
        page.drawText(labels[i], { x: xf + 4, y: PH - yFotos - fotoH - 9, size: 7, font: fontBold, color: NAVY });
      }
      y = yFotos + fotoH + 16;

      /* INFORME FORENSE */
      const detalle = (v.detalle || {}) as any;
      const motivoTxt = detalle.resultado_general?.motivo || (aprobada ? 'Identidad verificada exitosamente' : 'Verificacion no exitosa');
      const compFacial = detalle.comparacion_facial || {};
      const docOcr = detalle.documento_ocr || {};
      const liveness = detalle.liveness || {};

      rect(M, y, PW - 2 * M, 16, { fill: rgb(0.92, 0.93, 0.97) });
      text('INFORME DE VERIFICACION FORENSE', M + 10, { size: 9, bold: true, color: NAVY });
      y += 22;

      const reportRows: [string, string, any][] = [
        ['Resultado', aprobada ? 'APROBADO' : 'RECHAZADO', aprobada ? GREEN : RED],
        ['Coincidencia facial', (compFacial.score != null ? compFacial.score + '/100  ' : '-  ') + (compFacial.coincidencia ? '(positiva)' : '(negativa)'), null],
        ['Liveness (persona real)', liveness.es_persona_real ? 'SI' : 'NO', liveness.es_persona_real ? GREEN : RED],
        ['Rostro visible', liveness.rostro_visible ? 'SI' : 'NO', liveness.rostro_visible ? GREEN : RED],
        ['Tipo de documento', String(docOcr.tipo_documento || '-').toUpperCase(), null],
        ['Documento oficial colombiano', docOcr.es_documento_oficial ? 'SI' : 'NO', docOcr.es_documento_oficial ? GREEN : RED],
        ['Documento integro', docOcr.documento_integro ? 'SI' : 'NO', docOcr.documento_integro ? GREEN : RED]
      ];
      reportRows.forEach((row, i) => {
        const ry = y + i * 13;
        rect(M, ry, PW - 2 * M, 12, { fill: i % 2 === 0 ? rgb(0.97, 0.97, 0.97) : rgb(1, 1, 1) });
        page.drawText(san(row[0]), { x: M + 8, y: PH - ry - 8, size: 7.5, font: fontBold, color: NAVY });
        page.drawText(san(row[1]), { x: M + 200, y: PH - ry - 8, size: 7.5, font, color: row[2] || BLACK });
      });
      y += reportRows.length * 13 + 8;

      /* Observaciones */
      text('Observaciones del sistema:', M, { size: 8, bold: true, color: NAVY });
      y += 10;
      const maxW = PW - 2 * M;
      const words = san(motivoTxt).split(' ');
      let cur = '';
      const motivoLines: string[] = [];
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(test, 8) <= maxW) cur = test;
        else { motivoLines.push(cur); cur = w; }
      }
      if (cur) motivoLines.push(cur);
      motivoLines.slice(0, 5).forEach(ln => { text(ln, M, { size: 8, color: rgb(0.3, 0.3, 0.3) }); y += 10; });
      y += 6;

      /* CADENA DE CUSTODIA */
      rect(M, y, PW - 2 * M, 16, { fill: rgb(0.92, 0.93, 0.97) });
      text('CADENA DE CUSTODIA - METADATOS DE LA SESION', M + 10, { size: 9, bold: true, color: NAVY });
      y += 22;
      const fechaVal = v.validadoAt ? new Date(v.validadoAt).toLocaleString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
      const geoTxt = v.lat && v.lng ? `${parseFloat(v.lat).toFixed(6)}, ${parseFloat(v.lng).toFixed(6)}${v.ciudadGeo ? '  (' + v.ciudadGeo + ')' : ''}` : '(no proporcionada)';
      const metaRows = [
        ['Fecha y hora de validacion', fechaVal],
        ['Direccion IP del solicitante', v.ipAddress || '-'],
        ['Geolocalizacion GPS', geoTxt],
        ['Dispositivo / navegador', (v.userAgent || '-').slice(0, 75)],
        ['Token de sesion (truncado)', v.token ? v.token.slice(0, 16) + '...' : '-'],
        ['Intentos realizados', String(v.intentos || 0)]
      ];
      metaRows.forEach((row, i) => {
        const ry = y + i * 12;
        rect(M, ry, PW - 2 * M, 11, { fill: i % 2 === 0 ? rgb(0.97, 0.97, 0.97) : rgb(1, 1, 1) });
        page.drawText(san(row[0]), { x: M + 8, y: PH - ry - 7.5, size: 7, font: fontBold, color: NAVY });
        page.drawText(san(row[1]), { x: M + 200, y: PH - ry - 7.5, size: 7, font: fontMono, color: rgb(0.2, 0.2, 0.2) });
      });
      y += metaRows.length * 12 + 8;

      /* FOOTER */
      const FOOTER_H = 36;
      if (y + FOOTER_H > PH - 20) { page = pdfDoc.addPage([612, 792]); y = 40; }
      y += 6;
      page.drawLine({ start: { x: M, y: PH - y }, end: { x: PW - M, y: PH - y }, thickness: 0.5, color: GRAY });
      y += 8;
      page.drawText('Hash SHA-256 de auditoria:', { x: M, y: PH - y - 6, size: 6, font: fontBold, color: NAVY });
      y += 8;
      page.drawText(hash.slice(0, 64), { x: M, y: PH - y - 5.5, size: 5.5, font: fontMono, color: rgb(0.3, 0.3, 0.3) });
      y += 8;
      page.drawText('Documento generado automaticamente por el sistema Kyverum. Verificacion biometrica conforme a la Resolucion 17145 de 2023 del Mintransporte.', { x: M, y: PH - y - 5.5, size: 5.5, font, color: GRAY });

      pageIdx++;
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Certificacion_Identidad_${placa}.pdf"`);
    res.send(Buffer.from(pdfBytes));
    audit(req, { action: 'export', resource: 'certificado_identidad', resourceId: String(tramiteId), detail: `Placa: ${placa}` }).catch(() => {});
  } catch (e: any) {
    log.error({ err: e }, 'cert-vid fallo');
    res.status(500).json({ error: 'Error generando certificado: ' + e.message });
  }
});

export default router;
