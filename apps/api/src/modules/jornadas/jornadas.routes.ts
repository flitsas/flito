import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte, isNull, sql, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  jornadasConductor, jornadasPausas, jornadasAlarmas, jornadasReportesMensuales,
  jornadasIdempotencyKeys, users,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { JORNADA_LIMITS, computarAlarmasCierre } from './limits.js';
import { notifyJornadaAlarmas } from './notify.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const abrirSchema = z.object({
  vehicleId: z.number().int().positive().optional().nullable(),
  checklistId: z.number().int().positive().optional().nullable(),
  inicioAt: z.string().datetime().optional(),
  conductorId: z.number().int().positive().optional(), // admin abre por conductor; conductor abre por sí mismo
});

const cerrarSchema = z.object({
  finAt: z.string().datetime().optional(),
  observaciones: z.string().max(2000).optional().nullable(),
});

const pausaAbrirSchema = z.object({
  motivo: z.enum(['descanso', 'comida', 'combustible', 'cargue_descargue', 'otro']).default('descanso'),
  inicioAt: z.string().datetime().optional(),
});

const pausaCerrarSchema = z.object({
  finAt: z.string().datetime().optional(),
});

// ============ ABRIR JORNADA ============

router.post('/abrir', async (req: Request, res: Response) => {
  const idempKey = req.header('Idempotency-Key');
  if (!idempKey || idempKey.length < 8 || idempKey.length > 80) {
    return res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' });
  }
  const parsed = abrirSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });

  const userId = req.user!.sub;
  const role = req.user!.role;
  const conductorId = parsed.data.conductorId ?? userId;
  // Solo admin puede abrir jornada en nombre de otro conductor.
  if (conductorId !== userId && role !== 'admin') return res.status(403).json({ error: 'Solo admin puede abrir jornada para otro conductor' });

  const inicioAt = parsed.data.inicioAt ? new Date(parsed.data.inicioAt) : new Date();

  const result = await db.transaction(async (tx) => {
    // Idempotency check (key + scope='open' es UNIQUE → si ya se usó, devolver la jornada existente).
    const [prev] = await tx.select().from(jornadasIdempotencyKeys)
      .where(and(eq(jornadasIdempotencyKeys.key, idempKey), eq(jornadasIdempotencyKeys.scope, 'open'))).limit(1);
    if (prev?.jornadaId) {
      const [existing] = await tx.select().from(jornadasConductor).where(eq(jornadasConductor.id, prev.jornadaId)).limit(1);
      return { code: 200 as const, row: existing, idempotent: true };
    }

    // Calcular descanso previo: tiempo desde el fin_at de la última jornada cerrada del conductor.
    const [last] = await tx.select().from(jornadasConductor)
      .where(and(eq(jornadasConductor.conductorId, conductorId), eq(jornadasConductor.cerrada, true)))
      .orderBy(desc(jornadasConductor.finAt)).limit(1);
    let horasDescansoPre: string | null = null;
    if (last?.finAt) {
      const diffMs = inicioAt.getTime() - new Date(last.finAt).getTime();
      const horas = diffMs / (1000 * 60 * 60);
      if (horas >= 0) horasDescansoPre = horas.toFixed(2);
    }

    try {
      const [row] = await tx.insert(jornadasConductor).values({
        conductorId,
        vehicleId: parsed.data.vehicleId ?? null,
        checklistId: parsed.data.checklistId ?? null,
        inicioAt,
        horasDescansoPre,
      }).returning();

      await tx.insert(jornadasIdempotencyKeys).values({
        key: idempKey, scope: 'open', jornadaId: row.id, userId,
      });
      return { code: 201 as const, row };
    } catch (e: any) {
      if (e?.code === '23505') return { code: 409 as const, msg: 'Ya hay una jornada abierta para este conductor' };
      throw e;
    }
  });

  if (result.code === 409) return res.status(409).json({ error: result.msg });
  if ((result as any).idempotent) {
    return res.status(200).json(result.row);
  }
  await audit(req, { action: 'create', resource: 'jornada', resourceId: String((result.row as any).id), detail: `conductor=${conductorId}` });
  res.status(201).json(result.row);
});

// ============ CERRAR JORNADA ============

router.post('/:id/cerrar', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const idempKey = req.header('Idempotency-Key');
  if (!idempKey || idempKey.length < 8 || idempKey.length > 80) return res.status(400).json({ error: 'Idempotency-Key requerido' });
  const parsed = cerrarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });

  const userId = req.user!.sub;
  const role = req.user!.role;
  const finAt = parsed.data.finAt ? new Date(parsed.data.finAt) : new Date();

  const result = await db.transaction(async (tx) => {
    // Idempotency
    const [prev] = await tx.select().from(jornadasIdempotencyKeys)
      .where(and(eq(jornadasIdempotencyKeys.key, idempKey), eq(jornadasIdempotencyKeys.scope, 'close'))).limit(1);
    if (prev?.jornadaId === id) {
      const [r] = await tx.select().from(jornadasConductor).where(eq(jornadasConductor.id, id)).limit(1);
      return { code: 200 as const, row: r, idempotent: true };
    }

    // FOR UPDATE para evitar race entre cierre manual y cron autoclose.
    const [j] = await tx.select().from(jornadasConductor).where(eq(jornadasConductor.id, id)).for('update').limit(1);
    if (!j) return { code: 404 as const };
    if (j.cerrada) return { code: 409 as const, msg: 'Jornada ya cerrada' };
    if (j.conductorId !== userId && role !== 'admin') return { code: 403 as const, msg: 'No autorizado' };
    if (finAt.getTime() <= new Date(j.inicioAt).getTime()) return { code: 400 as const, msg: 'fin_at debe ser posterior al inicio' };

    // Cerrar pausa abierta si la hay.
    await tx.update(jornadasPausas).set({ finAt }).where(and(eq(jornadasPausas.jornadaId, id), isNull(jornadasPausas.finAt)));

    const [closed] = await tx.update(jornadasConductor).set({
      finAt,
      cerrada: true,
      cerradaPor: userId,
      observaciones: parsed.data.observaciones ?? j.observaciones,
      optimisticV: j.optimisticV + 1,
    }).where(eq(jornadasConductor.id, id)).returning();

    // Calcular alarmas (lee pausas ya cerradas + horas semana ISO acumuladas).
    const pausas = await tx.select().from(jornadasPausas).where(eq(jornadasPausas.jornadaId, id));
    const pausasMinTotales = pausas.reduce((sum, p) => sum + (p.duracionMin ?? 0), 0);
    const horasConduccion = Number(closed.horasConduccion ?? 0);
    const horasDescansoPre = closed.horasDescansoPre !== null ? Number(closed.horasDescansoPre) : null;

    // Suma horas conducción de todas las jornadas cerradas del conductor en la misma
    // semana ISO (lunes 00:00 → domingo 23:59) que la jornada que se acaba de cerrar.
    const semanaRows = await tx.execute(sql`
      SELECT COALESCE(SUM(horas_conduccion), 0)::float AS horas
      FROM jornadas_conductor
      WHERE conductor_id = ${j.conductorId}
        AND cerrada = true
        AND date_trunc('week', inicio_at) = date_trunc('week', ${new Date(closed.inicioAt as any).toISOString()}::timestamptz)
    ` as any) as any;
    const horasSemanaAcumulada = Number((semanaRows?.rows?.[0] ?? semanaRows?.[0])?.horas ?? 0);

    const alarmas = computarAlarmasCierre({ horasConduccion, horasDescansoPre, pausasMinTotales, horasSemanaAcumulada });
    if (alarmas.length) {
      await tx.insert(jornadasAlarmas).values(alarmas.map((a) => ({
        jornadaId: id,
        tipo: a.tipo,
        valorObservado: String(a.valorObservado),
        valorLimite: String(a.valorLimite),
        unidad: a.unidad,
      })));
    }

    await tx.insert(jornadasIdempotencyKeys).values({ key: idempKey, scope: 'close', jornadaId: id, userId });
    return { code: 200 as const, row: closed, alarmasCount: alarmas.length, alarmas, conductorId: j.conductorId };
  });

  if (result.code === 404) return res.status(404).json({ error: 'No encontrada' });
  if (result.code === 403) return res.status(403).json({ error: result.msg });
  if (result.code === 400) return res.status(400).json({ error: result.msg });
  if (result.code === 409) return res.status(409).json({ error: result.msg });
  if ((result as any).idempotent) return res.status(200).json(result.row);

  // Notificar admins post-tx (best-effort, no aborta).
  if ((result as any).alarmasCount > 0) {
    await notifyJornadaAlarmas({
      conductorId: (result as any).conductorId,
      jornadaId: id,
      alarmas: (result as any).alarmas,
    });
  }

  await audit(req, { action: 'update', resource: 'jornada', resourceId: String(id), detail: `cerrada alarmas=${(result as any).alarmasCount}` });
  res.json({ ...(result.row as any), alarmasGeneradas: (result as any).alarmasCount });
});

// ============ PAUSAS ============

router.post('/:id/pausa/abrir', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = pausaAbrirSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const userId = req.user!.sub;

  const result = await db.transaction(async (tx) => {
    const [j] = await tx.select().from(jornadasConductor).where(eq(jornadasConductor.id, id)).for('update').limit(1);
    if (!j) return { code: 404 as const };
    if (j.cerrada) return { code: 409 as const, msg: 'Jornada cerrada' };
    if (j.conductorId !== userId && req.user!.role !== 'admin') return { code: 403 as const, msg: 'No autorizado' };

    try {
      const inicioAt = parsed.data.inicioAt ? new Date(parsed.data.inicioAt) : new Date();
      const [pausa] = await tx.insert(jornadasPausas).values({
        jornadaId: id, motivo: parsed.data.motivo, inicioAt,
      }).returning();
      return { code: 201 as const, row: pausa };
    } catch (e: any) {
      if (e?.code === '23505') return { code: 409 as const, msg: 'Ya hay una pausa abierta' };
      throw e;
    }
  });

  if (result.code !== 201) return res.status(result.code).json({ error: (result as any).msg || 'no encontrada' });
  res.status(201).json(result.row);
});

router.post('/:id/pausa/cerrar', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = pausaCerrarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const finAt = parsed.data.finAt ? new Date(parsed.data.finAt) : new Date();
  const [pausa] = await db.update(jornadasPausas).set({ finAt })
    .where(and(eq(jornadasPausas.jornadaId, id), isNull(jornadasPausas.finAt))).returning();
  if (!pausa) return res.status(404).json({ error: 'No hay pausa abierta' });
  res.json(pausa);
});

// ============ READ ============

router.get('/abierta', async (req: Request, res: Response) => {
  const conductorId = Number(req.query.conductorId) || req.user!.sub;
  if (conductorId !== req.user!.sub && req.user!.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  const [j] = await db.select().from(jornadasConductor)
    .where(and(eq(jornadasConductor.conductorId, conductorId), eq(jornadasConductor.cerrada, false)))
    .limit(1);
  if (!j) return res.status(404).json({ error: 'Sin jornada abierta' });
  const pausas = await db.select().from(jornadasPausas).where(eq(jornadasPausas.jornadaId, j.id));
  res.json({ ...j, pausas });
});

router.get('/', requireRole('admin'), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const conductorId = req.query.conductorId ? Number(req.query.conductorId) : undefined;
  const conds: any[] = [];
  if (conductorId) conds.push(eq(jornadasConductor.conductorId, conductorId));
  if (req.query.from) conds.push(gte(jornadasConductor.inicioAt, new Date(String(req.query.from))));
  if (req.query.to) conds.push(lte(jornadasConductor.inicioAt, new Date(String(req.query.to))));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(jornadasConductor).where(where).orderBy(desc(jornadasConductor.inicioAt)).limit(limit).offset(offset);
  res.json({ data: rows, limit, offset });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [j] = await db.select().from(jornadasConductor).where(eq(jornadasConductor.id, id)).limit(1);
  if (!j) return res.status(404).json({ error: 'No encontrada' });
  if (j.conductorId !== req.user!.sub && req.user!.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  const pausas = await db.select().from(jornadasPausas).where(eq(jornadasPausas.jornadaId, id));
  const alarmas = await db.select().from(jornadasAlarmas).where(eq(jornadasAlarmas.jornadaId, id));
  res.json({ ...j, pausas, alarmas });
});

// ============ ALARMAS — ack ============

router.post('/alarmas/:alarmaId/ack', requireRole('admin'), async (req: Request, res: Response) => {
  const alarmaId = Number(req.params.alarmaId);
  if (!Number.isFinite(alarmaId) || alarmaId <= 0) return res.status(400).json({ error: 'id inválido' });
  const obs = typeof req.body?.observaciones === 'string' ? String(req.body.observaciones).slice(0, 1000) : null;
  const [row] = await db.update(jornadasAlarmas).set({ ackBy: req.user!.sub, ackAt: new Date(), ackObservaciones: obs })
    .where(and(eq(jornadasAlarmas.id, alarmaId), isNull(jornadasAlarmas.ackAt))).returning();
  if (!row) return res.status(409).json({ error: 'Alarma no existe o ya tiene ack' });
  await audit(req, { action: 'update', resource: 'jornada_alarma', resourceId: String(alarmaId), detail: 'ack' });
  res.json(row);
});

// ============ REPORTES MENSUALES ============

router.get('/reporte-mensual', async (req: Request, res: Response) => {
  const conductorId = Number(req.query.conductorId);
  const anio = Number(req.query.anio);
  const mes = Number(req.query.mes);
  if (!Number.isFinite(conductorId) || !Number.isFinite(anio) || !Number.isFinite(mes)) {
    return res.status(400).json({ error: 'conductorId, anio, mes requeridos' });
  }
  if (conductorId !== req.user!.sub && req.user!.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  const [r] = await db.select().from(jornadasReportesMensuales)
    .where(and(eq(jornadasReportesMensuales.conductorId, conductorId), eq(jornadasReportesMensuales.anio, anio), eq(jornadasReportesMensuales.mes, mes))).limit(1);
  if (!r) return res.status(404).json({ error: 'sin reporte para ese período' });
  res.json(r);
});

router.post('/reporte-mensual/regenerar', requireRole('admin'), async (req: Request, res: Response) => {
  const conductorId = Number(req.body?.conductorId);
  const anio = Number(req.body?.anio);
  const mes = Number(req.body?.mes);
  if (!Number.isFinite(conductorId) || !Number.isFinite(anio) || !Number.isFinite(mes)) {
    return res.status(400).json({ error: 'conductorId, anio, mes requeridos' });
  }
  const inicio = new Date(Date.UTC(anio, mes - 1, 1));
  const fin = new Date(Date.UTC(anio, mes, 1));

  const result = await db.transaction(async (tx) => {
    const jornadas = await tx.select().from(jornadasConductor)
      .where(and(eq(jornadasConductor.conductorId, conductorId), gte(jornadasConductor.inicioAt, inicio), lte(jornadasConductor.inicioAt, fin)));
    const cerradasIds = jornadas.filter((j) => j.cerrada).map((j) => j.id);
    let alarmasCount = 0;
    if (cerradasIds.length) {
      const alarmasRows = await tx.select({ count: sql<number>`count(*)::int` })
        .from(jornadasAlarmas).where(or(...cerradasIds.map((jid) => eq(jornadasAlarmas.jornadaId, jid))));
      alarmasCount = alarmasRows[0]?.count ?? 0;
    }
    const horasTotales = jornadas.reduce((sum, j) => sum + Number(j.horasConduccion ?? 0), 0);
    // PESV-S2: tope mensual real = 60h × 4 semanas = 240h (no 60×5=300, que era falso negativo).
    const cumple = alarmasCount === 0 && horasTotales <= JORNADA_LIMITS.MAX_MENSUAL_HORAS;

    await tx.delete(jornadasReportesMensuales)
      .where(and(eq(jornadasReportesMensuales.conductorId, conductorId), eq(jornadasReportesMensuales.anio, anio), eq(jornadasReportesMensuales.mes, mes)));
    const [row] = await tx.insert(jornadasReportesMensuales).values({
      conductorId, anio, mes,
      jornadasCount: jornadas.length,
      horasTotales: horasTotales.toFixed(2),
      alarmasCount,
      cumpleNorma: cumple,
      detalleJsonb: { regeneradoPor: req.user!.sub, generadoEn: new Date().toISOString() },
      generadoPor: req.user!.sub,
    }).returning();
    return row;
  });

  await audit(req, { action: 'create', resource: 'jornada_reporte', resourceId: String(result.id), detail: `${anio}-${mes}` });
  res.status(201).json(result);
});

export default router;
