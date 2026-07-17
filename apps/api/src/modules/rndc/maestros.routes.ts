import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, ilike, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  tenedores, propietariosCarga, destinatariosCarga,
} from '../../db/schema.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { normalizeDocument } from '../../shared/utils/crypto.js';

// Normaliza documentos eliminando puntos/espacios/separadores antes de persistir.
// Garantiza que un mismo doc escrito como "1.036.640.908", " 1036640908 " o "CC1036640908"
// quede como "1036640908" en BD — necesario para que /api/privacy/forget matchee correctamente.
const docField = z.string().min(3).max(20).transform(normalizeDocument).refine((s) => s.length >= 3, 'Documento debe tener al menos 3 dígitos');

const router = Router();
router.use(authMiddleware, requirePage('rndc'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const tipoDocEnum = z.enum(['CC', 'CE', 'NIT', 'PAS', 'TI', 'RC']);

// =====================================================
// TENEDORES
// =====================================================

const tenedorSchema = z.object({
  tipo: z.enum(['propietario', 'poseedor', 'tenedor']).default('tenedor'),
  tipoDoc: tipoDocEnum,
  documento: docField,
  nombre: z.string().min(2).max(200),
  direccion: z.string().max(300).optional().nullable(),
  ciudadDane: z.string().length(5).optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  email: z.string().email().max(150).optional().nullable(),
  vinculadoUserId: z.number().int().positive().optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
});

router.get('/tenedores', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const conds: any[] = [eq(tenedores.activo, true)];
  if (q && q.length >= 2) conds.push(ilike(tenedores.nombre, `%${q}%`));
  const rows = await db.select().from(tenedores).where(and(...conds))
    .orderBy(tenedores.nombre).limit(200);
  res.json({ data: rows });
});

router.get('/tenedores/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(tenedores).where(eq(tenedores.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: row });
});

router.post('/tenedores', async (req: Request, res: Response) => {
  const parsed = tenedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  try {
    const [row] = await db.insert(tenedores).values({ ...parsed.data, createdBy: req.user?.sub ?? null } as any).returning();
    await audit(req, { action: 'create', resource: 'tenedor', resourceId: String(row.id) });
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (err.code === '23505') { res.status(409).json({ error: 'Ya existe tenedor con ese documento' }); return; }
    throw err;
  }
});

router.put('/tenedores/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = tenedorSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [row] = await db.update(tenedores).set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(eq(tenedores.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'tenedor', resourceId: String(id) });
  res.json({ data: row });
});

router.delete('/tenedores/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(tenedores).set({ activo: false, updatedAt: new Date() })
    .where(eq(tenedores.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'delete', resource: 'tenedor', resourceId: String(id), detail: 'soft_delete' });
  res.json({ data: row });
});

// =====================================================
// PROPIETARIOS DE CARGA
// =====================================================

const propietarioCargaSchema = z.object({
  tipoDoc: tipoDocEnum,
  documento: docField,
  nombre: z.string().min(2).max(200),
  direccion: z.string().max(300).optional().nullable(),
  ciudadDane: z.string().length(5).optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  email: z.string().email().max(150).optional().nullable(),
  clientId: z.number().int().positive().optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
});

router.get('/propietarios-carga', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const conds: any[] = [eq(propietariosCarga.activo, true)];
  if (q && q.length >= 2) conds.push(ilike(propietariosCarga.nombre, `%${q}%`));
  const rows = await db.select().from(propietariosCarga).where(and(...conds))
    .orderBy(propietariosCarga.nombre).limit(200);
  res.json({ data: rows });
});

router.get('/propietarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(propietariosCarga).where(eq(propietariosCarga.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: row });
});

router.post('/propietarios-carga', async (req: Request, res: Response) => {
  const parsed = propietarioCargaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  try {
    const [row] = await db.insert(propietariosCarga).values({ ...parsed.data, createdBy: req.user?.sub ?? null } as any).returning();
    await audit(req, { action: 'create', resource: 'propietario_carga', resourceId: String(row.id) });
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (err.code === '23505') { res.status(409).json({ error: 'Ya existe propietario de carga con ese documento' }); return; }
    throw err;
  }
});

router.put('/propietarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = propietarioCargaSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [row] = await db.update(propietariosCarga).set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(eq(propietariosCarga.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'propietario_carga', resourceId: String(id) });
  res.json({ data: row });
});

router.delete('/propietarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(propietariosCarga).set({ activo: false, updatedAt: new Date() })
    .where(eq(propietariosCarga.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'delete', resource: 'propietario_carga', resourceId: String(id), detail: 'soft_delete' });
  res.json({ data: row });
});

// =====================================================
// DESTINATARIOS DE CARGA
// =====================================================

const destinatarioCargaSchema = z.object({
  tipoDoc: tipoDocEnum,
  documento: docField,
  nombre: z.string().min(2).max(200),
  direccion: z.string().max(300).optional().nullable(),
  ciudadDane: z.string().length(5).optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  email: z.string().email().max(150).optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
});

router.get('/destinatarios-carga', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const conds: any[] = [eq(destinatariosCarga.activo, true)];
  if (q && q.length >= 2) conds.push(ilike(destinatariosCarga.nombre, `%${q}%`));
  const rows = await db.select().from(destinatariosCarga).where(and(...conds))
    .orderBy(destinatariosCarga.nombre).limit(200);
  res.json({ data: rows });
});

router.get('/destinatarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(destinatariosCarga).where(eq(destinatariosCarga.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: row });
});

router.post('/destinatarios-carga', async (req: Request, res: Response) => {
  const parsed = destinatarioCargaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  try {
    const [row] = await db.insert(destinatariosCarga).values({ ...parsed.data, createdBy: req.user?.sub ?? null } as any).returning();
    await audit(req, { action: 'create', resource: 'destinatario_carga', resourceId: String(row.id) });
    res.status(201).json({ data: row });
  } catch (err: any) {
    if (err.code === '23505') { res.status(409).json({ error: 'Ya existe destinatario con ese documento' }); return; }
    throw err;
  }
});

router.put('/destinatarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = destinatarioCargaSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [row] = await db.update(destinatariosCarga).set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(eq(destinatariosCarga.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'destinatario_carga', resourceId: String(id) });
  res.json({ data: row });
});

router.delete('/destinatarios-carga/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(destinatariosCarga).set({ activo: false, updatedAt: new Date() })
    .where(eq(destinatariosCarga.id, id)).returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'delete', resource: 'destinatario_carga', resourceId: String(id), detail: 'soft_delete' });
  res.json({ data: row });
});

export default router;
