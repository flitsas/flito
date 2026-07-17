// TRAM-INNOV-EXP-PDF — Expediente certificado PDF + QR embebido.
//
// Genera PDF on-demand (sin persistir en S3 v1). Reutiliza pdf-lib + qrcode
// (mismo stack que RNDC/PESV). Sin PII completa — solo VIN enmascarado.

import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { db } from '../../db/client.js';
import { tramitesDigitales } from '../../db/schema.js';
import { getEntityDocumentStream } from '../../services/storage.js';
import { generateVerifyToken } from './eventos.js';
import type { TimelineEvento } from './eventos.js';

const KYVERUM = 'Kyverum LLC / FLIT Operaciones';
const A4_W = 595.28;
const MARGIN = 50;
const MAX_EVENTOS = 10;

const TIPO_LABEL: Record<string, string> = {
  creado: 'Tramite creado',
  documento_subido: 'Documento subido',
  mandato_subido: 'Mandato subido',
  cambio_estado: 'Cambio de estado',
  cambio_paso: 'Avance de paso',
  enviado_transito: 'Enviado a transito',
  recibido_transito: 'Recibido por transito',
  placa_asignada: 'Placa asignada',
  rechazado_ot: 'Rechazado OT',
  acceso_portal: 'Acceso portal externo',
  verify_token_generado: 'QR verificacion generado',
  expediente_pdf_generado: 'Expediente PDF generado',
};

function sanitize(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\n]/g, '?');
}

function maskVin(vin: string | null): string | null {
  if (!vin) return null;
  if (vin.length <= 4) return vin;
  return `${'*'.repeat(vin.length - 4)}${vin.slice(-4)}`;
}

/** TRAM-MT-02 Fase 3 — branding del organismo destino en la cabecera del PDF. */
export interface OrganismoBranding {
  codigo: string;
  nombre: string;
  ciudad: string;
  alias: string | null;
}

export interface ExpedientePdfMeta {
  tramiteId: number;
  estado: string;
  placa: string | null;
  vinMasked: string | null;
  tipologia: string | null;
  tipologiaNombre: string | null;
  verifyUrl: string;
  verifyExpires: string;
  eventos: { tipo: string; createdAt: string; docHash: string | null }[];
  // Fase 3 — opcionales: no afectan el hash de integridad (branding, no contenido).
  organismo?: OrganismoBranding | null;
  /** Bytes del logo embebibles en pdf-lib (PNG o JPEG). null → sin logo. */
  logoPng?: Buffer | null;
}

const LOGO_MAX_BYTES = 512 * 1024; // 512 KB (alineado con Fase 2b)
const LOGO_FETCH_TIMEOUT_MS = 5000;

/** Detecta PNG/JPEG por firma. pdf-lib solo embebe estos dos formatos raster. */
function detectRasterFormat(buf: Buffer): 'png' | 'jpeg' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

async function streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) return null; // logo demasiado grande → ignorar
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

async function fetchHttpsImage(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer | null> {
  if (!/^https:\/\//i.test(url)) return null; // solo https
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!resp.ok) return null;
    const len = resp.headers.get('content-length');
    if (len && Number(len) > maxBytes) return null;
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  } catch {
    return null; // timeout / red / DNS → fallo silencioso
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cabecera del PDF según el organismo destino (pura, testeable sin pdf-lib).
 * - Con alias → alias + "Expediente preparado — {ciudad}".
 * - Con organismo sin alias → nombre catálogo + "{ciudad} · codigo {codigo}".
 * - Sin organismo → título FLIT por defecto (comportamiento previo).
 */
export function resolveExpedienteHeader(organismo?: OrganismoBranding | null): { titulo: string; subtitulo: string | null } {
  if (organismo) {
    if (organismo.alias) {
      return { titulo: organismo.alias, subtitulo: `Expediente preparado — ${organismo.ciudad}` };
    }
    return { titulo: organismo.nombre, subtitulo: `${organismo.ciudad} · codigo ${organismo.codigo}` };
  }
  return { titulo: 'FLIT — Expediente certificado', subtitulo: null };
}

/**
 * Carga los bytes del logo del organismo desde MinIO (storage key) o una URL
 * https externa, solo si es PNG/JPEG embebible. Cualquier fallo → null (el PDF
 * se genera sin logo, nunca 500). webp/svg no son embebibles → null.
 */
export async function loadOrganismoLogoBytes(opts: {
  storageKey?: string | null;
  externalUrl?: string | null;
}): Promise<Buffer | null> {
  if (opts.storageKey) {
    try {
      const stream = await getEntityDocumentStream(opts.storageKey);
      const buf = await streamToBuffer(stream, LOGO_MAX_BYTES);
      if (buf && detectRasterFormat(buf)) return buf;
    } catch { /* fallo silencioso */ }
  }
  if (opts.externalUrl) {
    const buf = await fetchHttpsImage(opts.externalUrl, LOGO_MAX_BYTES, LOGO_FETCH_TIMEOUT_MS);
    if (buf && detectRasterFormat(buf)) return buf;
  }
  return null;
}

/** Hash SHA-256 del expediente (mismos campos que verificacion publica + ultimos eventos). */
export function computeExpedienteIntegrityHash(meta: Omit<ExpedientePdfMeta, 'verifyUrl' | 'verifyExpires' | 'tipologiaNombre'>): string {
  const canonical = JSON.stringify({
    tramiteId: meta.tramiteId,
    estado: meta.estado,
    placa: meta.placa,
    vinMasked: meta.vinMasked,
    tipologia: meta.tipologia,
    eventos: meta.eventos.map((e) => ({ tipo: e.tipo, docHash: e.docHash, createdAt: e.createdAt })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function fmtFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Construye el PDF (puro IO pdf-lib + qrcode). */
export async function buildExpedientePdf(meta: ExpedientePdfMeta): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Expediente trámite ${meta.tramiteId}`);
  doc.setAuthor(KYVERUM);
  doc.setProducer('Operaciones Kyverum');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([A4_W, 841.89]);
  const { height } = page.getSize();
  let y = height - MARGIN;

  const draw = (text: string, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.bold ? fontBold : font;
    const color = opts.color ? rgb(opts.color[0], opts.color[1], opts.color[2]) : rgb(0.15, 0.15, 0.15);
    page.drawText(sanitize(text), { x: MARGIN, y, size, font: f, color });
    y -= size + 4;
  };

  // Fase 3 — logo del organismo en la esquina superior derecha (máx 80×80 pt).
  // Fallo silencioso: un logo corrupto nunca rompe la generación del PDF.
  if (meta.logoPng) {
    try {
      const fmt = detectRasterFormat(meta.logoPng);
      const img = fmt === 'jpeg' ? await doc.embedJpg(meta.logoPng) : await doc.embedPng(meta.logoPng);
      const dims = img.scaleToFit(80, 80);
      page.drawImage(img, {
        x: A4_W - MARGIN - dims.width,
        y: height - MARGIN - dims.height + 6,
        width: dims.width,
        height: dims.height,
      });
    } catch { /* logo inválido → PDF sin logo */ }
  }

  // Fase 3 — cabecera según organismo destino (co-branding: el pie FLIT se mantiene).
  const { titulo, subtitulo } = resolveExpedienteHeader(meta.organismo);
  draw(titulo, { size: 14, bold: true, color: [0.2, 0.35, 0.65] });
  if (subtitulo) draw(subtitulo, { size: 9, color: [0.4, 0.4, 0.4] });
  y -= 4;
  draw(`Tramite #${meta.tramiteId}`, { size: 11, bold: true });
  draw(`Estado: ${meta.estado}`);
  if (meta.placa) draw(`Placa: ${meta.placa}`);
  if (meta.vinMasked) draw(`VIN: ${meta.vinMasked}`);
  if (meta.tipologiaNombre) draw(`Tipologia: ${meta.tipologiaNombre}`);
  draw(`Emitido: ${fmtFecha(new Date().toISOString())}`);
  y -= 8;

  draw('Linea de tiempo (ultimos eventos)', { size: 11, bold: true });
  const eventos = meta.eventos.slice(-MAX_EVENTOS);
  for (const e of eventos) {
    const label = TIPO_LABEL[e.tipo] || e.tipo;
    draw(`- ${label} — ${fmtFecha(e.createdAt)}`, { size: 9 });
    if (e.docHash) draw(`  sha256: ${e.docHash.slice(0, 32)}...`, { size: 8, color: [0.45, 0.45, 0.45] });
  }
  y -= 12;

  const integrity = computeExpedienteIntegrityHash({
    tramiteId: meta.tramiteId,
    estado: meta.estado,
    placa: meta.placa,
    vinMasked: meta.vinMasked,
    tipologia: meta.tipologia,
    eventos: meta.eventos,
  });
  draw('Integridad expediente (SHA-256):', { size: 9, bold: true });
  draw(integrity, { size: 8, color: [0.35, 0.35, 0.35] });
  y -= 8;

  draw('Documento informativo — no sustituye radicacion oficial en organismo de transito.', { size: 8, color: [0.5, 0.5, 0.5] });
  draw(`Verificacion QR valida hasta: ${fmtFecha(meta.verifyExpires)}`, { size: 8, color: [0.5, 0.5, 0.5] });

  const qrPng = await QRCode.toBuffer(meta.verifyUrl, { type: 'png', width: 200, margin: 1, errorCorrectionLevel: 'M' });
  const qrImg = await doc.embedPng(qrPng);
  page.drawImage(qrImg, { x: A4_W - MARGIN - 130, y: 70, width: 120, height: 120 });
  page.drawText(sanitize('Verificacion QR'), { x: A4_W - MARGIN - 120, y: 58, size: 8, font, color: rgb(0.45, 0.45, 0.45) });

  page.drawText(sanitize(KYVERUM), { x: MARGIN, y: 40, size: 8, font, color: rgb(0.5, 0.5, 0.5) });

  return Buffer.from(await doc.save());
}

/** Token de verificacion vigente o regenera uno nuevo (TTL 7d). */
export async function resolveVerifyUrl(
  tramiteId: number,
  actor: { userId: number; role?: string },
  publicUrl: string,
): Promise<{ url: string; expires: string; token: string } | null> {
  const [t] = await db.select({
    id: tramitesDigitales.id,
    verifyToken: tramitesDigitales.verifyToken,
    verifyTokenExpires: tramitesDigitales.verifyTokenExpires,
  }).from(tramitesDigitales).where(eq(tramitesDigitales.id, tramiteId)).limit(1);
  if (!t) return null;

  const expMs = t.verifyTokenExpires ? (t.verifyTokenExpires as Date).getTime() : 0;
  if (t.verifyToken && expMs > Date.now()) {
    const expires = (t.verifyTokenExpires as Date).toISOString();
    return { token: t.verifyToken, expires, url: `${publicUrl}/tramite/verificar?t=${t.verifyToken}` };
  }

  const result = await generateVerifyToken(tramiteId, actor);
  if (!result.ok) return null;
  return { token: result.token, expires: result.expires, url: `${publicUrl}/tramite/verificar?t=${result.token}` };
}

export function timelineToPdfEventos(eventos: TimelineEvento[]): ExpedientePdfMeta['eventos'] {
  return eventos.slice(-MAX_EVENTOS).map((e) => ({
    tipo: e.tipo,
    createdAt: e.createdAt,
    docHash: e.docHash,
  }));
}

export { maskVin };
