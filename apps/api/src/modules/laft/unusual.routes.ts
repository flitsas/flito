import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import { laftUnusualOperations, laftCounterparties } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { laftAudit } from './audit.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const writeLimiter = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: userOrIpKey('laft-uo'),
  message: { error: 'Demasiadas operaciones, espere 1 minuto' },
});

const decisionEnum = ['pendiente', 'en_analisis', 'descartada', 'escalada', 'reportada'] as const;

const createSchema = z.object({
  counterpartyId: z.number().int().positive().optional(),
  source: z.string().min(1).max(50),
  signals: z.array(z.string().max(200)).min(1).max(20),
  amount: z.number().nonnegative().optional(),
  currency: z.string().max(10).default('COP'),
  description: z.string().min(10).max(5000),
});

const updateSchema = z.object({
  analysisText: z.string().max(10000).optional(),
  decision: z.enum(decisionEnum),
  decisionReason: z.string().max(2000).optional(),
  version: z.number().int().positive(),
});

// === Listado con filtros y paginación =======================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const decisionFilter = req.query.decision as string | undefined;

  const where = decisionFilter && (decisionEnum as readonly string[]).includes(decisionFilter)
    ? eq(laftUnusualOperations.decision, decisionFilter as (typeof decisionEnum)[number])
    : undefined;

  const rows = await db.select({
    id: laftUnusualOperations.id,
    counterpartyId: laftUnusualOperations.counterpartyId,
    counterpartyName: laftCounterparties.fullName,
    counterpartyDoc: laftCounterparties.docNumber,
    detectedAt: laftUnusualOperations.detectedAt,
    source: laftUnusualOperations.source,
    signals: laftUnusualOperations.signals,
    amount: laftUnusualOperations.amount,
    currency: laftUnusualOperations.currency,
    description: laftUnusualOperations.description,
    decision: laftUnusualOperations.decision,
    decidedAt: laftUnusualOperations.decidedAt,
    version: laftUnusualOperations.version,
  }).from(laftUnusualOperations)
    .leftJoin(laftCounterparties, eq(laftUnusualOperations.counterpartyId, laftCounterparties.id))
    .where(where)
    .orderBy(desc(laftUnusualOperations.detectedAt))
    .limit(limit).offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(laftUnusualOperations).where(where);
  res.json({ rows, total: count, limit, offset });
});

// === Detalle ================================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [op] = await db.select().from(laftUnusualOperations).where(eq(laftUnusualOperations.id, id));
  if (!op) { res.status(404).json({ error: 'Operación no encontrada' }); return; }
  res.json(op);
});

// === Crear (registrar señal de alerta) ======================================
router.post('/', writeLimiter, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  if (data.counterpartyId) {
    const [cp] = await db.select({ id: laftCounterparties.id }).from(laftCounterparties).where(eq(laftCounterparties.id, data.counterpartyId));
    if (!cp) { res.status(400).json({ error: 'Contraparte no existe' }); return; }
  }

  const [created] = await db.insert(laftUnusualOperations).values({
    counterpartyId: data.counterpartyId ?? null,
    detectedBy: req.user!.sub,
    source: data.source,
    signals: data.signals,
    amount: data.amount != null ? String(data.amount) : null,
    currency: data.currency,
    description: data.description,
  }).returning();

  await laftAudit(req, {
    action: 'create_unusual_operation', resource: 'document', resourceId: created.id,
    after: { source: created.source, decision: created.decision, signals: data.signals },
  });

  res.status(201).json(created);
});

// === Actualizar análisis y decisión =========================================
router.patch('/:id', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [before] = await db.select().from(laftUnusualOperations).where(eq(laftUnusualOperations.id, id));
  if (!before) { res.status(404).json({ error: 'Operación no encontrada' }); return; }
  if (before.version !== data.version) { res.status(409).json({ error: 'Versión desactualizada — recargue' }); return; }

  if ((data.decision === 'descartada' || data.decision === 'reportada') && !data.decisionReason) {
    res.status(400).json({ error: 'La decisión requiere justificación' }); return;
  }

  // SARLAFT: ROS dirigido a UIAF debe identificar al sujeto reportado.
  // Sin contraparte el payload SIREL queda con sujeto null y la UIAF rechaza.
  if (data.decision === 'reportada' && !before.counterpartyId) {
    res.status(422).json({
      error: 'No se puede reportar (ROS) sin contraparte identificada',
      hint: 'Asocie la operación a una contraparte LAFT antes de marcarla como reportada',
    });
    return;
  }

  const isDecisionChange = data.decision !== before.decision;

  const [updated] = await db.update(laftUnusualOperations).set({
    analysisText: data.analysisText ?? before.analysisText,
    decision: data.decision,
    decisionReason: data.decisionReason ?? before.decisionReason,
    decidedBy: isDecisionChange ? req.user!.sub : before.decidedBy,
    decidedAt: isDecisionChange ? new Date() : before.decidedAt,
    updatedAt: new Date(),
    version: before.version + 1,
  })
    .where(and(eq(laftUnusualOperations.id, id), eq(laftUnusualOperations.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia' }); return; }

  await laftAudit(req, {
    action: 'update_unusual_operation', resource: 'document', resourceId: id,
    before: { decision: before.decision },
    after: { decision: updated.decision, reason: data.decisionReason ?? null },
  });

  res.json(updated);
});

export default router;
