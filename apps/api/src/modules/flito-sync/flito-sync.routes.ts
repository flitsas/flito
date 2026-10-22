// FLITO — sincronización (HTTP). Estado de la sincronización con FLIT 1 e interruptores por fuente.
// Integración de solo lectura. Ver docs/integracion/integracionFlit.md.
//
// HU #13631: se retiró `POST /sincronizar` (la sincronización manual de FLIT 1) y su función
// `sync.sync.lanzar` (migración 0243). FLIT 1 se lee solo de forma automática
// (`flit1-lectura-automatica.service.ts`, HU #13629); la ruta manual responde 404.
//
// HU #13237 (interruptor por fuente, `flito-sync-interruptor.service.ts`):
//   - GET /estado añade `habilitada` y `motivoDeshabilitada` (AC9; FLIT 1 no tiene maestro).
//   - GET/PUT /interruptores viven en `flito-sync-interruptores.routes.ts`, montado al final.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import type { SyncEstadoFlit1 } from '@operaciones/shared-types';
import { leerUltimaSincronizacion, hayTramites } from './flito-sync.service.js';
import { estadoHabilitacionFlit1 } from './flito-sync-interruptor.service.js';
import interruptoresRouter from './flito-sync-interruptores.routes.js';

const router = Router();
router.use(authMiddleware);

// Estado de sincronización: para mostrar "última actualización" y decidir si es la primera vez.
router.get('/estado', exigirFuncion('sync.sync.ver_estado'), async (_req: Request, res: Response) => {
  const [ultimaSincronizacion, tramites, habilitacion] = await Promise.all([
    leerUltimaSincronizacion(), hayTramites(), estadoHabilitacionFlit1(),
  ]);
  const cuerpo: SyncEstadoFlit1 = { ultimaSincronizacion, hayTramites: tramites, ...habilitacion };
  res.json(cuerpo);
});

// HU #13237: interruptor por fuente — ver la cabecera de `flito-sync-interruptores.routes.ts`.
router.use(interruptoresRouter);

export default router;
