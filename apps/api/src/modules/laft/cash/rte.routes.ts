import { Router, Request, Response } from 'express';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../../db/client.js';
import {
  laftCashTxns,
  laftCounterparties,
  laftReportesUiaf,
} from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { loggerFor } from '../../../shared/logger.js';
import { uploadReporte, downloadReporte } from './reportes-storage.js';

const log = loggerFor('laft-rte');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const generateLimiter = rateLimit({
  windowMs: 60_000, max: 10,
  keyGenerator: userOrIpKey('laft-rte'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas generaciones de RTE, espere 1 minuto' },
});

function parseAnioMes(req: Request): { anio: number; mes: number } | null {
  const anio = parseInt(req.params.anio, 10);
  const mes = parseInt(req.params.mes, 10);
  if (!Number.isFinite(anio) || anio < 2020 || anio > 2100) return null;
  if (!Number.isFinite(mes) || mes < 1 || mes > 12) return null;
  return { anio, mes };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // RFC 4180 — escapar comillas y envolver si contiene coma/comillas/salto de línea.
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(rows: Array<{
  docType: string | null;
  docNumber: string | null;
  fullName: string | null;
  fecha: string;
  amount: string;
  kind: string;
  numeroRecibo: string | null;
  causa: string;
}>): Buffer {
  // BOM UTF-8 para que Excel español abra el CSV con tildes correctas.
  const BOM = '﻿';
  const header = ['Tipo Documento', 'NIT/Documento', 'Nombre/Razón Social', 'Fecha', 'Monto COP', 'Tipo Pago', 'Número Recibo', 'Causa'].map(csvCell).join(',');
  const lines = rows.map((r) => [
    r.docType ?? '',
    r.docNumber ?? '',
    r.fullName ?? '',
    r.fecha,
    r.amount,
    r.kind,
    r.numeroRecibo ?? '',
    r.causa,
  ].map(csvCell).join(','));
  return Buffer.from(BOM + header + '\r\n' + lines.join('\r\n'), 'utf-8');
}

// === POST /generar/:anio/:mes — generar RTE mensual =========================
router.post('/generar/:anio/:mes', generateLimiter, async (req: Request, res: Response) => {
  const p = parseAnioMes(req);
  if (!p) { res.status(400).json({ error: 'Año o mes inválido' }); return; }
  const { anio, mes } = p;

  // Anti-overlap: no generar RTE de un mes que aún no termina.
  const today = new Date();
  const lastDay = new Date(Date.UTC(anio, mes, 0));
  if (today < lastDay) {
    res.status(422).json({ error: 'No se puede generar RTE de un mes en curso — espere al cierre del mes' });
    return;
  }

  // Idempotencia: si ya existe (tipo=RTE, anio, mes, formato=CSV), devolver 200.
  const [existing] = await db.select().from(laftReportesUiaf).where(and(
    eq(laftReportesUiaf.tipo, 'RTE'),
    eq(laftReportesUiaf.formato, 'CSV'),
    eq(laftReportesUiaf.periodoAnio, anio),
    eq(laftReportesUiaf.periodoMes, mes),
  ));
  if (existing) {
    res.status(200).json({ ...existing, idempotent: true });
    return;
  }

  const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const hastaDate = new Date(Date.UTC(anio, mes, 0)); // último día
  const hasta = `${hastaDate.getUTCFullYear()}-${String(hastaDate.getUTCMonth() + 1).padStart(2, '0')}-${String(hastaDate.getUTCDate()).padStart(2, '0')}`;

  // Solo efectivo + algún breach. Joineamos contraparte para la salida.
  const breachClause = sql`(${laftCashTxns.thresholdIndividualBreached} OR ${laftCashTxns.thresholdAcumuladoBreached})`;
  const rowsRaw = await db.select({
    docType: laftCounterparties.docType,
    docNumber: laftCounterparties.docNumber,
    fullName: laftCounterparties.fullName,
    fecha: laftCashTxns.fecha,
    amount: laftCashTxns.amount,
    kind: laftCashTxns.kind,
    numeroRecibo: laftCashTxns.numeroRecibo,
    indiv: laftCashTxns.thresholdIndividualBreached,
    acum: laftCashTxns.thresholdAcumuladoBreached,
  }).from(laftCashTxns)
    .leftJoin(laftCounterparties, eq(laftCashTxns.counterpartyId, laftCounterparties.id))
    .where(and(
      eq(laftCashTxns.kind, 'efectivo'),
      gte(laftCashTxns.fecha, desde),
      lte(laftCashTxns.fecha, hasta),
      breachClause as unknown as ReturnType<typeof eq>,
    ))
    .orderBy(laftCashTxns.fecha);

  const csvRows = rowsRaw.map((r) => ({
    docType: r.docType,
    docNumber: r.docNumber,
    fullName: r.fullName,
    fecha: r.fecha,
    amount: r.amount,
    kind: r.kind,
    numeroRecibo: r.numeroRecibo,
    causa: r.indiv && r.acum ? 'Individual + Acumulado'
      : r.indiv ? 'Individual'
      : 'Acumulado mensual',
  }));

  const totalMonto = rowsRaw.reduce((acc, r) => acc + Number(r.amount ?? '0'), 0);
  const csv = buildCsv(csvRows);
  const upload = await uploadReporte({ tipo: 'RTE', anio, mes, formato: 'CSV', body: csv });

  try {
    const [created] = await db.insert(laftReportesUiaf).values({
      tipo: 'RTE',
      periodoAnio: anio,
      periodoMes: mes,
      generadoPor: req.user!.sub,
      totalOperaciones: csvRows.length,
      totalMontoCop: String(totalMonto),
      formato: 'CSV',
      storageKey: upload.storageKey,
      sha256: upload.sha256,
    }).returning();

    await laftAudit(req, {
      action: 'rte_generate',
      resource: 'document',
      resourceId: created.id,
      after: { anio, mes, total: csvRows.length, sha256: upload.sha256 },
    });
    res.status(201).json(created);
  } catch (e: any) {
    // Carrera: alguien creó el reporte entre el SELECT y el INSERT — devolver el existente.
    if (e?.code === '23505') {
      const [again] = await db.select().from(laftReportesUiaf).where(and(
        eq(laftReportesUiaf.tipo, 'RTE'),
        eq(laftReportesUiaf.formato, 'CSV'),
        eq(laftReportesUiaf.periodoAnio, anio),
        eq(laftReportesUiaf.periodoMes, mes),
      ));
      if (again) { res.status(200).json({ ...again, idempotent: true }); return; }
    }
    log.error({ err: e?.message, anio, mes }, 'rte insert failed');
    res.status(500).json({ error: 'Error registrando reporte' });
  }
});

// === GET /:anio/:mes/download — descargar CSV ===============================
router.get('/:anio/:mes/download', async (req: Request, res: Response) => {
  const p = parseAnioMes(req);
  if (!p) { res.status(400).json({ error: 'Año o mes inválido' }); return; }
  const [row] = await db.select().from(laftReportesUiaf).where(and(
    eq(laftReportesUiaf.tipo, 'RTE'),
    eq(laftReportesUiaf.formato, 'CSV'),
    eq(laftReportesUiaf.periodoAnio, p.anio),
    eq(laftReportesUiaf.periodoMes, p.mes),
  ));
  if (!row || !row.storageKey) { res.status(404).json({ error: 'RTE no generado para ese mes' }); return; }
  try {
    const buf = await downloadReporte(row.storageKey);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="RTE-${p.anio}-${String(p.mes).padStart(2, '0')}.csv"`);
    res.setHeader('X-Reporte-Sha256', row.sha256);
    res.send(buf);
  } catch (e: any) {
    log.error({ err: e?.message, key: row.storageKey }, 'download failed');
    res.status(500).json({ error: 'Error descargando reporte' });
  }
});

// === GET / — list paginado =================================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const rows = await db.select().from(laftReportesUiaf)
    .where(eq(laftReportesUiaf.tipo, 'RTE'))
    .orderBy(desc(laftReportesUiaf.periodoAnio), desc(laftReportesUiaf.periodoMes))
    .limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(laftReportesUiaf).where(eq(laftReportesUiaf.tipo, 'RTE'));
  res.json({ rows, total: count, limit, offset });
});

export default router;
