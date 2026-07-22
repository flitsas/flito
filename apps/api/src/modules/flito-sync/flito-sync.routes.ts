// FLITO — sincronización (HTTP). Trigger manual de la sincronización FLIT, para Operaciones
// y para pruebas. En producción corre además el cron (flito-sync.cron.ts).

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { loggerFor } from '../../shared/logger.js';
import { sincronizar } from './flito-sync.service.js';

const log = loggerFor('flito-sync-routes');
const router = Router();
router.use(authMiddleware);

// Dispara una corrida de sincronización y devuelve el resultado. Solo `operaciones`.
router.post('/sincronizar', requireRole('admin', 'operaciones'), async (req: Request, res: Response) => {
  try {
    const resultado = await sincronizar();
    await audit(req, {
      action: 'update',
      resource: 'flito_sincronizacion',
      detail: `Sync manual: ${resultado.tramitesNuevos} nuevos, ${resultado.soatCreados} SOAT, ${resultado.impuestosRetenidos} retenidos`,
    });
    res.json(resultado);
  } catch (error) {
    log.error({ err: (error as Error).message }, 'sincronización manual falló');
    res.status(500).json({ error: 'La sincronización falló', detalle: (error as Error).message });
  }
});

export default router;
