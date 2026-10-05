// FLITO Impuestos — reemplazo del comprobante de pago de un impuesto y reenvío a FLIT 2 (HU #13269,
// Feature #13267, ADR-0020). Sub-router del de impuestos, en archivo PROPIO para que el inventario de
// guardas (`FICHEROS_EN_ALCANCE`) vea solo esta ruta con su código `impuestos.recibos.reemplazar`
// (migración 0220, nace sin rol: AC7). Mismo patrón que flito-impuestos.direccion.routes.ts.
//
// AUTENTICACIÓN PROPIA: `permisos.reconduccion-cierre` exige `router.use(authMiddleware)` en cada
// fichero del inventario. Se monta con `router.use(reciboReemplazoRouter(...))` desde
// flito-impuestos.routes.ts (autentica dos veces, inocuo). No montarlo en ningún otro sitio.
//
// La guarda de función va PRIMERO: sin ella, 403 antes de leer el archivo (AC2). Luego el limitador
// (cada reemplazo dispara OCR, AGENTS §18) y el MISMO multer + validación de MIME real que la carga
// desde el impuesto (AC3). Sin PII en la URL (solo el id opaco) ni en el logger.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { CodigoErrorReemplazoComprobante } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import type { ImpuestoCtx } from './flito-factura-venta.service.js';
import { archivoConMimeReal, recibir } from './flito-impuestos.recibo-fase.routes.js';
import { ReemplazoComprobanteError, reemplazarComprobantePago } from './flito-recibos.reemplazo.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

/** Cubo propio, por usuario (Operaciones sale por una IP corporativa). Va DELANTE de multer. */
export const reciboReemplazoLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-impuestos-recibo-reemplazo'),
  message: { error: 'Demasiados reemplazos seguidos, espera unos minutos' },
  store: makeStore('rl:flito-impuestos-recibo-reemplazo:'),
});

const idSchema = z.string().uuid();

export default function reciboReemplazoRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * POST /:id/recibos/reemplazar-pago — multipart `archivo` (uno).
   *   400 archivo_invalido · 403 sin función · 404 no_encontrado · 409 estado_no_permitido |
   *   sin_comprobante_vigente · 429 limitador · 503 OCR caído · 200 `RespuestaReemplazoComprobante`
   */
  router.post('/:id/recibos/reemplazar-pago', exigirFuncion('impuestos.recibos.reemplazar'), reciboReemplazoLimiter, recibir,
    async (req: Request, res: Response) => {
      const archivo = archivoConMimeReal(req, res);
      if (!archivo) return;
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) {
        res.status(404).json({ error: 'El impuesto no existe', codigo: CodigoErrorReemplazoComprobante.NO_ENCONTRADO });
        return;
      }
      try {
        const ctx = await contextoImpuesto(req.user!);
        const r = await reemplazarComprobantePago(id.data, archivo, ctx);
        const detalle = r.resultado === 'reemplazado'
          ? `Reemplazo del comprobante de pago: soporte(s) ${r.soportesDescartados.join(', ')} → ${r.soporteId}. ` +
            `Envío a FLIT 2: ${r.envioFlit2.reenviado ? 'reprogramado' : `no (${r.envioFlit2.motivo})`}.`
          : `Reemplazo del comprobante de pago rechazado: ${r.resultado}.`;
        await audit(req, { action: 'upload', resource: 'flito_impuesto', resourceId: id.data, detail: detalle });
        res.json(r);
      } catch (e) {
        if (e instanceof ReemplazoComprobanteError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
        if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    });

  return router;
}
