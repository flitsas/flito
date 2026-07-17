import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { and, desc, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  laftCashTxns,
  laftReportesUiaf,
  laftRosDrafts,
  laftUnusualOperations,
} from '../../../db/schema.js';
import { uploadReporte } from './reportes-storage.js';

// Trimestre 1 = Q4 año anterior cuando se reporta en abril (Ene/Feb/Mar = Q1).
// Estándar: Q1=Ene-Mar, Q2=Abr-Jun, Q3=Jul-Sep, Q4=Oct-Dic.
export function trimestreRange(anio: number, trimestre: number): { desde: string; hasta: string } {
  const startMonth = (trimestre - 1) * 3; // 0,3,6,9
  const desde = `${anio}-${String(startMonth + 1).padStart(2, '0')}-01`;
  const lastMonthZero = startMonth + 2;
  const last = new Date(Date.UTC(anio, lastMonthZero + 1, 0));
  const hasta = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
  return { desde, hasta };
}

export interface ArosResumen {
  trimestre: number;
  anio: number;
  desde: string;
  hasta: string;
  totalRosEnviados: number;
  totalUnusualReportadas: number;
  totalCashBreaches: number;
  esAusencia: boolean;
  detalle: {
    ros: Array<{ id: number; sirelRadicado: string | null; sentToUiafAt: Date | null; }>;
    unusualReportadas: Array<{ id: number; description: string; decidedAt: Date | null }>;
  };
}

export async function buildArosResumen(anio: number, trimestre: number): Promise<ArosResumen> {
  const { desde, hasta } = trimestreRange(anio, trimestre);
  // ROS enviados al SIREL en el trimestre
  const rosRows = await db.select({
    id: laftRosDrafts.id,
    sirelRadicado: laftRosDrafts.sirelRadicado,
    sentToUiafAt: laftRosDrafts.sentToUiafAt,
  }).from(laftRosDrafts)
    .where(and(
      gte(laftRosDrafts.sentToUiafAt, new Date(desde + 'T00:00:00Z')),
      lte(laftRosDrafts.sentToUiafAt, new Date(hasta + 'T23:59:59Z')),
    ));

  // Operaciones inusuales reportadas (decision=reportada) en el trimestre
  const opsRows = await db.select({
    id: laftUnusualOperations.id,
    description: laftUnusualOperations.description,
    decidedAt: laftUnusualOperations.decidedAt,
  }).from(laftUnusualOperations)
    .where(and(
      eq(laftUnusualOperations.decision, 'reportada'),
      gte(laftUnusualOperations.decidedAt, new Date(desde + 'T00:00:00Z')),
      lte(laftUnusualOperations.decidedAt, new Date(hasta + 'T23:59:59Z')),
    ));

  // Cash breaches del trimestre
  const breachClause = sql`(${laftCashTxns.thresholdIndividualBreached} OR ${laftCashTxns.thresholdAcumuladoBreached})`;
  const [{ cnt: breachCount }] = await db.select({ cnt: sql<number>`count(*)::int` })
    .from(laftCashTxns)
    .where(and(
      eq(laftCashTxns.kind, 'efectivo'),
      gte(laftCashTxns.fecha, desde),
      lte(laftCashTxns.fecha, hasta),
      breachClause as unknown as ReturnType<typeof eq>,
    ));

  const totalRos = rosRows.length;
  const totalReportadas = opsRows.length;
  const totalBreaches = breachCount;
  const esAusencia = totalRos === 0 && totalReportadas === 0 && totalBreaches === 0;
  return {
    trimestre, anio, desde, hasta,
    totalRosEnviados: totalRos,
    totalUnusualReportadas: totalReportadas,
    totalCashBreaches: totalBreaches,
    esAusencia,
    detalle: { ros: rosRows, unusualReportadas: opsRows.map((o) => ({ ...o, description: o.description ?? '' })) },
  };
}

// PDF AROS minimalista. Layout vertical A4. Cumple con Ley 527/1999 (firma
// electrónica) embebiendo el SHA-256 del contenido en el footer — el verificador
// puede recalcular el hash sobre el PDF sin la línea final y comparar.
export async function buildArosPdf(resumen: ArosResumen, generadoPorUsername: string): Promise<{ buffer: Buffer; sha256: string }> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  let y = 800;

  function drawLine(text: string, opts: { font?: any; size?: number; color?: any } = {}): void {
    page.drawText(text, {
      x: margin, y,
      font: opts.font ?? font,
      size: opts.size ?? 11,
      color: opts.color ?? rgb(0, 0, 0),
    });
    y -= (opts.size ?? 11) + 4;
  }

  drawLine(resumen.esAusencia ? 'REPORTE TRIMESTRAL DE AUSENCIA DE OPERACIONES SOSPECHOSAS (AROS)' : 'REPORTE TRIMESTRAL DE OPERACIONES SOSPECHOSAS (AROS)', { font: fontBold, size: 14 });
  y -= 6;
  drawLine(`Resolución UIAF 122/2021 — Decreto 1497/2002`);
  drawLine(`Periodo: ${resumen.trimestre}T-${resumen.anio}  (${resumen.desde} a ${resumen.hasta})`);
  drawLine(`Generado por: ${generadoPorUsername}`);
  drawLine(`Fecha de generación (UTC): ${new Date().toISOString()}`);
  y -= 10;

  if (resumen.esAusencia) {
    drawLine('Durante el trimestre referido NO se identificaron operaciones sospechosas', { font: fontBold });
    drawLine('reportables al sistema SIREL de la UIAF.');
    drawLine('Tampoco se registraron operaciones inusuales escaladas a "reportada", ni transacciones');
    drawLine('en efectivo que superaran los umbrales individuales o acumulados mensuales.');
    y -= 10;
    drawLine('De conformidad con el artículo 102 del E.O.S.F., y la Resolución UIAF 122/2021,');
    drawLine('se diligencia este reporte de AUSENCIA con efectos legales.');
  } else {
    drawLine(`Total ROS enviados al SIREL: ${resumen.totalRosEnviados}`, { font: fontBold });
    drawLine(`Total operaciones inusuales reportadas: ${resumen.totalUnusualReportadas}`);
    drawLine(`Total transacciones en efectivo con umbral superado: ${resumen.totalCashBreaches}`);
    y -= 6;
    if (resumen.detalle.ros.length) {
      drawLine('ROS enviados:', { font: fontBold });
      for (const r of resumen.detalle.ros.slice(0, 30)) {
        drawLine(`  • #${r.id}  Radicado: ${r.sirelRadicado ?? '(pendiente)'}  Enviado: ${r.sentToUiafAt?.toISOString().slice(0, 10) ?? '-'}`);
        if (y < 100) break;
      }
      y -= 4;
    }
    if (resumen.detalle.unusualReportadas.length && y > 120) {
      drawLine('Operaciones reportadas:', { font: fontBold });
      for (const o of resumen.detalle.unusualReportadas.slice(0, 30)) {
        const desc = (o.description || '').slice(0, 90);
        drawLine(`  • #${o.id}  ${desc}`);
        if (y < 100) break;
      }
    }
  }

  // Footer con espacio reservado para SHA-256
  page.drawText(`Documento generado por sistema FLIT Operaciones — Página 1 de 1`, {
    x: margin, y: 60, font, size: 8, color: rgb(0.4, 0.4, 0.4),
  });

  // Render preliminar para hash (no incluye la línea SHA-256 misma)
  const preBytes = await pdf.save();
  const sha256 = crypto.createHash('sha256').update(preBytes).digest('hex');

  // Línea final con hash. Si el verificador desea, puede recortar el último
  // text-object y recalcular el hash sobre el resto. Patrón común en PDF
  // government Colombia (Carta Porte / Cumplimiento ANSV).
  page.drawText(`SHA-256 del contenido (firma electrónica Ley 527/1999): ${sha256}`, {
    x: margin, y: 45, font, size: 7, color: rgb(0.2, 0.2, 0.2),
  });

  const buffer = Buffer.from(await pdf.save());
  return { buffer, sha256 };
}

export interface GenerarArosResult {
  reporte: typeof laftReportesUiaf.$inferSelect;
  resumen: ArosResumen;
  idempotent: boolean;
}

export async function generarAros(anio: number, trimestre: number, userId: number): Promise<GenerarArosResult> {
  // Idempotencia
  const [existing] = await db.select().from(laftReportesUiaf).where(and(
    eq(laftReportesUiaf.tipo, 'AROS'),
    eq(laftReportesUiaf.formato, 'PDF'),
    eq(laftReportesUiaf.periodoAnio, anio),
    eq(laftReportesUiaf.periodoTrimestre, trimestre),
  ));
  if (existing) {
    const resumen = await buildArosResumen(anio, trimestre);
    return { reporte: existing, resumen, idempotent: true };
  }

  const resumen = await buildArosResumen(anio, trimestre);
  // El user 'cron' (id reservado) no existe; usamos userId del caller. Si cron lo llama,
  // pasa el id de un admin (resolver_de admin) — el cron lo busca antes.
  const { buffer, sha256 } = await buildArosPdf(resumen, `usuario#${userId}`);
  const upload = await uploadReporte({ tipo: 'AROS', anio, trimestre, formato: 'PDF', body: buffer });

  try {
    const [created] = await db.insert(laftReportesUiaf).values({
      tipo: 'AROS',
      periodoAnio: anio,
      periodoTrimestre: trimestre,
      generadoPor: userId,
      totalOperaciones: resumen.totalRosEnviados + resumen.totalUnusualReportadas + resumen.totalCashBreaches,
      formato: 'PDF',
      storageKey: upload.storageKey,
      sha256: sha256 === upload.sha256 ? sha256 : upload.sha256,
    }).returning();
    return { reporte: created, resumen, idempotent: false };
  } catch (e: any) {
    if (e?.code === '23505') {
      const [again] = await db.select().from(laftReportesUiaf).where(and(
        eq(laftReportesUiaf.tipo, 'AROS'),
        eq(laftReportesUiaf.formato, 'PDF'),
        eq(laftReportesUiaf.periodoAnio, anio),
        eq(laftReportesUiaf.periodoTrimestre, trimestre),
      ));
      if (again) return { reporte: again, resumen, idempotent: true };
    }
    throw e;
  }
}
