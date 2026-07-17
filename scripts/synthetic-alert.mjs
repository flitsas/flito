#!/usr/bin/env node
/**
 * Alerta operaciones synthetic — email vía SMTP de apps/api/.env (prod).
 * Uso: node scripts/synthetic-alert.mjs "mensaje de fallo"
 */
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const envFile = process.env.OPERACIONES_ENV_FILE
  || path.join(root, 'apps/api/.env');
dotenv.config({ path: envFile });

const message = process.argv.slice(2).join(' ').trim()
  || 'Prueba de alerta synthetic — operaciones.flitsas.com';

const recipients = (process.env.SYNTHETIC_ALERT_EMAIL || 'info@kyverum.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.error('synthetic-alert: SMTP no configurado en', envFile);
  process.exit(1);
}

const port = Number(process.env.SMTP_PORT || 587);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const subject = `[FLIT Operaciones] Synthetic check FAIL — ${new Date().toISOString()}`;
const text = `${message}\n\nHost: ${process.env.BASE_URL || 'https://operaciones.flitsas.com'}\nLog: /var/log/operaciones-synthetic.log\nRunbook: docs/runbook/MONITORING-SYNTHETIC.md`;

await transport.sendMail({
  from: { name: process.env.SMTP_FROM_NAME || 'FLIT Operaciones', address: process.env.SMTP_USER },
  to: recipients.join(', '),
  subject,
  text,
});

console.log(`synthetic-alert: email enviado a ${recipients.join(', ')}`);
