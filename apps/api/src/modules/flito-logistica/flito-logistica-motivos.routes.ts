// HU #14119 — Catálogo de motivos de llegada a FLIT: `/api/flito/logistica/motivos-llegada`.
// CRUD sin DELETE (AC4). Todas las guardas: `logistica.motivos.gestionar`.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  MotivoLlegadaDuplicadoError, MotivoLlegadaNoEncontradoError,
  actualizarMotivoLlegada, cambiarEstadoMotivoLlegada, crearMotivoLlegada, listarMotivos, motivoLlegadaDto,
} from './flito-logistica-motivos.service.js';

const router = Router();
router.use(authMiddleware);

const texto = (max: number, etiqueta: string) =>
  z.string({ error: `${etiqueta} es obligatorio` }).trim().min(1, `${etiqueta} es obligatorio`).max(max, `${etiqueta} admite máximo ${max} caracteres`);

const crearSchema = z.object({
  nombre: texto(120, 'El nombre'),
  orden: z.number().int().optional(),
});
const editarSchema = z.object({
  nombre: texto(120, 'El nombre').optional(),
  orden: z.number().int().optional(),
});
const estadoSchema = z.object({ activo: z.boolean() });

function responder422(res: Response, error: z.ZodError): void {
  const f = error.issues[0]!;
  res.status(422).json({ error: f.message, campo: String(f.path[0] ?? ''), details: error.flatten() });
}

router.get('/', exigirFuncion('logistica.motivos.gestionar'), async (req: Request, res: Response) => {
  res.json((await listarMotivos({ soloActivos: req.query.soloActivos === 'true' })).map(motivoLlegadaDto));
});

router.post('/', exigirFuncion('logistica.motivos.gestionar'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  try {
    const creado = await crearMotivoLlegada({ ...parsed.data, creadoPorId: req.user!.sub });
    await audit(req, { action: 'create', resource: 'flito_logistica_motivo_llegada', resourceId: creado.id, detail: `Motivo de llegada: ${creado.nombre}` });
    res.status(201).json(motivoLlegadaDto(creado));
  } catch (e) { manejar(e, res, next); }
});

router.patch('/:id/estado', exigirFuncion('logistica.motivos.gestionar'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = estadoSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  try {
    const act = await cambiarEstadoMotivoLlegada(req.params.id!, parsed.data.activo);
    await audit(req, { action: 'update', resource: 'flito_logistica_motivo_llegada', resourceId: act.id, detail: `Motivo de llegada ${act.activo ? 'activado' : 'desactivado'}: ${act.nombre}` });
    res.json(motivoLlegadaDto(act));
  } catch (e) { manejar(e, res, next); }
});

router.patch('/:id', exigirFuncion('logistica.motivos.gestionar'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = editarSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  const datos = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as { nombre?: string; orden?: number };
  if (Object.keys(datos).length === 0) { res.status(422).json({ error: 'No hay datos para actualizar', campo: '' }); return; }
  try {
    const act = await actualizarMotivoLlegada(req.params.id!, datos);
    await audit(req, { action: 'update', resource: 'flito_logistica_motivo_llegada', resourceId: act.id, detail: `Motivo de llegada: ${act.nombre}` });
    res.json(motivoLlegadaDto(act));
  } catch (e) { manejar(e, res, next); }
});

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof MotivoLlegadaDuplicadoError) { res.status(409).json({ error: e.message }); return; }
  if (e instanceof MotivoLlegadaNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
  next(e);
}

export default router;
