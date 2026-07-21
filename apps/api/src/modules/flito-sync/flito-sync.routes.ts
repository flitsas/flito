// FLITO — sincronización (HTTP). Trigger MANUAL de la sincronización FLIT (Operaciones elige la fecha
// inicial; la final es hoy). Integración de solo lectura. Ver docs/integracion/integracionFlit.md.

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { loggerFor } from '../../shared/logger.js';
import { sincronizar } from './flito-sync.service.js';

const log = loggerFor('flito-sync-routes');
const router = Router();
router.use(authMiddleware);

/** Normaliza 'YYYY-MM-DD' o 'YYYYMMDD' a 'YYYYMMDD'; null si no es válida. */
function aYyyymmdd(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const soloDigitos = v.replace(/-/g, '');
  return /^\d{8}$/.test(soloDigitos) ? soloDigitos : null;
}
function hoyYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Dispara una sincronización desde `initialDate` (elegida por el usuario) hasta hoy. Solo admin/operaciones.
router.post('/sincronizar', requireRole('admin', 'operaciones'), async (req: Request, res: Response) => {
  const initialDate = aYyyymmdd(req.body?.initialDate);
  if (!initialDate) { res.status(400).json({ error: 'initialDate es requerida (YYYY-MM-DD)' }); return; }
  const finalDate = hoyYyyymmdd();
  try {
    const resultado = await sincronizar({ initialDate, finalDate });
    await audit(req, {
      action: 'update', resource: 'flito_sincronizacion',
      detail: `Sync manual [${initialDate}→${finalDate}]: ${resultado.tramitesLeidos} leídos, ${resultado.tramitesNuevos} nuevos, ${resultado.soatCreados} SOAT, ${resultado.impuestosRetenidos} retenidos, ${resultado.companiasFaltantes} sin empresa, ${resultado.organismosSinEmparejar} sin secretaría`,
    });
    res.json(resultado);
  } catch (error) {
    log.error({ err: (error as Error).message }, 'sincronización manual falló');
    res.status(500).json({ error: 'La sincronización falló', detalle: (error as Error).message });
  }
});

export default router;
