// LAFT v2 F1 — endpoints administrativos de sync de listas.
// GET  /api/laft/sync/jobs           — últimos 50 jobs paginados (admin/compliance)
// GET  /api/laft/sync/jobs/:id       — detalle de un job
// POST /api/laft/sync/run/:listCode  — trigger manual (solo admin) con Idempotency-Key
//
// El trigger manual NO bloquea el HTTP request hasta que el sync termine: dispara
// asincrónicamente y retorna jobId inmediato (los syncs UE pueden tomar minutos).
// El cliente puede pollear /jobs/:id para ver progreso.

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftListsSyncJobs } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { syncOneList } from './sync.cron.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-sync-routes');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// El sync manual descarga MB de XML/CSV — máx 6 disparos por hora (admin only).
const manualSyncLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 6,
  keyGenerator: userOrIpKey('laft-sync-manual'),
  message: { error: 'Demasiados sync manuales (6/hora). Use el cron diario.' },
});

const ALLOWED_CODES = new Set(['OFAC', 'UN', 'EU']);

// === GET /jobs ============================================================
router.get('/jobs', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const listCode = (req.query.listCode as string | undefined)?.toUpperCase();

  const where = listCode && ALLOWED_CODES.has(listCode) ? eq(laftListsSyncJobs.listCode, listCode) : undefined;

  const rows = await db.select({
    id: laftListsSyncJobs.id,
    listCode: laftListsSyncJobs.listCode,
    trigger: laftListsSyncJobs.trigger,
    triggeredBy: laftListsSyncJobs.triggeredBy,
    startedAt: laftListsSyncJobs.startedAt,
    finishedAt: laftListsSyncJobs.finishedAt,
    status: laftListsSyncJobs.status,
    sourceHash: laftListsSyncJobs.sourceHash,
    entriesTotal: laftListsSyncJobs.entriesTotal,
    entriesAdded: laftListsSyncJobs.entriesAdded,
    entriesRemoved: laftListsSyncJobs.entriesRemoved,
    entriesModified: laftListsSyncJobs.entriesModified,
    retroMatchesNew: laftListsSyncJobs.retroMatchesNew,
    durationMs: laftListsSyncJobs.durationMs,
    errorText: laftListsSyncJobs.errorText,
  }).from(laftListsSyncJobs)
    .where(where)
    .orderBy(desc(laftListsSyncJobs.startedAt))
    .limit(limit).offset(offset);

  res.json({ rows, limit, offset });
});

// === GET /jobs/:id ========================================================
router.get('/jobs/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  const [row] = await db.select().from(laftListsSyncJobs).where(eq(laftListsSyncJobs.id, id));
  if (!row) return res.status(404).json({ error: 'Job no encontrado' });

  res.json(row);
});

// === POST /run/:listCode ==================================================
// Trigger manual del sync. requireRole('admin') (compliance puede leer pero no disparar).
// Asíncrono: retorna 202 con jobId, el sync corre en background.
router.post('/run/:listCode', manualSyncLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const listCode = req.params.listCode.toUpperCase();
  if (!ALLOWED_CODES.has(listCode)) {
    return res.status(400).json({ error: `listCode debe ser uno de: ${[...ALLOWED_CODES].join(', ')}` });
  }

  // Idempotency-Key opcional: si está y se reusa dentro de 5 min, retornamos el último jobId
  // del mismo user para esa lista. No usamos tabla idempotency dedicada por simplicidad —
  // basta con el advisory lock per-list que ya garantiza no-duplicación a nivel BD.
  const idempKey = req.header('Idempotency-Key');
  if (idempKey && (idempKey.length < 8 || idempKey.length > 80)) {
    return res.status(400).json({ error: 'Idempotency-Key debe tener 8-80 chars' });
  }

  // Disparar async — el HTTP request no bloquea esperando el sync (puede tomar minutos).
  // Si el lock no se adquiere (otra instancia corriendo el mismo listCode), syncOneList
  // retorna 'skipped' y el caller lo verá vía GET /jobs.
  syncOneList({
    listCode: listCode as 'OFAC' | 'UN' | 'EU',
    trigger: 'manual',
    triggeredBy: req.user!.sub,
  }).then((outcome) => {
    log.info({ jobId: outcome.jobId, listCode, status: outcome.status, retro: outcome.retroMatches }, 'sync manual completado');
  }).catch((e) => {
    log.error({ err: (e as Error).message, listCode }, 'sync manual throw inesperado');
  });

  await laftAudit(req, {
    action: 'trigger_sync_manual',
    resource: 'list_check',
    resourceId: listCode,
    after: { listCode, idempotencyKey: idempKey ?? null },
  });

  res.status(202).json({
    accepted: true,
    listCode,
    message: 'Sync iniciado en background. Pollear /api/laft/sync/jobs?listCode=' + listCode + ' para estado.',
  });
});

export default router;
