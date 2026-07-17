// PESV-S6 huérfanos consolidados (mantiene <400 LOC):
//   - /auditorias    (Paso 22)
//   - /comunicaciones (Paso 1.8 + 24)
//   - /contratistas  (Paso 18)
//   - road_incidents extension causa raíz (Paso 13)
// El audit log Ley 1581 (/privacy/pii-access-log) está en privacy.routes.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  pesvAuditorias, pesvAuditoriaHallazgos,
  pesvComunicaciones, pesvComunicacionAcuses,
  pesvContratistas,
  roadIncidents,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const ADMIN_OR_LIDER = ['admin', 'lider_pesv'] as const;

// ============ AUDITORIAS ============
const auditoriaSchema = z.object({
  anio: z.number().int().min(2020).max(2100),
  tipo: z.enum(['interna', 'externa', 'supert', 'onac']),
  alcance: z.string().min(10).max(2000),
  fechaPlanificada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  auditorExterno: z.string().max(200).optional().nullable(),
  auditorLiderId: z.number().int().positive().optional().nullable(),
});

router.get('/auditorias', async (req, res) => {
  const anio = req.query.anio ? parseInt(req.query.anio as string, 10) : undefined;
  const conds: any[] = [];
  if (anio) conds.push(eq(pesvAuditorias.anio, anio));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvAuditorias).where(where).orderBy(desc(pesvAuditorias.anio), desc(pesvAuditorias.fechaPlanificada)).limit(200);
  res.json({ data: rows });
});

router.get('/auditorias/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [a] = await db.select().from(pesvAuditorias).where(eq(pesvAuditorias.id, id)).limit(1);
  if (!a) return res.status(404).json({ error: 'No encontrada' });
  const hallazgos = await db.select().from(pesvAuditoriaHallazgos).where(eq(pesvAuditoriaHallazgos.auditoriaId, id)).orderBy(desc(pesvAuditoriaHallazgos.severidad));
  res.json({ ...a, hallazgos });
});

router.post('/auditorias', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = auditoriaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const [row] = await db.insert(pesvAuditorias).values({
    ...parsed.data,
    auditorExterno: parsed.data.auditorExterno ?? null,
    auditorLiderId: parsed.data.auditorLiderId ?? null,
    createdBy: req.user!.sub,
  }).returning();
  await audit(req, { action: 'create', resource: 'pesv_auditoria', resourceId: String(row.id), detail: `${row.anio} ${row.tipo}` });
  res.status(201).json(row);
});

router.post('/auditorias/:id/cerrar', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(pesvAuditorias).where(eq(pesvAuditorias.id, id)).for('update').limit(1);
    if (!a) return { code: 404 as const };
    if (a.estado === 'cerrada') return { code: 409 as const, msg: 'Ya cerrada' };
    const [row] = await tx.update(pesvAuditorias).set({
      estado: 'cerrada', fechaCierre: today, optimisticV: a.optimisticV + 1,
    }).where(eq(pesvAuditorias.id, id)).returning();
    return { code: 200 as const, row };
  });
  if (result.code !== 200) return res.status(result.code).json({ error: (result as any).msg || 'no encontrada' });
  await audit(req, { action: 'update', resource: 'pesv_auditoria', resourceId: String(id), detail: 'cerrada' });
  res.json(result.row);
});

const hallazgoSchema = z.object({
  pasoPesv: z.number().int().min(1).max(24).optional().nullable(),
  severidad: z.enum(['observacion', 'no_conformidad_menor', 'no_conformidad_mayor', 'critico']),
  descripcion: z.string().min(10),
  responsableId: z.number().int().positive().optional().nullable(),
  fechaLimite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  accionesMd: z.string().optional().nullable(),
});

router.post('/auditorias/:id/hallazgos', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const auditoriaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(auditoriaId) || auditoriaId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = hallazgoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(pesvAuditoriaHallazgos).values({
      auditoriaId, pasoPesv: d.pasoPesv ?? null, severidad: d.severidad, descripcion: d.descripcion,
      responsableId: d.responsableId ?? null, fechaLimite: d.fechaLimite ?? null, accionesMd: d.accionesMd ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_hallazgo', resourceId: String(row.id), detail: d.severidad });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23503') return res.status(400).json({ error: 'auditoría inexistente' });
    throw e;
  }
});

router.post('/hallazgos/:hallazgoId/cerrar', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.hallazgoId, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const obs = typeof req.body?.cierreObservaciones === 'string' ? String(req.body.cierreObservaciones).slice(0, 2000) : null;
  const [row] = await db.update(pesvAuditoriaHallazgos).set({
    estado: 'cerrado', cerradoAt: new Date(), cerradoPor: req.user!.sub, cierreObservaciones: obs,
  }).where(and(eq(pesvAuditoriaHallazgos.id, id), eq(pesvAuditoriaHallazgos.estado, 'abierto'))).returning();
  if (!row) return res.status(409).json({ error: 'Hallazgo no existe o ya está cerrado' });
  await audit(req, { action: 'update', resource: 'pesv_hallazgo', resourceId: String(id), detail: 'cerrado' });
  res.json(row);
});

// ============ COMUNICACIONES ============
const comSchema = z.object({
  tipo: z.enum(['politica', 'lecciones_aprendidas', 'capacitacion', 'recordatorio', 'otro']),
  asunto: z.string().min(3).max(200),
  cuerpoMd: z.string().min(20),
  destinatariosRoles: z.array(z.string()).default([]),
  vencimientoAcuse: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

router.get('/comunicaciones', async (req, res) => {
  const tipo = req.query.tipo as string | undefined;
  const conds: any[] = [];
  if (tipo) conds.push(eq(pesvComunicaciones.tipo, tipo as any));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvComunicaciones).where(where).orderBy(desc(pesvComunicaciones.publicadoAt), desc(pesvComunicaciones.id)).limit(100);
  res.json({ data: rows });
});

router.get('/comunicaciones/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [c] = await db.select().from(pesvComunicaciones).where(eq(pesvComunicaciones.id, id)).limit(1);
  if (!c) return res.status(404).json({ error: 'No encontrada' });
  res.json(c);
});

router.post('/comunicaciones', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = comSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const [row] = await db.insert(pesvComunicaciones).values({
    ...parsed.data,
    vencimientoAcuse: parsed.data.vencimientoAcuse ?? null,
  }).returning();
  await audit(req, { action: 'create', resource: 'pesv_comunicacion', resourceId: String(row.id), detail: parsed.data.tipo });
  res.status(201).json(row);
});

router.post('/comunicaciones/:id/publicar', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [row] = await db.update(pesvComunicaciones).set({
    publicadoAt: new Date(), publicadoPor: req.user!.sub,
  }).where(and(eq(pesvComunicaciones.id, id), sql`publicado_at IS NULL`)).returning();
  if (!row) return res.status(409).json({ error: 'No encontrada o ya publicada' });
  await audit(req, { action: 'update', resource: 'pesv_comunicacion', resourceId: String(id), detail: 'publicada' });
  res.json(row);
});

// Acuse de recibo — cualquier user con rol PESV puede confirmar lectura.
router.post('/comunicaciones/:id/acusar', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || req.ip || null;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(pesvComunicacionAcuses).values({
        comunicacionId: id, userId: req.user!.sub, ipOrigen: ip,
      });
      await tx.update(pesvComunicaciones).set({
        acusesCount: sql`${pesvComunicaciones.acusesCount} + 1`,
      }).where(eq(pesvComunicaciones.id, id));
    });
    await audit(req, { action: 'update', resource: 'pesv_com_acuse', resourceId: String(id) });
    res.json({ ok: true });
  } catch (e: any) {
    if (e?.code === '23505') return res.status(200).json({ ok: true, alreadyAcknowledged: true });
    if (e?.code === '23503') return res.status(404).json({ error: 'Comunicación no existe' });
    throw e;
  }
});

// ============ CONTRATISTAS ============
const contratSchema = z.object({
  razonSocial: z.string().min(3).max(200),
  nit: z.string().min(5).max(20),
  contactoNombre: z.string().max(150).optional().nullable(),
  contactoEmail: z.string().email().max(150).optional().nullable(),
  contactoTelefono: z.string().max(40).optional().nullable(),
  pesvNivel: z.enum(['basico', 'estandar', 'avanzado', 'no_aplica']).optional().nullable(),
  pesvVencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  evaluacion: z.enum(['apto', 'apto_condicional', 'no_apto']).default('apto_condicional'),
  proximaEvaluacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
});

router.get('/contratistas', async (req, res) => {
  const estado = req.query.estado as string | undefined;
  const conds: any[] = [];
  if (estado) conds.push(eq(pesvContratistas.estado, estado as any));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvContratistas).where(where).orderBy(desc(pesvContratistas.createdAt)).limit(200);
  res.json({ data: rows });
});

router.post('/contratistas', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = contratSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(pesvContratistas).values({
      ...d, contactoNombre: d.contactoNombre ?? null, contactoEmail: d.contactoEmail ?? null,
      contactoTelefono: d.contactoTelefono ?? null, pesvNivel: d.pesvNivel ?? null,
      pesvVencimiento: d.pesvVencimiento ?? null, proximaEvaluacion: d.proximaEvaluacion ?? null,
      observaciones: d.observaciones ?? null, createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_contratista', resourceId: String(row.id), detail: d.razonSocial });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'NIT duplicado' });
    throw e;
  }
});

router.patch('/contratistas/:id', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = contratSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data as any;
  const [row] = await db.update(pesvContratistas).set(d).where(eq(pesvContratistas.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  await audit(req, { action: 'update', resource: 'pesv_contratista', resourceId: String(id) });
  res.json(row);
});

// ============ INVESTIGACIÓN CAUSA RAÍZ INCIDENTES (Paso 13) ============
const causaRaizSchema = z.object({
  metodo: z.enum(['5_porques', 'ishikawa', 'arbol_causas', 'otro']),
  jsonb: z.unknown(), // estructura libre por método
  responsableId: z.number().int().positive().optional().nullable(),
  cerrarInvestigacion: z.boolean().default(false),
});

router.patch('/incidents/:id/causa-raiz', requireRole(...ADMIN_OR_LIDER, 'supervisor_flota'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = causaRaizSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const [row] = await db.update(roadIncidents).set({
    causaRaizMetodo: d.metodo,
    causaRaizJsonb: d.jsonb,
    investigacionResponsableId: d.responsableId ?? req.user!.sub,
    investigacionCerradaAt: d.cerrarInvestigacion ? new Date() : null,
  } as any).where(eq(roadIncidents.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'Incidente no encontrado' });
  await audit(req, { action: 'update', resource: 'road_incident', resourceId: String(id), detail: `causa_raiz_${d.metodo}${d.cerrarInvestigacion ? ' cerrada' : ''}` });
  res.json(row);
});

export default router;
