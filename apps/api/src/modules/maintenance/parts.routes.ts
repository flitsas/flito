import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, asc, desc, sql, gte, lte, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { parts, partsLocations, partsStock, partsMovements } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ------ Ubicaciones ------

router.get('/locations', async (_req, res: Response) => {
  const rows = await db.select().from(partsLocations).where(eq(partsLocations.activo, true)).orderBy(asc(partsLocations.codigo));
  res.json({ data: rows });
});

router.post('/locations', requireRole('admin'), async (req: Request, res: Response) => {
  const schema = z.object({
    codigo: z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/),
    nombre: z.string().min(1).max(80),
    bodega: z.string().max(80).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(partsLocations).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'parts_location', resourceId: String(created.id) });
  res.status(201).json({ data: created });
});

// ------ Repuestos ------

router.get('/', async (req: Request, res: Response) => {
  const q = req.query.q ? String(req.query.q).slice(0, 100) : null;
  const systemId = req.query.systemId ? parseId(String(req.query.systemId)) : null;
  const conStockBajo = req.query.conStockBajo === '1';

  const conds = [eq(parts.activo, true)];
  if (q) conds.push(or(ilike(parts.nombre, `%${q}%`), ilike(parts.codigo, `%${q}%`))!);
  if (systemId) conds.push(eq(parts.systemId, systemId));

  const rows = await db.select({
    id: parts.id,
    codigo: parts.codigo,
    nombre: parts.nombre,
    unidadMedida: parts.unidadMedida,
    inventariable: parts.inventariable,
    existenciaMin: parts.existenciaMin,
    existenciaMax: parts.existenciaMax,
    valorPromedio: parts.valorPromedio,
    systemId: parts.systemId,
    stockTotal: sql<string>`COALESCE((SELECT SUM(cantidad) FROM parts_stock WHERE part_id = ${parts.id}), 0)`,
  })
    .from(parts)
    .where(and(...conds))
    .orderBy(asc(parts.nombre))
    .limit(200);

  const filtered = conStockBajo
    ? rows.filter((r) => Number(r.stockTotal) < Number(r.existenciaMin))
    : rows;

  res.json({ data: filtered });
});

const partBaseSchema = z.object({
  codigo: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/),
  nombre: z.string().min(1).max(150),
  unidadMedida: z.enum(['und', 'lt', 'gal', 'kg', 'mt', 'cm']).default('und'),
  inventariable: z.boolean().default(true),
  existenciaMin: z.number().min(0).max(99_999_999).default(0),
  existenciaMax: z.number().min(0).max(99_999_999).optional().nullable(),
  systemId: z.number().int().positive().optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
});

const partSchema = partBaseSchema.refine(
  (d) => d.existenciaMax == null || d.existenciaMax >= d.existenciaMin,
  { message: 'existenciaMax debe ser >= existenciaMin', path: ['existenciaMax'] },
);

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = partSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data as any;
  const [created] = await db.insert(parts).values({
    ...data,
    existenciaMin: String(data.existenciaMin ?? 0),
    existenciaMax: data.existenciaMax != null ? String(data.existenciaMax) : null,
  }).returning();
  await audit(req, { action: 'create', resource: 'part', resourceId: String(created.id), detail: created.codigo });
  res.status(201).json({ data: created });
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = partBaseSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data: any = { ...parsed.data, updatedAt: new Date() };
  if (data.existenciaMin != null) data.existenciaMin = String(data.existenciaMin);
  if (data.existenciaMax != null) data.existenciaMax = String(data.existenciaMax);
  const [updated] = await db.update(parts).set(data).where(eq(parts.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'part', resourceId: String(id) });
  res.json({ data: updated });
});

router.get('/:id/stock', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const rows = await db.select({
    locationId: partsStock.locationId,
    locationCodigo: partsLocations.codigo,
    locationNombre: partsLocations.nombre,
    cantidad: partsStock.cantidad,
    updatedAt: partsStock.updatedAt,
  })
    .from(partsStock)
    .leftJoin(partsLocations, eq(partsLocations.id, partsStock.locationId))
    .where(eq(partsStock.partId, id))
    .orderBy(asc(partsLocations.codigo));
  res.json({ data: rows });
});

// ------ Movimientos ------

router.get('/movements', async (req: Request, res: Response) => {
  const partId = req.query.partId ? parseId(String(req.query.partId)) : null;
  const tipo = req.query.tipo as string | undefined;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;

  const conds: any[] = [];
  if (partId) conds.push(eq(partsMovements.partId, partId));
  if (tipo) conds.push(eq(partsMovements.tipo, tipo as any));
  if (desde) conds.push(gte(partsMovements.fecha, desde));
  if (hasta) conds.push(lte(partsMovements.fecha, hasta));

  const rows = await db.select().from(partsMovements)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(partsMovements.fecha), desc(partsMovements.id))
    .limit(500);
  res.json({ data: rows });
});

const movementSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tipo: z.enum(['entrada', 'salida', 'traslado', 'ajuste']),
  partId: z.number().int().positive(),
  cantidad: z.number().positive().max(99_999_999),
  valorUnit: z.number().min(0).max(99_999_999_999).optional().nullable(),
  ubicacionOrigenId: z.number().int().positive().optional().nullable(),
  ubicacionDestinoId: z.number().int().positive().optional().nullable(),
  factura: z.string().max(50).optional().nullable(),
  remision: z.string().max(50).optional().nullable(),
  observaciones: z.string().max(500).optional().nullable(),
}).refine((d) => {
  if (d.tipo === 'entrada') return !!d.ubicacionDestinoId && d.valorUnit != null;
  if (d.tipo === 'salida') return !!d.ubicacionOrigenId;
  if (d.tipo === 'traslado') return !!d.ubicacionOrigenId && !!d.ubicacionDestinoId && d.ubicacionOrigenId !== d.ubicacionDestinoId;
  if (d.tipo === 'ajuste') return !!d.ubicacionDestinoId;
  return true;
}, { message: 'Combinación de ubicaciones inválida para el tipo de movimiento' });

router.post('/movements', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = movementSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  try {
    const [created] = await db.insert(partsMovements).values({
      fecha: data.fecha ?? new Date().toISOString().slice(0, 10),
      tipo: data.tipo as any,
      partId: data.partId,
      cantidad: String(data.cantidad),
      valorUnit: data.valorUnit != null ? String(data.valorUnit) : null,
      ubicacionOrigenId: data.ubicacionOrigenId ?? null,
      ubicacionDestinoId: data.ubicacionDestinoId ?? null,
      factura: data.factura ?? null,
      remision: data.remision ?? null,
      observaciones: data.observaciones ?? null,
      usuarioId: req.user?.sub ?? null,
    } as any).returning();
    // El trigger fn_apply_movement actualiza parts_stock y valor_promedio automáticamente.
    await audit(req, {
      action: 'create',
      resource: 'parts_movement',
      resourceId: String(created.id),
      detail: `${data.tipo} part=${data.partId} q=${data.cantidad}`,
    });
    res.status(201).json({ data: created });
  } catch (err: any) {
    // El trigger lanza RAISE EXCEPTION (PostgreSQL code P0001) si no hay stock.
    // También capturamos check_violation (23514) por si pasara una combinación inválida.
    if (err?.code === 'P0001' || err?.code === '23514') {
      res.status(422).json({ error: err.message ?? 'Inventario insuficiente o combinación inválida' });
      return;
    }
    throw err;
  }
});

export default router;
