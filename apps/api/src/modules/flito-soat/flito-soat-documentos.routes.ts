// FLITO — SOAT: documentos adicionales de una solicitud existente.
// Montado en `/api/flito/soat`, ANTES de `flito-soat.routes.ts` (ver `app.ts`).
//
//   GET    /:id/documentos-adicionales — función `soat.documentos_adicionales.ver` (HU #13362, AC8/AC9).
//   POST   /:id/documentos-adicionales — función `soat.documentos_adicionales.cargar` (HU #13364):
//          carga posterior, en cualquier estado. 201 `ResultadoDocumentosAdicionales`.
//   DELETE /:id/documentos-adicionales/:soporteId — función `soat.documentos_adicionales.eliminar`
//          (HU #13364): borrado definitivo, en cualquier estado. 204.
//
// Operación FLIT y proveedor SOAT; el cliente NO tiene estas funciones → 403. Sin acceso a la
// solicitud → 404, igual que el detalle: no se confirma que exista.
//
// Orden del POST (diseño HU #13364, D1): auth → función → limitador → multer → handler. Quien no
// tiene la función no gasta presupuesto; quien agotó el presupuesto no escribe nada a disco. El
// acceso a la solicitud se comprueba DESPUÉS de multer (responder sin consumir el multipart rompe la
// conexión del cliente); los temporales se borran en el `finally`, en todos los caminos.
//
// `:id` es un uuid opaco (permitido en el path, AGENTS.md §14). No se inscribe en
// `shared/middleware/canal-cliente.ts`: el cliente no tiene la función y la guardia del canal ya le
// cierra la ruta. La respuesta lleva URL firmada y temporal, nunca la clave de storage, y cada
// entrega no vacía queda en `pii_access_log` (`registrarAccesoSoat`).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { soatDocumentosAdicionalesLimiter } from '../../shared/middleware/rateLimiter.js';
import { contextoSoat } from './flito-soat.service.js';
import { registrarAccesoSoat } from './flito-soat.pii.js';
import {
  cargarDocumentosAdicionales, detalleBitacoraAdicional, DocumentoAdicionalError, eliminarDocumentoAdicional,
  listarDocumentosAdicionales,
} from './flito-soat-documentos.service.js';
import { archivosDeCarga, limpiarTemporales, uploadAdicionales } from './flito-soat-documentos.upload.js';

const router = Router();
router.use(authMiddleware);

const idSchema = z.string().uuid();

/** Lo que se entrega (`pii_access_log.campos_accedidos`): documentos del cliente que pueden traer datos personales. */
export const CAMPOS_PII_DOCUMENTOS_ADICIONALES = ['documentos_adicionales'] as const;

router.get('/:id/documentos-adicionales', exigirFuncion('soat.documentos_adicionales.ver'), async (req: Request, res: Response) => {
  if (!idSchema.safeParse(req.params.id).success) { res.status(404).json({ error: 'Solicitud de SOAT no encontrada' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const documentos = await listarDocumentosAdicionales(req.params.id, ctx);
    // Ley 1581 (art. 17): las URLs firmadas ENTREGAN documentos personales → rastro antes de responder.
    // Solo si se entregó algo: una lista vacía, un 403 o un 404 no accedieron a nada de nadie.
    if (documentos.length > 0) {
      await registrarAccesoSoat(req, {
        accion: 'read', soatId: req.params.id, filas: documentos.length, campos: CAMPOS_PII_DOCUMENTOS_ADICIONALES,
      });
    }
    res.json({ documentos });
  } catch (e) {
    if (e instanceof DocumentoAdicionalError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
});

const NO_ENCONTRADA = { error: 'Solicitud de SOAT no encontrada' };

router.post(
  '/:id/documentos-adicionales',
  exigirFuncion('soat.documentos_adicionales.cargar'),
  soatDocumentosAdicionalesLimiter,
  uploadAdicionales,
  async (req: Request, res: Response) => {
    try {
      if (!idSchema.safeParse(req.params.id).success) { res.status(404).json(NO_ENCONTRADA); return; }
      const ctx = await contextoSoat(req.user!);
      const { adicionales, etiquetas } = archivosDeCarga(req);
      const { guardados, resultado } = await cargarDocumentosAdicionales(req.params.id, ctx, adicionales, etiquetas);
      // AC9: una entrada por documento GUARDADO (tras el COMMIT), nunca por descartado.
      for (const g of guardados) {
        await audit(req, {
          action: 'create', resource: 'flito_soat', resourceId: req.params.id, detail: detalleBitacoraAdicional(g),
        });
      }
      res.status(201).json(resultado);
    } catch (e) {
      if (e instanceof DocumentoAdicionalError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    } finally {
      await limpiarTemporales(req);
    }
  },
);

router.delete(
  '/:id/documentos-adicionales/:soporteId',
  exigirFuncion('soat.documentos_adicionales.eliminar'),
  async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.id).success || !idSchema.safeParse(req.params.soporteId).success) {
      res.status(404).json(NO_ENCONTRADA); return;
    }
    try {
      const ctx = await contextoSoat(req.user!);
      const eliminado = await eliminarDocumentoAdicional(req.params.id, req.params.soporteId, ctx);
      await audit(req, {
        action: 'delete', resource: 'flito_soat', resourceId: req.params.id,
        detail: detalleBitacoraAdicional(eliminado, 'eliminado', eliminado.objetoPendiente),
      });
      res.status(204).end();
    } catch (e) {
      if (e instanceof DocumentoAdicionalError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  },
);

export default router;
