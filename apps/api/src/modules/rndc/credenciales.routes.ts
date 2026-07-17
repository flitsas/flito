import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  setCredenciales, listCredencialesPublic, deactivateCredencial,
} from './credenciales.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'), requirePage('rndc_admin'));

const credSchema = z.object({
  empresaNit: z.string().min(8).max(20).regex(/^\d+$/),
  habilitadorNit: z.string().min(8).max(20).regex(/^\d+$/),
  numNit: z.string().min(3).max(20),
  claveQR: z.string().min(6).max(200),
  ambiente: z.enum(['sandbox', 'produccion']),
  notas: z.string().max(500).optional(),
});

router.get('/', async (_req: Request, res: Response) => {
  const rows = await listCredencialesPublic();
  res.json({ data: rows });
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = credSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const userId = (req as any).user?.sub;
  const created = await setCredenciales({ ...parsed.data, userId });
  await audit(req, {
    action: 'create', resource: 'rndc_credencial',
    resourceId: String(created.id),
    detail: `empresa=${created.empresaNit} ambiente=${created.ambiente}`,
  });
  res.status(201).json(created);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const userId = (req as any).user?.sub;
  const ok = await deactivateCredencial(id, userId);
  if (!ok) { res.status(404).json({ error: 'No encontrada' }); return; }
  await audit(req, {
    action: 'delete', resource: 'rndc_credencial', resourceId: String(id),
    detail: 'soft delete (activo=false)',
  });
  res.json({ success: true });
});

export default router;
