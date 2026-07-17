// LAFT/SARLAFT v2 · F5 — Endpoint manual para anonimización LAFT post-10y.
//
// Patrón idéntico a pesv/retencion: DRY-RUN por defecto, ejecución real exige
// confirm:true + razón. NO automatizado por cron (decisión PO: revisión humana).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { pesvRetencionPoliticas } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { laftAudit } from '../audit.service.js';
import { anonimizarLaftCounterparties } from './anonimizar.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));

const TIPOS = ['laft_counterparty'] as const;

const runSchema = z.object({
  confirm: z.boolean().default(false),
  razon: z.string().min(10).max(2000),
});

router.post('/anonimizar/:tipo', async (req: Request, res: Response) => {
  const tipo = req.params.tipo as typeof TIPOS[number];
  if (!(TIPOS as readonly string[]).includes(tipo)) {
    res.status(400).json({ error: `tipo no soportado, usar uno de: ${TIPOS.join(', ')}` });
    return;
  }
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }
  const { confirm, razon } = parsed.data;

  const [pol] = await db.select().from(pesvRetencionPoliticas)
    .where(eq(pesvRetencionPoliticas.tipoDocumento, tipo)).limit(1);
  if (!pol) { res.status(404).json({ error: 'Política de retención no encontrada (mig 0067 pendiente?)' }); return; }
  if (!pol.habilitado) { res.status(409).json({ error: 'Política deshabilitada' }); return; }

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - pol.retencionAnios);

  if (tipo === 'laft_counterparty') {
    const result = await anonimizarLaftCounterparties(cutoff, {
      simulacion: !confirm,
      userId: confirm ? req.user!.sub : null,
    });
    await laftAudit(req, {
      action: confirm ? 'retencion_anonimizar_real' : 'retencion_anonimizar_dryrun',
      resource: 'counterparty',
      resourceId: 0,
      after: { tipo, cutoff: result.cutoffDate, cantidad: result.cantidadAfectada, razon },
    });
    res.json({ ok: true, ...result });
    return;
  }

  res.status(400).json({ error: 'tipo no implementado' });
});

export default router;
