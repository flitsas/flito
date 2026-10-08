// Siigo API — línea de tiempo del ciclo de facturación (HU #11338).
// Montada en /api/siigo/linea-tiempo.
//
// Solo lectura, y a propósito: reconstruir el relato no puede ser también la puerta para
// modificarlo. Los roles son los que ya leen el reporte de costos, que es donde vive esta pregunta.
//
// No llama a Siigo: todo sale de bitácoras locales.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { lineaTiempoDeTramite } from './siigo.linea-tiempo.service.js';

const router = Router();
router.use(authMiddleware);

/** Los mismos que leen el reporte de costos. `auditor` incluido: es su pregunta natural. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /:tramiteId — el relato completo de un trámite.
router.get('/:tramiteId', exigirFuncion('siigo.factura.consultar'), async (req: Request, res: Response) => {
  const { tramiteId } = req.params;
  // Un uuid malformado daría un error de sintaxis de PostgreSQL en vez de un 400, y se llevaría
  // la transacción por delante.
  if (!UUID_RE.test(tramiteId)) {
    res.status(400).json({ error: 'Identificador de trámite inválido' });
    return;
  }
  res.json(await lineaTiempoDeTramite(tramiteId));
});

export default router;
