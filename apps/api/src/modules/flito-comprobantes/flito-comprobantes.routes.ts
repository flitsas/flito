// Comprobantes universales (HTTP) — Épica #12245, Feature #12605, HU #12611. Montado en
// /api/flito/comprobantes. Cinco rutas, cada una con su función del motor de permisos (el módulo
// nace reconducido: ninguna guarda `requireRole`). Errores `{ error, codigo }` (`ComprobanteError`);
// `Cache-Control: no-store` en el detalle y en el archivo (llaves de vehículo y URL prefirmada).
//
// F1 solo carga, lee, lista, muestra y relee. Asociar/aplicar/descartar (F2) y aceptar diferencia
// (F3) llegan con sus migraciones (0199/0200) y sus rutas.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  CARGA_MASIVA_ARCHIVOS_POR_PETICION, CARGA_MASIVA_MAX_BYTES_ARCHIVO, CodigoErrorComprobante, CONCEPTOS_COSTO,
  ESTADOS_COMPROBANTE, type ConceptoCosto, type EstadoComprobante,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { cargarLote, type ArchivoCargado } from './flito-comprobantes.carga.js';
import { ComprobanteError, detalle, listar, releer, urlArchivo, type ComprobanteCtx } from './flito-comprobantes.service.js';

const router = Router();
router.use(authMiddleware);

const ctxDe = (user: { sub: number; username: string }): ComprobanteCtx => ({ userId: user.sub, username: user.username });

// ── Carga: 1..5 archivos por envío, 15 MiB cada uno, sin ZIP ─────────────────────────────────────
// Sin `fileFilter` por MIME: el tipo que decide es la CABECERA real, que lee `cargarLote` archivo a
// archivo (un `.pdf` que no empieza por %PDF va a `fallidos`, no tumba el envío entero). Multer solo
// pone los topes de cantidad y peso, que sí son del envío y sí son 400.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CARGA_MASIVA_MAX_BYTES_ARCHIVO, files: CARGA_MASIVA_ARCHIVOS_POR_PETICION },
});
/** Motivos de multer traducidos, sin eco del nombre ni del MIME que mandó el cliente. */
const MOTIVO_MULTER: Record<string, string> = {
  LIMIT_FILE_SIZE: 'Un archivo supera los 15 MB',
  LIMIT_FILE_COUNT: `Máximo ${CARGA_MASIVA_ARCHIVOS_POR_PETICION} archivos por envío`,
  LIMIT_UNEXPECTED_FILE: 'Los archivos van en el campo "archivos"',
};
/** Envuelve a multer para que sus rechazos salgan como 400 con `codigo` y no como el 500 genérico. */
function recibirArchivos(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.array('archivos', CARGA_MASIVA_ARCHIVOS_POR_PETICION)(req, res, (err: unknown) => {
    if (err) {
      const motivo = err instanceof multer.MulterError ? MOTIVO_MULTER[err.code] : undefined;
      res.status(400).json({ error: motivo ?? 'Archivo inválido', codigo: CodigoErrorComprobante.ARCHIVO_INVALIDO });
      return;
    }
    next();
  });
}

const aArchivo = (f: Express.Multer.File): ArchivoCargado => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size });

export const cargaSchema = z.object({ loteId: z.string().uuid() });

router.post('/', exigirFuncion('comprobantes.lote.cargar'), recibirArchivos, async (req: Request, res: Response) => {
  const parsed = cargaSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'loteId inválido', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo', codigo: CodigoErrorComprobante.ARCHIVO_INVALIDO }); return; }
  try {
    const resultado = await cargarLote(files.map(aArchivo), parsed.data.loteId, ctxDe(req.user!));
    await audit(req, { action: 'upload', resource: 'flito_comprobante_lote', resourceId: parsed.data.loteId,
      detail: `Envío de ${files.length} archivo(s): ${resultado.documentos} documento(s), ${resultado.pendientes.length} pendiente(s), ${resultado.duplicados.length} duplicado(s), ${resultado.fallidos.length} fallido(s).` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

// ── Cola ─────────────────────────────────────────────────────────────────────────────────────────
export const listarSchema = z.object({
  estado: z.enum(ESTADOS_COMPROBANTE as [EstadoComprobante, ...EstadoComprobante[]]).optional(),
  concepto: z.enum(CONCEPTOS_COSTO as [ConceptoCosto, ...ConceptoCosto[]]).optional(),
  motivo: z.string().max(40).optional(),
  loteId: z.string().uuid().optional(),
  tramiteId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', exigirFuncion('comprobantes.cola.ver'), async (req: Request, res: Response) => {
  const parsed = listarSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtros inválidos', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  try { res.json(await listar(parsed.data)); } catch (e) { handleError(res, e); }
});

// ── Detalle ──────────────────────────────────────────────────────────────────────────────────────
router.get('/:id', exigirFuncion('comprobantes.comprobante.ver'), async (req: Request, res: Response) => {
  try {
    const dto = await detalle(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(dto);
  } catch (e) { handleError(res, e); }
});

// ── Archivo: URL prefirmada de corta vida (calco de flito-revisiones) ────────────────────────────
router.get('/:id/archivo', exigirFuncion('comprobantes.archivo.descargar'), async (req: Request, res: Response) => {
  try {
    const url = await urlArchivo(req.params.id, req.query.aplicado === '1');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  } catch (e) { handleError(res, e); }
});

// ── Releer: solo sobre `ocr_no_disponible`; nunca crea filas ─────────────────────────────────────
router.post('/:id/releer', exigirFuncion('comprobantes.comprobante.releer'), async (req: Request, res: Response) => {
  try {
    const dto = await releer(req.params.id, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_comprobante', resourceId: req.params.id, detail: `Comprobante releído: ${dto.motivoPendiente}.` });
    res.setHeader('Cache-Control', 'no-store');
    res.json(dto);
  } catch (e) { handleError(res, e); }
});

function handleError(res: Response, e: unknown): void {
  if (e instanceof ComprobanteError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
  throw e;
}

export default router;
