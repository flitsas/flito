import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../../db/client.js';
import {
  laftCashTxns,
  laftCounterparties,
  laftRosDrafts,
} from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { loggerFor } from '../../../shared/logger.js';
import { registrarCashTxn } from './cash.service.js';

const log = loggerFor('laft-cash');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// Rate limit más estricto que el global — registro de PII financiera.
const writeLimiter = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: userOrIpKey('laft-cash'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones, espere 1 minuto' },
});

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  counterpartyId: z.number().int().positive(),
  amount: z.number().positive().max(1e15),
  currency: z.string().length(3).default('COP').transform((s) => s.toUpperCase()),
  kind: z.enum(['efectivo', 'cheque', 'transferencia', 'otro']),
  fecha: z.string().regex(FECHA_RE, 'fecha debe ser YYYY-MM-DD').refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    // No aceptamos fechas futuras (>1 día por timezone) — anti registro adelantado.
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return d.getTime() <= tomorrow.getTime();
  }, 'fecha inválida o futura'),
  descripcion: z.string().max(2000).optional(),
  numeroRecibo: z.string().max(60).optional(),
});

const linkRosSchema = z.object({
  rosDraftId: z.number().int().positive(),
});

function readIdempKey(req: Request): string | null {
  const k = req.header('Idempotency-Key');
  if (!k || k.length < 8 || k.length > 80) return null;
  return k;
}

// === POST / — registrar txn en efectivo (o no efectivo) =====================
router.post('/', writeLimiter, async (req: Request, res: Response) => {
  const idempKey = readIdempKey(req);
  if (!idempKey) {
    res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' });
    return;
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  try {
    const result = await registrarCashTxn(
      {
        counterpartyId: data.counterpartyId,
        amount: data.amount,
        currency: data.currency,
        kind: data.kind,
        fecha: data.fecha,
        descripcion: data.descripcion ?? null,
        numeroRecibo: data.numeroRecibo ?? null,
      },
      req.user!.sub,
      idempKey,
    );

    // Audit fuera de transacción — best effort (igual que el resto del módulo LAFT).
    if (!result.idempotent) {
      await laftAudit(req, {
        action: 'create_cash_txn',
        resource: 'document',
        resourceId: result.txn.id,
        after: {
          counterpartyId: data.counterpartyId,
          amount: data.amount,
          kind: data.kind,
          breachIndividual: result.breachIndividual,
          breachAcumulado: result.breachAcumulado,
          unusualOperationId: result.unusualOperationId,
        },
      });
      if (result.breachIndividual || result.breachAcumulado) {
        await laftAudit(req, {
          action: 'cash_threshold_breach',
          resource: 'document',
          resourceId: result.txn.id,
          after: {
            individual: result.breachIndividual,
            acumulado: result.breachAcumulado,
            unusualOperationId: result.unusualOperationId,
            monthlySumAfter: result.monthlySumAfter,
          },
        });
      }
    }

    res.status(result.idempotent ? 200 : 201).json({
      ...result.txn,
      breachIndividual: result.breachIndividual,
      breachAcumulado: result.breachAcumulado,
      unusualOperationId: result.unusualOperationId,
      idempotent: result.idempotent,
    });
  } catch (e: any) {
    if (e?.httpStatus) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    log.error({ err: e?.message, counterpartyId: data.counterpartyId }, 'cash txn create failed');
    res.status(500).json({ error: 'Error registrando transacción' });
  }
});

// === GET / — list paginado con filtros =====================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const counterpartyId = req.query.counterpartyId ? parseInt(req.query.counterpartyId as string, 10) : null;
  const kind = req.query.kind as string | undefined;
  const fechaDesde = req.query.fechaDesde as string | undefined;
  const fechaHasta = req.query.fechaHasta as string | undefined;
  const breachOnly = req.query.breachOnly === 'true';

  const conds: ReturnType<typeof eq>[] = [];
  if (counterpartyId && counterpartyId > 0) conds.push(eq(laftCashTxns.counterpartyId, counterpartyId));
  if (kind && ['efectivo', 'cheque', 'transferencia', 'otro'].includes(kind)) {
    conds.push(eq(laftCashTxns.kind, kind));
  }
  if (fechaDesde && FECHA_RE.test(fechaDesde)) conds.push(gte(laftCashTxns.fecha, fechaDesde));
  if (fechaHasta && FECHA_RE.test(fechaHasta)) conds.push(lte(laftCashTxns.fecha, fechaHasta));
  if (breachOnly) {
    conds.push(sql`(${laftCashTxns.thresholdIndividualBreached} OR ${laftCashTxns.thresholdAcumuladoBreached})` as unknown as ReturnType<typeof eq>);
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select({
    id: laftCashTxns.id,
    counterpartyId: laftCashTxns.counterpartyId,
    counterpartyName: laftCounterparties.fullName,
    counterpartyDoc: laftCounterparties.docNumber,
    amount: laftCashTxns.amount,
    currency: laftCashTxns.currency,
    kind: laftCashTxns.kind,
    fecha: laftCashTxns.fecha,
    descripcion: laftCashTxns.descripcion,
    numeroRecibo: laftCashTxns.numeroRecibo,
    thresholdIndividualBreached: laftCashTxns.thresholdIndividualBreached,
    thresholdAcumuladoBreached: laftCashTxns.thresholdAcumuladoBreached,
    unusualOperationId: laftCashTxns.unusualOperationId,
    rosDraftId: laftCashTxns.rosDraftId,
    registradoAt: laftCashTxns.registradoAt,
  }).from(laftCashTxns)
    .leftJoin(laftCounterparties, eq(laftCashTxns.counterpartyId, laftCounterparties.id))
    .where(where)
    .orderBy(desc(laftCashTxns.fecha), desc(laftCashTxns.id))
    .limit(limit).offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(laftCashTxns).where(where);
  res.json({ rows, total: count, limit, offset });
});

// === GET /:id — detalle ====================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(laftCashTxns).where(eq(laftCashTxns.id, id));
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json(row);
});

// === PATCH /:id/link-ros — vincular a un ROS draft =========================
router.patch('/:id/link-ros', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = linkRosSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  // FOR UPDATE para evitar carrera con otro link-ros sobre la misma fila.
  const result = await db.transaction(async (tx) => {
    const [txn] = await tx.select().from(laftCashTxns)
      .where(eq(laftCashTxns.id, id)).for('update');
    if (!txn) return { code: 404 as const };
    const [ros] = await tx.select({ id: laftRosDrafts.id })
      .from(laftRosDrafts).where(eq(laftRosDrafts.id, parsed.data.rosDraftId));
    if (!ros) return { code: 422 as const, msg: 'ROS draft no existe' };

    const [updated] = await tx.update(laftCashTxns)
      .set({ rosDraftId: parsed.data.rosDraftId })
      .where(eq(laftCashTxns.id, id))
      .returning();
    return { code: 200 as const, before: txn.rosDraftId, row: updated };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (result.code === 422) { res.status(422).json({ error: result.msg }); return; }

  await laftAudit(req, {
    action: 'cash_link_ros',
    resource: 'document',
    resourceId: id,
    before: { rosDraftId: result.before },
    after: { rosDraftId: parsed.data.rosDraftId },
  });
  res.json(result.row);
});

export default router;
