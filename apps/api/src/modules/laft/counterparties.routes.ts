import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import { laftCounterparties, laftBeneficialOwners, laftListChecks } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { laftAudit } from './audit.service.js';
import { assessRisk, isValidFactor, nextReviewDate } from './risk.service.js';
import { checkAllLists, decideFromMatches, normalizeDoc, normalizeName } from './match.service.js';
import { encryptCounterpartyField, counterpartyDocHash } from './employees/counterparty-pii.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('laft-counterparties');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// Rate limit específico LAFT — más estricto que el global porque maneja PII sensible.
const laftWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones LAFT, espere 1 minuto' },
});

const docTypes = ['CC', 'CE', 'NIT', 'PAS', 'TI', 'PEP', 'DIE'] as const;

const beneficialOwnerSchema = z.object({
  docType: z.enum(docTypes),
  docNumber: z.string().min(3).max(20).regex(/^[0-9A-Z-]+$/i, 'Documento inválido').transform((s) => normalizeDoc(s)).refine((s) => s.length >= 3, 'Documento inválido'),
  fullName: z.string().min(2).max(200),
  ownershipPct: z.number().min(5).max(100),
  isPep: z.boolean().default(false),
});

const factorSchema = z.number().int().min(1).max(3);

const createSchema = z.object({
  kind: z.enum(['PN', 'PJ']),
  docType: z.enum(docTypes),
  docNumber: z.string().min(3).max(20).regex(/^[0-9A-Z-]+$/i, 'Documento inválido').transform((s) => normalizeDoc(s)).refine((s) => s.length >= 3, 'Documento inválido'),
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(150).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(80).default('Colombia'),
  economicActivity: z.string().max(200).optional(),
  ciiu: z.string().max(10).optional(),
  fundOrigin: z.string().min(10).max(2000),
  isPep: z.boolean().default(false),
  pepRole: z.string().max(200).optional(),
  pepPeriodStart: z.string().optional(),
  pepPeriodEnd: z.string().optional(),
  pepKinship: z.string().max(50).optional(),
  factorCounterparty: factorSchema,
  factorProduct: factorSchema,
  factorChannel: factorSchema,
  factorJurisdiction: factorSchema,
  beneficialOwners: z.array(beneficialOwnerSchema).optional().default([]),
});

const updateSchema = createSchema.partial().extend({
  version: z.number().int().min(1),
});

// === Listado con filtros y paginación ========================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const status = req.query.status as string | undefined;
  const risk = req.query.risk as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();

  const conds = [] as ReturnType<typeof eq>[];
  if (status && ['pendiente', 'vinculada', 'bloqueada', 'archivada'].includes(status)) {
    conds.push(eq(laftCounterparties.status, status as 'pendiente' | 'vinculada' | 'bloqueada' | 'archivada'));
  }
  if (risk && ['bajo', 'medio', 'alto'].includes(risk)) {
    conds.push(eq(laftCounterparties.riskLevel, risk as 'bajo' | 'medio' | 'alto'));
  }
  const whereClause = search
    ? and(
        conds.length ? and(...conds) : undefined,
        or(
          ilike(laftCounterparties.fullName, `%${search}%`),
          ilike(laftCounterparties.docNumber, `%${search}%`),
        ),
      )
    : conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(laftCounterparties)
    .where(whereClause)
    .orderBy(desc(laftCounterparties.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(laftCounterparties)
    .where(whereClause);

  res.json({ rows, total: count, limit, offset });
});

// === Detalle (incluye beneficiarios) =========================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  // Paralelizamos las 2 queries: counterparty y beneficiarios. No usamos LEFT JOIN porque
  // duplicaría las columnas del counterparty por cada beneficiario y luego habría que
  // colapsarlas en JS (más complejo, sin ganancia real).
  const [cps, owners] = await Promise.all([
    db.select().from(laftCounterparties).where(eq(laftCounterparties.id, id)),
    db.select().from(laftBeneficialOwners).where(eq(laftBeneficialOwners.counterpartyId, id)),
  ]);
  const cp = cps[0];
  if (!cp) { res.status(404).json({ error: 'Contraparte no encontrada' }); return; }
  res.json({ ...cp, beneficialOwners: owners });
});

// === Crear contraparte =======================================================
router.post('/', laftWriteLimiter, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  // Validación cruzada PEP
  if (data.isPep && (!data.pepRole || !data.pepKinship)) {
    res.status(400).json({ error: 'Si es PEP, indique cargo público y vínculo (titular/familiar)' }); return;
  }
  // PJ debe tener al menos un beneficiario final
  if (data.kind === 'PJ' && (!data.beneficialOwners || data.beneficialOwners.length === 0)) {
    res.status(400).json({ error: 'Persona jurídica requiere al menos un beneficiario final ≥5%' }); return;
  }
  // Validar factores explícitamente (Zod ya lo hace, pero defensa)
  if (![data.factorCounterparty, data.factorProduct, data.factorChannel, data.factorJurisdiction].every(isValidFactor)) {
    res.status(400).json({ error: 'Factores de riesgo inválidos (1-3)' }); return;
  }

  const risk = assessRisk({
    counterparty: data.factorCounterparty,
    product: data.factorProduct,
    channel: data.factorChannel,
    jurisdiction: data.factorJurisdiction,
  });
  const reviewDate = nextReviewDate(risk.nextReviewMonths);

  // Toda la creación + match contra listas restrictivas + posible bloqueo automático ocurren
  // en UNA transacción. Si cualquier paso falla, rollback completo (cumple sección 11 política:
  // no se crea contraparte sin verificar contra listas vinculantes).
  try {
    const txResult = await db.transaction(async (tx) => {
      const [cp] = await tx.insert(laftCounterparties).values({
        kind: data.kind,
        docType: data.docType,
        docNumber: data.docNumber.toUpperCase(),
        fullName: data.fullName.trim(),
        email: data.email ?? null,
        phone: data.phone ?? null,
        address: data.address ?? null,
        city: data.city ?? null,
        country: data.country,
        economicActivity: data.economicActivity ?? null,
        ciiu: data.ciiu ?? null,
        fundOrigin: data.fundOrigin,
        isPep: data.isPep,
        pepRole: data.pepRole ?? null,
        pepPeriodStart: data.pepPeriodStart ?? null,
        pepPeriodEnd: data.pepPeriodEnd ?? null,
        pepKinship: data.pepKinship ?? null,
        factorCounterparty: data.factorCounterparty,
        factorProduct: data.factorProduct,
        factorChannel: data.factorChannel,
        factorJurisdiction: data.factorJurisdiction,
        riskLevel: risk.level,
        status: 'pendiente',
        nextReviewAt: reviewDate,
        createdBy: req.user!.sub,
      }).returning();

      // F2 — cifrado PII en el INSERT inicial. Se hace en UPDATE adicional dentro
      // de la misma transacción porque el aadNonce del bundle depende del id de la
      // fila (rowKey = id). Si la transacción rollback, no queda cifrado huérfano.
      const docEnc = encryptCounterpartyField(cp.docNumber, 'doc_number', cp.id);
      const emailEnc = encryptCounterpartyField(cp.email ?? null, 'email', cp.id);
      const phoneEnc = encryptCounterpartyField(cp.phone ?? null, 'phone', cp.id);
      const docHash = counterpartyDocHash(cp.docNumber);
      await tx.update(laftCounterparties).set({
        docNumberEnc: docEnc as unknown as Record<string, unknown>,
        docNumberHash: docHash,
        emailEnc: emailEnc as unknown as Record<string, unknown>,
        phoneEnc: phoneEnc as unknown as Record<string, unknown>,
      }).where(eq(laftCounterparties.id, cp.id));

      if (data.beneficialOwners.length > 0) {
        await tx.insert(laftBeneficialOwners).values(
          data.beneficialOwners.map((bo) => ({
            counterpartyId: cp.id,
            docType: bo.docType,
            docNumber: bo.docNumber.toUpperCase(),
            fullName: bo.fullName.trim(),
            ownershipPct: String(bo.ownershipPct),
            isPep: bo.isPep,
          })),
        );
      }

      // Match contra listas: SELECT seguro de leer fuera de la tx (no necesita ver el counterparty
      // recién insertado). Las escrituras (laft_list_checks + update status) sí van en la tx.
      const listMatches = await checkAllLists({ docNumber: cp.docNumber, fullName: cp.fullName });
      const listDecision = decideFromMatches(listMatches);

      if (listMatches.length > 0) {
        await tx.insert(laftListChecks).values(listMatches.map((m) => ({
          counterpartyId: cp.id,
          listId: m.listId,
          queryDoc: normalizeDoc(cp.docNumber),
          queryNameNorm: normalizeName(cp.fullName),
          matchEntryId: m.entryId,
          matchScore: m.score,
          matchKind: m.kind,
          evidence: { listCode: m.listCode, entryName: m.entryName, entryDoc: m.entryDoc, binding: m.binding },
          checkedBy: req.user!.sub,
        })));
      }

      let finalCp = cp;
      if (listDecision.shouldBlock) {
        const [blocked] = await tx.update(laftCounterparties).set({
          status: 'bloqueada',
          blockReason: listDecision.reason,
          updatedAt: new Date(),
          version: cp.version + 1,
        }).where(eq(laftCounterparties.id, cp.id)).returning();
        finalCp = blocked ?? cp;
      }

      return { cp: finalCp, listMatches, listDecision };
    });

    // Audit fuera de la tx (mejor que dentro: si la tx falla no interesa registrar el intento;
    // si llegamos aquí, todo el flujo fue atómico).
    await laftAudit(req, {
      action: 'create_counterparty',
      resource: 'counterparty',
      resourceId: txResult.cp.id,
      after: { docNumber: txResult.cp.docNumber, fullName: txResult.cp.fullName, riskLevel: txResult.cp.riskLevel },
    });
    if (txResult.listDecision.shouldBlock) {
      await laftAudit(req, {
        action: 'auto_block',
        resource: 'counterparty',
        resourceId: txResult.cp.id,
        after: { reason: txResult.listDecision.reason, matches: txResult.listMatches.length },
      });
    }

    res.status(201).json({
      ...txResult.cp,
      riskScore: risk.score,
      listDecision: txResult.listDecision,
      listMatches: txResult.listMatches,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    if (msg.includes('laft_counterparties_doc_unique') || msg.includes('duplicate key')) {
      res.status(409).json({ error: 'Ya existe contraparte con ese tipo y número de documento' }); return;
    }
    log.error({ err: e }, 'create error');
    res.status(500).json({ error: 'Error creando contraparte' });
  }
});

// === Actualizar (con optimistic lock) ========================================
router.patch('/:id', laftWriteLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [before] = await db.select().from(laftCounterparties).where(eq(laftCounterparties.id, id));
  if (!before) { res.status(404).json({ error: 'Contraparte no encontrada' }); return; }
  if (before.version !== data.version) {
    res.status(409).json({ error: 'Versión desactualizada — recargue antes de guardar' }); return;
  }

  // Recalcular riesgo si vinieron factores
  const updates: Record<string, unknown> = { updatedAt: new Date(), version: before.version + 1 };
  for (const k of ['fullName', 'email', 'phone', 'address', 'city', 'country', 'economicActivity', 'ciiu', 'fundOrigin', 'isPep', 'pepRole', 'pepKinship'] as const) {
    if (data[k] !== undefined) updates[k] = data[k];
  }
  // F2 — re-cifrar email/phone si cambiaron. Para doc_number no hacemos rotate
  // porque la unicidad lógica depende del hash y del valor claro (que aún viene
  // hasta drop legacy). Si docNumber no se permite cambiar en este endpoint, no
  // tocamos su enc/hash.
  if (data.email !== undefined) {
    updates.emailEnc = encryptCounterpartyField(data.email ?? null, 'email', id) as unknown as Record<string, unknown>;
  }
  if (data.phone !== undefined) {
    updates.phoneEnc = encryptCounterpartyField(data.phone ?? null, 'phone', id) as unknown as Record<string, unknown>;
  }
  if (data.factorCounterparty !== undefined) updates.factorCounterparty = data.factorCounterparty;
  if (data.factorProduct !== undefined) updates.factorProduct = data.factorProduct;
  if (data.factorChannel !== undefined) updates.factorChannel = data.factorChannel;
  if (data.factorJurisdiction !== undefined) updates.factorJurisdiction = data.factorJurisdiction;

  const factors = {
    counterparty: data.factorCounterparty ?? before.factorCounterparty ?? 1,
    product: data.factorProduct ?? before.factorProduct ?? 1,
    channel: data.factorChannel ?? before.factorChannel ?? 1,
    jurisdiction: data.factorJurisdiction ?? before.factorJurisdiction ?? 1,
  };
  if ([factors.counterparty, factors.product, factors.channel, factors.jurisdiction].every(isValidFactor)) {
    const risk = assessRisk(factors);
    updates.riskLevel = risk.level;
    updates.nextReviewAt = nextReviewDate(risk.nextReviewMonths);
  }

  // Optimistic lock atómico: el version va al WHERE para que un escritor concurrente quede sin returning.
  const [updated] = await db.update(laftCounterparties).set(updates)
    .where(and(eq(laftCounterparties.id, id), eq(laftCounterparties.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia — recargue' }); return; }

  await laftAudit(req, {
    action: 'update_counterparty',
    resource: 'counterparty',
    resourceId: id,
    before: { riskLevel: before.riskLevel, status: before.status, version: before.version },
    after: { riskLevel: updated.riskLevel, status: updated.status, version: updated.version },
  });

  res.json(updated);
});

// === Cambiar estado (vincular / bloquear / archivar) =========================
const statusChangeSchema = z.object({
  status: z.enum(['pendiente', 'vinculada', 'bloqueada', 'archivada']),
  reason: z.string().max(2000).optional(),
  version: z.number().int().min(1),
});

router.post('/:id/status', laftWriteLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = statusChangeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const [before] = await db.select().from(laftCounterparties).where(eq(laftCounterparties.id, id));
  if (!before) { res.status(404).json({ error: 'Contraparte no encontrada' }); return; }
  if (before.version !== parsed.data.version) {
    res.status(409).json({ error: 'Versión desactualizada' }); return;
  }

  if (parsed.data.status === 'bloqueada' && !parsed.data.reason) {
    res.status(400).json({ error: 'Bloqueo requiere motivo' }); return;
  }

  const [updated] = await db.update(laftCounterparties).set({
    status: parsed.data.status,
    blockReason: parsed.data.status === 'bloqueada' ? (parsed.data.reason ?? null) : null,
    updatedAt: new Date(),
    version: before.version + 1,
  })
    .where(and(eq(laftCounterparties.id, id), eq(laftCounterparties.version, before.version)))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Conflicto de concurrencia — recargue' }); return; }

  await laftAudit(req, {
    action: `status_${parsed.data.status}`,
    resource: 'counterparty',
    resourceId: id,
    before: { status: before.status },
    after: { status: updated.status, reason: parsed.data.reason ?? null },
  });

  res.json(updated);
});

export default router;
