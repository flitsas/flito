// FLITO Impuestos — carga de un comprobante de liquidación o de pago desde el impuesto, eligiendo la
// fase (HU #13208, Feature #12955). Sub-router del de impuestos, en archivo PROPIO por el catálogo de
// permisos (D-1 del diseño): reutiliza `impuestos.recibos.cargar`, que ya guarda `POST /recibos` en
// flito-impuestos.routes.ts (fichero del inventario `FICHEROS_EN_ALCANCE`). Una segunda guarda con ese
// código en aquel archivo rompería el catálogo; aquí, fuera del inventario, sigue el precedente de
// `POST /:id/reanalizar`. NO añadir este archivo al inventario ni a `catalogo-operaciones.ts`.
//
// AUTENTICACIÓN PROPIA: `router.use(authMiddleware)` aunque el padre ya autentica (redundante e
// inocuo, como en direccion). Se monta con `router.use(reciboFaseRouter(...))`; no montarlo en otro sitio.
//
// Recibe `contextoImpuesto` por parámetro: sin import circular con el router padre.
// Sin PII en la URL (solo el id opaco) ni en el logger. La auditoría de ESTA ruta no lleva la placa;
// el servicio sí la escribe en `audit_logs` al rechazar por placa (como la carga masiva).

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  CARGA_MASIVA_MAX_BYTES_ARCHIVO, CodigoErrorCargaPorFase, FASES_RECIBO, type FaseRecibo,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { clasificarBytes } from '../../shared/soportes/soportes-zip.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import type { ArchivoSubido, ImpuestoCtx } from './flito-factura-venta.service.js';
import { CargaPorFaseError, cargarReciboPorFase } from './flito-recibos.service.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

/**
 * Cada carga dispara OCR (AGENTS §18). Cubo propio (D-5): no se comparte con la puerta universal de
 * comprobantes. Por usuario, no por IP: Operaciones sale por una IP corporativa. Va DELANTE de multer.
 */
export const reciboFaseLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-impuestos-recibo-fase'),
  message: { error: 'Demasiadas cargas seguidas, espera unos minutos' },
  store: makeStore('rl:flito-impuestos-recibo-fase:'),
});

/** Lo declarado por el cliente → lo que tienen que decir los bytes (`clasificarBytes`). Sin ZIP. */
const MIME_POR_CLASE = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' } as const;
const MIMES: readonly string[] = Object.values(MIME_POR_CLASE);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CARGA_MASIVA_MAX_BYTES_ARCHIVO, files: 1, fields: 2 },
  fileFilter: (_req, file, cb) => {
    if (MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(MOTIVO_TIPO));
  },
});

/** Motivos de multer traducidos, sin eco del nombre ni del MIME que mandó el cliente (AC10). */
const MOTIVO_MULTER: Record<string, string> = {
  LIMIT_FILE_SIZE: 'El archivo supera el tamaño máximo permitido (15 MB)',
  LIMIT_FILE_COUNT: 'Solo se admite un archivo',
  LIMIT_UNEXPECTED_FILE: 'Solo se admite un archivo, en el campo "archivo"',
  LIMIT_FIELD_COUNT: 'La carga trae campos de más',
};
const MOTIVO_GENERICO = 'Archivo inválido';
const MOTIVO_TIPO = 'Tipo de archivo no permitido: solo PDF, JPEG o PNG';

export const archivoInvalido = (res: Response, error: string): void => {
  res.status(400).json({ error, codigo: CodigoErrorCargaPorFase.ARCHIVO_INVALIDO });
};

/**
 * multer envuelto: sus rechazos salen como 400 con `codigo`, no como el 500 del error handler. Lo
 * reutiliza el reemplazo del comprobante (HU #13269): mismos límites, mismos textos.
 */
export function recibir(req: Request, res: Response, next: NextFunction): void {
  upload.single('archivo')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    // Solo textos propios: un error de busboy («Unexpected end of form»…) no sale crudo (AC10).
    const motivo = err instanceof multer.MulterError ? MOTIVO_MULTER[err.code]
      : err instanceof Error && err.message === MOTIVO_TIPO ? MOTIVO_TIPO : undefined;
    archivoInvalido(res, motivo ?? MOTIVO_GENERICO);
  });
}

/**
 * Tras `recibir`: el archivo con el MIME que dicen sus BYTES (D-6), o null con el 400 ya respondido.
 * Compartido con el reemplazo del comprobante (HU #13269, AC3: mismo rechazo).
 */
export function archivoConMimeReal(req: Request, res: Response): ArchivoSubido | null {
  const file = req.file;
  if (!file) { archivoInvalido(res, 'No se adjuntó ningún archivo'); return null; }
  const clase = clasificarBytes(file.buffer);
  if (!clase || MIME_POR_CLASE[clase] !== file.mimetype) {
    archivoInvalido(res, 'El contenido del archivo no corresponde a un PDF, JPEG o PNG');
    return null;
  }
  return { originalname: file.originalname, mimetype: MIME_POR_CLASE[clase], buffer: file.buffer, size: file.size };
}

const idSchema = z.string().uuid();
const cuerpoSchema = z.object({ fase: z.enum(FASES_RECIBO as [FaseRecibo, ...FaseRecibo[]]) });

export default function reciboFaseRouter(contextoImpuesto: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  /**
   * POST /:id/recibos — multipart `archivo` (uno) + `fase` (`liquidacion` | `pago`).
   *   400 archivo_invalido | fase_invalida · 403 sin función · 404 no_encontrado · 409 estado_no_permitido
   *   429 limitador · 503 OCR caído · 200 `RespuestaCargaPorFase` (también los resultados sin escritura)
   */
  router.post('/:id/recibos', exigirFuncion('impuestos.recibos.cargar'), reciboFaseLimiter, recibir,
    async (req: Request, res: Response) => {
      const archivo = archivoConMimeReal(req, res);
      if (!archivo) return;
      const cuerpo = cuerpoSchema.safeParse(req.body);
      if (!cuerpo.success) {
        res.status(400).json({ error: 'La fase debe ser liquidación o pago', codigo: CodigoErrorCargaPorFase.FASE_INVALIDA });
        return;
      }
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) {
        res.status(404).json({ error: 'El impuesto no existe', codigo: CodigoErrorCargaPorFase.NO_ENCONTRADO });
        return;
      }
      try {
        const ctx = await contextoImpuesto(req.user!);
        const r = await cargarReciboPorFase(id.data, cuerpo.data.fase, archivo, ctx);
        const soporte = 'soporteId' in r ? ` Soporte ${r.soporteId}.` : '';
        await audit(req, { action: 'upload', resource: 'flito_impuesto', resourceId: id.data,
          detail: `Carga por fase (${cuerpo.data.fase}): ${r.resultado}.${soporte}` });
        res.json(r);
      } catch (e) {
        if (e instanceof CargaPorFaseError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
        if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
        throw e;
      }
    });

  return router;
}
