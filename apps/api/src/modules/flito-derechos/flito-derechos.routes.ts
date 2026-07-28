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
  DerechoError, cargarDerechos, candidatosDePlaca, listarDerechos,
  reintentarPendientes, type DerechoCtx,
} from './flito-derechos.service.js';
import { esConceptoPendiente, listarPendientes } from '../flito-pendientes/flito-pendientes.service.js';
import { contextoSoat, reintentarPendientesSoat } from '../flito-soat/flito-soat.service.js';
import { contextoImpuesto } from '../flito-impuestos/flito-impuestos.routes.js';
import { reintentarPendientesImpuestos } from '../flito-impuestos/flito-recibos.service.js';
import { archivosDelDrive, procesarArchivoDrive, ProcesadorError } from './flito-derechos-drive.service.js';
import type { ArchivoPlano } from '../../shared/archivos/expandir-zip.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');

/** Archivos del Drive en curso, para no procesar el mismo dos veces a la vez. */
const procesando = new Set<string>();
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

// GET /pendientes — recibos leídos que aún no cruzan con ningún registro. Desde la HU #10982 la
// bandeja es de los tres conceptos; sin `concepto` los devuelve todos, para no romper a quien ya
// consumía este endpoint.
router.get('/pendientes', LECTURA, async (req: Request, res: Response) => {
  const c = req.query.concepto;
  res.json(await listarPendientes(esConceptoPendiente(c) ? c : undefined));
});

// POST /pendientes/reintentar — fuerza el barrido sin esperar a la próxima sincronización.
//
// Barre los tres conceptos en la misma pasada: quien pulsa el botón quiere que se resuelva lo que
// se pueda resolver, no elegir de qué tipo. Cada barrido usa las reglas de cruce de SU módulo.
router.post('/pendientes/reintentar', OPERACIONES, async (req: Request, res: Response) => {
  const ctx = contexto(req);
  const derechos = await reintentarPendientes(ctx);
  const soat = await reintentarPendientesSoat(await contextoSoat({ sub: ctx.userId, username: ctx.username, role: ctx.role }));
  const impuestos = await reintentarPendientesImpuestos(await contextoImpuesto({ sub: ctx.userId, username: ctx.username, role: ctx.role }));

  const resultado = {
    revisados: derechos.revisados + soat.revisados + impuestos.revisados,
    asociados: derechos.asociados + soat.asociados + impuestos.asociados,
    porConcepto: { derecho: derechos, soat, impuesto: impuestos },
  };
  await audit(req, {
    action: 'update', resource: 'flito_derecho_tramite',
    detail: `Reintento de pendientes: ${resultado.asociados}/${resultado.revisados} asociados `
      + `(derechos ${derechos.asociados}, SOAT ${soat.asociados}, impuestos ${impuestos.asociados})`,
  });
  res.json(resultado);
});

// ─────────────────────────── Drive de la secretaría ─────────────────────────
//
// Sustituyen al barrido genérico por organismo de la HU #10952: solo Medellín tiene Drive
// compartido, ninguna otra secretaría tenía carpeta y no había forma de ponérsela desde la
// aplicación. El resto cargan sus recibos a mano, que es lo que hacen hoy.

// GET /drive/archivos — los PDF consolidados de la carpeta, para elegir el día.
router.get('/drive/archivos', LECTURA, async (_req: Request, res: Response) => {
  try {
    res.json(await archivosDelDrive());
  } catch (e) {
    // El Drive puede estar caído o sin credencial: se informa sin tumbar la pantalla, que tiene
    // otras dos pestañas que sí funcionan.
    res.status(503).json({ error: e instanceof Error ? e.message : 'El Drive no está disponible' });
  }
});

// POST /drive/procesar — lee un consolidado y asocia sus recibos a los trámites. Bajo demanda:
// quien opera elige el día. Un barrido automático se comería el OCR de la carpeta entera.
const procesarSchema = z.object({ fileId: z.string().min(5) });
router.post('/drive/procesar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = procesarSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Falta el archivo a procesar' }); return; }

  const fileId = parsed.data.fileId;
  // Dos procesamientos del mismo archivo a la vez duplicarían el gasto de OCR para llegar al mismo
  // resultado; el segundo espera a que termine el primero.
  if (procesando.has(fileId)) { res.status(409).json({ error: 'Ese archivo ya se está procesando' }); return; }
  procesando.add(fileId);
  try {
    const r = await procesarArchivoDrive(fileId, contexto(req));
    await audit(req, {
      action: 'update', resource: 'flito_derecho_tramite',
      detail: `Drive «${r.archivo}»: ${r.placasUnicas} placa(s), ${r.registrados.length} registrado(s), `
        + `${r.enRevision.length} en revisión, ${r.pendientes.length} pendiente(s), ${r.duplicados.length} duplicado(s)`,
    });
    res.json(r);
  } catch (e) {
    if (e instanceof ProcesadorError) { res.status(e.status).json({ error: e.message }); return; }
    handleError(res, e);
  } finally {
    procesando.delete(fileId);
  }
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
