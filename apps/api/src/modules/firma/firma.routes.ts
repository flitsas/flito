// TRAM-INNOV-B3 — API de firma (montada en /api/tramites). Auth admin/transito.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { solicitarFirma, listarFirmas } from './firma.service.js';

const router = Router();
router.use(authMiddleware);

const solicitarSchema = z.object({
  rol: z.enum(['comprador', 'vendedor']),
  docTipo: z.string().max(40).optional(),
}).strict();

// POST /tramites/:id/firma/solicitar — el gestor (admin) dispara la firma.
router.post('/:id/firma/solicitar', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = solicitarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  try {
    const result = await solicitarFirma({ tramiteId: id, rol: parsed.data.rol, docTipo: parsed.data.docTipo, userId: req.user!.sub });
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'duplicada' || result.code === 'contrato_requerido' ? 409
        : 400;
      res.status(status).json({ error: result.message, code: result.code });
      return;
    }
    await audit(req, { action: 'create', resource: 'tramite_firma', resourceId: String(id), detail: `Firma solicitada (${parsed.data.rol})` });
    res.status(201).json({ firma: result.firma, signUrl: result.signUrl });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /tramites/:id/firma — lista de firmas del trámite (admin o transito).
router.get('/:id/firma', requireRole('admin', 'transito'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    res.json({ firmas: await listarFirmas(id) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
