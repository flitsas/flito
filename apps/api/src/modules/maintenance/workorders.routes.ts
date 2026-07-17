import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  workOrders, woJobs, woParts, woSeguimientos, woOtrosGastos,
  vehicles, maintenanceJobs, parts, partsStock, partsMovements,
  vehicleMeasurements, maintenanceSchedule,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { nextWorkOrderNumero } from './preorders.routes.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const vehicleId = req.query.vehicleId ? parseId(String(req.query.vehicleId)) : null;
  const tipo = req.query.tipo as string | undefined;
  const conds: any[] = [];
  if (estado) conds.push(eq(workOrders.estado, estado as any));
  if (vehicleId) conds.push(eq(workOrders.vehicleId, vehicleId));
  if (tipo) conds.push(eq(workOrders.tipoTrabajo, tipo as any));

  const rows = await db.select({
    id: workOrders.id,
    numero: workOrders.numero,
    vehicleId: workOrders.vehicleId,
    plate: vehicles.plate,
    tipoTrabajo: workOrders.tipoTrabajo,
    estado: workOrders.estado,
    fechaIngresoTaller: workOrders.fechaIngresoTaller,
    fechaCierreFinal: workOrders.fechaCierreFinal,
    costoTotalCalculado: workOrders.costoTotalCalculado,
  })
    .from(workOrders)
    .leftJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(workOrders.fechaIngresoTaller))
    .limit(200);
  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
  if (!wo) { res.status(404).json({ error: 'No encontrado' }); return; }
  const [jobs, partsList, gastos, seg] = await Promise.all([
    db.select({
      id: woJobs.id, jobId: woJobs.jobId, mechanicId: woJobs.mechanicId,
      tiempoRealHoras: woJobs.tiempoRealHoras, costoManoObra: woJobs.costoManoObra,
      jobNombre: maintenanceJobs.nombre, jobCodigo: maintenanceJobs.codigo,
    }).from(woJobs).leftJoin(maintenanceJobs, eq(maintenanceJobs.id, woJobs.jobId))
      .where(eq(woJobs.woId, id)),
    db.select({
      id: woParts.id, partId: woParts.partId, cantidad: woParts.cantidad,
      valorUnit: woParts.valorUnit, descuento: woParts.descuento,
      ubicacionId: woParts.ubicacionId, aplicadoStock: woParts.aplicadoStock,
      partNombre: parts.nombre, partCodigo: parts.codigo,
    }).from(woParts).leftJoin(parts, eq(parts.id, woParts.partId))
      .where(eq(woParts.woId, id)),
    db.select().from(woOtrosGastos).where(eq(woOtrosGastos.woId, id)),
    db.select().from(woSeguimientos).where(eq(woSeguimientos.woId, id)).orderBy(desc(woSeguimientos.createdAt)),
  ]);
  res.json({ data: wo, jobs, parts: partsList, otrosGastos: gastos, seguimientos: seg });
});

const createWoSchema = z.object({
  vehicleId: z.number().int().positive(),
  tipoTrabajo: z.enum(['preventivo', 'correctivo', 'predictivo']).default('correctivo'),
  falla: z.string().max(500).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
  routineId: z.number().int().positive().optional().nullable(),
  medicionIngreso: z.number().int().min(0).optional().nullable(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createWoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const numero = await nextWorkOrderNumero();
  const [created] = await db.insert(workOrders).values({
    numero,
    vehicleId: parsed.data.vehicleId,
    tipoTrabajo: parsed.data.tipoTrabajo,
    falla: parsed.data.falla ?? null,
    observaciones: parsed.data.observaciones ?? null,
    routineId: parsed.data.routineId ?? null,
    medicionIngreso: parsed.data.medicionIngreso ?? null,
    estado: 'abierta',
    creadoPor: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'wo_open', resource: 'work_order', resourceId: String(created.id), detail: numero });
  res.status(201).json({ data: created });
});

router.post('/:id/jobs', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({
    jobId: z.number().int().positive(),
    mechanicId: z.number().int().positive().optional().nullable(),
    tiempoRealHoras: z.number().min(0).max(999).optional().nullable(),
    costoManoObra: z.number().min(0).default(0),
    notas: z.string().max(500).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(woJobs).values({
    woId: id,
    jobId: parsed.data.jobId,
    mechanicId: parsed.data.mechanicId ?? null,
    tiempoRealHoras: parsed.data.tiempoRealHoras != null ? String(parsed.data.tiempoRealHoras) : null,
    costoManoObra: String(parsed.data.costoManoObra),
    notas: parsed.data.notas ?? null,
  } as any).returning();
  res.status(201).json({ data: created });
});

router.post('/:id/parts', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({
    partId: z.number().int().positive(),
    cantidad: z.number().positive().max(99_999),
    valorUnit: z.number().min(0).optional().nullable(),
    descuento: z.number().min(0).default(0),
    ubicacionId: z.number().int().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(woParts).values({
    woId: id,
    partId: parsed.data.partId,
    cantidad: String(parsed.data.cantidad),
    valorUnit: parsed.data.valorUnit != null ? String(parsed.data.valorUnit) : null,
    descuento: String(parsed.data.descuento),
    ubicacionId: parsed.data.ubicacionId,
    aplicadoStock: false,
  } as any).returning();
  res.status(201).json({ data: created });
});

router.post('/:id/otros-gastos', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ concepto: z.string().min(1).max(150), monto: z.number().min(0) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(woOtrosGastos).values({
    woId: id, concepto: parsed.data.concepto, monto: String(parsed.data.monto),
  } as any).returning();
  res.status(201).json({ data: created });
});

router.post('/:id/seguimiento', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ texto: z.string().min(1).max(2000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(woSeguimientos).values({
    woId: id, texto: parsed.data.texto, autorId: req.user?.sub ?? null,
  } as any).returning();
  res.status(201).json({ data: created });
});

router.post('/:id/close-tecnica', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(workOrders)
    .set({ estado: 'cerrada_tecnica', fechaCierreTecnica: new Date(), updatedAt: new Date() })
    .where(and(eq(workOrders.id, id), eq(workOrders.estado, 'abierta')))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Solo OT abiertas pueden cerrarse técnicamente' }); return; }
  await audit(req, { action: 'update', resource: 'work_order', resourceId: String(id), detail: 'close_tecnica' });
  res.json({ data: updated });
});

// CIERRE FINAL (CRÍTICO) — transacción atómica:
//   1. SELECT FOR UPDATE en work_order
//   2. Por cada wo_part NO aplicada: lock parts_stock, valida cantidad, inserta movimiento salida
//      (el trigger fn_apply_movement descuenta stock automáticamente)
//   3. Marca wo_parts.aplicado_stock = true
//   4. Suma costos
//   5. Marca schedules pendientes de la rutina como ejecutadas
//   6. Inserta vehicle_measurement con fuente='ot'
//   7. UPDATE wo.estado = cerrada_final + costo_total
// Idempotente: si se reintenta, encuentra estado=cerrada_final → 409 con mismo costo.
// Concurrencia: orden de adquisición de locks por part_id ASC para evitar deadlocks.
router.post('/:id/close-final', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      const [wo] = await tx.execute<any>(sql`SELECT * FROM work_orders WHERE id = ${id} FOR UPDATE`).then((r: any) => r.rows ?? r);
      if (!wo) throw new Error('OT no encontrada');
      if (wo.estado === 'cerrada_final') {
        return { wo, idempotente: true };
      }
      if (wo.estado !== 'abierta' && wo.estado !== 'cerrada_tecnica') {
        throw new Error(`Estado ${wo.estado} no permite cierre final`);
      }

      // Carga partes pendientes ordenadas por part_id ASC (evita deadlocks).
      const pendientes = await tx.select().from(woParts)
        .where(and(eq(woParts.woId, id), eq(woParts.aplicadoStock, false)))
        .orderBy(woParts.partId);

      // Carga jobs y otros gastos para cálculo de costo total.
      const jobs = await tx.select().from(woJobs).where(eq(woJobs.woId, id));
      const otros = await tx.select().from(woOtrosGastos).where(eq(woOtrosGastos.woId, id));

      let costoMO = 0;
      for (const j of jobs) costoMO += Number(j.costoManoObra ?? 0);
      let costoOtros = 0;
      for (const g of otros) costoOtros += Number(g.monto ?? 0);

      let costoRep = 0;
      for (const p of pendientes) {
        if (!p.ubicacionId) throw new Error(`Repuesto wo_parts.id=${p.id} sin ubicación`);
        // Lock pesimista de la fila de stock.
        const stockRows = await tx.execute<any>(sql`
          SELECT cantidad FROM parts_stock
           WHERE part_id = ${p.partId} AND location_id = ${p.ubicacionId}
           FOR UPDATE
        `);
        const stockRow = ((stockRows as any).rows ?? stockRows as any[])[0];
        const stockActual = Number(stockRow?.cantidad ?? 0);
        const requerido = Number(p.cantidad);
        if (stockActual < requerido) {
          throw new Error(`Stock insuficiente para part_id=${p.partId} ubic=${p.ubicacionId}: requiere ${requerido}, hay ${stockActual}`);
        }

        // Si valorUnit no se definió, usa valor_promedio actual del repuesto.
        let valorUnit = p.valorUnit != null ? Number(p.valorUnit) : 0;
        if (!p.valorUnit) {
          const [partRow] = await tx.select({ valorPromedio: parts.valorPromedio }).from(parts).where(eq(parts.id, p.partId));
          valorUnit = Number(partRow?.valorPromedio ?? 0);
          await tx.update(woParts).set({ valorUnit: String(valorUnit) }).where(eq(woParts.id, p.id));
        }
        const linea = requerido * valorUnit - Number(p.descuento ?? 0);
        costoRep += linea;

        // Inserta movimiento salida — el trigger fn_apply_movement descuenta parts_stock.
        await tx.insert(partsMovements).values({
          tipo: 'salida',
          partId: p.partId,
          cantidad: String(requerido),
          valorUnit: String(valorUnit),
          ubicacionOrigenId: p.ubicacionId,
          woId: id,
          observaciones: `Cierre OT ${wo.numero}`,
          usuarioId: req.user?.sub ?? null,
        } as any);

        await tx.update(woParts).set({ aplicadoStock: true }).where(eq(woParts.id, p.id));
      }

      const costoTotal = costoMO + costoRep + costoOtros;

      // Marca schedules pendientes asociados a esta rutina (si la OT vino de una).
      if (wo.routine_id) {
        await tx.update(maintenanceSchedule)
          .set({ estado: 'ejecutada', woId: id, updatedAt: new Date() })
          .where(and(
            eq(maintenanceSchedule.vehicleId, wo.vehicle_id),
            eq(maintenanceSchedule.routineId, wo.routine_id),
            eq(maintenanceSchedule.estado, 'pendiente'),
          ));
      }

      // Registra medición si tenemos medicion_ingreso (representa el odómetro al ingresar al taller).
      if (wo.medicion_ingreso) {
        await tx.insert(vehicleMeasurements).values({
          vehicleId: wo.vehicle_id,
          fecha: new Date().toISOString().slice(0, 10),
          odometro: wo.medicion_ingreso,
          fuente: 'ot',
          usuarioId: req.user?.sub ?? null,
          nota: `Cierre OT ${wo.numero}`,
        } as any);
      }

      const [updated] = await tx.update(workOrders).set({
        estado: 'cerrada_final',
        fechaCierreFinal: new Date(),
        costoTotalCalculado: String(costoTotal),
        updatedAt: new Date(),
      }).where(eq(workOrders.id, id)).returning();

      return { wo: updated, costoTotal, idempotente: false };
    });

    if (!result.idempotente) {
      await audit(req, {
        action: 'wo_close',
        resource: 'work_order',
        resourceId: String(id),
        detail: `costo=${result.costoTotal}`,
      });
    }
    res.json({ data: result.wo, idempotente: result.idempotente });
  } catch (err: any) {
    if (err?.message?.includes('Stock insuficiente') || err?.message?.includes('sin ubicación')) {
      res.status(422).json({ error: err.message });
      return;
    }
    if (err?.message?.includes('no permite cierre') || err?.message?.includes('no encontrada')) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post('/:id/anular', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(workOrders)
    .set({ estado: 'anulada', updatedAt: new Date() })
    .where(and(eq(workOrders.id, id), inArray(workOrders.estado, ['abierta', 'cerrada_tecnica'])))
    .returning();
  if (!updated) { res.status(409).json({ error: 'No se puede anular una OT cerrada o ya anulada' }); return; }
  await audit(req, { action: 'update', resource: 'work_order', resourceId: String(id), detail: 'anulada' });
  res.json({ data: updated });
});

export default router;
