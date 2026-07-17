import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, or, desc, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehicles, vehicleEquipmentLinks } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('fleet'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Lista vinculaciones de un vehículo (como cabezote o como trailer), historial completo.
router.get('/vehicle/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const rows = await db.select().from(vehicleEquipmentLinks)
    .where(or(
      eq(vehicleEquipmentLinks.vehiculoPrincipalId, id),
      eq(vehicleEquipmentLinks.vehiculoVinculadoId, id),
    )!)
    .orderBy(desc(vehicleEquipmentLinks.desde));
  res.json({ data: rows });
});

const createLinkSchema = z.object({
  vehiculoPrincipalId: z.number().int().positive(),
  vehiculoVinculadoId: z.number().int().positive(),
  desde: z.string().datetime().optional(),
  notas: z.string().max(500).optional().nullable(),
}).refine((d) => d.vehiculoPrincipalId !== d.vehiculoVinculadoId, {
  message: 'El cabezote y el trailer no pueden ser el mismo vehículo',
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validación', details: parsed.error.flatten() });
    return;
  }
  const { vehiculoPrincipalId, vehiculoVinculadoId, desde, notas } = parsed.data;

  // Validar que ambos sean flota propia
  const both = await db.select({ id: vehicles.id, esFlota: vehicles.esFlotaPropia })
    .from(vehicles)
    .where(or(eq(vehicles.id, vehiculoPrincipalId), eq(vehicles.id, vehiculoVinculadoId))!);
  if (both.length !== 2 || both.some((v) => !v.esFlota)) {
    res.status(400).json({ error: 'Ambos vehículos deben pertenecer a la flota propia' });
    return;
  }

  // Transacción: cerrar link previo activo del vinculado y crear el nuevo.
  const created = await db.transaction(async (tx) => {
    const closedAt = new Date();
    await tx.update(vehicleEquipmentLinks)
      .set({ esActual: false, hasta: closedAt })
      .where(and(
        eq(vehicleEquipmentLinks.vehiculoVinculadoId, vehiculoVinculadoId),
        eq(vehicleEquipmentLinks.esActual, true),
      ));
    const [row] = await tx.insert(vehicleEquipmentLinks).values({
      vehiculoPrincipalId,
      vehiculoVinculadoId,
      desde: desde ? new Date(desde) : new Date(),
      esActual: true,
      creadoPor: req.user?.sub ?? null,
      notas: notas ?? null,
    } as any).returning();
    return row;
  });

  await audit(req, {
    action: 'create',
    resource: 'fleet_equipment_link',
    resourceId: String(created.id),
    detail: `principal=${vehiculoPrincipalId} vinculado=${vehiculoVinculadoId}`,
  });
  res.status(201).json({ data: created });
});

router.patch('/:id/close', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(vehicleEquipmentLinks)
    .set({ esActual: false, hasta: new Date() })
    .where(and(eq(vehicleEquipmentLinks.id, id), eq(vehicleEquipmentLinks.esActual, true)))
    .returning();
  if (!updated) { res.status(404).json({ error: 'Vínculo no encontrado o ya cerrado' }); return; }
  await audit(req, { action: 'update', resource: 'fleet_equipment_link', resourceId: String(id), detail: 'closed' });
  res.json({ data: updated });
});

export default router;
