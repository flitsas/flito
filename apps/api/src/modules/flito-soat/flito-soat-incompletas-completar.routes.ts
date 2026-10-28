// FLITO — SOAT, canal Cliente (HTTP): COMPLETAR una pendiente de la carga masiva (HU #14136, Feature #14014).
// Montado dentro del router de incompletas (`router.use`), tras `authMiddleware`; sin montaje nuevo en app.ts.
//
//   POST /cliente/incompletas/:id/factura   — adjunta la factura (multipart `facturaVenta`), OCR, VIN igual (AC1, AC4, AC6, AC8).
//   POST /cliente/incompletas/:id/confirmar — confirmación EXPLÍCITA: RUNT + despacho al gestor (AC2, AC3, AC5, AC9).
//
// Función: `soat.solicitud.crear` (la del alta; decisión de la HU, sin función nueva) → 403 sin ella (AC10).
// PII (AGENTS.md §14): el propietario viaja en el CUERPO; en la URL solo el uuid opaco de la incompleta.
// Orden de middlewares como `/cliente/factura/lectura`: el limitador va DELANTE de multer.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { soatClienteLimiter, soatLecturaFacturaLimiter, soatPreconsultaLimiter } from '../../shared/middleware/rateLimiter.js';
import { contextoSoat } from './flito-soat.service.js';
import { SolicitudSoatError, type ArchivoSolicitud } from './flito-soat-cliente.service.js';
import { ClienteNoOperableError } from '../clients/cliente-operable.js';
import {
  documentoSchema, procedenciaMapaSchema, refinarTitular, titularCampos,
} from './flito-soat-cliente.routes.js';
import {
  adjuntarFactura, confirmarIncompleta, VinFacturaNoCoincideError, type ConfirmacionInput,
} from './flito-soat-incompletas-completar.service.js';
import {
  CAMPOS_PII_INCOMPLETA_DETALLE, registrarAccesoIncompleta, registrarAccesoRuntCliente,
  registrarLecturaFacturaCliente,
} from './flito-soat.pii.js';

const router = Router();
router.use(authMiddleware);

const idSchema = z.string().guid();
const NO_EXISTE = { error: 'La solicitud no existe' };

/** Un archivo, 15 MB; el `fileFilter` es solo un freno barato: el MIME REAL se olfatea en el servicio (AC8). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

/** Errores de dominio → HTTP. Lo demás lo resuelve el handler global (nunca el mensaje crudo con PII). */
function manejarError(res: Response, e: unknown): void {
  if (e instanceof VinFacturaNoCoincideError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
  if (e instanceof ClienteNoOperableError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof SolicitudSoatError) {
    res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.datos ?? {}) });
    return;
  }
  throw e;
}

/** Multer rechaza con un `Error` plano (tipo no permitido, tamaño): 400 y no 500. */
function subida(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.single('facturaVenta')(req, res, (err?: unknown) => {
    if (err) { res.status(400).json({ error: 'Archivo no permitido: solo se acepta un PDF de hasta 15 MB' }); return; }
    next();
  });
}

router.post('/cliente/incompletas/:id/factura',
  exigirFuncion('soat.solicitud.crear'), soatLecturaFacturaLimiter, subida,
  async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.id).success) { res.status(404).json(NO_EXISTE); return; }
    if (!req.file) { res.status(400).json({ error: 'Falta la factura de venta (PDF)' }); return; }
    const archivo: ArchivoSolicitud = {
      originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer, size: req.file.size,
    };
    try {
      const ctx = await contextoSoat(req.user!);
      const r = await adjuntarFactura(req.params.id, archivo, ctx);
      if (!r) { res.status(404).json(NO_EXISTE); return; } // AC7: sin revelar que existe
      // Se entregaron datos personales leídos de la factura (artículo 17); una lectura sin OCR no entrega nada.
      if (r.lectura === 'ok') await registrarLecturaFacturaCliente(req, { solicitudId: null });
      await audit(req, {
        action: 'update', resource: 'flito_soat_incompletas', resourceId: req.params.id,
        detail: `Factura adjuntada a solicitud SOAT pendiente de validar (lectura=${r.lectura})`,
      });
      res.json(r);
    } catch (e) { manejarError(res, e); }
  },
);

/** AC5: sin `confirmado: true` explícito es 400; nada se despacha. `.strict()`: un campo extra es 400. */
export const confirmarSchema = documentoSchema.extend(titularCampos).extend({
  confirmado: z.literal(true, { message: 'Debes confirmar explícitamente la solicitud' }),
  procedencia: procedenciaMapaSchema.optional(),
}).strict().superRefine(refinarTitular);

router.post('/cliente/incompletas/:id/confirmar',
  exigirFuncion('soat.solicitud.crear'), soatClienteLimiter, soatPreconsultaLimiter,
  async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.id).success) { res.status(404).json(NO_EXISTE); return; }
    const parsed = confirmarSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
    const { confirmado: _c, procedencia, ...propietario } = parsed.data;
    const input: ConfirmacionInput = {
      propietario: {
        tipoDocumento: propietario.tipoDocumento, numeroDocumento: propietario.numeroDocumento,
        nombres: propietario.nombres ?? null, apellidos: propietario.apellidos ?? null,
        razonSocial: propietario.razonSocial ?? null, correo: propietario.correo, celular: propietario.celular,
        direccion: propietario.direccion, municipio: propietario.municipio, departamento: propietario.departamento,
      },
      procedencia: (procedencia ?? null) as ConfirmacionInput['procedencia'],
    };
    try {
      const ctx = await contextoSoat(req.user!);
      const r = await confirmarIncompleta(req.params.id, input, ctx);
      if (!r) { res.status(404).json(NO_EXISTE); return; } // AC7
      // El RUNT (registro nacional) SÍ se consultó y el propietario SÍ se escribió: rastro del artículo 17.
      try {
        await registrarAccesoRuntCliente(req, { vin: r.vin, placa: r.placa, conPropietario: false, motivo: 'alta' });
        await registrarAccesoIncompleta(req, {
          accion: 'read', incompletaId: req.params.id, vin: r.vin, placa: r.placa, filas: 1, campos: CAMPOS_PII_INCOMPLETA_DETALLE,
        });
      } catch { /* el SOAT ya nació: el 200 manda */ }
      await audit(req, {
        action: 'update', resource: 'flito_soat_incompletas', resourceId: req.params.id,
        detail: `Solicitud SOAT pendiente confirmada y despachada (soat=${r.soatId})`,
      });
      res.json({ id: r.soatId, estado: r.estado });
    } catch (e) { manejarError(res, e); }
  },
);


export default router;
