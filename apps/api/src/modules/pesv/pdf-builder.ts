// PDF builder para documentos PESV: política, acta de comité, plan anual, diagnóstico,
// resumen ejecutivo SISI/PESV. Usa pdf-lib (sin nativos, ya instalado).
//
// Bloque de firma electrónica (Ley 527/1999): última página con SHA-256 del contenido,
// nombre+rol del firmante, timestamp UTC, organización (Kyverum LLC).
// NO es firma digital certificada — eso requiere cert de Certicámara o similar CA acreditada.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import crypto from 'crypto';

const KYVERUM = 'Kyverum LLC';
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;

interface SignerInfo {
  nombre: string;
  rol: string;
  userId: number;
  timestamp: Date;
}

interface BuildPolicyOpts {
  version: number;
  titulo: string;
  contenidoMd: string;
  vigenciaDesde: string;
  vigenciaHasta?: string | null;
  signer: SignerInfo;
}

interface BuildActaOpts {
  comiteNombre: string;
  numero: number;
  fecha: string;
  lugar?: string | null;
  agendaMd?: string | null;
  decisionesMd?: string | null;
  asistentesNombres: string[];
  signer: SignerInfo;
}

interface BuildPlanOpts {
  anio: number;
  objetivoGeneral: string;
  presupuestoCop: string;
  estado: string;
  objetivos: Array<{ codigo: string; descripcion: string; metaPct: string }>;
}

interface BuildDiagOpts {
  anio: number;
  fecha: string;
  scoreGlobal: number;
  estado: string;
  estandares: Array<{ codigo: string; fase: string; nombre: string; scorePct: number }>;
}

interface BuildResumenOpts {
  anio: number;
  trimestre: string;
  empresa: string;
  politicaVigente: { version: number; titulo: string; firmadaAt: string | null } | null;
  planActual: { anio: number; estado: string; presupuestoCop: string } | null;
  diagnostico: { anio: number; scoreGlobal: number } | null;
  jornadasMes: { total: number; alarmasMes: number; conductoresExcedenSemanal: number };
  rutas: { total: number; conAnalisisTrimestre: number; sinAnalisisTrimestre: number };
}

function sanitize(s: string): string {
  // pdf-lib WinAnsi encoding rechaza algunos caracteres unicode. Normalizamos.
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E\n]/g, '?');
}

async function newDoc(): Promise<{ doc: PDFDocument; font: any; fontBold: any }> {
  const doc = await PDFDocument.create();
  doc.setTitle('Documento PESV');
  doc.setAuthor(KYVERUM);
  doc.setProducer('Operaciones Kyverum');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, fontBold };
}

function drawHeader(page: any, fontBold: any, titulo: string): number {
  const { height } = page.getSize();
  page.drawText(sanitize('PESV — ' + KYVERUM), { x: MARGIN, y: height - MARGIN, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(sanitize(titulo), { x: MARGIN, y: height - MARGIN - 20, size: 14, font: fontBold });
  page.drawLine({ start: { x: MARGIN, y: height - MARGIN - 28 }, end: { x: A4_W - MARGIN, y: height - MARGIN - 28 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  return height - MARGIN - 50;
}

function wrap(text: string, max: number): string[] {
  const words = sanitize(text).split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { lines.push(cur); cur = w; } else { cur = (cur + ' ' + w).trim(); }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawBlock(page: any, font: any, text: string, x: number, y: number, size = 10, lineH = 14, maxChars = 95): number {
  for (const line of wrap(text, maxChars).slice(0, 80)) {
    page.drawText(line, { x, y, size, font });
    y -= lineH;
    if (y < MARGIN + 100) break;
  }
  return y;
}

function drawFirmaBlock(page: any, font: any, fontBold: any, signer: SignerInfo, contentHash: string): void {
  const y0 = MARGIN + 80;
  page.drawLine({ start: { x: MARGIN, y: y0 + 10 }, end: { x: A4_W - MARGIN, y: y0 + 10 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  page.drawText(sanitize('FIRMA ELECTRONICA (Ley 527/1999)'), { x: MARGIN, y: y0, size: 8, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(sanitize(`Firmado por: ${signer.nombre} (${signer.rol})`), { x: MARGIN, y: y0 - 14, size: 9, font });
  page.drawText(sanitize(`Organizacion: ${KYVERUM}`), { x: MARGIN, y: y0 - 28, size: 9, font });
  page.drawText(sanitize(`Fecha y hora UTC: ${signer.timestamp.toISOString()}`), { x: MARGIN, y: y0 - 42, size: 9, font });
  page.drawText(sanitize(`SHA-256 del contenido: ${contentHash}`), { x: MARGIN, y: y0 - 56, size: 7, font, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(sanitize(`UserID: ${signer.userId}`), { x: MARGIN, y: y0 - 70, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
}

export async function buildPolicyPdf(opts: BuildPolicyOpts): Promise<Buffer> {
  const { doc, font, fontBold } = await newDoc();
  const page = doc.addPage([A4_W, A4_H]);
  let y = drawHeader(page, fontBold, `Politica de Seguridad Vial — version ${opts.version}`);
  page.drawText(sanitize(opts.titulo), { x: MARGIN, y, size: 12, font: fontBold }); y -= 18;
  page.drawText(sanitize(`Vigente desde: ${opts.vigenciaDesde}${opts.vigenciaHasta ? ' hasta ' + opts.vigenciaHasta : ''}`), { x: MARGIN, y, size: 9, font }); y -= 24;
  drawBlock(page, font, opts.contenidoMd, MARGIN, y);
  const hash = crypto.createHash('sha256').update(opts.contenidoMd, 'utf8').digest('hex');
  drawFirmaBlock(page, font, fontBold, opts.signer, hash);
  return Buffer.from(await doc.save());
}

export async function buildActaPdf(opts: BuildActaOpts): Promise<Buffer> {
  const { doc, font, fontBold } = await newDoc();
  const page = doc.addPage([A4_W, A4_H]);
  let y = drawHeader(page, fontBold, `Acta No. ${opts.numero} — ${opts.comiteNombre}`);
  page.drawText(sanitize(`Fecha: ${opts.fecha}${opts.lugar ? ' — Lugar: ' + opts.lugar : ''}`), { x: MARGIN, y, size: 10, font }); y -= 20;
  page.drawText(sanitize(`Asistentes (${opts.asistentesNombres.length}): ${opts.asistentesNombres.join(', ')}`), { x: MARGIN, y, size: 9, font }); y -= 22;
  page.drawText(sanitize('AGENDA'), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14;
  y = drawBlock(page, font, opts.agendaMd ?? '(sin agenda)', MARGIN, y);
  y -= 10;
  page.drawText(sanitize('DECISIONES'), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14;
  drawBlock(page, font, opts.decisionesMd ?? '(sin decisiones)', MARGIN, y);
  const hash = crypto.createHash('sha256').update((opts.agendaMd ?? '') + '|' + (opts.decisionesMd ?? ''), 'utf8').digest('hex');
  drawFirmaBlock(page, font, fontBold, opts.signer, hash);
  return Buffer.from(await doc.save());
}

export async function buildPlanPdf(opts: BuildPlanOpts): Promise<Buffer> {
  const { doc, font, fontBold } = await newDoc();
  const page = doc.addPage([A4_W, A4_H]);
  let y = drawHeader(page, fontBold, `Plan Anual PESV ${opts.anio} — Estado: ${opts.estado}`);
  page.drawText(sanitize(`Presupuesto: $ ${opts.presupuestoCop}`), { x: MARGIN, y, size: 10, font }); y -= 18;
  page.drawText(sanitize('OBJETIVO GENERAL'), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14;
  y = drawBlock(page, font, opts.objetivoGeneral, MARGIN, y);
  y -= 10;
  page.drawText(sanitize('OBJETIVOS Y METAS'), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14;
  for (const o of opts.objetivos) {
    page.drawText(sanitize(`${o.codigo}: ${o.descripcion} (meta ${o.metaPct}%)`), { x: MARGIN, y, size: 9, font }); y -= 12;
    if (y < MARGIN + 20) break;
  }
  return Buffer.from(await doc.save());
}

export async function buildDiagnosticoPdf(opts: BuildDiagOpts): Promise<Buffer> {
  const { doc, font, fontBold } = await newDoc();
  const page = doc.addPage([A4_W, A4_H]);
  let y = drawHeader(page, fontBold, `Diagnostico PESV ${opts.anio} — Score: ${opts.scoreGlobal.toFixed(1)}%`);
  page.drawText(sanitize(`Fecha: ${opts.fecha} — Estado: ${opts.estado}`), { x: MARGIN, y, size: 10, font }); y -= 20;
  page.drawText(sanitize('24 PASOS PHVA (Res. 40595/2022)'), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14;
  for (const e of opts.estandares) {
    if (y < MARGIN + 20) break;
    page.drawText(sanitize(`P${e.codigo} [${e.fase}] ${e.nombre}: ${e.scorePct.toFixed(0)}%`), { x: MARGIN, y, size: 8, font }); y -= 11;
  }
  return Buffer.from(await doc.save());
}

export async function buildResumenSisiPdf(opts: BuildResumenOpts): Promise<Buffer> {
  const { doc, font, fontBold } = await newDoc();
  const page = doc.addPage([A4_W, A4_H]);
  let y = drawHeader(page, fontBold, `Resumen PESV ${opts.anio} — ${opts.empresa}`);
  page.drawText(sanitize(`Periodo: ${opts.trimestre} (corte ${new Date().toISOString().slice(0, 10)})`), { x: MARGIN, y, size: 10, font }); y -= 22;

  const sec = (t: string) => { page.drawText(sanitize(t), { x: MARGIN, y, size: 11, font: fontBold }); y -= 14; };
  const line = (t: string) => { page.drawText(sanitize(t), { x: MARGIN, y, size: 9, font }); y -= 12; };

  sec('DOCUMENTOS PESV');
  line(`Politica vigente: ${opts.politicaVigente ? `v${opts.politicaVigente.version} — ${opts.politicaVigente.titulo} (firmada ${opts.politicaVigente.firmadaAt?.slice(0, 10) ?? '-'})` : 'NO HAY POLITICA VIGENTE'}`);
  line(`Plan ${opts.anio}: ${opts.planActual ? `${opts.planActual.estado} — presupuesto $${opts.planActual.presupuestoCop}` : 'NO REGISTRADO'}`);
  line(`Diagnostico: ${opts.diagnostico ? `score ${opts.diagnostico.scoreGlobal.toFixed(1)}%` : 'NO REGISTRADO'}`);
  y -= 10;

  sec('CONTROL DE JORNADA (mes en curso)');
  line(`Jornadas registradas: ${opts.jornadasMes.total}`);
  line(`Alarmas generadas: ${opts.jornadasMes.alarmasMes}`);
  line(`Conductores que excedieron 60h semanales: ${opts.jornadasMes.conductoresExcedenSemanal}`);
  y -= 10;

  sec('RUTAS Y RIESGO TRIMESTRAL');
  line(`Total rutas activas: ${opts.rutas.total}`);
  line(`Con analisis del trimestre: ${opts.rutas.conAnalisisTrimestre}`);
  line(`Sin analisis del trimestre: ${opts.rutas.sinAnalisisTrimestre}`);
  y -= 10;

  sec('NORMATIVA APLICABLE');
  line('- Resolucion 40595 de 2022 (Min Transporte)');
  line('- Resolucion 20223040045295 de 2022 (24 estandares minimos PHVA)');
  line('- Decreto 1079 de 2015 + Resolucion 12379 de 2012 (jornada conductor)');
  line('- Ley 1503 de 2011 + Decreto 2851 de 2013');

  return Buffer.from(await doc.save());
}
