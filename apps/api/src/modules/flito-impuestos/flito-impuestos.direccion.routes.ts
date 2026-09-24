// FLITO Impuestos — corrección manual de la dirección del comprador (HU #12833, AC5/AC6). Sub-router
// del de impuestos, en archivo PROPIO para que el inventario de guardas (`FICHEROS_EN_ALCANCE`) vea
// solo esta ruta y no `POST /:id/reanalizar` (cuyo código ya es de `POST /:id/certificar`).
//
// AUTENTICACIÓN PROPIA: `permisos.reconduccion-cierre` exige `router.use(authMiddleware)` en cada
// fichero del inventario. Se monta con `router.use(direccionRouter(...))` DESPUÉS del
// `router.use(authMiddleware)` de flito-impuestos.routes.ts, así que autentica dos veces (inocuo,
// decisión del diseño D5). No montarlo en ningún otro sitio.
//
// PII: la dirección viaja en el BODY (nunca en la URL), no se loguea, y la auditoría no lleva valores.
// Sin restricción de estado (decisión de David, 2026-09-24): también certificado o pagado, sin 409.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import type { ImpuestoCtx } from './flito-factura-venta.service.js';
import { buscarConAcceso } from './flito-impuestos.service.js';
import { corregirDireccionImpuesto } from './flito-impuestos.direccion.js';
import { registrarAccesoImpuesto } from './flito-impuestos.pii.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

const idSchema = z.string().uuid();

/** Los tres campos, recortados y obligatorios. `.strict()`: nada más entra en el `UPDATE`. */
export const corregirDireccionSchema = z.object({
  direccion: z.string().trim().min(1).max(200),
  municipio: z.string().trim().min(1).max(100),
  departamento: z.string().trim().min(1).max(100),
}).strict();

export default function direccionRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * PATCH /:id/direccion — guarda y confirma la dirección del comprador (`origen: 'manual'`).
   * 400 id/body inválido · 403 sin función (no toca la fila) · 404 fuera de frontera (404, no 403).
   */
  router.patch('/:id/direccion', exigirFuncion('impuestos.tramite.corregir_direccion'),
    async (req: Request, res: Response) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) { res.status(400).json({ error: 'Id inválido' }); return; }
      const body = corregirDireccionSchema.safeParse(req.body ?? {});
      // Sin `details`: el error de Zod no arrastra valores, pero no hace falta devolver la forma.
      if (!body.success) { res.status(400).json({ error: 'Dirección, municipio y departamento son obligatorios' }); return; }
      const ctx = await contextoImpuesto(req.user!);
      if (!await buscarConAcceso(id.data, ctx)) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      const bloque = await corregirDireccionImpuesto(id.data, body.data, { userId: ctx.userId, nombre: ctx.username });
      if (!bloque) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      await audit(req, {
        action: 'update', resource: 'flito_impuesto', resourceId: id.data,
        detail: 'Dirección del comprador corregida',
      });
      // `pii_access_log.accion` no tiene 'update' (la escritura la anota `audit`): la respuesta devuelve
      // la dirección, así que es una lectura, marcada `resultado=corregida`.
      await registrarAccesoImpuesto(req, {
        accion: 'read', resultado: 'corregida', impuestoId: id.data, campos: ['direccion', 'municipio', 'departamento'],
      });
      res.json(bloque);
    });

  return router;
}
