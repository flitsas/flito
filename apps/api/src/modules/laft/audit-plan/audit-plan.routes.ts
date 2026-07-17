// LAFT/SARLAFT v2 · F5 — Plan anual de auditorías (Decreto 1497/2002 + Res 4607/2026).
//
// Tipos: 'interna' (oficial cumplimiento o auditor interno) | 'revisor_fiscal' (CPA externo).
// Idempotencia: UNIQUE(anio, tipo) — si llega duplicado responde 409 (no crear segundo plan
// del mismo tipo en el mismo año).
//
// Cierre exige: hallazgos_md, conclusiones_md, evidencia_storage_key. Sin estos
// el cierre devuelve 422.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftAuditPlans, users } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { requirePage } from '../../../shared/permissions.js';
import { laftAudit } from '../audit.service.js';
import { uploadEntityDocument } from '../../../services/storage.js';
import { loggerFor } from '../../../shared/logger.js';

const slog = loggerFor('laft-audit-plan');

const router = Router();
router.use(authMiddleware, requirePage('laft_audit_plan'));

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo no permitido: ${file.mimetype}`));
  },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const TIPOS = ['interna', 'revisor_fiscal'] as const;
const ESTADOS = ['planeada', 'en_ejecucion', 'cerrada', 'cancelada'] as const;

const createSchema = z.object({
  anio: z.coerce.number().int().min(2020).max(2100),
  tipo: z.enum(TIPOS),
  alcance: z.string().max(4000).optional().nullable(),
  responsableUserId: z.coerce.number().int().positive().optional().nullable(),
  responsableExternoNombre: z.string().max(150).optional().nullable(),
  responsableExternoNit: z.string().max(20).optional().nullable(),
  fechaPlanificada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const updateSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  fechaEjecutada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  hallazgosMd: z.string().max(50_000).optional().nullable(),
  conclusionesMd: z.string().max(50_000).optional().nullable(),
  alcance: z.string().max(4000).optional().nullable(),
  responsableUserId: z.coerce.number().int().positive().optional().nullable(),
  responsableExternoNombre: z.string().max(150).optional().nullable(),
  responsableExternoNit: z.string().max(20).optional().nullable(),
});

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================================
// GET / — list paginado con filtros
// ============================================================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const anio = req.query.anio ? parseInt(req.query.anio as string, 10) : undefined;
  const tipo = typeof req.query.tipo === 'string' && (TIPOS as readonly string[]).includes(req.query.tipo) ? req.query.tipo : undefined;
  const estado = typeof req.query.estado === 'string' && (ESTADOS as readonly string[]).includes(req.query.estado) ? req.query.estado : undefined;

  const conds = [] as ReturnType<typeof eq>[];
  if (Number.isFinite(anio)) conds.push(eq(laftAuditPlans.anio, anio as number));
  if (tipo) conds.push(eq(laftAuditPlans.tipo, tipo as string));
  if (estado) conds.push(eq(laftAuditPlans.estado, estado as string));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(laftAuditPlans).where(where)
    .orderBy(desc(laftAuditPlans.anio), laftAuditPlans.tipo)
    .limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(laftAuditPlans).where(where);
  res.json({ data: rows, total: count, limit, offset });
});

// ============================================================================
// GET /:id — detalle
// ============================================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(laftAuditPlans).where(eq(laftAuditPlans.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json(row);
});

// ============================================================================
// POST / — crear plan (idempotente por (anio, tipo))
// ============================================================================
router.post('/', writeLimiter, requireRole('admin', 'compliance'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }
  const data = parsed.data;

  // Validar responsable interno si vino userId.
  if (data.responsableUserId) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, data.responsableUserId)).limit(1);
    if (!u) { res.status(400).json({ error: 'responsableUserId no existe' }); return; }
  }

  try {
    const [row] = await db.insert(laftAuditPlans).values({
      anio: data.anio, tipo: data.tipo,
      alcance: data.alcance ?? null,
      responsableUserId: data.responsableUserId ?? null,
      responsableExternoNombre: data.responsableExternoNombre ?? null,
      responsableExternoNit: data.responsableExternoNit ?? null,
      fechaPlanificada: data.fechaPlanificada,
      estado: 'planeada',
      createdBy: req.user!.sub,
    }).returning();
    await laftAudit(req, {
      action: 'audit_plan_create', resource: 'risk_assessment', resourceId: row.id,
      after: { anio: row.anio, tipo: row.tipo, fechaPlanificada: row.fechaPlanificada },
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') {
      res.status(409).json({ error: `Ya existe plan ${data.tipo} para ${data.anio}` });
      return;
    }
    slog.error({ err: e?.message }, 'fallo crear plan');
    res.status(500).json({ error: 'Error creando plan' });
  }
});

// ============================================================================
// PATCH /:id — actualizar progreso
// ============================================================================
router.patch('/:id', writeLimiter, requireRole('admin', 'compliance'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }
  const data = parsed.data;

  const setData: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of Object.keys(data) as (keyof typeof data)[]) {
    if (data[k] !== undefined) setData[k] = data[k] ?? null;
  }
  const [row] = await db.update(laftAuditPlans).set(setData).where(eq(laftAuditPlans.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await laftAudit(req, {
    action: 'audit_plan_update', resource: 'risk_assessment', resourceId: id,
    after: { estado: row.estado },
  });
  res.json(row);
});

// ============================================================================
// POST /:id/evidencia — subir archivo de evidencia (multipart)
// ============================================================================
router.post('/:id/evidencia', writeLimiter, requireRole('admin', 'compliance'), upload.single('archivo'),
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const [exists] = await db.select({ id: laftAuditPlans.id }).from(laftAuditPlans).where(eq(laftAuditPlans.id, id)).limit(1);
    if (!exists) { res.status(404).json({ error: 'No encontrado' }); return; }

    let key: string;
    try {
      key = await uploadEntityDocument(
        'laft/audit-evidencia', id,
        req.file.originalname, req.file.buffer, req.file.mimetype,
      );
    } catch (e: any) {
      slog.error({ err: e?.message, id }, 'fallo upload evidencia');
      res.status(500).json({ error: 'Error subiendo evidencia' });
      return;
    }
    const [row] = await db.update(laftAuditPlans)
      .set({ evidenciaStorageKey: key, updatedAt: new Date() })
      .where(eq(laftAuditPlans.id, id)).returning();
    await laftAudit(req, {
      action: 'audit_plan_evidencia', resource: 'document', resourceId: id,
      after: { storageKey: key },
    });
    res.json(row);
  },
);

// ============================================================================
// POST /:id/cerrar — cerrar plan (requiere hallazgos+conclusiones+evidencia)
// ============================================================================
router.post('/:id/cerrar', writeLimiter, requireRole('admin', 'compliance'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(laftAuditPlans).where(eq(laftAuditPlans.id, id)).for('update').limit(1);
    if (!row) return { code: 404 as const };
    if (row.estado === 'cerrada') return { code: 409 as const, msg: 'Ya cerrada' };
    if (!row.hallazgosMd || !row.conclusionesMd || !row.evidenciaStorageKey) {
      return { code: 422 as const, msg: 'Cierre requiere hallazgosMd + conclusionesMd + evidencia' };
    }
    if (!row.fechaEjecutada) {
      return { code: 422 as const, msg: 'Cierre requiere fechaEjecutada' };
    }
    const [updated] = await tx.update(laftAuditPlans)
      .set({ estado: 'cerrada', updatedAt: new Date() })
      .where(eq(laftAuditPlans.id, id)).returning();
    return { code: 200 as const, row: updated };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (result.code === 409) { res.status(409).json({ error: result.msg }); return; }
  if (result.code === 422) { res.status(422).json({ error: result.msg }); return; }
  await laftAudit(req, {
    action: 'audit_plan_cerrar', resource: 'risk_assessment', resourceId: id,
    after: { estado: 'cerrada', fechaEjecutada: result.row!.fechaEjecutada },
  });
  res.json(result.row);
});

export default router;
