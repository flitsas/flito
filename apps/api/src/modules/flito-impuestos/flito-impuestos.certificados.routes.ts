// FLITO Impuestos — ZIP de certificados RUNT con listado de omitidos (HU #13205). Sub-router del de
// impuestos, en archivo PROPIO (mismo criterio que `flito-impuestos.analisis.routes.ts`): reutiliza un
// código ya declarado en el catálogo de permisos sin sumar otra guarda al inventario de
// `flito-impuestos.routes.ts`; montado ANTES de cualquier `/:id/...`.
//
// AUTENTICACIÓN PROPIA: igual que `flito-impuestos.direccion.routes.ts`, `router.use(authMiddleware)`
// en el fichero (se monta tras el del router padre: autentica dos veces, inocuo).
//
// PII: los ids (uuid) viajan en el BODY. No se loguean placas, ids FLIT ni uuids; la bitácora lleva
// solo conteos. Registro PII ANTES del primer byte (AC8) y también en el 409, que devuelve placas.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { comprobarTopeRegistrosZip, ZipError } from '../../shared/soportes/soportes-zip.js';
import { CausaCertificadoOmitido } from '@operaciones/shared-types';
import { ImpuestoError, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { certificacionesVigentesLoteConAcceso } from './certificacion.service.js';
import {
  emitirZipCertificados, generarPdfsCertificados, planificarZipCertificados, ZipSinCertificadosError,
} from './certificados-zip.js';
import { CAMPOS_PII_ZIP_CERTIFICADOS, registrarAccesoImpuesto } from './flito-impuestos.pii.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

/**
 * Sin `.max()`: el tope lo dice `comprobarTopeRegistrosZip` con `codigo` propio y el número en el
 * mensaje (AC5). Un `.max()` de Zod daría un 400 indistinguible de un cuerpo roto.
 */
export const zipCertificadosSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
}).strict();

/**
 * 5 por minuto y usuario (AC6). Bolsa PROPIA, no la de soportes: raciona otro recurso (CPU de
 * pdf-lib) y compartirla haría que descargar certificados gastara la cuota de soportes.
 */
export const zipCertificadosLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-certificados-zip'),
  message: { error: 'Demasiadas descargas seguidas, espera 1 minuto' },
  store: makeStore('rl:flito-certificados-zip:'),
});

export default function certificadosRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * POST /certificados/zip — un PDF por impuesto con certificación vigente + `omitidos.csv`.
   * 400 cuerpo/tope · 403 sin función (no consume cuota) · 409 todos omitidos · 429 frecuencia.
   */
  router.post('/certificados/zip', exigirFuncion('impuestos.certificado.descargar'), zipCertificadosLimiter,
    async (req: Request, res: Response) => {
      const parsed = zipCertificadosSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
        return;
      }
      try {
        // ANTES del contexto (que puede consultar la base) y del lote (AC5).
        comprobarTopeRegistrosZip(parsed.data.ids);
        const ctx = await contextoImpuesto(req.user!);
        const lote = await certificacionesVigentesLoteConAcceso(parsed.data.ids, ctx);
        const { incluidos, omitidos } = planificarZipCertificados(parsed.data.ids, lote);

        if (incluidos.length === 0) {
          // El 409 publica placas de impuestos visibles: también es una lectura de datos personales.
          await registrarAccesoImpuesto(req, {
            accion: 'export', archivo: 'zip_certificados_runt', resultado: 'todos_omitidos', filas: 0, campos: ['placa'],
          });
          throw new ZipSinCertificadosError(omitidos);
        }

        const ahora = new Date();
        const pdfs = await generarPdfsCertificados(incluidos, ctx.username, ahora);

        await registrarAccesoImpuesto(req, {
          accion: 'export', archivo: 'zip_certificados_runt', filas: incluidos.length, campos: CAMPOS_PII_ZIP_CERTIFICADOS,
        });
        const sinCert = omitidos.filter((o) => o.causa === CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE).length;
        await audit(req, {
          action: 'export', resource: 'flito_impuesto',
          detail: `Descarga ZIP de certificados RUNT: ${incluidos.length} incluido(s), ${omitidos.length} omitido(s)`
            + ` (sin certificación vigente: ${sinCert}, no disponible: ${omitidos.length - sinCert})`,
        });

        await emitirZipCertificados(res, pdfs, omitidos, ahora);
      } catch (e) {
        if (res.headersSent) throw e;
        if (e instanceof ZipSinCertificadosError) {
          res.status(e.status).json({ error: e.message, codigo: e.codigo, omitidos: e.omitidos });
          return;
        }
        if (e instanceof ZipError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
        if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    });

  return router;
}
