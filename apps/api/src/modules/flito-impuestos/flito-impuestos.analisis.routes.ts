// FLITO Impuestos — reintento del análisis post-envío (HU #12825, AC5). Sub-router del de impuestos.
//
// AUTENTICACIÓN HEREDADA: este router NO declara `authMiddleware` porque se monta con
// `router.use(analisisRouter(...))` justo DESPUÉS de `router.use(authMiddleware)` en
// flito-impuestos.routes.ts. No montarlo en ningún otro sitio.
//
// Recibe `contextoImpuesto` por parámetro en vez de importarlo del router padre: así no hay import
// circular entre los dos archivos de rutas.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import type { ImpuestoCtx } from './flito-factura-venta.service.js';
import { buscarConAcceso } from './flito-impuestos.service.js';
import { reanalizarImpuesto } from './flito-impuestos.analisis.service.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

/**
 * El reintento dispara OCR y una consulta al RUNT (AGENTS §18). Por usuario, no por IP: varios
 * usuarios de Operaciones salen por la misma IP corporativa.
 */
export const reanalizarLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-impuestos-reanalizar'),
  message: { error: 'Demasiados reintentos seguidos, espera 1 minuto' },
  store: makeStore('rl:flito-impuestos-reanalizar:'),
});

const idSchema = z.string().uuid();

const MENSAJES_409 = {
  ANALISIS_EN_CURSO: 'La validación de la factura ya está en curso.',
  NO_SOLICITADO: 'Solo se puede reintentar la validación de un impuesto en estado Solicitado.',
  YA_CERTIFICADO: 'El impuesto ya tiene una certificación vigente.',
  SIN_ANALISIS: 'Este impuesto se envió antes de la validación automática y no tiene análisis que reintentar.',
} as const;

export default function analisisRouter(contextoImpuesto: Contexto): Router {
  const router = Router();

  /**
   * POST /:id/reanalizar — «Reintentar validación» (AC5). 202 inmediato: la respuesta no espera ni
   * al OCR ni al RUNT. 404 si no existe o está fuera de la frontera del usuario (404, no 403).
   */
  router.post('/:id/reanalizar', exigirFuncion('impuestos.tramite.certificar'), reanalizarLimiter,
    async (req: Request, res: Response) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) { res.status(400).json({ error: 'Id inválido' }); return; }
      const ctx = await contextoImpuesto(req.user!);
      if (!await buscarConAcceso(id.data, ctx)) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      const r = await reanalizarImpuesto(id.data);
      if (r.resultado === 'ENCOLADO') {
        await audit(req, {
          action: 'update', resource: 'flito_impuesto', resourceId: id.data,
          detail: 'Reintento de validación de factura encolado',
        });
        res.status(202).json({ id: r.id, analisisEstado: r.analisisEstado });
        return;
      }
      if (r.resultado === 'NO_ENCONTRADO') { res.status(404).json({ error: 'El impuesto no existe' }); return; }
      res.status(409).json({ code: r.resultado, error: MENSAJES_409[r.resultado] });
    });

  return router;
}
