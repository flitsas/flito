import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  preOrders, preOrderJobs, preOrderParts,
  workOrders, woJobs, woParts,
  vehicles, maintenanceJobs, parts,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Numeración: PO-YYYYMM-NNNN. Cuenta cuántas hay este mes y le suma 1.
async function nextPreOrderNumero(): Promise<string> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const r = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM pre_orders
    WHERE numero LIKE ${`PO-${yyyymm}-%`}
  `);
  const rows = (r as any).rows ?? r as any[];
  const seq = (rows[0]?.count ?? 0) + 1;
  return `PO-${yyyymm}-${String(seq).padStart(4, '0')}`;
}

async function nextWorkOrderNumero(): Promise<string> {
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const r = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM work_orders
    WHERE numero LIKE ${`OT-${yyyymm}-%`}
  `);
  const rows = (r as any).rows ?? r as any[];
  const seq = (rows[0]?.count ?? 0) + 1;
  return `OT-${yyyymm}-${String(seq).padStart(4, '0')}`;
}

router.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const vehicleId = req.query.vehicleId ? parseId(String(req.query.vehicleId)) : null;
  const conds: any[] = [];
  if (estado) conds.push(eq(preOrders.estado, estado as any));
  if (vehicleId) conds.push(eq(preOrders.vehicleId, vehicleId));
  const rows = await db.select({
    id: preOrders.id,
    numero: preOrders.numero,
    vehicleId: preOrders.vehicleId,
    plate: vehicles.plate,
    fecha: preOrders.fecha,
    estado: preOrders.estado,
    observaciones: preOrders.observaciones,
    createdAt: preOrders.createdAt,
  })
    .from(preOrders)
    .leftJoin(vehicles, eq(vehicles.id, preOrders.vehicleId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(preOrders.fecha), desc(preOrders.id))
    .limit(200);
  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [po] = await db.select().from(preOrders).where(eq(preOrders.id, id)).limit(1);
  if (!po) { res.status(404).json({ error: 'No encontrado' }); return; }
  const [jobs, partsList] = await Promise.all([
    db.select({
      jobId: preOrderJobs.jobId, costoEstimado: preOrderJobs.costoEstimado,
      jobNombre: maintenanceJobs.nombre, jobCodigo: maintenanceJobs.codigo,
    }).from(preOrderJobs).leftJoin(maintenanceJobs, eq(maintenanceJobs.id, preOrderJobs.jobId))
      .where(eq(preOrderJobs.preOrderId, id)),
    db.select({
      partId: preOrderParts.partId, cantidad: preOrderParts.cantidad, costoEstimado: preOrderParts.costoEstimado,
      partNombre: parts.nombre, partCodigo: parts.codigo,
    }).from(preOrderParts).leftJoin(parts, eq(parts.id, preOrderParts.partId))
      .where(eq(preOrderParts.preOrderId, id)),
  ]);
  res.json({ data: po, jobs, parts: partsList });
});

const createSchema = z.object({
  vehicleId: z.number().int().positive(),
  observaciones: z.string().max(2000).optional().nullable(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const numero = await nextPreOrderNumero();
  const [created] = await db.insert(preOrders).values({
    numero,
    vehicleId: parsed.data.vehicleId,
    observaciones: parsed.data.observaciones ?? null,
    creadoPor: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'pre_order', resourceId: String(created.id), detail: numero });
  res.status(201).json({ data: created });
});

router.post('/:id/jobs', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ jobId: z.number().int().positive(), costoEstimado: z.number().min(0).default(0) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  await db.insert(preOrderJobs).values({
    preOrderId: id, jobId: parsed.data.jobId, costoEstimado: String(parsed.data.costoEstimado),
  }).onConflictDoUpdate({
    target: [preOrderJobs.preOrderId, preOrderJobs.jobId],
    set: { costoEstimado: String(parsed.data.costoEstimado) },
  });
  res.status(201).json({ ok: true });
});

router.post('/:id/parts', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({
    partId: z.number().int().positive(),
    cantidad: z.number().positive().max(99_999),
    costoEstimado: z.number().min(0).default(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  await db.insert(preOrderParts).values({
    preOrderId: id, partId: parsed.data.partId,
    cantidad: String(parsed.data.cantidad), costoEstimado: String(parsed.data.costoEstimado),
  }).onConflictDoUpdate({
    target: [preOrderParts.preOrderId, preOrderParts.partId],
    set: { cantidad: String(parsed.data.cantidad), costoEstimado: String(parsed.data.costoEstimado) },
  });
  res.status(201).json({ ok: true });
});

router.post('/:id/approve', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(preOrders)
    .set({ estado: 'aprobada', aprobadoPor: req.user?.sub ?? null, updatedAt: new Date() })
    .where(and(eq(preOrders.id, id), eq(preOrders.estado, 'borrador')))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Solo borradores pueden aprobarse' }); return; }
  await audit(req, { action: 'update', resource: 'pre_order', resourceId: String(id), detail: 'approved' });
  res.json({ data: updated });
});

// Genera OT desde una preorden aprobada. Copia jobs y parts. NO descuenta inventario.
router.post('/:id/generate-ot', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const numeroOt = await nextWorkOrderNumero();
  try {
    const wo = await db.transaction(async (tx) => {
      const [po] = await tx.select().from(preOrders).where(eq(preOrders.id, id)).limit(1);
      if (!po) throw new Error('Preorden no encontrada');
      if (po.estado !== 'aprobada') throw new Error('Solo preordenes aprobadas pueden generar OT');

      const [createdWo] = await tx.insert(workOrders).values({
        numero: numeroOt,
        vehicleId: po.vehicleId,
        preOrderId: po.id,
        tipoTrabajo: 'preventivo',
        estado: 'abierta',
        observaciones: po.observaciones,
        creadoPor: req.user?.sub ?? null,
      } as any).returning();

      const poJobs = await tx.select().from(preOrderJobs).where(eq(preOrderJobs.preOrderId, id));
      for (const j of poJobs) {
        await tx.insert(woJobs).values({
          woId: createdWo.id, jobId: j.jobId, costoManoObra: j.costoEstimado,
        } as any);
      }
      const poParts = await tx.select().from(preOrderParts).where(eq(preOrderParts.preOrderId, id));
      for (const p of poParts) {
        await tx.insert(woParts).values({
          woId: createdWo.id, partId: p.partId, cantidad: p.cantidad,
          valorUnit: null, descuento: '0', aplicadoStock: false,
        } as any);
      }

      await tx.update(preOrders).set({ estado: 'generada_ot', updatedAt: new Date() }).where(eq(preOrders.id, id));
      return createdWo;
    });

    await audit(req, { action: 'create', resource: 'work_order', resourceId: String(wo.id), detail: `from_po=${id}` });
    res.status(201).json({ data: wo });
  } catch (err: any) {
    res.status(409).json({ error: err.message ?? 'No se pudo generar la OT' });
  }
});

export { router as default, nextWorkOrderNumero };
