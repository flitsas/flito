import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { routes, routeWaypoints } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const CRITICIDADES = ['baja', 'media', 'alta', 'critica'] as const;
const WAYPOINT_TIPOS = ['origen', 'destino', 'parada_segura', 'area_descanso', 'punto_riesgo', 'zona_peligrosa', 'peaje', 'pernocta', 'cargue', 'descargue'] as const;
const numericish = z.union([z.string(), z.number()]).transform((v) => String(v));

const routeCreateSchema = z.object({
  codigo: z.string().min(2).max(30),
  nombre: z.string().min(3).max(200),
  origen: z.string().min(2).max(200),
  destino: z.string().min(2).max(200),
  distanciaKm: numericish.optional().nullable(),
  duracionEstimadaMin: z.number().int().min(0).optional().nullable(),
  criticidad: z.enum(CRITICIDADES).default('media'),
  modoOperacion: z.string().max(50).optional().nullable(),
  vehiculoTipo: z.string().max(50).optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
});

const routeUpdateSchema = routeCreateSchema.partial().extend({
  optimisticV: z.number().int().positive(),
  activo: z.boolean().optional(),
});

const waypointSchema = z.object({
  orden: z.number().int().min(0).max(999),
  tipo: z.enum(WAYPOINT_TIPOS),
  nombre: z.string().min(1).max(200),
  descripcion: z.string().max(2000).optional().nullable(),
  lat: numericish.optional().nullable(),
  lng: numericish.optional().nullable(),
  telefonoContacto: z.string().max(40).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
});

router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const activo = req.query.activo === 'false' ? false : true;
  const rows = await db.select().from(routes)
    .where(eq(routes.activo, activo))
    .orderBy(asc(routes.codigo)).limit(limit).offset(offset);
  res.json({ data: rows, limit, offset });
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [route] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
  if (!route) return res.status(404).json({ error: 'No encontrada' });
  const waypoints = await db.select().from(routeWaypoints).where(eq(routeWaypoints.routeId, id)).orderBy(asc(routeWaypoints.orden));
  res.json({ ...route, waypoints });
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = routeCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;
  try {
    const [row] = await db.insert(routes).values({
      codigo: data.codigo,
      nombre: data.nombre,
      origen: data.origen,
      destino: data.destino,
      distanciaKm: data.distanciaKm ?? null,
      duracionEstimadaMin: data.duracionEstimadaMin ?? null,
      criticidad: data.criticidad,
      modoOperacion: data.modoOperacion ?? null,
      vehiculoTipo: data.vehiculoTipo ?? null,
      notas: data.notas ?? null,
      createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'route', resourceId: String(row.id), detail: data.codigo });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Código de ruta duplicado' });
    throw e;
  }
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = routeUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;

  const [current] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
  if (!current) return res.status(404).json({ error: 'No encontrada' });
  if (current.optimisticV !== data.optimisticV) return res.status(409).json({ error: 'concurrencia' });

  const [row] = await db.update(routes).set({
    ...(data.codigo !== undefined && { codigo: data.codigo }),
    ...(data.nombre !== undefined && { nombre: data.nombre }),
    ...(data.origen !== undefined && { origen: data.origen }),
    ...(data.destino !== undefined && { destino: data.destino }),
    ...(data.distanciaKm !== undefined && { distanciaKm: data.distanciaKm ?? null }),
    ...(data.duracionEstimadaMin !== undefined && { duracionEstimadaMin: data.duracionEstimadaMin ?? null }),
    ...(data.criticidad !== undefined && { criticidad: data.criticidad }),
    ...(data.modoOperacion !== undefined && { modoOperacion: data.modoOperacion ?? null }),
    ...(data.vehiculoTipo !== undefined && { vehiculoTipo: data.vehiculoTipo ?? null }),
    ...(data.notas !== undefined && { notas: data.notas ?? null }),
    ...(data.activo !== undefined && { activo: data.activo }),
    optimisticV: current.optimisticV + 1,
  }).where(eq(routes.id, id)).returning();
  await audit(req, { action: 'update', resource: 'route', resourceId: String(id) });
  res.json(row);
});

// ============ WAYPOINTS ============

router.post('/:id/waypoints', requireRole('admin'), async (req: Request, res: Response) => {
  const routeId = parseInt(req.params.id, 10);
  if (!Number.isFinite(routeId) || routeId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = waypointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(routeWaypoints).values({
      routeId,
      orden: d.orden,
      tipo: d.tipo,
      nombre: d.nombre,
      descripcion: d.descripcion ?? null,
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      telefonoContacto: d.telefonoContacto ?? null,
      observaciones: d.observaciones ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'route_waypoint', resourceId: String(row.id), detail: `${routeId}/${d.tipo}` });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: `Ya hay un waypoint en orden ${d.orden}` });
    if (e?.code === '23503') return res.status(400).json({ error: 'Ruta inexistente' });
    if (e?.code === '23514') return res.status(400).json({ error: 'lat/lng fuera de rango' });
    throw e;
  }
});

router.patch('/waypoints/:wpId', requireRole('admin'), async (req: Request, res: Response) => {
  const wpId = parseInt(req.params.wpId, 10);
  if (!Number.isFinite(wpId) || wpId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = waypointSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.update(routeWaypoints).set({
      ...(d.orden !== undefined && { orden: d.orden }),
      ...(d.tipo !== undefined && { tipo: d.tipo }),
      ...(d.nombre !== undefined && { nombre: d.nombre }),
      ...(d.descripcion !== undefined && { descripcion: d.descripcion ?? null }),
      ...(d.lat !== undefined && { lat: d.lat ?? null }),
      ...(d.lng !== undefined && { lng: d.lng ?? null }),
      ...(d.telefonoContacto !== undefined && { telefonoContacto: d.telefonoContacto ?? null }),
      ...(d.observaciones !== undefined && { observaciones: d.observaciones ?? null }),
    }).where(eq(routeWaypoints.id, wpId)).returning();
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    await audit(req, { action: 'update', resource: 'route_waypoint', resourceId: String(wpId) });
    res.json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'orden duplicado' });
    throw e;
  }
});

router.delete('/waypoints/:wpId', requireRole('admin'), async (req: Request, res: Response) => {
  const wpId = parseInt(req.params.wpId, 10);
  if (!Number.isFinite(wpId) || wpId <= 0) return res.status(400).json({ error: 'id inválido' });
  await db.delete(routeWaypoints).where(eq(routeWaypoints.id, wpId));
  await audit(req, { action: 'delete', resource: 'route_waypoint', resourceId: String(wpId) });
  res.json({ ok: true });
});

router.post('/:id/waypoints/reorder', requireRole('admin'), async (req: Request, res: Response) => {
  const routeId = parseInt(req.params.id, 10);
  if (!Number.isFinite(routeId) || routeId <= 0) return res.status(400).json({ error: 'id inválido' });
  const ordenSchema = z.array(z.object({ id: z.number().int().positive(), orden: z.number().int().min(0).max(999) })).min(1);
  const parsed = ordenSchema.safeParse(req.body?.items);
  if (!parsed.success) return res.status(400).json({ error: 'items requerido [{id, orden}]' });

  await db.transaction(async (tx) => {
    // Advisory lock por ruta para evitar race en reordenamiento concurrente.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'route:' + routeId}))`);
    // Estrategia anti-conflict UNIQUE: dos pasadas — primero a órdenes 1000+id (libre), luego a destino.
    for (const item of parsed.data) {
      await tx.update(routeWaypoints).set({ orden: 1000 + item.id }).where(eq(routeWaypoints.id, item.id));
    }
    for (const item of parsed.data) {
      await tx.update(routeWaypoints).set({ orden: item.orden }).where(eq(routeWaypoints.id, item.id));
    }
  });

  await audit(req, { action: 'update', resource: 'route_waypoints_reorder', resourceId: String(routeId) });
  res.json({ ok: true, count: parsed.data.length });
});

export default router;
