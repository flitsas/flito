// FLITO — sincronización (HTTP). Trigger MANUAL de la sincronización FLIT (Operaciones elige la fecha
// inicial; la final es hoy). Integración de solo lectura. Ver docs/integracion/integracionFlit.md.
//
// HU #13237 (interruptor por fuente, `flito-sync-interruptor.service.ts`):
//   - POST /sincronizar con FLIT 1 apagada → 409 `{ codigo: 'FUENTE_APAGADA', fuente: 'flit1' }` ANTES de
//     todo lo demás: no consulta FLIT 1, no escribe y no mueve la última sincronización (AC5).
//   - GET /estado añade `habilitada` y `motivoDeshabilitada` (AC9; FLIT 1 no tiene maestro).
//   - GET/PUT /interruptores viven en `flito-sync-interruptores.routes.ts`, montado al final.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { loggerFor } from '../../shared/logger.js';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { sincronizar, leerUltimaSincronizacion, guardarUltimaSincronizacion, hayTramites } from './flito-sync.service.js';
import { estadoHabilitacionFlit1, FuenteApagadaError, fuenteHabilitada } from './flito-sync-interruptor.service.js';
import interruptoresRouter from './flito-sync-interruptores.routes.js';

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
router.get('/estado', exigirFuncion('sync.sync.ver_estado'), async (_req: Request, res: Response) => {
  const [ultimaSincronizacion, tramites, habilitacion] = await Promise.all([
    leerUltimaSincronizacion(), hayTramites(), estadoHabilitacionFlit1(),
  ]);
  const cuerpo: SyncEstadoFlit1 = { ultimaSincronizacion, hayTramites: tramites, ...habilitacion };
  res.json(cuerpo);
});

// Dispara una sincronización. initialDate: si viene en el body se respeta (modo manual); si no, se usa
// la fecha del último sync (incremental). La primera vez (sin fecha previa) exige elegir fecha. finalDate
// = hoy. Solo admin. Al terminar, persiste la fecha/hora del sync como "última actualización".
router.post('/sincronizar', exigirFuncion('sync.sync.lanzar'), async (req: Request, res: Response) => {
  if (!(await fuenteHabilitada('flit1'))) {
    const e = new FuenteApagadaError('flit1');
    res.status(e.status).json({ error: e.message, codigo: e.codigo, fuente: e.fuente });
    return;
  }
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

// HU #13237: interruptor por fuente — ver la cabecera de `flito-sync-interruptores.routes.ts`.
router.use(interruptoresRouter);

export default router;
