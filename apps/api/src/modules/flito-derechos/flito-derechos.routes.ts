// FLITO Derechos de tránsito (HTTP) — HU #10950. Montado en /api/flito/derechos.
//
// Solo Operaciones (admin) carga y consulta: a diferencia de impuestos, aquí no hay un gestor
// externo con frontera por organismo — el recibo lo trae quien opera el trámite. `financiera` y
// `auditor` leen, porque el valor alimenta el reporte de costos.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { firmarDescargaEntidad } from '../../services/storage.js';
import { storageKeySoporte } from '../flito-revisiones/flito-revisiones.service.js';
import {
  DerechoError, cargarDerechos, candidatosDePlaca, listarDerechos, listarPendientes,
  reintentarPendientes, type DerechoCtx,
} from './flito-derechos.service.js';
import type { ArchivoPlano } from '../../shared/archivos/expandir-zip.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');
const LECTURA = requireRole('admin', 'auditor', 'financiera');

const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true); else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoPlano => ({
  originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size,
});

const contexto = (req: Request): DerechoCtx => ({
  userId: req.user!.sub, username: req.user!.username, role: req.user!.role,
});

function handleError(res: Response, e: unknown): void {
  if (e instanceof DerechoError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// POST /cargar — carga manual: uno o varios PDF/imágenes, un ZIP, o un PDF consolidado con varios
// recibos. `organismoCodigo` es opcional y solo fija el umbral de OCR y la pista de prompt.
router.post('/cargar', OPERACIONES, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  const organismoCodigo = typeof req.body?.organismoCodigo === 'string' && req.body.organismoCodigo.trim()
    ? req.body.organismoCodigo.trim()
    : null;
  try {
    const resultado = await cargarDerechos(files.map(aArchivo), { organismoCodigo, origen: 'manual' }, contexto(req));
    await audit(req, {
      action: 'upload', resource: 'flito_derecho_tramite',
      detail: `Carga de derechos de tránsito: ${resultado.registrados.length} registrados, ` +
        `${resultado.enRevision.length} en revisión, ${resultado.pendientes.length} pendientes, ` +
        `${resultado.duplicados.length} duplicados, ${resultado.omitidas.length} omitidas, ` +
        `${resultado.fallidos.length} fallidos`,
    });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

// GET / — listado paginado de derechos registrados.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar : undefined;
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 50;
  res.json(await listarDerechos({ buscar, page, pageSize }));
});

// GET /pendientes — recibos leídos que aún no cruzan con ningún trámite.
router.get('/pendientes', LECTURA, async (_req: Request, res: Response) => {
  res.json(await listarPendientes());
});

// POST /pendientes/reintentar — fuerza el barrido sin esperar a la próxima sincronización.
router.post('/pendientes/reintentar', OPERACIONES, async (req: Request, res: Response) => {
  const resultado = await reintentarPendientes(contexto(req));
  await audit(req, {
    action: 'update', resource: 'flito_derecho_tramite',
    detail: `Reintento de pendientes: ${resultado.asociados}/${resultado.revisados} asociados`,
  });
  res.json(resultado);
});

// GET /candidatos/:placa — trámites vivos de una placa, para elegir en la cola de revisión.
const placaSchema = z.string().min(4).max(10);
router.get('/candidatos/:placa', LECTURA, async (req: Request, res: Response) => {
  const parsed = placaSchema.safeParse(req.params.placa);
  if (!parsed.success) { res.status(400).json({ error: 'Placa inválida' }); return; }
  res.json(await candidatosDePlaca(parsed.data));
});

// GET /soporte/:id — URL firmada para ver el PDF del recibo sin exponer el storage.
router.get('/soporte/:id', LECTURA, async (req: Request, res: Response) => {
  const s = await storageKeySoporte(req.params.id);
  if (!s) { res.status(404).json({ error: 'El soporte no existe' }); return; }
  res.json({ url: firmarDescargaEntidad(s.storageKey), nombreArchivo: s.nombreArchivo, contentType: s.contentType });
});

export default router;
