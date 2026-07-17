import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, ilike, and, or, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehicles, vehicleMeasurements, vehicleEquipmentLinks } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();

router.use(authMiddleware, requirePage('fleet'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const fleetVehicleSchema = z.object({
  vin: z.string().max(17).optional().nullable(),
  plate: z.string().max(10).optional().nullable(),
  alias: z.string().max(80).optional().nullable(),
  brand: z.string().max(50).optional().nullable(),
  model: z.string().max(50).optional().nullable(),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  vehicleClass: z.string().max(50).optional().nullable(),
  color: z.string().max(30).optional().nullable(),
  tipoVehiculo: z.enum(['tractomula', 'camion', 'buseta', 'camioneta', 'automovil', 'motocicleta', 'otro']).optional().nullable(),
  tipoMedicion: z.enum(['km', 'horas', 'ambos']).default('km'),
  medicionPrincipal: z.enum(['km', 'horas']).default('km'),
  tipoTrabajo: z.enum(['bajo', 'normal', 'severo']).default('normal'),
  combustiblePrincipal: z.enum(['acpm', 'gasolina', 'gas', 'electrico', 'hibrido']).optional().nullable(),
  combustibleSecundario: z.enum(['acpm', 'gasolina', 'gas', 'electrico', 'hibrido']).optional().nullable(),
  numMotor: z.string().max(50).optional().nullable(),
  numSerie: z.string().max(50).optional().nullable(),
  fechaCompra: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  precioCompra: z.number().min(0).max(99_999_999_999).optional().nullable(),
  distMax24h: z.number().int().min(0).max(10_000).optional().nullable(),
  distPromedioDia: z.number().int().min(0).max(10_000).optional().nullable(),
  horasOpMes: z.number().int().min(0).max(744).optional().nullable(),
  rendimientoIdeal: z.number().min(0).max(9999).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const updateSchema = fleetVehicleSchema.partial();

// Listar flota propia. NO mezcla con vehículos de tránsito.
router.get('/', async (req: Request, res: Response) => {
  const search = req.query.search ? (req.query.search as string).slice(0, 100) : undefined;
  const tipo = req.query.tipo as string | undefined;
  const combustible = req.query.combustible as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  const conditions = [eq(vehicles.esFlotaPropia, true)];
  if (search) {
    conditions.push(or(
      ilike(vehicles.plate, `%${search}%`),
      ilike(vehicles.alias, `%${search}%`),
      ilike(vehicles.brand, `%${search}%`),
      ilike(vehicles.model, `%${search}%`),
    )!);
  }
  if (tipo) conditions.push(eq(vehicles.tipoVehiculo, tipo as any));
  if (combustible) conditions.push(eq(vehicles.combustiblePrincipal, combustible as any));

  const rows = await db.select({
    id: vehicles.id,
    plate: vehicles.plate,
    alias: vehicles.alias,
    brand: vehicles.brand,
    model: vehicles.model,
    year: vehicles.year,
    color: vehicles.color,
    tipoVehiculo: vehicles.tipoVehiculo,
    tipoMedicion: vehicles.tipoMedicion,
    medicionPrincipal: vehicles.medicionPrincipal,
    combustiblePrincipal: vehicles.combustiblePrincipal,
    distPromedioDia: vehicles.distPromedioDia,
    rendimientoIdeal: vehicles.rendimientoIdeal,
    createdAt: vehicles.createdAt,
  })
    .from(vehicles)
    .where(and(...conditions))
    .orderBy(desc(vehicles.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [vehicle] = await db.select().from(vehicles)
    .where(and(eq(vehicles.id, id), eq(vehicles.esFlotaPropia, true)))
    .limit(1);
  if (!vehicle) { res.status(404).json({ error: 'Vehículo no encontrado' }); return; }

  // Última medición y conteo (para mostrar en cabecera)
  const [lastMeas] = await db.select({
    fecha: vehicleMeasurements.fecha,
    odometro: vehicleMeasurements.odometro,
    horometro: vehicleMeasurements.horometro,
  })
    .from(vehicleMeasurements)
    .where(eq(vehicleMeasurements.vehicleId, id))
    .orderBy(desc(vehicleMeasurements.fecha), desc(vehicleMeasurements.id))
    .limit(1);

  // Vinculaciones activas: este vehículo como cabezote o como trailer
  const linksAsPrincipal = await db.select().from(vehicleEquipmentLinks)
    .where(and(eq(vehicleEquipmentLinks.vehiculoPrincipalId, id), eq(vehicleEquipmentLinks.esActual, true)));
  const linksAsVinculado = await db.select().from(vehicleEquipmentLinks)
    .where(and(eq(vehicleEquipmentLinks.vehiculoVinculadoId, id), eq(vehicleEquipmentLinks.esActual, true)));

  res.json({
    data: vehicle,
    lastMeasurement: lastMeas ?? null,
    linksAsPrincipal,
    linksAsVinculado,
  });
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = fleetVehicleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validación', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  // VIN único si se provee
  if (data.vin) {
    const [exists] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, data.vin)).limit(1);
    if (exists) { res.status(409).json({ error: 'Ya existe un vehículo con ese VIN' }); return; }
  }
  const [created] = await db.insert(vehicles).values({
    ...data,
    esFlotaPropia: true,
    stage: 'listo',
  } as any).returning();
  await audit(req, { action: 'create', resource: 'fleet_vehicle', resourceId: String(created.id), detail: created.plate ?? undefined });
  res.status(201).json({ data: created });
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validación', details: parsed.error.flatten() });
    return;
  }
  const [updated] = await db.update(vehicles)
    .set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(and(eq(vehicles.id, id), eq(vehicles.esFlotaPropia, true)))
    .returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'fleet_vehicle', resourceId: String(id), detail: JSON.stringify(parsed.data).slice(0, 400) });
  res.json({ data: updated });
});

// Promueve un vehículo de tránsito a flota propia (caso: FLIT compra un vehículo del pipeline).
router.post('/:id/convert', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(vehicles)
    .set({ esFlotaPropia: true, updatedAt: new Date() })
    .where(eq(vehicles.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'fleet_vehicle', resourceId: String(id), detail: 'converted_to_fleet' });
  res.json({ data: updated });
});

export default router;
