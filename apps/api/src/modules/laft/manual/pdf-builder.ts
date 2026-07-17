// PDF builder para Manual SARLAFT versionado. Reusa pattern de pesv/pdf-builder
// (firma electrónica Ley 527/1999 con SHA-256 del contenido + bloque firmante).
// Output A4, Helvetica, sin nativos.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import crypto from 'crypto';

const KYVERUM = 'Kyverum LLC';
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;

export interface ManualSignerInfo {
  nombre: string;
  rol: string;
  userId: number;
  timestamp: Date;
}

export interface BuildManualOpts {
  version: number;
  titulo: string;
  contenidoMd: string;
  motivoCambio?: string | null;
  representante?: ManualSignerInfo | null;
  oficial?: ManualSignerInfo | null;
}

function sanitize(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E\n]/g, '?');
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of sanitize(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    const words = para.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) { out.push(cur); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
  }
  return out;
}

export async function buildManualPdf(opts: BuildManualOpts): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Manual SARLAFT — ' + KYVERUM);
  doc.setAuthor(KYVERUM);
  doc.setProducer('Operaciones Kyverum');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Página 1: cabecera + contenido principal.
  let page = doc.addPage([A4_W, A4_H]);
  page.drawText(sanitize('SARLAFT — ' + KYVERUM), {
    x: MARGIN, y: A4_H - MARGIN, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3),
  });
  page.drawText(sanitize(`Manual SARLAFT — version ${opts.version}`), {
    x: MARGIN, y: A4_H - MARGIN - 22, size: 14, font: fontBold,
  });
  page.drawLine({
    start: { x: MARGIN, y: A4_H - MARGIN - 30 },
    end: { x: A4_W - MARGIN, y: A4_H - MARGIN - 30 },
    thickness: 0.5, color: rgb(0.7, 0.7, 0.7),
  });

  let y = A4_H - MARGIN - 50;
  page.drawText(sanitize(opts.titulo), { x: MARGIN, y, size: 12, font: fontBold });
  y -= 18;
  if (opts.motivoCambio) {
    page.drawText(sanitize(`Motivo del cambio: ${opts.motivoCambio.slice(0, 200)}`), {
      x: MARGIN, y, size: 9, font, color: rgb(0.4, 0.4, 0.4),
    });
    y -= 18;
  }

  for (const line of wrap(opts.contenidoMd, 95)) {
    if (y < MARGIN + 100) {
      page = doc.addPage([A4_W, A4_H]);
      y = A4_H - MARGIN;
    }
    if (line) page.drawText(line, { x: MARGIN, y, size: 10, font });
    y -= 14;
  }

  // Bloque de firmas (Ley 527/1999) en la página actual o una nueva si no cabe.
  const blockH = 180;
  if (y < MARGIN + blockH) {
    page = doc.addPage([A4_W, A4_H]);
    y = A4_H - MARGIN;
  }
  const firmasY = MARGIN + 20;
  page.drawLine({
    start: { x: MARGIN, y: firmasY + blockH - 10 },
    end: { x: A4_W - MARGIN, y: firmasY + blockH - 10 },
    thickness: 0.5, color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText(sanitize('FIRMA ELECTRONICA (Ley 527/1999) — Manual SARLAFT'), {
    x: MARGIN, y: firmasY + blockH - 24, size: 9, font: fontBold, color: rgb(0.3, 0.3, 0.3),
  });
  const hash = crypto.createHash('sha256').update(opts.contenidoMd, 'utf8').digest('hex');
  page.drawText(sanitize(`SHA-256 contenido: ${hash}`), {
    x: MARGIN, y: firmasY + blockH - 38, size: 7, font, color: rgb(0.3, 0.3, 0.3),
  });
  page.drawText(sanitize(`Organizacion: ${KYVERUM}`), {
    x: MARGIN, y: firmasY + blockH - 52, size: 9, font,
  });

  // Dos firmas: representante legal + oficial cumplimiento.
  const drawSig = (s: ManualSignerInfo | null | undefined, x: number, label: string) => {
    page.drawText(sanitize(label), {
      x, y: firmasY + 80, size: 9, font: fontBold, color: rgb(0.3, 0.3, 0.3),
    });
    if (s) {
      page.drawText(sanitize(`${s.nombre}`), { x, y: firmasY + 64, size: 10, font });
      page.drawText(sanitize(`(${s.rol})`), { x, y: firmasY + 50, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
      page.drawText(sanitize(`Firmado: ${s.timestamp.toISOString()}`), {
        x, y: firmasY + 36, size: 7, font, color: rgb(0.4, 0.4, 0.4),
      });
      page.drawText(sanitize(`UserID: ${s.userId}`), {
        x, y: firmasY + 22, size: 7, font, color: rgb(0.5, 0.5, 0.5),
      });
    } else {
      page.drawText(sanitize('(pendiente de firma)'), {
        x, y: firmasY + 64, size: 9, font, color: rgb(0.7, 0.3, 0.3),
      });
    }
  };
  drawSig(opts.representante, MARGIN, 'REPRESENTANTE LEGAL');
  drawSig(opts.oficial, A4_W / 2 + 10, 'OFICIAL DE CUMPLIMIENTO');

  return Buffer.from(await doc.save());
}
