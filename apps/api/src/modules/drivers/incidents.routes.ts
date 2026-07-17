import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roadIncidents, incidentActions, vehicles, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { notifyPesvAdmin } from '../jornadas/notify.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import { appendEventoSafe } from '../vehicles/vehiculo-historial.js';

const slog = loggerFor('drivers-incidents');

/** TRAM-INNOV B1 — registra incidente PESV en pasaporte VIN (best-effort). */
async function pasaporteDesdeIncidente(
  incidentId: number,
  vehicleId: number | null | undefined,
  meta: { tipo: string; fecha: string; gravedad?: string; origen: 'admin' | 'mobile' },
): Promise<void> {
  if (!vehicleId) return;
  const [veh] = await db.select({ vin: vehicles.vin }).from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
  if (!veh?.vin) return;
  await appendEventoSafe({
    vin: veh.vin,
    eventoTipo: 'pesv_incidente',
    payload: { incidentId, ...meta },
  });
}

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get('/', async (req: Request, res: Response) => {
  const tipo = req.query.tipo as string | undefined;
  const gravedad = req.query.gravedad as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const conductorId = req.query.conductorId ? parseId(String(req.query.conductorId)) : null;
  const conds: any[] = [];
  if (tipo) conds.push(eq(roadIncidents.tipo, tipo as any));
  if (gravedad) conds.push(eq(roadIncidents.gravedad, gravedad as any));
  if (from) conds.push(gte(roadIncidents.fecha, from));
  if (to) conds.push(lte(roadIncidents.fecha, to));
  if (conductorId) conds.push(eq(roadIncidents.conductorId, conductorId));

  const rows = await db.select({
    id: roadIncidents.id,
    tipo: roadIncidents.tipo,
    fecha: roadIncidents.fecha,
    gravedad: roadIncidents.gravedad,
    estado: roadIncidents.estado,
    plate: vehicles.plate,
    vehicleId: roadIncidents.vehicleId,
    conductorId: roadIncidents.conductorId,
    conductorName: users.name,
    descripcion: roadIncidents.descripcion,
    costos: roadIncidents.costos,
    victimasCount: roadIncidents.victimasCount,
    diasPerdidos: roadIncidents.diasPerdidos,
  })
    .from(roadIncidents)
    .leftJoin(vehicles, eq(vehicles.id, roadIncidents.vehicleId))
    .leftJoin(users, eq(users.id, roadIncidents.conductorId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(roadIncidents.fecha), desc(roadIncidents.id))
    .limit(500);
  res.json({ data: rows });
});

// /stats DEBE ir antes de /:id en el orden de Express (sino /:id lo intercepta).
// Definición real más abajo (PESV-S8). Aquí solo reservamos el orden de match.
router.get('/:id(\\d+)', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [inc] = await db.select().from(roadIncidents).where(eq(roadIncidents.id, id)).limit(1);
  if (!inc) { res.status(404).json({ error: 'No encontrado' }); return; }
  const actions = await db.select().from(incidentActions).where(eq(incidentActions.incidentId, id));
  res.json({ data: inc, actions });
});

const incidentSchema = z.object({
  tipo: z.enum(['accidente', 'casi_accidente', 'comparendo']),
  vehicleId: z.number().int().positive().optional().nullable(),
  conductorId: z.number().int().positive().optional().nullable(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  lugarTexto: z.string().max(300).optional().nullable(),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  gravedad: z.enum(['sin', 'leve', 'grave', 'fatal']).default('sin'),
  descripcion: z.string().max(2000).optional().nullable(),
  costos: z.number().min(0).default(0),
  victimasCount: z.number().int().min(0).default(0),
  diasPerdidos: z.number().int().min(0).default(0),
  comparendoNumero: z.string().max(40).optional().nullable(),
  valorMulta: z.number().min(0).optional().nullable(),
});

// PESV-S8 Paso 21 — agregados estadísticos de siniestros viales para indicadores PESV.
// Read-only; cualquier rol con page=pesv puede consultar para análisis.
router.get('/stats', async (req: Request, res: Response) => {
  // Periodo por defecto: últimos 12 meses.
  const fromIso = req.query.from
    ? new Date(String(req.query.from)).toISOString()
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString();
  const toIso = req.query.to
    ? new Date(String(req.query.to)).toISOString()
    : new Date().toISOString();

  // Totales globales del periodo.
  const totalRows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE tipo = 'accidente')::int AS accidentes,
      COUNT(*) FILTER (WHERE tipo = 'casi_accidente')::int AS casi,
      COUNT(*) FILTER (WHERE tipo = 'comparendo')::int AS comparendos,
      COUNT(*) FILTER (WHERE gravedad = 'fatal')::int AS fatales,
      COUNT(*) FILTER (WHERE gravedad = 'grave')::int AS graves,
      COUNT(*) FILTER (WHERE gravedad = 'leve')::int AS leves,
      COALESCE(SUM(victimas_count), 0)::int AS victimas_total,
      COALESCE(SUM(dias_perdidos), 0)::int AS dias_perdidos_total,
      COALESCE(SUM(costos), 0)::numeric AS costos_total,
      COUNT(*) FILTER (WHERE causa_raiz_metodo IS NOT NULL)::int AS investigaciones,
      COUNT(*) FILTER (WHERE investigacion_cerrada_at IS NOT NULL)::int AS investigaciones_cerradas
    FROM road_incidents
    WHERE fecha >= ${fromIso}::date AND fecha <= ${toIso}::date
  ` as any) as any;
  const total = (totalRows?.rows?.[0] ?? totalRows?.[0]) ?? {};

  // Serie mensual (12 meses).
  const mensualRows = await db.execute(sql`
    SELECT
      TO_CHAR(date_trunc('month', fecha), 'YYYY-MM') AS mes,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE tipo = 'accidente')::int AS accidentes,
      COUNT(*) FILTER (WHERE gravedad IN ('grave', 'fatal'))::int AS graves_fatales,
      COALESCE(SUM(victimas_count), 0)::int AS victimas
    FROM road_incidents
    WHERE fecha >= ${fromIso}::date AND fecha <= ${toIso}::date
    GROUP BY 1
    ORDER BY 1
  ` as any) as any;

  // Por tipo de causa raíz (Paso 13 vinculado a Paso 21).
  const causaRows = await db.execute(sql`
    SELECT causa_raiz_metodo AS metodo, COUNT(*)::int AS c
    FROM road_incidents
    WHERE fecha >= ${fromIso}::date AND fecha <= ${toIso}::date
      AND causa_raiz_metodo IS NOT NULL
    GROUP BY 1 ORDER BY c DESC
  ` as any) as any;

  // Top conductores con más incidentes (alerta de patrón).
  const conductorRows = await db.execute(sql`
    SELECT ri.conductor_id, u.name, COUNT(*)::int AS c,
           COALESCE(SUM(ri.victimas_count), 0)::int AS victimas
    FROM road_incidents ri
    LEFT JOIN users u ON u.id = ri.conductor_id
    WHERE ri.fecha >= ${fromIso}::date AND ri.fecha <= ${toIso}::date
      AND ri.conductor_id IS NOT NULL
    GROUP BY 1, 2
    ORDER BY c DESC, victimas DESC
    LIMIT 10
  ` as any) as any;

  // Indicadores PESV (Res. 40595 anexo): frecuencia, severidad, índice de gravedad.
  // Para HHT real necesitaríamos jornadas; aproximamos con jornadas_conductor cerradas en el periodo.
  const hhtRows = await db.execute(sql`
    SELECT COALESCE(SUM(horas_conduccion), 0)::float AS hht
    FROM jornadas_conductor
    WHERE cerrada = true AND inicio_at >= ${fromIso}::timestamptz AND inicio_at <= ${toIso}::timestamptz
  ` as any) as any;
  const hht = Number((hhtRows?.rows?.[0] ?? hhtRows?.[0])?.hht ?? 0);

  // Frecuencia = (accidentes × 200000) / HHT (estándar OSHA × 1000 horas-hombre).
  const frecuencia = hht > 0 ? Number(total.accidentes ?? 0) * 200000 / hht : 0;
  // Severidad = (días perdidos × 200000) / HHT.
  const severidad = hht > 0 ? Number(total.dias_perdidos_total ?? 0) * 200000 / hht : 0;
  // Índice de gravedad = frecuencia × severidad / 1000.
  const indiceGravedad = (frecuencia * severidad) / 1000;

  res.json({
    periodo: { from: fromIso.slice(0, 10), to: toIso.slice(0, 10) },
    totales: total,
    mensual: (mensualRows?.rows ?? mensualRows ?? []) as any[],
    porCausa: (causaRows?.rows ?? causaRows ?? []) as any[],
    topConductores: (conductorRows?.rows ?? conductorRows ?? []) as any[],
    indicadoresPesv: {
      hht: Number(hht.toFixed(2)),
      frecuencia: Number(frecuencia.toFixed(2)),
      severidad: Number(severidad.toFixed(2)),
      indiceGravedad: Number(indiceGravedad.toFixed(2)),
      formula: 'frecuencia/severidad = (X × 200.000) / HHT — Res. 40595 anexo',
    },
  });
});

router.post('/', requireRole('admin', 'lider_pesv', 'supervisor_flota'), async (req: Request, res: Response) => {
  const parsed = incidentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const [created] = await db.insert(roadIncidents).values({
    ...data,
    costos: String(data.costos),
    valorMulta: data.valorMulta != null ? String(data.valorMulta) : null,
    lat: data.lat != null ? String(data.lat) : null,
    lng: data.lng != null ? String(data.lng) : null,
    reportadoPor: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'road_incident', resourceId: String(created.id), detail: `${data.tipo} ${data.gravedad}` });
  await pasaporteDesdeIncidente(created.id, created.vehicleId, {
    tipo: data.tipo,
    fecha: data.fecha,
    gravedad: data.gravedad,
    origen: 'admin',
  });
  res.status(201).json({ data: created });
});

// ============ MÓVIL — REPORTE DESDE CONDUCTOR ============
// Cualquier usuario autenticado con acceso a /pesv puede reportar incidentes desde
// móvil con foto base64 + GPS. Diseñado para que el conductor en ruta no espere a
// que un admin esté disponible. La notificación al admin es automática.
const mobileReportSchema = z.object({
  tipo: z.enum(['accidente', 'casi_accidente', 'comparendo']),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  vehicleId: z.number().int().positive().optional().nullable(),
  conductorId: z.number().int().positive().optional().nullable(),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  descripcion: z.string().min(10).max(2000),
  fotoBase64: z.string().optional().nullable(),
  fotoMime: z.enum(['image/jpeg', 'image/png']).optional().nullable(),
});

router.post('/report-mobile', async (req: Request, res: Response) => {
  const parsed = mobileReportSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const reportadoPor = req.user!.sub;
  const conductorIdEfectivo = data.conductorId ?? reportadoPor;

  // Inserta primero (rapid response). La foto sube async y luego patcha la observación.
  const [created] = await db.insert(roadIncidents).values({
    tipo: data.tipo,
    fecha: data.fecha,
    hora: data.hora ?? null,
    vehicleId: data.vehicleId ?? null,
    conductorId: conductorIdEfectivo,
    lat: data.lat != null ? String(data.lat) : null,
    lng: data.lng != null ? String(data.lng) : null,
    gravedad: 'sin' as any,
    descripcion: data.descripcion,
    costos: '0',
    victimasCount: 0,
    diasPerdidos: 0,
    estado: 'abierto' as any,
    reportadoPor,
  } as any).returning();

  // Subir foto best-effort post-tx.
  let fotoKey: string | null = null;
  if (data.fotoBase64 && data.fotoMime) {
    try {
      const buf = Buffer.from(data.fotoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buf.length > 8 * 1024 * 1024) throw new Error('Foto excede 8MB');
      fotoKey = await uploadEntityDocument('drivers/incidents', created.id, `report-${created.id}.${data.fotoMime === 'image/png' ? 'png' : 'jpg'}`, buf, data.fotoMime);
      await db.update(roadIncidents).set({
        descripcion: `${data.descripcion}\n\n[Foto adjunta] ${fotoKey}`,
      } as any).where(eq(roadIncidents.id, created.id));
    } catch (e: any) {
      slog.warn({ err: e?.message, incidentId: created.id }, 'fallo subiendo foto reporte móvil');
    }
  }

  await audit(req, { action: 'create', resource: 'road_incident', resourceId: String(created.id), detail: `mobile reporte ${data.tipo} GPS=${data.lat},${data.lng}${fotoKey ? ' +foto' : ''}` });

  // Notificar admins (best-effort fuera de tx).
  const ubic = (data.lat && data.lng) ? `https://maps.google.com/?q=${data.lat},${data.lng}` : '(sin GPS)';
  await pasaporteDesdeIncidente(created.id, created.vehicleId ?? data.vehicleId, {
    tipo: data.tipo,
    fecha: data.fecha,
    origen: 'mobile',
  });

  await notifyPesvAdmin({
    contextoTipo: 'road_incident_mobile',
    contextoId: created.id,
    asunto: `Incidente reportado desde móvil — ${data.tipo} (#${created.id})`,
    cuerpoHtml: `<h3>Incidente reportado por conductor #${reportadoPor} desde móvil</h3>
      <p><strong>Tipo:</strong> ${data.tipo}<br>
      <strong>Fecha:</strong> ${data.fecha}${data.hora ? ' ' + data.hora : ''}<br>
      <strong>Vehículo:</strong> ${data.vehicleId ?? 'no especificado'}<br>
      <strong>Ubicación:</strong> ${ubic}</p>
      <p><strong>Descripción:</strong><br>${data.descripcion.replace(/</g, '&lt;')}</p>
      <p>${fotoKey ? `Foto adjunta: ${fotoKey}` : '(sin foto)'}</p>
      <p>Acción: revisar el incidente en PESV → Incidentes y completar gravedad/víctimas/costos.</p>`,
  });

  res.status(201).json({ data: created, fotoKey });
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = incidentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data: any = { ...parsed.data };
  if (data.costos != null) data.costos = String(data.costos);
  if (data.valorMulta != null) data.valorMulta = String(data.valorMulta);
  if (data.lat != null) data.lat = String(data.lat);
  if (data.lng != null) data.lng = String(data.lng);
  const [updated] = await db.update(roadIncidents).set(data).where(eq(roadIncidents.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'road_incident', resourceId: String(id) });
  res.json({ data: updated });
});

const actionSchema = z.object({
  descripcion: z.string().min(1).max(1000),
  responsableId: z.number().int().positive().optional().nullable(),
  fechaLimite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

router.post('/:id/actions', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(incidentActions).values({
    incidentId: id,
    descripcion: parsed.data.descripcion,
    responsableId: parsed.data.responsableId ?? null,
    fechaLimite: parsed.data.fechaLimite ?? null,
  } as any).returning();
  res.status(201).json({ data: created });
});

router.patch('/:id/actions/:actionId', requireRole('admin'), async (req: Request, res: Response) => {
  const actionId = parseId(req.params.actionId);
  if (!actionId) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({
    estado: z.enum(['pendiente', 'en_proceso', 'cumplida', 'vencida']).optional(),
    fechaCumplimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(incidentActions).set(parsed.data as any).where(eq(incidentActions.id, actionId)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: updated });
});

// Cierre de incidente: solo si todas las acciones están cumplidas.
router.post('/:id/close', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [inc] = await tx.select().from(roadIncidents).where(eq(roadIncidents.id, id)).limit(1);
      if (!inc) throw new Error('Incidente no encontrado');
      if (inc.estado === 'cerrado') return { inc, idempotente: true };
      const pendientes = await tx.select({ id: incidentActions.id }).from(incidentActions)
        .where(and(eq(incidentActions.incidentId, id), ne(incidentActions.estado, 'cumplida')));
      if (pendientes.length > 0) throw new Error(`No se puede cerrar: ${pendientes.length} acciones sin cumplir`);
      const [updated] = await tx.update(roadIncidents)
        .set({ estado: 'cerrado', closedAt: new Date() })
        .where(eq(roadIncidents.id, id))
        .returning();
      return { inc: updated, idempotente: false };
    });
    if (!result.idempotente) await audit(req, { action: 'update', resource: 'road_incident', resourceId: String(id), detail: 'closed' });
    res.json({ data: result.inc, idempotente: result.idempotente });
  } catch (err: any) {
    if (err?.message?.includes('No se puede cerrar') || err?.message?.includes('no encontrado')) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
