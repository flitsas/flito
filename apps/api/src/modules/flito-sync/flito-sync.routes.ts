// FLITO — sincronización (HTTP). Trigger MANUAL de la sincronización FLIT (Operaciones elige la fecha
// inicial; la final es hoy). Integración de solo lectura. Ver docs/integracion/integracionFlit.md.

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { loggerFor } from '../../shared/logger.js';
import { sincronizar, leerUltimaSincronizacion, guardarUltimaSincronizacion, hayTramites } from './flito-sync.service.js';

const log = loggerFor('flito-sync-routes');
const router = Router();
router.use(authMiddleware);

/** Normaliza 'YYYY-MM-DD' o 'YYYYMMDD' a 'YYYYMMDD'; null si no es válida. */
function aYyyymmdd(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const soloDigitos = v.slice(0, 10).replace(/-/g, '');
  return /^\d{8}$/.test(soloDigitos) ? soloDigitos : null;
}
function hoyYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Estado de sincronización: para mostrar "última actualización" y decidir si es la primera vez.
router.get('/estado', requireRole('admin'), async (_req: Request, res: Response) => {
  const [ultimaSincronizacion, tramites] = await Promise.all([leerUltimaSincronizacion(), hayTramites()]);
  res.json({ ultimaSincronizacion, hayTramites: tramites });
});

// Dispara una sincronización. initialDate: si viene en el body se respeta (modo manual); si no, se usa
// la fecha del último sync (incremental). La primera vez (sin fecha previa) exige elegir fecha. finalDate
// = hoy. Solo admin. Al terminar, persiste la fecha/hora del sync como "última actualización".
router.post('/sincronizar', requireRole('admin'), async (req: Request, res: Response) => {
  const manual = aYyyymmdd(req.body?.initialDate);
  const ultima = await leerUltimaSincronizacion();
  const initialDate = manual ?? (ultima ? aYyyymmdd(ultima) : null);
  if (!initialDate) { res.status(400).json({ error: 'La primera sincronización requiere una fecha inicial (YYYY-MM-DD).' }); return; }
  const finalDate = hoyYyyymmdd();
  try {
    const resultado = await sincronizar({ initialDate, finalDate });
    const at = new Date().toISOString();
    await guardarUltimaSincronizacion(at);
    await audit(req, {
      action: 'update', resource: 'flito_sincronizacion',
      detail: `Sync ${manual ? 'manual' : 'incremental'} [${initialDate}→${finalDate}]: ${resultado.tramitesLeidos} leídos, ${resultado.tramitesNuevos} nuevos, ${resultado.tramitesActualizados} con cambios, ${resultado.tramitesSinCambios} sin cambios, ${resultado.companiasFaltantes} sin empresa, ${resultado.organismosSinEmparejar} sin secretaría`,
    });
    res.json({ ...resultado, ultimaSincronizacion: at });
  } catch (error) {
    log.error({ err: (error as Error).message }, 'sincronización manual falló');
    res.status(500).json({ error: 'La sincronización falló', detalle: (error as Error).message });
  }
});

export default router;
