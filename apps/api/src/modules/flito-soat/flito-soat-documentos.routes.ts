// FLITO — SOAT: lectura de los documentos adicionales de una solicitud (HU #13362, AC8/AC9).
// Montado en `/api/flito/soat`, ANTES de `flito-soat.routes.ts` (ver `app.ts`).
//
//   GET /:id/documentos-adicionales — función configurable `soat.documentos_adicionales.ver`
//   (operación FLIT y proveedor SOAT; el cliente NO la tiene → 403). Sin acceso a la solicitud
//   → 404, igual que el detalle: no se confirma que exista.
//
// `:id` es un uuid opaco (permitido en el path, AGENTS.md §14). No se inscribe en
// `shared/middleware/canal-cliente.ts`: el cliente no tiene la función y la guardia del canal ya le
// cierra la ruta. La respuesta lleva URL firmada y temporal, nunca la clave de storage.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { contextoSoat } from './flito-soat.service.js';
import { DocumentoAdicionalError, listarDocumentosAdicionales } from './flito-soat-documentos.service.js';

const router = Router();
router.use(authMiddleware);

const idSchema = z.string().uuid();

router.get('/:id/documentos-adicionales', exigirFuncion('soat.documentos_adicionales.ver'), async (req: Request, res: Response) => {
  if (!idSchema.safeParse(req.params.id).success) { res.status(404).json({ error: 'Solicitud de SOAT no encontrada' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const documentos = await listarDocumentosAdicionales(req.params.id, ctx);
    res.json({ documentos });
  } catch (e) {
    if (e instanceof DocumentoAdicionalError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
});

export default router;
