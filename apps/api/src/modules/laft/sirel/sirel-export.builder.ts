// Builder de export ROS para data-entry humano en el portal SIREL de la UIAF
// (https://www.uiaf.gov.co/sirel). El portal no expone API ni XSD pública: el oficial
// de cumplimiento debe transcribir manualmente los campos. Este builder produce dos
// artefactos firmables:
//   - PDF (BORRADOR con watermark diagonal): documento humanamente legible que el
//     oficial usa como referencia visual + firma electrónica Ley 527 con SHA-256.
//   - CSV (UTF-8 BOM): una fila por campo SIREL clave=valor para copy-paste rápido.
//
// El SHA-256 de retorno es del CSV (canónico). Se persiste en la BD y se imprime al pie
// del PDF para que el oficial pueda verificar integridad cruzada antes de transcribir.
//
// Normativa: Resolución UIAF 122/2021 (formato ROS) + Decreto 1497/2002 (deber de
// reporte) + Ley 527/1999 (firma electrónica).

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import crypto from 'crypto';

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;
const KYVERUM = 'Kyverum LLC';

interface RosDraftLike {
  id: number;
  operationId: number;
  generatedAt: Date | string;
  clasificadoAt?: Date | string | null;
  slaDueAt?: Date | string | null;
  sirelPayload: unknown; // JSON con encabezado/operacion/contraparte/notas
  notes?: string | null;
}

interface CounterpartyLike {
  kind?: string | null;
  docType?: string | null;
  docNumber?: string | null;
  fullName?: string | null;
  country?: string | null;
  city?: string | null;
  isPep?: boolean | null;
  pepRole?: string | null;
  fundOrigin?: string | null;
  riskLevel?: string | null;
  status?: string | null;
}

export interface RosExportResult {
  pdf: Uint8Array;
  csv: string;
  sha256: string; // hex sha256 del CSV (canónico)
}

interface SignerInfo {
  nombre: string;
  rol: string;
  userId: number;
  timestamp: Date;
}

interface BuildOpts {
  ros: RosDraftLike;
  counterparty: CounterpartyLike | null;
  signer: SignerInfo;
}

// pdf-lib usa WinAnsi por defecto: caracteres no ASCII rompen drawText.
// Normalizamos quitando acentos y reemplazando los demás por '?'.
function sanitize(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E\n]/g, '?');
}

function wrap(text: string, max: number): string[] {
  const words = sanitize(text).split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { lines.push(cur); cur = w; }
    else { cur = (cur + ' ' + w).trim(); }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  try { return new Date(d).toISOString(); } catch { return String(d); }
}

// CSV escape conforme RFC 4180: si tiene coma, comilla o salto de línea, envolver y duplicar comillas.
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsvRows(opts: BuildOpts): Array<[string, string]> {
  const { ros, counterparty } = opts;
  const payload = (ros.sirelPayload ?? {}) as Record<string, any>;
  const op = payload.operacion ?? {};
  const enc = payload.encabezado ?? {};

  const senales = Array.isArray(op.senales_alerta)
    ? op.senales_alerta.map((s: any) => typeof s === 'string' ? s : JSON.stringify(s)).join(' | ')
    : '';

  return [
    ['campo_sirel', 'valor'],
    ['tipo_reporte', String(enc.tipo_reporte ?? 'ROS')],
    ['fecha_generacion', fmtDate(ros.generatedAt)],
    ['fecha_clasificacion', fmtDate(ros.clasificadoAt)],
    ['sla_vence_at', fmtDate(ros.slaDueAt)],
    ['entidad_reportante_nombre', String(enc.entidad_reportante?.name ?? '')],
    ['entidad_reportante_nit', String(enc.entidad_reportante?.nit ?? '')],
    ['empleado_cumplimiento', String(enc.empleado_cumplimiento ?? '')],
    ['operacion_id_interno', String(ros.operationId)],
    ['operacion_fecha_deteccion', fmtDate(op.fecha_deteccion)],
    ['operacion_origen', String(op.origen ?? '')],
    ['operacion_monto', String(op.monto ?? '')],
    ['operacion_moneda', String(op.moneda ?? '')],
    ['operacion_descripcion', String(op.descripcion ?? '')],
    ['operacion_senales_alerta', senales],
    ['operacion_analisis', String(op.analisis ?? '')],
    ['contraparte_tipo', String(counterparty?.kind ?? '')],
    ['contraparte_documento_tipo', String(counterparty?.docType ?? '')],
    ['contraparte_documento_numero', String(counterparty?.docNumber ?? '')],
    ['contraparte_nombre', String(counterparty?.fullName ?? '')],
    ['contraparte_pais', String(counterparty?.country ?? '')],
    ['contraparte_ciudad', String(counterparty?.city ?? '')],
    ['contraparte_es_pep', counterparty?.isPep ? 'SI' : 'NO'],
    ['contraparte_cargo_pep', String(counterparty?.pepRole ?? '')],
    ['contraparte_origen_fondos', String(counterparty?.fundOrigin ?? '')],
    ['contraparte_nivel_riesgo', String(counterparty?.riskLevel ?? '')],
    ['contraparte_estado', String(counterparty?.status ?? '')],
    ['notas_oficial', String(ros.notes ?? '')],
  ];
}

export function buildRosCsvExport(ros: RosDraftLike, counterparty: CounterpartyLike | null): string {
  const signerStub: SignerInfo = { nombre: '', rol: '', userId: 0, timestamp: new Date(0) };
  const rows = buildCsvRows({ ros, counterparty, signer: signerStub });
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  // BOM para que Excel/LibreOffice abran como UTF-8 sin pasos manuales.
  return '﻿' + body + '\r\n';
}

function drawWatermark(page: any, font: any): void {
  // Watermark diagonal "BORRADOR — RADICAR EN SIREL" para que nadie lo confunda
  // con un radicado real. Detectable por tests vía page text content.
  page.drawText('BORRADOR - RADICAR EN SIREL', {
    x: 90, y: 380, size: 38, font, color: rgb(0.85, 0.7, 0.7),
    rotate: degrees(45), opacity: 0.35,
  });
}

function drawHeader(page: any, fontBold: any, font: any, ros: RosDraftLike): number {
  page.drawText(sanitize(`ROS - ${KYVERUM}`), { x: MARGIN, y: A4_H - MARGIN, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(sanitize('Reporte de Operacion Sospechosa - Borrador para SIREL UIAF'), {
    x: MARGIN, y: A4_H - MARGIN - 18, size: 13, font: fontBold,
  });
  page.drawText(sanitize(`Resolucion UIAF 122/2021 + Decreto 1497/2002 - ROS interno #${ros.id} (operacion #${ros.operationId})`), {
    x: MARGIN, y: A4_H - MARGIN - 34, size: 8, font, color: rgb(0.4, 0.4, 0.4),
  });
  page.drawLine({
    start: { x: MARGIN, y: A4_H - MARGIN - 42 }, end: { x: A4_W - MARGIN, y: A4_H - MARGIN - 42 },
    thickness: 0.5, color: rgb(0.7, 0.7, 0.7),
  });
  return A4_H - MARGIN - 60;
}

function section(page: any, fontBold: any, title: string, y: number): number {
  page.drawText(sanitize(title), { x: MARGIN, y, size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.4) });
  return y - 14;
}

function line(page: any, font: any, label: string, value: string, y: number): number {
  if (y < MARGIN + 110) return y; // dejar espacio para firma
  for (const ln of wrap(`${label}: ${value}`, 95)) {
    page.drawText(ln, { x: MARGIN, y, size: 9, font });
    y -= 12;
    if (y < MARGIN + 110) return y;
  }
  return y;
}

function drawSignature(page: any, font: any, fontBold: any, signer: SignerInfo, sha256: string): void {
  const y0 = MARGIN + 70;
  page.drawLine({
    start: { x: MARGIN, y: y0 + 10 }, end: { x: A4_W - MARGIN, y: y0 + 10 },
    thickness: 0.5, color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText(sanitize('FIRMA ELECTRONICA (Ley 527/1999)'), { x: MARGIN, y: y0, size: 8, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(sanitize(`Oficial de Cumplimiento: ${signer.nombre} (${signer.rol})`), { x: MARGIN, y: y0 - 14, size: 9, font });
  page.drawText(sanitize(`Organizacion: ${KYVERUM}`), { x: MARGIN, y: y0 - 28, size: 9, font });
  page.drawText(sanitize(`Fecha y hora UTC: ${signer.timestamp.toISOString()}`), { x: MARGIN, y: y0 - 42, size: 9, font });
  page.drawText(sanitize(`SHA-256 export CSV: ${sha256}`), { x: MARGIN, y: y0 - 56, size: 7, font, color: rgb(0.3, 0.3, 0.3) });
}

export async function buildRosPdfExport(
  ros: RosDraftLike,
  counterparty: CounterpartyLike | null,
  signer: SignerInfo,
  csvSha256: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Metadata sin comprimir (queda en texto claro al pie del PDF) — permite verificación
  // externa rápida del SHA-256 del CSV y del estado BORRADOR sin descomprimir streams.
  doc.setTitle(`ROS borrador SIREL #${ros.id} - BORRADOR - SHA256:${csvSha256}`);
  doc.setSubject(`BORRADOR - RADICAR EN SIREL - sha256=${csvSha256}`);
  doc.setKeywords(['BORRADOR', 'RADICAR EN SIREL', 'ROS', 'UIAF', csvSha256]);
  doc.setAuthor(KYVERUM);
  doc.setProducer('Operaciones Kyverum - LAFT/SARLAFT');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([A4_W, A4_H]);

  let y = drawHeader(page, fontBold, font, ros);
  drawWatermark(page, fontBold);

  const payload = (ros.sirelPayload ?? {}) as Record<string, any>;
  const op = payload.operacion ?? {};
  const enc = payload.encabezado ?? {};

  y = section(page, fontBold, 'ENTIDAD REPORTANTE', y);
  y = line(page, font, 'Nombre', String(enc.entidad_reportante?.name ?? ''), y);
  y = line(page, font, 'NIT', String(enc.entidad_reportante?.nit ?? ''), y);
  y = line(page, font, 'Empleado de Cumplimiento', String(enc.empleado_cumplimiento ?? ''), y);
  y -= 6;

  y = section(page, fontBold, 'CONTRAPARTE', y);
  if (counterparty) {
    y = line(page, font, 'Tipo', String(counterparty.kind ?? ''), y);
    y = line(page, font, 'Documento', `${counterparty.docType ?? ''} ${counterparty.docNumber ?? ''}`, y);
    y = line(page, font, 'Nombre', String(counterparty.fullName ?? ''), y);
    y = line(page, font, 'Pais / Ciudad', `${counterparty.country ?? ''} / ${counterparty.city ?? ''}`, y);
    y = line(page, font, 'PEP', counterparty.isPep ? `SI (${counterparty.pepRole ?? ''})` : 'NO', y);
    y = line(page, font, 'Origen de fondos', String(counterparty.fundOrigin ?? ''), y);
    y = line(page, font, 'Nivel de riesgo', String(counterparty.riskLevel ?? ''), y);
  } else {
    y = line(page, font, 'Contraparte', '(sin contraparte vinculada)', y);
  }
  y -= 6;

  y = section(page, fontBold, 'OPERACION SOSPECHOSA', y);
  y = line(page, font, 'Detectada', fmtDate(op.fecha_deteccion), y);
  y = line(page, font, 'Origen / Canal', String(op.origen ?? ''), y);
  y = line(page, font, 'Monto', `${op.monto ?? ''} ${op.moneda ?? ''}`, y);
  y = line(page, font, 'Descripcion', String(op.descripcion ?? ''), y);
  y = line(page, font, 'Analisis del oficial', String(op.analisis ?? ''), y);
  y -= 6;

  y = section(page, fontBold, 'SENALES DE ALERTA', y);
  const senales: any[] = Array.isArray(op.senales_alerta) ? op.senales_alerta : [];
  if (!senales.length) {
    y = line(page, font, '-', '(sin senales registradas)', y);
  } else {
    for (const s of senales) {
      y = line(page, font, '-', typeof s === 'string' ? s : JSON.stringify(s), y);
      if (y < MARGIN + 130) break;
    }
  }

  drawSignature(page, font, fontBold, signer, csvSha256);
  // useObjectStreams:false → flujos sin compresión, así el SHA-256 y el watermark
  // quedan en texto claro dentro del PDF (útil para auditoría externa con grep).
  // El tradeoff es ~2-3x el tamaño en bytes; para un ROS de 1 página es marginal.
  return doc.save({ useObjectStreams: false });
}

export async function buildRosExport(opts: BuildOpts): Promise<RosExportResult> {
  const csv = buildRosCsvExport(opts.ros, opts.counterparty);
  const sha256 = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
  const pdf = await buildRosPdfExport(opts.ros, opts.counterparty, opts.signer, sha256);
  return { pdf, csv, sha256 };
}
