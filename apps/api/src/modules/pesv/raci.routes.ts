// PESV-S9 · Paso 1.5 — Matriz RACI (Responsible / Accountable / Consulted / Informed)
// Cruza pasos PHVA × roles del sistema, una fila por (proceso, rol, tipo).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvRaci } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv_raci'));

const ADMIN_OR_LIDER = ['admin', 'lider_pesv'] as const;
const ROLES_VALIDOS = ['admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor'] as const;

const raciSchema = z.object({
  procesoCodigo: z.string().min(1).max(20),
  procesoNombre: z.string().min(3).max(200),
  rol: z.enum(ROLES_VALIDOS),
  tipo: z.enum(['R', 'A', 'C', 'I']),
  descripcion: z.string().max(2000).optional().nullable(),
});

// Lista plana — el frontend pivotea a matriz.
router.get('/', async (req, res) => {
  const proceso = typeof req.query.proceso === 'string' ? req.query.proceso : undefined;
  const rol = typeof req.query.rol === 'string' ? req.query.rol : undefined;
  const conds: any[] = [];
  if (proceso) conds.push(eq(pesvRaci.procesoCodigo, proceso));
  if (rol) conds.push(eq(pesvRaci.rol, rol));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvRaci).where(where).orderBy(pesvRaci.procesoCodigo, pesvRaci.rol, pesvRaci.tipo).limit(2000);
  res.json({ data: rows });
});

// Vista pivote: { procesos: [...], roles: [...], celdas: { [proc]: { [rol]: ['R','A',...] } } }
router.get('/matriz', async (_req, res) => {
  const rows = await db.select().from(pesvRaci).orderBy(pesvRaci.procesoCodigo, pesvRaci.rol);
  const procesos = new Map<string, string>();
  const roles = new Set<string>();
  const celdas: Record<string, Record<string, string[]>> = {};
  for (const r of rows) {
    procesos.set(r.procesoCodigo, r.procesoNombre);
    roles.add(r.rol);
    if (!celdas[r.procesoCodigo]) celdas[r.procesoCodigo] = {};
    if (!celdas[r.procesoCodigo][r.rol]) celdas[r.procesoCodigo][r.rol] = [];
    celdas[r.procesoCodigo][r.rol].push(r.tipo);
  }
  res.json({
    procesos: Array.from(procesos.entries()).map(([codigo, nombre]) => ({ codigo, nombre })),
    roles: Array.from(roles).sort(),
    celdas,
  });
});

router.post('/', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = raciSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(pesvRaci).values({
      procesoCodigo: d.procesoCodigo,
      procesoNombre: d.procesoNombre,
      rol: d.rol,
      tipo: d.tipo,
      descripcion: d.descripcion ?? null,
      createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_raci', resourceId: String(row.id), detail: `${d.procesoCodigo}/${d.rol}/${d.tipo}` });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Ya existe asignación para (proceso, rol, tipo)' });
    throw e;
  }
});

router.patch('/:id(\\d+)', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const parsed = raciSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const expectedV = Number(req.body?.optimisticV);
  if (!Number.isFinite(expectedV)) return res.status(400).json({ error: 'optimisticV requerido' });
  const [row] = await db.update(pesvRaci).set({
    ...d,
    descripcion: d.descripcion ?? undefined,
    optimisticV: expectedV + 1,
    updatedAt: new Date(),
  }).where(and(eq(pesvRaci.id, id), eq(pesvRaci.optimisticV, expectedV))).returning();
  if (!row) return res.status(409).json({ error: 'No encontrado o versión desactualizada' });
  await audit(req, { action: 'update', resource: 'pesv_raci', resourceId: String(id) });
  res.json(row);
});

router.delete('/:id(\\d+)', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const result = await db.delete(pesvRaci).where(eq(pesvRaci.id, id)).returning();
  if (!result.length) return res.status(404).json({ error: 'No encontrado' });
  await audit(req, { action: 'delete', resource: 'pesv_raci', resourceId: String(id) });
  res.json({ ok: true });
});

// Bulk replace para un proceso (UI matriz: el usuario edita columnas de un paso y guarda).
const bulkSchema = z.object({
  procesoCodigo: z.string().min(1).max(20),
  procesoNombre: z.string().min(3).max(200),
  asignaciones: z.array(z.object({
    rol: z.enum(ROLES_VALIDOS),
    tipos: z.array(z.enum(['R', 'A', 'C', 'I'])).max(4),
    descripcion: z.string().max(2000).optional().nullable(),
  })).max(50),
});

router.put('/proceso', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  await db.transaction(async (tx) => {
    await tx.delete(pesvRaci).where(eq(pesvRaci.procesoCodigo, d.procesoCodigo));
    const valores: any[] = [];
    for (const a of d.asignaciones) {
      for (const t of a.tipos) {
        valores.push({
          procesoCodigo: d.procesoCodigo,
          procesoNombre: d.procesoNombre,
          rol: a.rol,
          tipo: t,
          descripcion: a.descripcion ?? null,
          createdBy: req.user!.sub,
        });
      }
    }
    if (valores.length) await tx.insert(pesvRaci).values(valores);
  });
  await audit(req, { action: 'update', resource: 'pesv_raci_bulk', resourceId: d.procesoCodigo, detail: `${d.asignaciones.length} roles` });
  res.json({ ok: true, proceso: d.procesoCodigo });
});

export default router;
