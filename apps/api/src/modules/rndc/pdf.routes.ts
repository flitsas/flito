import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { generarManifiestoPdf } from './pdf.service.js';

const router = Router();
router.use(authMiddleware, requirePage('rndc'));

router.get('/manifiestos/:id/pdf', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    const pdf = await generarManifiestoPdf({ manifiestoId: id });
    await audit(req, { action: 'export', resource: 'manifiesto', resourceId: String(id), detail: 'pdf' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="manifiesto-${id}.pdf"`);
    res.send(pdf);
  } catch (e: any) {
    if (String(e?.message).includes('no encontrado')) {
      res.status(404).json({ error: 'Manifiesto no encontrado' });
      return;
    }
    throw e;
  }
});

export default router;
