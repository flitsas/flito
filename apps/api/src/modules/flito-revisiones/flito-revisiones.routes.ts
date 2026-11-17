// FLITO Revisiones (HTTP). Porta packages/server/src/revision/revision.controlador.ts. Montado en
// /api/flito/revisiones.
//
// La cola es exclusiva de Operaciones, con lectura para Auditoría. Los gestores NO entran (RN-04/RN-05):
// si el gestor que cargó la factura pudiera resolver su propia revisión, el umbral de OCR no serviría.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  CANDIDATOS_REVISION_LIMITE, CANDIDATOS_REVISION_LIMITE_MAX, CANDIDATOS_REVISION_PLACA_MAX,
  CANDIDATOS_REVISION_TEXTO_MAX, CANDIDATOS_REVISION_TEXTO_MIN, CANDIDATOS_REVISION_VIN_MAX, FlujoRevision,
} from '@operaciones/shared-types';
import { soloSinEnlace } from '../../shared/middleware/frontera-enlace.js';
import { esUuid } from '../../shared/utils/uuid.js';
import { presignedGetEntityDocument } from '../../services/storage.js';
import {
  camposEsperados, descartar, listar, resolver, storageKeySoporte,
  RevisionError, type RevisionCtx,
} from './flito-revisiones.service.js';
import { buscarCandidatos } from './flito-revisiones.candidatos.js';

const router = Router();
router.use(authMiddleware);


const MODULOS = Object.values(FlujoRevision) as string[];

function ctxDe(user: { sub: number; username: string; role: string }): RevisionCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof RevisionError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// GET / — cola (?modulo=soat|impuestos|factura_venta&incluirResueltas=true)
router.get('/', exigirFuncion('revisiones.cola.ver'), async (req: Request, res: Response) => {
  const moduloRaw = typeof req.query.modulo === 'string' ? req.query.modulo : undefined;
  const modulo = moduloRaw && MODULOS.includes(moduloRaw) ? (moduloRaw as FlujoRevision) : undefined;
  const incluirResueltas = req.query.incluirResueltas === 'true';
  res.json(await listar(modulo, incluirResueltas));
});

// GET /campos/:modulo — campos que la UI debe pedir para ese flujo.
router.get('/campos/:modulo', exigirFuncion('revisiones.campos.ver'), (req: Request, res: Response) => {
  const modulo = req.params.modulo;
  if (!MODULOS.includes(modulo)) { res.status(400).json({ error: 'Módulo de revisión desconocido' }); return; }
  res.json(camposEsperados(modulo as FlujoRevision));
});

// GET /soporte/:soporteId/archivo — el documento en revisión hay que poder verlo, no solo leer lo que
// el OCR creyó. Redirige a una URL S3 prefirmada de corta vida (visor PDF, D-3).
router.get('/soporte/:soporteId/archivo', exigirFuncion('revisiones.soporte.descargar'), async (req: Request, res: Response) => {
  const s = await storageKeySoporte(req.params.soporteId);
  if (!s) { res.status(404).json({ error: 'El soporte no existe' }); return; }
  const url = await presignedGetEntityDocument(s.storageKey);
  res.redirect(url);
});

// POST /:id/resolver — la persona confirma registro + campos. Solo Operaciones.
const resolverSchema = z.object({
  registroId: z.string().guid(),
  campos: z.record(z.string(), z.string()),
  motivo: z.string().min(1, 'Deja constancia de qué validaste'),
});
router.post('/:id/resolver', exigirFuncion('revisiones.revision.resolver'), async (req: Request, res: Response) => {
  const parsed = resolverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    await resolver(req.params.id, parsed.data.registroId, parsed.data.campos, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_revision', resourceId: req.params.id, detail: `Revisión resuelta sobre ${parsed.data.registroId}: ${parsed.data.motivo.trim()}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// POST /:id/candidatos/buscar — buscador de trámite para resolver (Bug #14569, punto 8). Las llaves
// (placa, VIN, N.º FLIT) van en el BODY para que no queden en la URL ni en los logs de acceso
// (AGENTS.md §14). Misma función que resolver: solo sirve a esa acción. `soloSinEnlace`: busca entre
// TODOS los registros del módulo, igual que el buscador de comprobantes.
// Sin `logPiiAccess`: la respuesta no proyecta columnas personales del titular (ni compradores ni
// documento). Sin limitador propio: no es OCR ni carga masiva (AGENTS.md §18), va tras auth + función
// de Operaciones, cada consulta está acotada a `limite` ≤ 50 y lleva un predicado parametrizado.
const textoBuscar = z.string().trim().max(CANDIDATOS_REVISION_TEXTO_MAX)
  .refine((v) => v === '' || v.length >= CANDIDATOS_REVISION_TEXTO_MIN, `Escribe entre ${CANDIDATOS_REVISION_TEXTO_MIN} y ${CANDIDATOS_REVISION_TEXTO_MAX} caracteres`);
export const buscarCandidatosSchema = z.object({
  texto: textoBuscar.optional(),
  placa: z.string().trim().max(CANDIDATOS_REVISION_PLACA_MAX).optional(),
  vin: z.string().trim().max(CANDIDATOS_REVISION_VIN_MAX).optional(),
  limite: z.number().int().min(1).max(CANDIDATOS_REVISION_LIMITE_MAX).default(CANDIDATOS_REVISION_LIMITE),
}).strict();
router.post('/:id/candidatos/buscar', soloSinEnlace(), exigirFuncion('revisiones.revision.resolver'), async (req: Request, res: Response) => {
  // Un id sin forma de uuid contra una columna `uuid` sería un 22P02 (500): es «no existe», sin consultar.
  if (!esUuid(req.params.id)) { res.status(404).json({ error: 'La revisión no existe' }); return; }
  const parsed = buscarCandidatosSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const r = await buscarCandidatos(req.params.id, parsed.data, req.user!);
    res.setHeader('Cache-Control', 'no-store');
    res.json(r);
  } catch (e) { handleError(res, e); }
});

// POST /:id/descartar — descarta el documento (soporte huérfano y trazado). Solo Operaciones, motivo ≥5.
const descartarSchema = z.object({ motivo: z.string().min(5, 'Descartar un documento exige explicar por qué') });
router.post('/:id/descartar', exigirFuncion('revisiones.revision.descartar'), async (req: Request, res: Response) => {
  const parsed = descartarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Descartar un documento exige explicar por qué' }); return; }
  try {
    await descartar(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'delete', resource: 'flito_revision', resourceId: req.params.id, detail: `Descarte: ${parsed.data.motivo.trim()}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

export default router;
