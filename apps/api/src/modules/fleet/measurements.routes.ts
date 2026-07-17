import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehicles, vehicleMeasurements } from '../../db/schema.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('fleet'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get('/vehicle/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  const rows = await db.select().from(vehicleMeasurements)
    .where(eq(vehicleMeasurements.vehicleId, id))
    .orderBy(desc(vehicleMeasurements.fecha), desc(vehicleMeasurements.id))
    .limit(limit)
    .offset(offset);
  res.json({ data: rows });
});

const createSchema = z.object({
  vehicleId: z.number().int().positive(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  odometro: z.number().int().min(0).max(99_999_999).optional(),
  horometro: z.number().int().min(0).max(9_999_999).optional(),
  fuente: z.enum(['manual', 'app', 'gps', 'combustible', 'ot']).default('manual'),
  nota: z.string().max(500).optional().nullable(),
}).refine((d) => d.odometro !== undefined || d.horometro !== undefined, {
  message: 'Debe registrar al menos odómetro u horómetro',
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validación', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  // Validar que el vehículo sea flota propia
  const [vehicle] = await db.select({
    id: vehicles.id,
    tipoMedicion: vehicles.tipoMedicion,
    distPromedioDia: vehicles.distPromedioDia,
    esFlotaPropia: vehicles.esFlotaPropia,
  }).from(vehicles).where(eq(vehicles.id, data.vehicleId)).limit(1);
  if (!vehicle || !vehicle.esFlotaPropia) {
    res.status(404).json({ error: 'Vehículo de flota no encontrado' });
    return;
  }

  // Coherencia con tipoMedicion del vehículo
  if (vehicle.tipoMedicion === 'km' && data.odometro === undefined) {
    res.status(400).json({ error: 'Este vehículo requiere odómetro' });
    return;
  }
  if (vehicle.tipoMedicion === 'horas' && data.horometro === undefined) {
    res.status(400).json({ error: 'Este vehículo requiere horómetro' });
    return;
  }

  // Buscar última medición para validar monotonía y excedio_promedio
  const [last] = await db.select({
    fecha: vehicleMeasurements.fecha,
    odometro: vehicleMeasurements.odometro,
    horometro: vehicleMeasurements.horometro,
  }).from(vehicleMeasurements)
    .where(eq(vehicleMeasurements.vehicleId, data.vehicleId))
    .orderBy(desc(vehicleMeasurements.fecha), desc(vehicleMeasurements.id))
    .limit(1);

  let excedio = false;
  const warnings: string[] = [];
  if (last) {
    if (data.odometro !== undefined && last.odometro !== null && data.odometro < last.odometro) {
      warnings.push(`Odómetro ingresado (${data.odometro}) es menor al último registrado (${last.odometro})`);
    }
    if (data.horometro !== undefined && last.horometro !== null && data.horometro < last.horometro) {
      warnings.push(`Horómetro ingresado (${data.horometro}) es menor al último registrado (${last.horometro})`);
    }
    // Detección de excedio de promedio (>3x distPromedioDia)
    if (vehicle.distPromedioDia && data.odometro !== undefined && last.odometro !== null) {
      const fechaNueva = new Date(data.fecha ?? new Date().toISOString().slice(0, 10));
      const fechaUltima = new Date(last.fecha as any);
      const dias = Math.max(1, Math.round((fechaNueva.getTime() - fechaUltima.getTime()) / 86_400_000));
      const diff = data.odometro - last.odometro;
      if (diff > vehicle.distPromedioDia * dias * 3) {
        excedio = true;
        warnings.push(`Diferencia ${diff} km en ${dias} días excede 3x el promedio diario (${vehicle.distPromedioDia})`);
      }
    }
  }

  const [created] = await db.insert(vehicleMeasurements).values({
    vehicleId: data.vehicleId,
    fecha: data.fecha ?? new Date().toISOString().slice(0, 10),
    odometro: data.odometro ?? null,
    horometro: data.horometro ?? null,
    fuente: data.fuente,
    usuarioId: req.user?.sub ?? null,
    nota: data.nota ?? null,
    excedioPromedio: excedio,
  } as any).returning();

  await audit(req, {
    action: 'create',
    resource: 'fleet_measurement',
    resourceId: String(created.id),
    detail: `vehicle=${data.vehicleId} odo=${data.odometro ?? '-'} horo=${data.horometro ?? '-'}`,
  });
  res.status(201).json({ data: created, warnings });
});

export default router;
