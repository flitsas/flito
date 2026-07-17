import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  manifiestos, manifiestoRemesas, remesas, vehicles, users,
  rndcMunicipios, rndcProductosTransportar, rndcEmpaques, rndcUnidadesMedida,
} from '../../db/schema.js';
import { env } from '../../config/env.js';

// ============================================================================
// Generador de PDF del manifiesto electrónico de carga.
// Encabezado: Kyverum LLC + datos del manifiesto + QR + tabla de remesas.
// Sin emojis, sin marcas IA. Helvetica standard (no embed → tamaño compacto).
// ============================================================================

interface PdfOptions {
  manifiestoId: number;
}

const COLOR_DARK = rgb(0.16, 0.20, 0.27);
const COLOR_GREY = rgb(0.45, 0.50, 0.58);
const COLOR_LINE = rgb(0.88, 0.90, 0.92);
const COLOR_OK = rgb(0.13, 0.55, 0.30);
const COLOR_DANGER = rgb(0.78, 0.22, 0.22);

interface RowCtx {
  page: PDFPage;
  y: number;
  font: PDFFont;
  fontBold: PDFFont;
  width: number;
  margin: number;
}

function drawText(ctx: RowCtx, text: string, x: number, opts: { size?: number; bold?: boolean; color?: any } = {}) {
  ctx.page.drawText(text, {
    x, y: ctx.y,
    size: opts.size ?? 10,
    font: opts.bold ? ctx.fontBold : ctx.font,
    color: opts.color ?? COLOR_DARK,
  });
}

function drawLine(ctx: RowCtx, color = COLOR_LINE) {
  ctx.page.drawLine({
    start: { x: ctx.margin, y: ctx.y },
    end: { x: ctx.width - ctx.margin, y: ctx.y },
    thickness: 0.5,
    color,
  });
}

function drawHeader(ctx: RowCtx, manifiesto: any): number {
  drawText(ctx, 'KYVERUM LLC', ctx.margin, { size: 18, bold: true });
  ctx.y -= 18;
  drawText(ctx, 'Sistema de Operaciones - FLIT SAS', ctx.margin, { size: 9, color: COLOR_GREY });
  ctx.y -= 24;

  drawText(ctx, 'MANIFIESTO ELECTRÓNICO DE CARGA', ctx.margin, { size: 14, bold: true });
  ctx.y -= 6;
  drawLine(ctx);
  ctx.y -= 16;

  // Bloque número/consecutivo/fecha
  drawText(ctx, 'Número interno:', ctx.margin, { size: 9, color: COLOR_GREY });
  drawText(ctx, manifiesto.numero, ctx.margin + 90, { size: 11, bold: true });

  drawText(ctx, 'Consecutivo RNDC:', ctx.margin + 280, { size: 9, color: COLOR_GREY });
  drawText(ctx, manifiesto.consecutivoRndc ?? '— pendiente —', ctx.margin + 380, { size: 10, bold: true });
  ctx.y -= 14;
  drawText(ctx, 'Fecha expedición:', ctx.margin, { size: 9, color: COLOR_GREY });
  drawText(ctx, String(manifiesto.fechaExpedicion), ctx.margin + 90, { size: 10 });

  drawText(ctx, 'Estado:', ctx.margin + 280, { size: 9, color: COLOR_GREY });
  const estadoLabel = String(manifiesto.estado).toUpperCase();
  drawText(ctx, estadoLabel, ctx.margin + 380, {
    size: 10, bold: true,
    color: estadoLabel === 'ANULADO' ? COLOR_DANGER : COLOR_OK,
  });
  ctx.y -= 24;

  return ctx.y;
}

function drawSection(ctx: RowCtx, title: string): void {
  drawText(ctx, title.toUpperCase(), ctx.margin, { size: 10, bold: true, color: COLOR_GREY });
  ctx.y -= 4;
  drawLine(ctx);
  ctx.y -= 14;
}

function drawKv(ctx: RowCtx, label: string, value: string, x = 0): void {
  const baseX = ctx.margin + x;
  drawText(ctx, label, baseX, { size: 8, color: COLOR_GREY });
  drawText(ctx, value, baseX, { size: 10 });
}

export async function generarManifiestoPdf(opts: PdfOptions): Promise<Buffer> {
  const [m] = await db.select({
    id: manifiestos.id,
    numero: manifiestos.numero,
    consecutivoRndc: manifiestos.consecutivoRndc,
    fechaExpedicion: manifiestos.fechaExpedicion,
    estado: manifiestos.estado,
    municipioOrigenDane: manifiestos.municipioOrigenDane,
    municipioDestinoDane: manifiestos.municipioDestinoDane,
    valorFleteTotal: manifiestos.valorFleteTotal,
    valorAnticipo: manifiestos.valorAnticipo,
    titularPagoTipo: manifiestos.titularPagoTipo,
    titularPagoNombre: manifiestos.titularPagoNombre,
    titularPagoDoc: manifiestos.titularPagoDoc,
    qrToken: manifiestos.qrToken,
    observaciones: manifiestos.observaciones,
    vehiculoPrincipalId: manifiestos.vehiculoPrincipalId,
    vehiculoRemolqueId: manifiestos.vehiculoRemolqueId,
    conductorId: manifiestos.conductorId,
  }).from(manifiestos).where(eq(manifiestos.id, opts.manifiestoId)).limit(1);

  if (!m) throw new Error('Manifiesto no encontrado');

  const [veh] = await db.select({ plate: vehicles.plate }).from(vehicles)
    .where(eq(vehicles.id, m.vehiculoPrincipalId)).limit(1);
  const [rem] = m.vehiculoRemolqueId
    ? await db.select({ plate: vehicles.plate }).from(vehicles).where(eq(vehicles.id, m.vehiculoRemolqueId)).limit(1)
    : [null];
  const [cond] = await db.select({ name: users.name, username: users.username })
    .from(users).where(eq(users.id, m.conductorId)).limit(1);

  const [origen] = await db.select({ nombre: rndcMunicipios.nombre, depto: rndcMunicipios.departamentoNombre })
    .from(rndcMunicipios).where(eq(rndcMunicipios.codigoDane, m.municipioOrigenDane)).limit(1);
  const [destino] = await db.select({ nombre: rndcMunicipios.nombre, depto: rndcMunicipios.departamentoNombre })
    .from(rndcMunicipios).where(eq(rndcMunicipios.codigoDane, m.municipioDestinoDane)).limit(1);

  const remesasRows = await db.select({
    numero: remesas.numero,
    consecutivoRndc: remesas.consecutivoRndc,
    cantidadCargada: remesas.cantidadCargada,
    valorFlete: remesas.valorFlete,
    productoCodigo: remesas.productoCodigo,
  }).from(manifiestoRemesas)
    .innerJoin(remesas, eq(remesas.id, manifiestoRemesas.remesaId))
    .where(eq(manifiestoRemesas.manifiestoId, opts.manifiestoId));

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Manifiesto ${m.numero}`);
  pdf.setProducer('Kyverum LLC');
  pdf.setCreator('Kyverum Operaciones');
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ctx: RowCtx = { page, y: 800, font, fontBold, width: 595, margin: 40 };

  drawHeader(ctx, m);

  drawSection(ctx, 'Vehículo y conductor');
  drawKv(ctx, 'Placa principal', veh?.plate ?? '—', 0);
  drawKv(ctx, 'Placa remolque', rem?.plate ?? '—', 180);
  drawKv(ctx, 'Conductor', `${cond?.name ?? '—'} (${cond?.username ?? '—'})`, 360);
  ctx.y -= 30;

  drawSection(ctx, 'Ruta');
  drawKv(ctx, 'Origen', `${origen?.nombre ?? m.municipioOrigenDane} - ${origen?.depto ?? ''}`, 0);
  drawKv(ctx, 'Destino', `${destino?.nombre ?? m.municipioDestinoDane} - ${destino?.depto ?? ''}`, 280);
  ctx.y -= 30;

  drawSection(ctx, 'Pagos');
  drawKv(ctx, 'Valor flete total', `$ ${Number(m.valorFleteTotal).toLocaleString('es-CO')}`, 0);
  drawKv(ctx, 'Anticipo', `$ ${Number(m.valorAnticipo).toLocaleString('es-CO')}`, 180);
  drawKv(ctx, 'Titular pago', `${m.titularPagoTipo}: ${m.titularPagoNombre ?? '—'}`, 360);
  ctx.y -= 30;

  drawSection(ctx, `Remesas asociadas (${remesasRows.length})`);
  if (remesasRows.length === 0) {
    drawText(ctx, 'Sin remesas asociadas', ctx.margin, { size: 9, color: COLOR_GREY });
    ctx.y -= 18;
  } else {
    drawText(ctx, 'Número', ctx.margin, { size: 8, bold: true, color: COLOR_GREY });
    drawText(ctx, 'Cons. RNDC', ctx.margin + 90, { size: 8, bold: true, color: COLOR_GREY });
    drawText(ctx, 'Producto', ctx.margin + 200, { size: 8, bold: true, color: COLOR_GREY });
    drawText(ctx, 'Cantidad', ctx.margin + 320, { size: 8, bold: true, color: COLOR_GREY });
    drawText(ctx, 'Valor flete', ctx.margin + 410, { size: 8, bold: true, color: COLOR_GREY });
    ctx.y -= 12;
    drawLine(ctx);
    ctx.y -= 12;
    for (const r of remesasRows) {
      drawText(ctx, r.numero, ctx.margin, { size: 9 });
      drawText(ctx, r.consecutivoRndc ?? '—', ctx.margin + 90, { size: 9 });
      drawText(ctx, r.productoCodigo ?? '—', ctx.margin + 200, { size: 9 });
      drawText(ctx, String(r.cantidadCargada), ctx.margin + 320, { size: 9 });
      drawText(ctx, `$ ${Number(r.valorFlete).toLocaleString('es-CO')}`, ctx.margin + 410, { size: 9 });
      ctx.y -= 14;
    }
    ctx.y -= 8;
  }

  if (m.observaciones) {
    drawSection(ctx, 'Observaciones');
    drawText(ctx, String(m.observaciones).slice(0, 600), ctx.margin, { size: 9, color: COLOR_GREY });
    ctx.y -= 30;
  }

  // QR — abajo derecha
  if (m.qrToken) {
    const qrUrl = `${env.PUBLIC_URL}/m/${m.qrToken}`;
    const qrPng = await QRCode.toBuffer(qrUrl, { type: 'png', width: 220, margin: 1, errorCorrectionLevel: 'M' });
    const qrImg = await pdf.embedPng(qrPng);
    page.drawImage(qrImg, { x: 415, y: 60, width: 140, height: 140 });
    page.drawText('Verificación QR', { x: 425, y: 50, size: 8, font, color: COLOR_GREY });
    page.drawText(qrUrl.slice(0, 40), { x: 415, y: 38, size: 6, font, color: COLOR_GREY });
  }

  // Footer
  page.drawText('Kyverum LLC — kyverum.com', { x: 40, y: 30, size: 8, font, color: COLOR_GREY });
  page.drawText(`Generado: ${new Date().toLocaleString('es-CO')}`, { x: 40, y: 18, size: 7, font, color: COLOR_GREY });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
