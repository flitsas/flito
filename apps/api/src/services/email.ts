import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

// Servicio compartido de email. Usa el mismo transport singleton optimizado para Office 365
// que ya usa identidad biométrica. Sin SMTP configurado, sendEmail() devuelve null y NO falla.

let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      tls: { minVersion: 'TLSv1.2' },
      pool: true,
      maxConnections: 3,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      dnsTimeout: 10_000,
    });
  }
  return transport;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (e: string): boolean => EMAIL_RE.test(e);

export const escapeHtml = (s: string): string => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  replyTo?: string;
}

interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const tp = getTransport();
  if (!tp) return { ok: false, error: 'SMTP no configurado' };

  const recipients = Array.isArray(args.to) ? args.to : [args.to];
  const valid = recipients.filter(isValidEmail);
  if (valid.length === 0) return { ok: false, error: 'sin_destinatarios' };

  try {
    const info = await tp.sendMail({
      from: { name: env.SMTP_FROM_NAME, address: env.SMTP_USER! },
      to: valid.join(', '),
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo ?? env.SMTP_USER!,
      headers: {
        'List-Unsubscribe': `<mailto:${env.SMTP_USER}?subject=unsubscribe>`,
        ...(args.headers ?? {}),
      },
    });
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'error_smtp' };
  }
}

export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}
