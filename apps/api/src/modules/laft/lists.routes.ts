import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq, desc } from 'drizzle-orm';
import multer from 'multer';
import { db } from '../../db/client.js';
import { laftCounterparties, laftListChecks, laftRestrictiveLists, laftListEntries } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { laftAudit } from './audit.service.js';
import { checkAllLists, decideFromMatches, getListsWithCounts, normalizeName, normalizeDoc } from './match.service.js';
import { syncOfacSdn } from './lists/ofac.loader.js';
import { syncUnConsolidated } from './lists/un.loader.js';
import { syncEuSanctions } from './lists/eu.loader.js';
import { syncManualCsv, isManualListCode } from './lists/manual-csv.loader.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('laft-lists');

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB CSV
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv');
    if (!ok) return cb(new Error('Solo archivos CSV') as Error);
    cb(null, true);
  },
});

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// Sync de listas: máximo 2 por hora (descarga pesada).
const syncLimiter = rateLimit({ windowMs: 3_600_000, max: 2, keyGenerator: userOrIpKey('laft-sync'), message: { error: 'Sincronización limitada a 2 por hora' } });

// === Catálogo de listas =====================================================
router.get('/', async (_req: Request, res: Response) => {
  const lists = await getListsWithCounts();
  res.json(lists);
});

// === Sync automático de listas vinculantes (solo admin) =====================
router.post('/:code/sync', syncLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  const syncers: Record<string, () => Promise<{ listCode: string; fetched: number; inserted: number; errors: number; durationMs: number }>> = {
    OFAC: syncOfacSdn,
    UN: syncUnConsolidated,
    EU: syncEuSanctions,
  };
  const syncer = syncers[code];
  if (!syncer) {
    res.status(400).json({ error: `Sin loader automático para "${code}". Use el endpoint de upload CSV.` });
    return;
  }
  try {
    const result = await syncer();
    await laftAudit(req, { action: 'sync_list', resource: 'list_check', resourceId: code, after: result });
    if (result.errors > 0 || (result.fetched > 0 && result.inserted < result.fetched)) {
      const missing = result.fetched - result.inserted;
      res.status(500).json({ error: `Sincronización parcial: descargados ${result.fetched}, insertados ${result.inserted} (faltan ${missing}, ${result.errors} batch(es) con error). Revise logs.`, ...result });
      return;
    }
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    log.error({ err: e, code }, 'sync error');
    res.status(500).json({ error: `Sincronización fallida: ${msg}` });
  }
});

// === Upload manual CSV para listas de referencia ============================
router.post('/:code/upload-csv', requireRole('admin'), csvUpload.single('file'), async (req: Request, res: Response) => {
  const code = req.params.code.toUpperCase();
  if (!isManualListCode(code)) {
    res.status(400).json({ error: `Código "${code}" no acepta upload manual. Listas válidas: PROCURADURIA, CONTRALORIA, POLICIA, INTERPOL, CLINTON.` });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'Archivo CSV requerido (campo "file")' }); return; }

  try {
    const csv = req.file.buffer.toString('utf8');
    const result = await syncManualCsv({ code, csvContent: csv });
    await laftAudit(req, {
      action: 'upload_list_csv', resource: 'list_check', resourceId: code,
      after: { fetched: result.fetched, inserted: result.inserted, skipped: result.errors, filename: req.file.originalname },
    });
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    log.error({ err: e, code }, 'upload-csv error');
    res.status(400).json({ error: `Carga fallida: ${msg}` });
  }
});

// === Consultar listas para una contraparte ==================================
router.post('/check/:counterpartyId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.counterpartyId, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [cp] = await db.select().from(laftCounterparties).where(eq(laftCounterparties.id, id));
  if (!cp) { res.status(404).json({ error: 'Contraparte no encontrada' }); return; }

  const matches = await checkAllLists({ docNumber: cp.docNumber, fullName: cp.fullName });
  const decision = decideFromMatches(matches);

  // Persistir UN check por lista consultada (incluso si no hubo match — registro de DD §11)
  const userId = req.user!.sub;
  if (matches.length > 0) {
    await db.insert(laftListChecks).values(matches.map((m) => ({
      counterpartyId: id,
      listId: m.listId,
      queryDoc: normalizeDoc(cp.docNumber),
      queryNameNorm: normalizeName(cp.fullName),
      matchEntryId: m.entryId,
      matchScore: m.score,
      matchKind: m.kind,
      evidence: { listCode: m.listCode, entryName: m.entryName, entryDoc: m.entryDoc, binding: m.binding },
      checkedBy: userId,
    })));
  }

  // Aplicar decisión: bloqueo automático si match exacto vinculante
  let updatedStatus = cp.status;
  if (decision.shouldBlock && cp.status !== 'bloqueada') {
    await db.update(laftCounterparties).set({
      status: 'bloqueada',
      blockReason: decision.reason,
      updatedAt: new Date(),
      version: cp.version + 1,
    }).where(eq(laftCounterparties.id, id));
    updatedStatus = 'bloqueada';
  }

  await laftAudit(req, {
    action: 'check_lists',
    resource: 'counterparty',
    resourceId: id,
    after: { matches: matches.length, blocked: decision.shouldBlock, needsReview: decision.needsReview },
  });

  res.json({
    counterpartyId: id,
    status: updatedStatus,
    decision,
    matches,
    checkedAt: new Date().toISOString(),
  });
});

// === Historial de consultas de una contraparte ==============================
router.get('/checks/:counterpartyId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.counterpartyId, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const rows = await db.select({
    id: laftListChecks.id,
    listId: laftListChecks.listId,
    listCode: laftRestrictiveLists.code,
    listName: laftRestrictiveLists.name,
    binding: laftRestrictiveLists.binding,
    matchScore: laftListChecks.matchScore,
    matchKind: laftListChecks.matchKind,
    matchEntryId: laftListChecks.matchEntryId,
    evidence: laftListChecks.evidence,
    checkedAt: laftListChecks.checkedAt,
    checkedBy: laftListChecks.checkedBy,
  }).from(laftListChecks)
    .innerJoin(laftRestrictiveLists, eq(laftListChecks.listId, laftRestrictiveLists.id))
    .where(eq(laftListChecks.counterpartyId, id))
    .orderBy(desc(laftListChecks.checkedAt))
    .limit(limit);

  res.json(rows);
});

// === Detalle de un entry específico (cuando match) =========================
router.get('/entry/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [entry] = await db.select().from(laftListEntries).where(eq(laftListEntries.id, id));
  if (!entry) { res.status(404).json({ error: 'Entry no encontrado' }); return; }
  res.json(entry);
});

export default router;
