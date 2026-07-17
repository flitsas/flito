// Hoja de improntas digitales — port transitos.cjs POST /improntas.

import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { sanWinAnsi } from './pdf-utils.js';

export interface ImprontasInput {
  placa?: string; marca?: string; linea?: string; modelo?: string;
  numMotor?: string; numChasis?: string; numSerie?: string; vin?: string;
  orgNombre?: string; orgNit?: string; orgCiudad?: string; operador?: string;
}

export interface ImprontasResult {
  ok: boolean; pdf?: string; hash?: string; radicado?: string; message?: string;
}

export async function generarImprontasPdf(data: ImprontasInput): Promise<ImprontasResult> {
  try {
    const placa = (data.placa || '').toUpperCase();
    const marca = data.marca || '';
    const linea = data.linea || '';
    const modelo = data.modelo || '';
    const numMotor = data.numMotor || '';
    const numChasis = data.numChasis || '';
    const numSerie = data.numSerie || data.vin || '';
    const orgN = data.orgNombre || 'Organismo de Tránsito';
    const orgNit = data.orgNit || '';
    const orgCiudad = data.orgCiudad || '';
    const operador = data.operador || 'sistema';
    const fechaIso = new Date().toISOString();
    const radicado = 'IMPR-' + Date.now().toString(36).toUpperCase();
    const hashInput = [placa, numMotor, numChasis, numSerie, fechaIso, orgN, operador].join('|');
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const { width: PW, height: PH } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
    const fontMonoBold = await pdfDoc.embedFont(StandardFonts.CourierBold);
    const BLACK = rgb(0, 0, 0);
    const GRAY = rgb(0.4, 0.4, 0.4);
    const LIGHTGRAY = rgb(0.92, 0.92, 0.92);
    const san = sanWinAnsi;

    const text = (t: unknown, xt: number, yt: number, opts: { size?: number; bold?: boolean; mono?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
      if (t === undefined || t === null || t === '') return;
      const size = opts.size || 10;
      const f = opts.mono ? (opts.bold ? fontMonoBold : fontMono) : (opts.bold ? fontBold : font);
      page.drawText(san(t), { x: xt, y: PH - yt - size, size, font: f, color: opts.color || BLACK });
    };
    const textC = (t: unknown, cx: number, yt: number, opts: { size?: number; bold?: boolean; mono?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
      if (t === undefined || t === null || t === '') return;
      const size = opts.size || 10;
      const f = opts.mono ? (opts.bold ? fontMonoBold : fontMono) : (opts.bold ? fontBold : font);
      const safe = san(t);
      const w = f.widthOfTextAtSize(safe, size);
      page.drawText(safe, { x: cx - w / 2, y: PH - yt - size, size, font: f, color: opts.color || BLACK });
    };
    const rect = (xt: number, yt: number, w: number, h: number, opts: { borderColor?: ReturnType<typeof rgb>; borderWidth?: number; fill?: ReturnType<typeof rgb> } = {}) => {
      page.drawRectangle({ x: xt, y: PH - yt - h, width: w, height: h, borderColor: opts.borderColor || BLACK, borderWidth: opts.borderWidth || 1, color: opts.fill });
    };

    const M = 30;
    const W = PW - 2 * M;
    rect(M, M, W, PH - 2 * M, { borderWidth: 1.5 });
    page.drawRectangle({ x: M, y: PH - M - 50, width: W, height: 50, color: rgb(0.12, 0.23, 0.54) });
    textC('HOJA DE IMPRONTAS DIGITALES DEL VEHICULO', PW / 2, M + 10, { size: 13, bold: true, color: rgb(1, 1, 1) });
    textC('Resolucion 17145 de 2023 - Ministerio de Transporte de Colombia', PW / 2, M + 26, { size: 8, color: rgb(0.85, 0.9, 1) });
    textC(orgN + (orgNit ? '  -  NIT ' + orgNit : ''), PW / 2, M + 38, { size: 8, bold: true, color: rgb(1, 1, 1) });

    let cy = M + 65;
    rect(M, cy, W, 14, { fill: LIGHTGRAY });
    textC('DATOS DEL VEHICULO', PW / 2, cy + 3, { size: 9, bold: true });
    cy += 14;
    const dataRows = [[['Placa', placa], ['Marca', marca], ['Linea', linea], ['Modelo', modelo]]];
    dataRows.forEach((row) => {
      const cellW = W / row.length;
      row.forEach((cell, i) => {
        const cx = M + i * cellW;
        rect(cx, cy, cellW, 30);
        text(cell[0], cx + 6, cy + 4, { size: 7, bold: true, color: GRAY });
        textC(cell[1] || '-', cx + cellW / 2, cy + 14, { size: 11, bold: true });
      });
      cy += 30;
    });

    let _seed = 0;
    for (let i = 0; i < hash.length; i++) _seed = (_seed * 31 + hash.charCodeAt(i)) >>> 0;
    const rnd = () => { _seed = (_seed * 1103515245 + 12345) >>> 0; return ((_seed >>> 16) & 0x7fff) / 0x7fff; };

    const improntas = [
      { titulo: 'IMPRONTA DEL MOTOR', subtitulo: 'No. de Motor — tomado del bloque', numero: numMotor, color: rgb(0.65, 0.05, 0.05) },
      { titulo: 'IMPRONTA DEL CHASIS', subtitulo: 'No. de Chasis — tomado del larguero', numero: numChasis, color: rgb(0.05, 0.25, 0.55) },
      { titulo: 'IMPRONTA DE SERIE / VIN', subtitulo: 'VIN — Vehicle Identification Number', numero: numSerie, color: rgb(0.1, 0.4, 0.15) },
    ];
    cy += 14;
    const PAPEL = rgb(0.965, 0.94, 0.86);

    improntas.forEach((imp) => {
      rect(M, cy, W, 145, { borderWidth: 1.2, borderColor: rgb(0.45, 0.32, 0.18) });
      page.drawRectangle({ x: M, y: PH - cy - 18, width: W, height: 18, color: imp.color });
      textC(imp.titulo, PW / 2, cy + 5, { size: 10, bold: true, color: rgb(1, 1, 1) });
      const subY = cy + 22;
      page.drawRectangle({ x: M, y: PH - subY - 14, width: W, height: 14, color: rgb(0.96, 0.93, 0.85) });
      text(imp.subtitulo, M + 8, subY + 3, { size: 7, bold: true, color: rgb(0.4, 0.3, 0.15) });
      text('Placa: ' + placa, M + W - 100, subY + 3, { size: 7, bold: true, color: rgb(0.4, 0.3, 0.15) });
      const padX = 25;
      const grafX = M + padX;
      const grafY = subY + 18;
      const grafW = W - 2 * padX;
      const grafH = 88;
      page.drawRectangle({ x: grafX, y: PH - grafY - grafH, width: grafW, height: grafH, color: PAPEL });
      page.drawRectangle({ x: grafX, y: PH - grafY - grafH, width: grafW, height: grafH, borderColor: rgb(0.55, 0.45, 0.30), borderWidth: 0.8 });
      const gIn = 8;
      const gX = grafX + gIn;
      const gY = grafY + gIn;
      const gW = grafW - 2 * gIn;
      const gH = grafH - 2 * gIn;
      for (let i = 0; i < 4500; i++) {
        const px = gX + rnd() * gW;
        const py = PH - gY - rnd() * gH;
        const dxC = (px - (gX + gW / 2)) / (gW / 2);
        const dyC = ((PH - py) - (gY + gH / 2)) / (gH / 2);
        const dist = Math.sqrt(dxC * dxC + dyC * dyC);
        const fade = Math.min(1, dist * 0.6);
        const tone = 0.08 + fade * 0.18 + rnd() * 0.12;
        page.drawCircle({ x: px, y: py, size: 0.6 + rnd() * 1.2, color: rgb(tone, tone, tone + 0.01) });
      }
      const numStr = (imp.numero || '(SIN DATO)').toUpperCase();
      let numSize = 30;
      let numW = fontMonoBold.widthOfTextAtSize(numStr, numSize);
      while (numW > gW - 16 && numSize > 12) { numSize -= 1; numW = fontMonoBold.widthOfTextAtSize(numStr, numSize); }
      const charW = numW / numStr.length;
      const startX = gX + (gW - numW) / 2;
      const baseY = PH - gY - gH / 2 - numSize / 2 + 2;
      for (let i = 0; i < numStr.length; i++) {
        const ch = numStr[i];
        const cx = startX + i * charW;
        [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]].forEach(([dx, dy]) => {
          page.drawText(ch, { x: cx + dx, y: baseY + dy, size: numSize, font: fontMonoBold, color: rgb(0.04, 0.04, 0.05) });
        });
        for (let k = 0; k < 5; k++) {
          page.drawText(ch, { x: cx + (rnd() - 0.5) * 0.6, y: baseY + (rnd() - 0.5) * 0.6, size: numSize, font: fontMonoBold, color: PAPEL });
        }
      }
      text('Tomada electronicamente del RUNT - Resolucion 17145/2023', M + 8, cy + 130, { size: 6.5, color: GRAY });
      text('Fecha: ' + fechaIso.slice(0, 10) + '  Hora: ' + fechaIso.slice(11, 19), M + W - 145, cy + 130, { size: 6.5, color: GRAY });
      cy += 152;
    });

    const qrData = JSON.stringify({ tipo: 'IMPRONTA_DIGITAL', radicado, hash: hash.slice(0, 32), placa, motor: numMotor, chasis: numChasis, serie: numSerie, fecha: fechaIso.slice(0, 10), organismo: orgN });
    let qrImage = null;
    try {
      const qrDataUrl = await QRCode.toDataURL(qrData, { width: 200, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
      qrImage = await pdfDoc.embedPng(Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    } catch { /* QR opcional */ }

    cy += 8;
    const pieH = qrImage ? 100 : 70;
    rect(M, cy, W, pieH, { fill: rgb(0.97, 0.97, 0.99), borderColor: rgb(0.8, 0.8, 0.85) });
    text('VERIFICACION DE AUTENTICIDAD', M + 10, cy + 5, { size: 8, bold: true, color: rgb(0.12, 0.23, 0.54) });
    const qrSize = 85;
    if (qrImage) {
      page.drawImage(qrImage, { x: M + W - qrSize - 10, y: PH - cy - pieH + (pieH - qrSize) / 2, width: qrSize, height: qrSize });
    }
    text('Radicado interno:', M + 10, cy + 18, { size: 7, color: GRAY });
    text(radicado, M + 90, cy + 18, { size: 8, bold: true, mono: true });
    text('Hash SHA-256:', M + 10, cy + 54, { size: 7, color: GRAY });
    text(hash.slice(0, 64), M + 90, cy + 54, { size: 6, mono: true, color: rgb(0.3, 0.3, 0.3) });

    const finalBytes = await pdfDoc.save();
    return { ok: true, pdf: 'data:application/pdf;base64,' + Buffer.from(finalBytes).toString('base64'), hash, radicado };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Error generando improntas' };
  }
}
