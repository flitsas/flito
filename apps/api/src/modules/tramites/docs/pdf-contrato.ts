// Contrato de compraventa vehicular — port transitos.cjs POST /contrato-compraventa.

import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { sanWinAnsi, fmtCOP } from './pdf-utils.js';
import { mapSellosContrato, construirFirmantesPdf, type SelloFirmaInput } from './pdf-firmantes.js';
import { firmarPdfMultiple } from './pdf-signer.js';

export interface ContratoInput {
  tramiteId?: number;
  firmantes?: SelloFirmaInput[];
  vehiculo?: Record<string, unknown>;
  vendedor?: Record<string, unknown>;
  comprador?: Record<string, unknown>;
  valorVenta?: number;
  tasaImpuesto?: number;
  valorTramite?: number;
  metodoPago?: string;
  causal?: string;
  orgNombre?: string;
  orgNit?: string;
  orgCiudad?: string;
  fecha?: string;
}

export async function generarContratoPdf(d: ContratoInput): Promise<Buffer> {
  const v = d.vehiculo || {};
  const ven = d.vendedor || {};
  const com = d.comprador || {};
  const firmantesArr = d.firmantes || [];
  const { vendedor: firmaVendedor, comprador: firmaComprador } = mapSellosContrato(firmantesArr);
  const valorVenta = Number(d.valorVenta) || 0;
  const metodoPago = d.metodoPago || 'Efectivo';
  const orgN = d.orgNombre || 'Organismo de Tránsito';
  const orgNit = d.orgNit || '';
  const orgCiudad = d.orgCiudad || '';
  const causal = d.causal || 'COMPRAVENTA';

  const pdfDoc = await PDFDocument.create();
  let page: PDFPage = pdfDoc.addPage([612, 792]);
  const { width: PW, height: PH } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
  const BLACK = rgb(0, 0, 0);
  const GRAY = rgb(0.4, 0.4, 0.4);
  const NAVY = rgb(0.12, 0.23, 0.54);
  const san = sanWinAnsi;
  const M = 42;
  let y = 40;
  const maxW = PW - 2 * M;

  const ensure = (need: number) => { if (y + need > PH - 36) { page = pdfDoc.addPage([612, 792]); y = 40; } };
  const drawC = (text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size || 10;
    const f = opts.bold ? fontBold : font;
    const w = f.widthOfTextAtSize(san(text), size);
    page.drawText(san(text), { x: (PW - w) / 2, y: PH - y - size, size, font: f, color: opts.color || BLACK });
  };
  const para = (text: string, opts: { size?: number; lh?: number } = {}) => {
    const size = opts.size || 9;
    const lh = opts.lh || (size + 2.5);
    const words = san(text).split(/\s+/).filter(Boolean);
    const spaceW = font.widthOfTextAtSize(' ', size);
    const lines: { w: string; ww: number }[][] = [];
    let cur: { w: string; ww: number }[] = [];
    let curWordsW = 0;
    for (const w of words) {
      const ww = font.widthOfTextAtSize(w, size);
      const widthIfAdd = curWordsW + (cur.length ? spaceW : 0) + ww;
      if (widthIfAdd <= maxW || cur.length === 0) { cur.push({ w, ww }); curWordsW = widthIfAdd; }
      else { lines.push(cur); cur = [{ w, ww }]; curWordsW = ww; }
    }
    if (cur.length) lines.push(cur);
    lines.forEach((ln, idx) => {
      ensure(lh);
      const isLast = idx === lines.length - 1;
      const wordsW = ln.reduce((s, x) => s + x.ww, 0);
      const gaps = ln.length - 1;
      let gapW = (!isLast && gaps > 0) ? Math.min((maxW - wordsW) / gaps, spaceW * 3.5) : spaceW;
      let x = M;
      ln.forEach((it) => { page.drawText(it.w, { x, y: PH - y - size, size, font, color: BLACK }); x += it.ww + gapW; });
      y += lh;
    });
    y += 2;
  };
  const titulo2 = (text: string) => {
    ensure(16); y += 5;
    page.drawText(san(text), { x: M, y: PH - y - 10, size: 10, font: fontBold, color: NAVY });
    page.drawLine({ start: { x: M, y: PH - y - 12.5 }, end: { x: M + 60, y: PH - y - 12.5 }, thickness: 0.6, color: NAVY });
    y += 14;
  };

  const fechaActual = (() => {
    const f = d.fecha ? new Date(d.fecha) : new Date();
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${f.getDate()} de ${meses[f.getMonth()]} de ${f.getFullYear()}`;
  })();

  page.drawRectangle({ x: M, y: PH - 32, width: maxW, height: 3, color: NAVY });
  drawC('CONTRATO DE COMPRAVENTA DE VEHICULO AUTOMOTOR', { size: 13, bold: true, color: NAVY });
  y += 18;
  drawC(`${orgCiudad ? orgCiudad + ', ' : ''}${fechaActual}`, { size: 9, color: GRAY });
  y += 18;

  const venDoc = `${ven.tipoDoc || 'CC'} N° ${ven.documento || '-'}`;
  const comDoc = `${com.tipoDoc || 'CC'} N° ${com.documento || '-'}`;
  para(`Entre los suscritos, por una parte ${ven.nombre || '-'}, identificado(a) con ${venDoc}${ven.direccion ? ', domiciliado(a) en ' + ven.direccion : ''}, quien en adelante se denominara EL VENDEDOR, y por la otra ${com.nombre || '-'}, identificado(a) con ${comDoc}${com.direccion ? ', domiciliado(a) en ' + com.direccion : ''}, quien en adelante se denominara EL COMPRADOR, hemos convenido celebrar el presente contrato de compraventa, regido por las siguientes clausulas:`);

  titulo2('PRIMERA - OBJETO');
  para('EL VENDEDOR transfiere a titulo de venta real y efectiva al COMPRADOR, quien adquiere y recibe a su entera satisfaccion, el vehiculo automotor cuyas caracteristicas se describen a continuacion:');

  ensure(110); y += 2;
  const filas = [
    ['Placa', String(v.placa || '-'), 'Marca', String(v.marca || '-')],
    ['Linea', String(v.linea || '-'), 'Modelo', String(v.modelo || '-')],
    ['Color', String(v.color || '-'), 'Clase', String(v.clase || '-')],
    ['Cilindraje', v.cilindraje ? v.cilindraje + ' cc' : '-', 'Combustible', String(v.combustible || '-')],
    ['Servicio', String(v.servicio || 'Particular'), 'Carroceria', String(v.carroceria || '-')],
    ['VIN', String(v.vin || '-'), 'Motor No.', String(v.numMotor || '-')],
    ['Chasis No.', String(v.numChasis || '-'), 'Serie No.', String(v.numSerie || v.vin || '-')],
  ];
  const colW = maxW / 4;
  const rowH = 13;
  page.drawRectangle({ x: M, y: PH - y - 0.5, width: maxW, height: 0.5, color: NAVY });
  filas.forEach((fila, i) => {
    const yTop = y;
    const bg = i % 2 === 0 ? rgb(0.96, 0.97, 0.99) : rgb(1, 1, 1);
    page.drawRectangle({ x: M, y: PH - yTop - rowH, width: maxW, height: rowH, color: bg });
    for (let c = 0; c < 4; c++) {
      const isLabel = c % 2 === 0;
      page.drawText(san(fila[c]), { x: M + c * colW + 6, y: PH - yTop - 9, size: isLabel ? 8 : 8.5, font: isLabel ? fontBold : font, color: isLabel ? NAVY : BLACK });
    }
    y += rowH;
  });
  page.drawRectangle({ x: M, y: PH - y - 0.5, width: maxW, height: 0.5, color: NAVY });
  y += 6;

  titulo2('SEGUNDA - PRECIO Y FORMA DE PAGO');
  para(`El precio total convenido por las partes para la presente compraventa es la suma de ${fmtCOP(valorVenta)} (${valorVenta.toLocaleString('es-CO')} pesos colombianos m/cte), suma que EL COMPRADOR pago en su totalidad al VENDEDOR por concepto de ${metodoPago.toLowerCase()}, declarando este ultimo haberla recibido a su entera satisfaccion. La causal del traspaso es: ${causal}.`);
  titulo2('TERCERA - TRADICION');
  para(`Con la firma del presente contrato, EL VENDEDOR hace entrega real y material del vehiculo automotor objeto de esta venta a EL COMPRADOR, quien declara recibirlo en perfecto estado de funcionamiento. Las partes se obligan a comparecer ante el organismo de transito ${orgN}${orgNit ? ' (NIT ' + orgNit + ')' : ''} para perfeccionar el traspaso de propiedad ante el Registro Unico Nacional de Transito (RUNT).`);
  titulo2('CUARTA - DECLARACIONES DEL VENDEDOR');
  para('EL VENDEDOR declara bajo juramento que: (a) es el unico y legitimo propietario del vehiculo; (b) el vehiculo no se encuentra embargado, prendado ni sujeto a limitacion al dominio; (c) esta al dia en SOAT y RTM (cuando aplique); (d) ha cancelado los impuestos vehiculares; (e) no existen comparendos pendientes asociados al vehiculo o al propietario.');
  titulo2('QUINTA - GASTOS DEL TRASPASO');
  para('Los gastos del traspaso ante el organismo de transito y los impuestos derivados de esta operacion seran asumidos por EL COMPRADOR.');
  titulo2('SEXTA - RESPONSABILIDAD Y LEY APLICABLE');
  para('A partir de la firma, EL COMPRADOR asume la totalidad de la responsabilidad civil, penal, contravencional y fiscal derivada del uso del vehiculo. El presente contrato se rige por la legislacion colombiana, en especial el Codigo Civil, la Ley 769 de 2002 (Codigo Nacional de Transito) y la Resolucion 12379 de 2012 del Ministerio de Transporte.');

  y += 8;
  para(`Para constancia, las partes firman electronicamente en ${orgCiudad || '_______________'}, a los ${fechaActual}, mediante firma electronica avanzada con verificacion biometrica facial conforme a la Ley 527 de 1999, Decreto 2364 de 2012 y Resolucion 17145 de 2023 del Ministerio de Transporte.`);
  y += 12;

  const colWidth = (maxW - 40) / 2;
  const GREEN_DARK = rgb(0.06, 0.55, 0.34);
  const drawSelloDigital = (firma: SelloFirmaInput | null, persona: Record<string, unknown>, label: string, xCol: number) => {
    const yTop = y;
    const sH = 78;
    const ok = !!(firma && (firma as any).firma_serie);
    page.drawRectangle({ x: xCol, y: PH - yTop - sH, width: colWidth, height: sH, borderColor: ok ? GREEN_DARK : rgb(0.7, 0.7, 0.7), borderWidth: 1.2, color: ok ? rgb(0.95, 0.99, 0.95) : rgb(0.97, 0.97, 0.97) });
    page.drawRectangle({ x: xCol, y: PH - yTop - 13, width: colWidth, height: 13, color: ok ? GREEN_DARK : rgb(0.55, 0.55, 0.55) });
    const lblW = fontBold.widthOfTextAtSize(san(label), 7.5);
    page.drawText(san(label), { x: xCol + (colWidth - lblW) / 2, y: PH - yTop - 10, size: 7.5, font: fontBold, color: rgb(1, 1, 1) });
    const yC = yTop + 18;
    const tx = (txt: string, dy: number, sz: number, bold: boolean) => {
      const f = bold ? fontBold : font;
      const w = f.widthOfTextAtSize(san(txt), sz);
      page.drawText(san(txt), { x: xCol + (colWidth - w) / 2, y: PH - yC - dy - sz, size: sz, font: f, color: ok ? rgb(0.06, 0.4, 0.25) : rgb(0.4, 0.4, 0.4) });
    };
    tx(String(persona.nombre || '-'), 0, 9.5, true);
    tx(`${persona.tipoDoc || 'CC'} ${persona.documento || '-'}`, 12, 8, false);
    if (ok && firma) {
      tx('FIRMA ELECTRONICA AVANZADA', 25, 6.5, true);
      const serieFmt = String((firma as any).firma_serie).slice(0, 32);
      const serieW = fontMono.widthOfTextAtSize(serieFmt, 6);
      page.drawText(serieFmt, { x: xCol + (colWidth - serieW) / 2, y: PH - yC - 33 - 6, size: 6, font: fontMono, color: rgb(0.06, 0.4, 0.25) });
    } else {
      tx('(Firma electronica no generada)', 28, 6.5, false);
    }
  };
  drawSelloDigital(firmaVendedor, ven, 'VENDEDOR (TRADENTE)', M);
  drawSelloDigital(firmaComprador, com, 'COMPRADOR (ADQUIRENTE)', M + colWidth + 40);
  y += 86;

  page.drawLine({ start: { x: M, y: PH - y }, end: { x: PW - M, y: PH - y }, thickness: 0.4, color: GRAY });
  y += 5;
  drawC(`Documento generado por ${orgN}${orgNit ? ' - NIT ' + orgNit : ''} - Sistema Kyverum Operaciones FLIT  ·  ${new Date().toLocaleString('es-CO')}`, { size: 7, color: GRAY });

  let signedBytes: Buffer = Buffer.from(await pdfDoc.save());
  const firmantes = construirFirmantesPdf(String(v.placa || ''), firmantesArr);
  if (firmantes.length) {
    try { signedBytes = Buffer.from(await firmarPdfMultiple(signedBytes, firmantes)); } catch { /* sellos visuales bastan */ }
  }
  return signedBytes;
}
