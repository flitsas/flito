import { Router, Request, Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../../db/client.js';
import { laftReportesUiaf } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { loggerFor } from '../../../shared/logger.js';
import { downloadReporte } from './reportes-storage.js';
import { generarAros } from './aros.service.js';

const log = loggerFor('laft-aros');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const generateLimiter = rateLimit({
  windowMs: 60_000, max: 10,
  keyGenerator: userOrIpKey('laft-aros'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas generaciones de AROS, espere 1 minuto' },
});

function parseAnioTrim(req: Request): { anio: number; trimestre: number } | null {
  const anio = parseInt(req.params.anio, 10);
  const trimestre = parseInt(req.params.trimestre, 10);
  if (!Number.isFinite(anio) || anio < 2020 || anio > 2100) return null;
  if (!Number.isFinite(trimestre) || trimestre < 1 || trimestre > 4) return null;
  return { anio, trimestre };
}

// === POST /generar/:anio/:trimestre =========================================
router.post('/generar/:anio/:trimestre', generateLimiter, async (req: Request, res: Response) => {
  const p = parseAnioTrim(req);
  if (!p) { res.status(400).json({ error: 'Año o trimestre inválido' }); return; }
  // Anti-overlap: no generar AROS de un trimestre que aún no termina.
  // Trimestre N termina el último día del mes 3*N.
  const lastMonthZero = p.trimestre * 3 - 1;
  const lastDay = new Date(Date.UTC(p.anio, lastMonthZero + 1, 0));
  if (new Date() < lastDay) {
    res.status(422).json({ error: 'No se puede generar AROS de un trimestre en curso' });
    return;
  }

  try {
    const { reporte, resumen, idempotent } = await generarAros(p.anio, p.trimestre, req.user!.sub);
    if (!idempotent) {
      await laftAudit(req, {
        action: 'aros_generate',
        resource: 'document',
        resourceId: reporte.id,
        after: {
          anio: p.anio,
          trimestre: p.trimestre,
          esAusencia: resumen.esAusencia,
          totalRos: resumen.totalRosEnviados,
          totalReportadas: resumen.totalUnusualReportadas,
          totalBreaches: resumen.totalCashBreaches,
        },
      });
    }
    res.status(idempotent ? 200 : 201).json({ ...reporte, resumen, idempotent });
  } catch (e: any) {
    log.error({ err: e?.message, ...p }, 'aros generate failed');
    res.status(500).json({ error: 'Error generando AROS' });
  }
});

// === GET /:anio/:trimestre/download — descargar PDF ==========================
router.get('/:anio/:trimestre/download', async (req: Request, res: Response) => {
  const p = parseAnioTrim(req);
  if (!p) { res.status(400).json({ error: 'Año o trimestre inválido' }); return; }
  const [row] = await db.select().from(laftReportesUiaf).where(and(
    eq(laftReportesUiaf.tipo, 'AROS'),
    eq(laftReportesUiaf.formato, 'PDF'),
    eq(laftReportesUiaf.periodoAnio, p.anio),
    eq(laftReportesUiaf.periodoTrimestre, p.trimestre),
  ));
  if (!row || !row.storageKey) { res.status(404).json({ error: 'AROS no generado para ese trimestre' }); return; }
  try {
    const buf = await downloadReporte(row.storageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="AROS-${p.anio}-Q${p.trimestre}.pdf"`);
    res.setHeader('X-Reporte-Sha256', row.sha256);
    res.send(buf);
  } catch (e: any) {
    log.error({ err: e?.message, key: row.storageKey }, 'download failed');
    res.status(500).json({ error: 'Error descargando reporte' });
  }
});

// === GET / — list paginado ==================================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const rows = await db.select().from(laftReportesUiaf)
    .where(eq(laftReportesUiaf.tipo, 'AROS'))
    .orderBy(desc(laftReportesUiaf.periodoAnio), desc(laftReportesUiaf.periodoTrimestre))
    .limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(laftReportesUiaf).where(eq(laftReportesUiaf.tipo, 'AROS'));
  res.json({ rows, total: count, limit, offset });
});

export default router;
