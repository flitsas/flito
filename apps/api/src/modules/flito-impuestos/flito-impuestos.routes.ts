// FLITO Impuestos (HTTP). Porta packages/server/src/impuestos/impuestos.controlador.ts. Montado en
// /api/flito/impuestos; coexiste con /api/tramites del grande.
//
// Fase 4 P1: factura de venta (precondición del envío). Cola/envío (P2) y recibos (P3) llegan después.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  cargarFacturaVentaIndividual, cargarFacturasVentaMasivo, ImpuestoError,
  type ArchivoSubido, type ImpuestoCtx,
} from './flito-factura-venta.service.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('operaciones');

const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true); else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoSubido => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size });

/**
 * Contexto del gestor de impuestos: la atadura de visibilidad por organismo vive en
 * users.transito_codigo (§9.3), leída de BD, no del JWT. Para el resto de roles es null.
 */
async function contextoImpuesto(user: { sub: number; username: string; role: string }): Promise<ImpuestoCtx> {
  let transitoCodigo: string | null = null;
  if (user.role === 'gestor_impuestos') {
    const [u] = await db.select({ t: users.transitoCodigo }).from(users).where(eq(users.id, user.sub)).limit(1);
    transitoCodigo = u?.t ?? null;
  }
  return { userId: user.sub, username: user.username, role: user.role, transitoCodigo };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// POST /:id/factura-venta — carga la factura de venta de UN impuesto (precondición). Solo Operaciones.
router.post('/:id/factura-venta', OPERACIONES, upload.single('archivo'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Falta el archivo de la factura de venta' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    await cargarFacturaVentaIndividual(req.params.id, aArchivo(req.file), ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', resourceId: req.params.id, detail: `Factura de venta: ${req.file.originalname}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// POST /facturas-venta — carga MASIVA de facturas de venta (varios archivos o ZIP). Solo Operaciones.
router.post('/facturas-venta', OPERACIONES, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const resultado = await cargarFacturasVentaMasivo(files.map(aArchivo), ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', detail: `Carga masiva facturas de venta: ${resultado.conciliados.length} conciliadas, ${resultado.enRevision.length} en revisión, ${resultado.duplicados.length} duplicadas, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

export default router;
