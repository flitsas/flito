// FLITO Revisiones (HTTP). Porta packages/server/src/revision/revision.controlador.ts. Montado en
// /api/flito/revisiones.
//
// La cola es exclusiva de Operaciones, con lectura para Auditoría. Los gestores NO entran (RN-04/RN-05):
// si el gestor que cargó la factura pudiera resolver su propia revisión, el umbral de OCR no serviría.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { FlujoRevision } from '@operaciones/shared-types';
import { presignedGetEntityDocument } from '../../services/storage.js';
import {
  camposEsperados, descartar, listar, resolver, storageKeySoporte,
  RevisionError, type RevisionCtx,
} from './flito-revisiones.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin', 'operaciones');
const LECTURA = requireRole('admin', 'operaciones', 'auditor');

const MODULOS = Object.values(FlujoRevision) as string[];

function ctxDe(user: { sub: number; username: string; role: string }): RevisionCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof RevisionError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// GET / — cola (?modulo=soat|impuestos|factura_venta&incluirResueltas=true)
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const moduloRaw = typeof req.query.modulo === 'string' ? req.query.modulo : undefined;
  const modulo = moduloRaw && MODULOS.includes(moduloRaw) ? (moduloRaw as FlujoRevision) : undefined;
  const incluirResueltas = req.query.incluirResueltas === 'true';
  res.json(await listar(modulo, incluirResueltas));
});

// GET /campos/:modulo — campos que la UI debe pedir para ese flujo.
router.get('/campos/:modulo', LECTURA, (req: Request, res: Response) => {
  const modulo = req.params.modulo;
  if (!MODULOS.includes(modulo)) { res.status(400).json({ error: 'Módulo de revisión desconocido' }); return; }
  res.json(camposEsperados(modulo as FlujoRevision));
});

// GET /soporte/:soporteId/archivo — el documento en revisión hay que poder verlo, no solo leer lo que
// el OCR creyó. Redirige a una URL S3 prefirmada de corta vida (visor PDF, D-3).
router.get('/soporte/:soporteId/archivo', LECTURA, async (req: Request, res: Response) => {
  const s = await storageKeySoporte(req.params.soporteId);
  if (!s) { res.status(404).json({ error: 'El soporte no existe' }); return; }
  const url = await presignedGetEntityDocument(s.storageKey);
  res.redirect(url);
});

// POST /:id/resolver — la persona confirma registro + campos. Solo Operaciones.
const resolverSchema = z.object({
  registroId: z.string().uuid(),
  campos: z.record(z.string()),
  motivo: z.string().min(1, 'Deja constancia de qué validaste'),
});
router.post('/:id/resolver', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = resolverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    await resolver(req.params.id, parsed.data.registroId, parsed.data.campos, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_revision', resourceId: req.params.id, detail: `Revisión resuelta sobre ${parsed.data.registroId}: ${parsed.data.motivo.trim()}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// POST /:id/descartar — descarta el documento (soporte huérfano y trazado). Solo Operaciones, motivo ≥5.
const descartarSchema = z.object({ motivo: z.string().min(5, 'Descartar un documento exige explicar por qué') });
router.post('/:id/descartar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = descartarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Descartar un documento exige explicar por qué' }); return; }
  try {
    await descartar(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'delete', resource: 'flito_revision', resourceId: req.params.id, detail: `Descarte: ${parsed.data.motivo.trim()}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

export default router;
