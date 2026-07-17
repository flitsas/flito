import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, sql, isNull, desc, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { routePernoctaZones, routeAssignments } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const numericish = z.union([z.string(), z.number()]).transform((v) => String(v));

const pernoctaSchema = z.object({
  nombre: z.string().min(3).max(200),
  routeId: z.number().int().positive().optional().nullable(),
  lat: numericish.optional().nullable(),
  lng: numericish.optional().nullable(),
  capacidad: z.number().int().min(0).optional().nullable(),
  contacto: z.string().max(150).optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  protocoloMd: z.string().max(10000).optional().nullable(),
  servicios: z.array(z.string().max(50)).default([]),
});

const assignmentSchema = z.object({
  routeId: z.number().int().positive(),
  remesaId: z.number().int().positive().optional().nullable(),
  manifiestoId: z.number().int().positive().optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
}).refine(
  (d) => (!!d.remesaId) !== (!!d.manifiestoId),
  { message: 'Debe especificar SOLO remesaId O manifiestoId (no ambos, no ninguno)' }
);

// ============ PERNOCTA ============

router.get('/pernocta', async (req, res) => {
  const vigente = req.query.vigente === 'false' ? false : true;
  const rows = await db.select().from(routePernoctaZones).where(eq(routePernoctaZones.vigente, vigente)).orderBy(asc(routePernoctaZones.nombre));
  res.json({ data: rows });
});

router.get('/pernocta/cercanas', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radioKm = Math.min(parseFloat(req.query.radioKm as string) || 50, 500);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng requeridos' });
  // Haversine en SQL — aproximación esférica.
  const rows = await db.execute(sql`
    SELECT id, nombre, lat, lng, capacidad, contacto, telefono, servicios,
           (6371 * acos(
             cos(radians(${lat})) * cos(radians(lat::float)) * cos(radians(lng::float) - radians(${lng}))
             + sin(radians(${lat})) * sin(radians(lat::float))
           )) AS distancia_km
    FROM route_pernocta_zones
    WHERE vigente = true AND lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY distancia_km ASC
    LIMIT 20
  ` as any) as any;
  const all = (rows?.rows ?? rows ?? []) as any[];
  res.json({ data: all.filter((r: any) => Number(r.distancia_km) <= radioKm) });
});

router.post('/pernocta', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = pernoctaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(routePernoctaZones).values({
      nombre: d.nombre,
      routeId: d.routeId ?? null,
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      capacidad: d.capacidad ?? null,
      contacto: d.contacto ?? null,
      telefono: d.telefono ?? null,
      protocoloMd: d.protocoloMd ?? null,
      servicios: d.servicios,
      createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'route_pernocta', resourceId: String(row.id) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23514') return res.status(400).json({ error: 'lat/lng fuera de rango' });
    throw e;
  }
});

router.patch('/pernocta/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = pernoctaSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const [row] = await db.update(routePernoctaZones).set({
    ...(d.nombre !== undefined && { nombre: d.nombre }),
    ...(d.routeId !== undefined && { routeId: d.routeId ?? null }),
    ...(d.lat !== undefined && { lat: d.lat ?? null }),
    ...(d.lng !== undefined && { lng: d.lng ?? null }),
    ...(d.capacidad !== undefined && { capacidad: d.capacidad ?? null }),
    ...(d.contacto !== undefined && { contacto: d.contacto ?? null }),
    ...(d.telefono !== undefined && { telefono: d.telefono ?? null }),
    ...(d.protocoloMd !== undefined && { protocoloMd: d.protocoloMd ?? null }),
    ...(d.servicios !== undefined && { servicios: d.servicios }),
  }).where(eq(routePernoctaZones.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  await audit(req, { action: 'update', resource: 'route_pernocta', resourceId: String(id) });
  res.json(row);
});

router.delete('/pernocta/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  // Soft archive: vigente=false (preservación histórica).
  const [row] = await db.update(routePernoctaZones).set({ vigente: false }).where(eq(routePernoctaZones.id, id)).returning();
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  await audit(req, { action: 'delete', resource: 'route_pernocta', resourceId: String(id), detail: 'archivado' });
  res.json({ ok: true });
});

// ============ ASSIGNMENTS ============

router.get('/assignments', async (req, res) => {
  const routeId = req.query.routeId ? parseInt(req.query.routeId as string, 10) : undefined;
  const conds: any[] = [];
  if (routeId) conds.push(eq(routeAssignments.routeId, routeId));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(routeAssignments).where(where).orderBy(desc(routeAssignments.asignadoAt)).limit(200);
  res.json({ data: rows });
});

router.post('/assignments', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(routeAssignments).values({
      routeId: d.routeId,
      remesaId: d.remesaId ?? null,
      manifiestoId: d.manifiestoId ?? null,
      asignadoPor: req.user!.sub,
      notas: d.notas ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'route_assignment', resourceId: String(row.id) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Remesa/manifiesto ya tiene ruta asignada' });
    if (e?.code === '23503') return res.status(400).json({ error: 'Ruta/remesa/manifiesto inexistente' });
    if (e?.code === '23514') return res.status(400).json({ error: 'Debe especificar remesaId XOR manifiestoId' });
    throw e;
  }
});

router.delete('/assignments/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  await db.delete(routeAssignments).where(eq(routeAssignments.id, id));
  await audit(req, { action: 'delete', resource: 'route_assignment', resourceId: String(id) });
  res.json({ ok: true });
});

export default router;
