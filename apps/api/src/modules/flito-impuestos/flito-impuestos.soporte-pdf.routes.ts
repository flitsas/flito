// FLITO Impuestos — descarga individual de UN soporte por tipo de un impuesto (Bug #14532).
// Sub-router del de impuestos, en archivo PROPIO (mismo criterio que
// `flito-impuestos.certificados.routes.ts`): reutiliza un código ya declarado en el catálogo,
// `impuestos.soportes.descargar` (el del ZIP de soportes), sin sumar otra guarda al inventario de
// `flito-impuestos.routes.ts` ni migración.
//
// AUTENTICACIÓN PROPIA: `router.use(authMiddleware)` en el fichero, como los demás sub-routers (se
// monta tras el del router padre: autentica dos veces, inocuo). No montarlo en ningún otro sitio.
//
// ── Qué entrega ──────────────────────────────────────────────────────────────────────────────────
//
// UN PDF con el documento del tipo pedido de ESE impuesto: la factura de venta de FLIT, la
// liquidación (`recibo_impuesto_sin_marca_agua`) o el pago con sello PAGADO (`recibo_impuesto`). Sin
// caída cruzada entre liquidación y pago: es justo lo que el Bug corrige (antes el pagado no salía
// nunca si había liquidación). La pantalla llama una vez por tipo marcado.
//
// Reutiliza el MISMO camino del ZIP —`registrosZipImpuestos` (frontera), `resolverEntradasZip`
// (tipos y orden) y `consolidarPorRegistro` (varias piezas del mismo tipo → un PDF, imágenes a A4)—
// para que el documento individual y el que va dentro del ZIP sean el mismo.
//
// ── PDF protegido (cifrado) ──────────────────────────────────────────────────────────────────────
//
// pdf-lib no puede unir un PDF cifrado, y el ZIP lo manda APARTE. Aquí no hay «aparte»: la respuesta
// es un solo archivo. Decisión: se entrega el PRIMER archivo resultante (el consolidado si hubo algo
// legible; si no, el cifrado tal cual) y los demás cifrados se suman a `X-Soportes-Omitidos`, que la
// pantalla ya sabe leer. En la práctica un impuesto tiene un solo documento por fase.
//
// PII: solo el uuid en la URL; el tipo va en el BODY. Registro PII y bitácora ANTES del primer byte.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CABECERAS_ZIP_SOPORTES, CODIGO_ZIP_SIN_SOPORTES, TipoSoporteZip } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  CAMPOS_PII_ZIP_SOPORTES, nombrePorPlaca, resolverEntradasZip, ZipError, ZipSinSoportesError, zipSoportesLimiter,
} from '../../shared/soportes/soportes-zip.js';
import { consolidarPorRegistro } from '../../shared/soportes/soportes-zip-consolidar.js';
import { ImpuestoError, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { registrarAccesoImpuesto } from './flito-impuestos.pii.js';
import { registrosZipImpuestos } from './flito-impuestos.service.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

/** Sufijo del nombre del archivo por tipo: `<PLACA>-<sufijo>.pdf`. */
export const SUFIJO_PDF_SOPORTE = {
  [TipoSoporteZip.FACTURA_VENTA]: 'factura-venta',
  [TipoSoporteZip.LIQUIDACION_IMPUESTO]: 'liquidacion',
  [TipoSoporteZip.PAGO_IMPUESTO]: 'pagado',
} as const;

/** `.strict()`: un `tipos` en plural o un campo de más se rechaza, no se ignora en silencio. */
export const soportePdfSchema = z.object({
  tipo: z.enum([TipoSoporteZip.FACTURA_VENTA, TipoSoporteZip.LIQUIDACION_IMPUESTO, TipoSoporteZip.PAGO_IMPUESTO]),
}).strict();

const idSchema = z.string().guid();

const MENSAJE_SIN_SOPORTE = 'Este impuesto no tiene el documento que pediste.';

export default function soportePdfRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * POST /:id/soportes/pdf — `{ tipo }` → un `application/pdf`.
   *   400 cuerpo inválido · 403 sin función (no consume cuota) · 404 impuesto no visible o sin ese
   *   documento (`codigo` = `zip_sin_soportes`) · 422 demasiado grande · 429 limitador · 200 PDF.
   */
  router.post('/:id/soportes/pdf', exigirFuncion('impuestos.soportes.descargar'), zipSoportesLimiter,
    async (req: Request, res: Response) => {
      const parsed = soportePdfSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
        return;
      }
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) {
        res.status(404).json({ error: 'El impuesto no existe' });
        return;
      }
      const { tipo } = parsed.data;

      try {
        const ctx = await contextoImpuesto(req.user!);
        // Misma frontera que el ZIP: fuera del alcance del actor, el impuesto «no existe».
        const [registro] = await registrosZipImpuestos([id.data], ctx);
        if (!registro) {
          res.status(404).json({ error: 'El impuesto no existe' });
          return;
        }

        const entradas = await resolverEntradasZip([registro], [tipo]);
        const zc = await consolidarPorRegistro(entradas);
        // El PDF de UN impuesto y UN tipo cabe en memoria (lo acota `FLITO_ZIP_SOPORTES_MAX_BYTES`):
        // se lee entero y el temporal se borra ANTES de responder, así no queda nada en disco si el
        // cliente corta la descarga a medias.
        const [archivo, ...resto] = zc.entradas;
        let pdf: Buffer;
        try {
          const { stream } = await archivo!.abrir();
          const trozos: Buffer[] = [];
          for await (const c of stream) trozos.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
          pdf = Buffer.concat(trozos);
        } finally {
          await zc.limpiar();
        }
        const omitidos = zc.omitidos + resto.length;

        await registrarAccesoImpuesto(req, {
          accion: 'export', archivo: 'pdf_soporte', campos: CAMPOS_PII_ZIP_SOPORTES, filas: 1,
        });
        await audit(req, {
          action: 'export', resource: 'flito_impuesto', resourceId: id.data,
          detail: `Descarga PDF de soporte (${tipo}): ${zc.incluidos - resto.length} documento(s), ${omitidos} omitido(s)`,
        });

        const nombre = `${nombrePorPlaca(registro.placa)}-${SUFIJO_PDF_SOPORTE[tipo]}.pdf`;
        res.status(200);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(CABECERAS_ZIP_SOPORTES.omitidos, String(omitidos));
        res.setHeader('Access-Control-Expose-Headers', `Content-Disposition, ${CABECERAS_ZIP_SOPORTES.omitidos}`);
        res.end(pdf);
      } catch (e) {
        if (res.headersSent) throw e;
        if (e instanceof ZipSinSoportesError) {
          res.status(404).json({ error: MENSAJE_SIN_SOPORTE, codigo: CODIGO_ZIP_SIN_SOPORTES });
          return;
        }
        if (e instanceof ZipError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
        if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    });

  return router;
}
