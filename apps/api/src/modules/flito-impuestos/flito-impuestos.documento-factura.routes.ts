// FLITO Impuestos — corregir o reintentar número, fecha y avalúo de la factura (HU #14664, AC2/AC3/
// AC6). Sub-router propio del de impuestos, en archivo APARTE para que el inventario de guardas
// (`FICHEROS_EN_ALCANCE`) vea solo estas dos rutas (mismo motivo que `flito-impuestos.direccion.routes.ts`).
//
// AUTENTICACIÓN PROPIA: cada fichero del inventario exige su propio `router.use(authMiddleware)`. Se
// monta con `router.use(documentoFacturaRouter(...))` DESPUÉS del `router.use(authMiddleware)` de
// flito-impuestos.routes.ts, así que autentica dos veces (inocuo, igual que direccionRouter).
//
// Mismo permiso que certificar (`impuestos.tramite.certificar`): quien certifica puede corregir o
// reintentar estos 3 campos, con o sin certificación vigente (AC4 — sin condición de estado).
//
// PII: número/fecha/avalúo de la factura NO son datos del titular (AGENTS.md §16); la auditoría va
// por `audit()`, nunca por `logPiiAccess`. El motivo de `FACTURA_NO_DISPONIBLE` nunca sale crudo.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { documentoFacturaReintentoLimiter } from '../../shared/middleware/rateLimiter.js';
import type { ImpuestoCtx } from './flito-factura-venta.service.js';
import { buscarConAcceso } from './flito-impuestos.service.js';
import { exigirCompaniaPropia } from './flito-impuestos.alcance.js';
import { corregirDatosDocumentoFactura, reintentarLecturaDocumentoFactura } from './flito-impuestos.documento-factura.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

const idSchema = z.string().guid();
const motivoSchema = z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(500);
const fechaOVacio = z.string().trim()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Fecha inválida (AAAA-MM-DD)');
const avaluoOVacio = z.string().trim()
  .refine((v) => v === '' || /^\d+(\.\d{1,2})?$/.test(v), 'Avalúo inválido');

/** `.strict()`: nada más entra en la corrección. Omitir una llave no toca ese campo; `''` lo vacía. */
export const corregirDocumentoFacturaSchema = z.object({
  numeroFactura: z.string().trim().max(60).optional(),
  fechaFactura: fechaOVacio.optional(),
  avaluoComercial: avaluoOVacio.optional(),
  motivo: motivoSchema,
}).strict().refine(
  (d) => d.numeroFactura !== undefined || d.fechaFactura !== undefined || d.avaluoComercial !== undefined,
  { message: 'Debes corregir al menos uno: número, fecha o avalúo de la factura' },
);

export const reintentarDocumentoFacturaSchema = z.object({ motivo: motivoSchema }).strict();

export default function documentoFacturaRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * PATCH /:id/documento-factura — corrección manual (AC2). Sin restricción de estado (AC4): también
   * certificado o pagado. 400 id/body inválido · 403 sin función (no toca la fila) · 404 fuera de frontera.
   */
  router.patch('/:id/documento-factura', exigirFuncion('impuestos.tramite.certificar'),
    async (req: Request, res: Response) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) { res.status(400).json({ error: 'Id inválido' }); return; }
      const body = corregirDocumentoFacturaSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? 'Datos inválidos' });
        return;
      }
      const ctx = await contextoImpuesto(req.user!);
      await exigirCompaniaPropia([id.data], ctx);
      if (!await buscarConAcceso(id.data, ctx)) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      const { motivo, ...datos } = body.data;
      const bloque = await corregirDatosDocumentoFactura(id.data, { ...datos, motivo }, { userId: ctx.userId, nombre: ctx.username });
      if (!bloque) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      await audit(req, {
        action: 'update', resource: 'flito_impuesto', resourceId: id.data,
        detail: `Datos de la factura corregidos a mano — motivo: ${motivo}`,
      });
      res.json(bloque);
    });

  /**
   * POST /:id/documento-factura/reintentar — vuelve a leer SOLO estos 3 campos de la misma factura
   * (AC3). SÍNCRONO: responde en el mismo request (decisión del humano, sin cola).
   * 400 · 403 · 404 · 409 `FACTURA_NO_DISPONIBLE` (nunca el motivo crudo del error).
   */
  router.post('/:id/documento-factura/reintentar', exigirFuncion('impuestos.tramite.certificar'),
    documentoFacturaReintentoLimiter, async (req: Request, res: Response) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) { res.status(400).json({ error: 'Id inválido' }); return; }
      const body = reintentarDocumentoFacturaSchema.safeParse(req.body ?? {});
      if (!body.success) { res.status(400).json({ error: 'El motivo es obligatorio (mínimo 5 caracteres)' }); return; }
      const ctx = await contextoImpuesto(req.user!);
      await exigirCompaniaPropia([id.data], ctx);
      if (!await buscarConAcceso(id.data, ctx)) { res.status(404).json({ error: 'El impuesto no existe' }); return; }

      const resultado = await reintentarLecturaDocumentoFactura(
        id.data, body.data.motivo, { userId: ctx.userId, nombre: ctx.username },
      );
      if (resultado.resultado === 'NO_ENCONTRADO') { res.status(404).json({ error: 'El impuesto no existe' }); return; }
      if (resultado.resultado === 'FACTURA_NO_DISPONIBLE') {
        res.status(409).json({ code: 'FACTURA_NO_DISPONIBLE', error: 'No se pudo obtener la factura de venta para releerla.' });
        return;
      }

      await audit(req, {
        action: 'update', resource: 'flito_impuesto', resourceId: id.data,
        detail: `Reintento de lectura de número/fecha/avalúo — motivo: ${body.data.motivo}`,
      });
      res.json(resultado.datos);
    });

  return router;
}
