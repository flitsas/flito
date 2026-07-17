import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftEmployeesKyc, users } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { checkAllLists, decideFromMatches } from '../match.service.js';
import { assessEmployeeRisk, nextEmployeeReviewDate, type EmpRiskInput } from './employees.service.js';
import { invalidateLaftBlockCache } from './auth-block.service.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-employees');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// Rate limit estricto LAFT (paralelo a counterparties).
const laftWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('laft-emp-w'),
  message: { error: 'Demasiadas operaciones LAFT, espere 1 minuto' },
});

// Upload de antecedentes — PDF/imagen, ≤10MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =============================================================================
// Schemas
// =============================================================================

const factorSchema = z.object({
  value: z.number().int().min(1).max(3),
}).passthrough().nullable().optional();

const antecedentesResultadoSchema = z.object({
  procuraduria: z.string().optional(),
  policia: z.string().optional(),
  contraloria: z.string().optional(),
}).strict().nullable().optional();

const createSchema = z.object({
  factorPersona: factorSchema,
  factorCanal: factorSchema,
  factorZona: factorSchema,
  pep: z.boolean().default(false),
  pepDetalle: z.string().max(2000).optional(),
  observaciones: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  factorPersona: factorSchema,
  factorCanal: factorSchema,
  factorZona: factorSchema,
  pep: z.boolean().optional(),
  pepDetalle: z.string().max(2000).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
  version: z.number().int().min(1),
});

const antecedentesSchema = z.object({
  procuraduria: z.string().max(50).optional(),
  policia: z.string().max(50).optional(),
  contraloria: z.string().max(50).optional(),
});

// =============================================================================
// Idempotency (header Idempotency-Key) — usamos pg advisory lock para que la
// segunda llamada con la misma key dentro de la misma transacción NO duplique.
// El patrón completo (tabla persistente) lo tiene jornadas; aquí basta con
// UNIQUE(user_id) que ya enforza idempotencia natural por user.
// =============================================================================

function readIdempKey(req: Request): string | null {
  const k = req.header('Idempotency-Key');
  if (!k || k.length < 8 || k.length > 80) return null;
  return k;
}

// =============================================================================
// Rutas
// =============================================================================

// === Listado con filtros y paginación ========================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const risk = req.query.risk_level as string | undefined;
  const blocked = req.query.match_blocked as string | undefined;
  const dueUntil = req.query.next_review_at_until as string | undefined;

  const conds: ReturnType<typeof eq>[] = [];
  if (risk && ['bajo', 'medio', 'alto'].includes(risk)) {
    conds.push(eq(laftEmployeesKyc.riskLevel, risk));
  }
  if (blocked === 'true') conds.push(eq(laftEmployeesKyc.matchBlocked, true));
  if (blocked === 'false') conds.push(eq(laftEmployeesKyc.matchBlocked, false));
  if (dueUntil && /^\d{4}-\d{2}-\d{2}$/.test(dueUntil)) {
    conds.push(lte(laftEmployeesKyc.nextReviewAt, dueUntil));
  }
  const whereClause = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(laftEmployeesKyc)
    .where(whereClause)
    .orderBy(desc(laftEmployeesKyc.updatedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(laftEmployeesKyc)
    .where(whereClause);

  res.json({ rows, total: count, limit, offset });
});

// === Detalle por user_id =====================================================
router.get('/:userId', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ error: 'userId inválido' }); return; }
  const [row] = await db.select().from(laftEmployeesKyc).where(eq(laftEmployeesKyc.userId, userId)).limit(1);
  if (!row) { res.status(404).json({ error: 'KYC no encontrado para el empleado' }); return; }
  res.json(row);
});

// === Crear KYC para empleado =================================================
router.post('/:userId/kyc', laftWriteLimiter, async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ error: 'userId inválido' }); return; }

  const idempKey = readIdempKey(req);
  if (!idempKey) { res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' }); return; }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  if (data.pep && !data.pepDetalle) {
    res.status(400).json({ error: 'PEP=true requiere pepDetalle' }); return;
  }

  try {
    const txResult = await db.transaction(async (tx) => {
      // FOR UPDATE en users (lock pessimista) para que no se borre el user mientras
      // creamos su KYC. Sigue el patrón de jornadas/cobros.
      const [u] = await tx.select({ id: users.id, name: users.name, username: users.username })
        .from(users).where(eq(users.id, userId)).for('update').limit(1);
      if (!u) return { code: 404 as const };

      // Match contra listas restrictivas usando username + name (no tenemos doc).
      // Si en el futuro `users` tiene cédula cifrada, pasarla aquí también.
      const listMatches = await checkAllLists({ docNumber: u.username, fullName: u.name });
      const listDecision = decideFromMatches(listMatches);

      const risk = assessEmployeeRisk({
        factorPersona: data.factorPersona ?? null,
        factorCanal: data.factorCanal ?? null,
        factorZona: data.factorZona ?? null,
        pep: data.pep,
        antecedentesResultado: null,
      });
      const reviewDate = nextEmployeeReviewDate(risk.nextReviewMonths);

      try {
        const [row] = await tx.insert(laftEmployeesKyc).values({
          userId,
          factorPersona: data.factorPersona ?? null,
          factorCanal: data.factorCanal ?? null,
          factorZona: data.factorZona ?? null,
          pep: data.pep,
          pepDetalle: data.pepDetalle ?? null,
          riskLevel: risk.level,
          matchBlocked: listDecision.shouldBlock,
          matchBlockedReason: listDecision.shouldBlock ? listDecision.reason : null,
          nextReviewAt: reviewDate,
          observaciones: data.observaciones ?? null,
          createdBy: req.user!.sub,
        }).returning();

        // Si quedó bloqueado, bumpear session_invalidated_at del user para tirar tokens previos.
        if (listDecision.shouldBlock) {
          await tx.update(users).set({ sessionInvalidatedAt: new Date() }).where(eq(users.id, userId));
        }
        return { code: 201 as const, row, listMatches, listDecision };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        if (msg.includes('uq_laft_emp_kyc_user') || msg.includes('duplicate key')) {
          return { code: 409 as const, msg: 'Ya existe KYC para este empleado' };
        }
        throw e;
      }
    });

    if (txResult.code === 404) { res.status(404).json({ error: 'Empleado no encontrado' }); return; }
    if (txResult.code === 409) { res.status(409).json({ error: txResult.msg }); return; }

    invalidateLaftBlockCache(userId);

    await laftAudit(req, {
      action: 'create_employee_kyc',
      resource: 'risk_assessment',
      resourceId: txResult.row.id,
      after: { userId, riskLevel: txResult.row.riskLevel, matchBlocked: txResult.row.matchBlocked },
    });
    if (txResult.listDecision.shouldBlock) {
      await laftAudit(req, {
        action: 'employee_auto_block',
        resource: 'risk_assessment',
        resourceId: txResult.row.id,
        after: { userId, reason: txResult.listDecision.reason, matches: txResult.listMatches.length },
      });
    }

    res.status(201).json({
      ...txResult.row,
      listDecision: txResult.listDecision,
      listMatches: txResult.listMatches,
    });
  } catch (e) {
    log.error({ err: e, userId }, 'create_employee_kyc error');
    res.status(500).json({ error: 'Error creando KYC empleado' });
  }
});

// === Update KYC (optimistic locking) =========================================
router.patch('/:userId', laftWriteLimiter, async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ error: 'userId inválido' }); return; }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [before] = await db.select().from(laftEmployeesKyc).where(eq(laftEmployeesKyc.userId, userId)).limit(1);
  if (!before) { res.status(404).json({ error: 'KYC no encontrado' }); return; }
  if (before.version !== data.version) {
    res.status(409).json({ error: 'Versión desactualizada — recargue antes de guardar' }); return;
  }

  // Si vino algo de factor o pep, recalcular risk + relistar.
  const merged: EmpRiskInput = {
    factorPersona: data.factorPersona !== undefined ? data.factorPersona : (before.factorPersona as EmpRiskInput['factorPersona']),
    factorCanal: data.factorCanal !== undefined ? data.factorCanal : (before.factorCanal as EmpRiskInput['factorCanal']),
    factorZona: data.factorZona !== undefined ? data.factorZona : (before.factorZona as EmpRiskInput['factorZona']),
    pep: data.pep !== undefined ? data.pep : before.pep,
    antecedentesResultado: before.antecedentesResultado as EmpRiskInput['antecedentesResultado'],
  };
  const risk = assessEmployeeRisk(merged);

  // Reevaluar match (si el name cambió, etc.) — barato y mantiene el bloqueo coherente.
  const [u] = await db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
  let listDecision: { shouldBlock: boolean; reason: string | null } = { shouldBlock: false, reason: null };
  if (u) {
    const matches = await checkAllLists({ docNumber: u.username, fullName: u.name });
    listDecision = decideFromMatches(matches);
  }

  const updates: Record<string, unknown> = {
    riskLevel: risk.level,
    nextReviewAt: nextEmployeeReviewDate(risk.nextReviewMonths),
    matchBlocked: listDecision.shouldBlock,
    matchBlockedReason: listDecision.shouldBlock ? listDecision.reason : null,
    updatedAt: new Date(),
    updatedBy: req.user!.sub,
    version: before.version + 1,
  };
  if (data.factorPersona !== undefined) updates.factorPersona = data.factorPersona;
  if (data.factorCanal !== undefined) updates.factorCanal = data.factorCanal;
  if (data.factorZona !== undefined) updates.factorZona = data.factorZona;
  if (data.pep !== undefined) updates.pep = data.pep;
  if (data.pepDetalle !== undefined) updates.pepDetalle = data.pepDetalle;
  if (data.observaciones !== undefined) updates.observaciones = data.observaciones;

  const [updated] = await db.update(laftEmployeesKyc).set(updates)
    .where(and(eq(laftEmployeesKyc.userId, userId), eq(laftEmployeesKyc.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia — recargue' }); return; }

  // Si el bloqueo cambió, invalidar caché y bumpear session.
  if (before.matchBlocked !== updated.matchBlocked) {
    invalidateLaftBlockCache(userId);
    if (updated.matchBlocked) {
      await db.update(users).set({ sessionInvalidatedAt: new Date() }).where(eq(users.id, userId));
    }
  } else {
    invalidateLaftBlockCache(userId);
  }

  await laftAudit(req, {
    action: 'update_employee_kyc',
    resource: 'risk_assessment',
    resourceId: updated.id,
    before: { riskLevel: before.riskLevel, matchBlocked: before.matchBlocked, version: before.version },
    after: { riskLevel: updated.riskLevel, matchBlocked: updated.matchBlocked, version: updated.version },
  });

  res.json(updated);
});

// === Antecedentes (upload + resultados) ======================================
router.post('/:userId/antecedentes', laftWriteLimiter, upload.single('file'), async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ error: 'userId inválido' }); return; }

  // El cuerpo viene como multipart con field "data" JSON cuando hay file, o JSON puro.
  const raw = (req.body && typeof req.body.data === 'string') ? JSON.parse(req.body.data) : req.body;
  const parsed = antecedentesSchema.safeParse(raw);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const [before] = await db.select().from(laftEmployeesKyc).where(eq(laftEmployeesKyc.userId, userId)).limit(1);
  if (!before) { res.status(404).json({ error: 'KYC no encontrado' }); return; }

  // El file en sí lo guardamos como path simbólico (la subida real a S3/MinIO la hace
  // un módulo upstream o se conecta luego — F2 no es la fase de storage).
  const documentoPath = req.file
    ? `laft/employees/${userId}/antecedentes-${Date.now()}-${req.file.originalname}`
    : before.antecedentesDocumentoPath;

  const resultado = parsed.data;
  // Recalcular riesgo con el nuevo resultado.
  const risk = assessEmployeeRisk({
    factorPersona: before.factorPersona as EmpRiskInput['factorPersona'],
    factorCanal: before.factorCanal as EmpRiskInput['factorCanal'],
    factorZona: before.factorZona as EmpRiskInput['factorZona'],
    pep: before.pep,
    antecedentesResultado: resultado,
  });

  const [updated] = await db.update(laftEmployeesKyc).set({
    antecedentesCheckAt: new Date(),
    antecedentesResultado: resultado,
    antecedentesDocumentoPath: documentoPath ?? null,
    riskLevel: risk.level,
    nextReviewAt: nextEmployeeReviewDate(risk.nextReviewMonths),
    updatedAt: new Date(),
    updatedBy: req.user!.sub,
    version: before.version + 1,
  })
    .where(and(eq(laftEmployeesKyc.userId, userId), eq(laftEmployeesKyc.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia' }); return; }

  invalidateLaftBlockCache(userId);

  await laftAudit(req, {
    action: 'employee_antecedentes_check',
    resource: 'document',
    resourceId: updated.id,
    after: { userId, resultado, riskLevel: updated.riskLevel },
  });

  res.json(updated);
});

// === ReKYC manual (extiende next_review_at +1 año) ==========================
router.post('/:userId/rekyc', laftWriteLimiter, async (req: Request, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ error: 'userId inválido' }); return; }

  const [before] = await db.select().from(laftEmployeesKyc).where(eq(laftEmployeesKyc.userId, userId)).limit(1);
  if (!before) { res.status(404).json({ error: 'KYC no encontrado' }); return; }

  const next = nextEmployeeReviewDate(12);
  const [updated] = await db.update(laftEmployeesKyc).set({
    nextReviewAt: next,
    updatedAt: new Date(),
    updatedBy: req.user!.sub,
    version: before.version + 1,
  })
    .where(and(eq(laftEmployeesKyc.userId, userId), eq(laftEmployeesKyc.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia' }); return; }

  await laftAudit(req, {
    action: 'employee_rekyc',
    resource: 'risk_assessment',
    resourceId: updated.id,
    before: { nextReviewAt: before.nextReviewAt },
    after: { nextReviewAt: updated.nextReviewAt },
  });
  res.json(updated);
});

export default router;
