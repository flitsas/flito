import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

// Indicadores oficiales PESV (Paso 20 Resolución 40595/2022).
// Implementados: tasa accidentalidad/lesionados/fatalidades por km, severidad,
// % cumplimiento documental conductores, % capacitación, % inspecciones preoperacionales (placeholder).

function clampDate(raw: unknown, fallbackOffsetDays: number): string {
  const s = typeof raw === 'string' ? raw : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date(Date.now() + fallbackOffsetDays * 86_400_000).toISOString().slice(0, 10);
}

router.get('/', async (req: Request, res: Response) => {
  const desde = clampDate(req.query.desde, -90);
  const hasta = clampDate(req.query.hasta, 0);
  const today = new Date().toISOString().slice(0, 10);

  // Km recorridos por flota propia: delta de odómetro por vehículo en el período.
  const kmRes = await db.execute<{ km_total: number }>(sql`
    WITH km_periodo AS (
      SELECT vehicle_id,
             MAX(odometro) FILTER (WHERE fecha BETWEEN ${desde}::date AND ${hasta}::date)
             - MIN(odometro) FILTER (WHERE fecha BETWEEN ${desde}::date AND ${hasta}::date) AS km
        FROM vehicle_measurements
       WHERE odometro IS NOT NULL
       GROUP BY vehicle_id
    )
    SELECT COALESCE(SUM(GREATEST(km, 0)), 0)::int AS km_total FROM km_periodo
  `);
  const km = Number(((kmRes as any).rows ?? kmRes as any[])[0]?.km_total ?? 0);

  const incRes = await db.execute<any>(sql`
    SELECT
      COUNT(*) FILTER (WHERE tipo = 'accidente')::int AS accidentes,
      COUNT(*) FILTER (WHERE tipo = 'casi_accidente')::int AS casi_accidentes,
      COUNT(*) FILTER (WHERE tipo = 'comparendo')::int AS comparendos,
      SUM(victimas_count) FILTER (WHERE gravedad IN ('grave','fatal'))::int AS lesionados,
      COUNT(*) FILTER (WHERE gravedad = 'fatal')::int AS fatales,
      SUM(dias_perdidos) FILTER (WHERE tipo = 'accidente')::int AS dias_perdidos_total,
      SUM(costos)::numeric(15,2) AS costo_total
    FROM road_incidents
    WHERE fecha BETWEEN ${desde}::date AND ${hasta}::date
  `);
  const incRow = ((incRes as any).rows ?? incRes as any[])[0] ?? {};
  const accidentes = Number(incRow.accidentes ?? 0);
  const lesionados = Number(incRow.lesionados ?? 0);
  const fatales = Number(incRow.fatales ?? 0);
  const diasPerdidos = Number(incRow.dias_perdidos_total ?? 0);
  const K = 1_000_000;
  const tasaAccidentalidad = km > 0 ? Number(((accidentes * K) / km).toFixed(2)) : null;
  const tasaLesionados = km > 0 ? Number(((lesionados * K) / km).toFixed(2)) : null;
  const tasaFatales = km > 0 ? Number(((fatales * K) / km).toFixed(2)) : null;
  const severidad = accidentes > 0 ? Number((diasPerdidos / accidentes).toFixed(2)) : null;

  // Cumplimiento documental conductores.
  // VENCIDOS REALES: vigencia_hasta < hoy (compliance estricto).
  // POR VENCER: vigencia_hasta entre hoy y hoy+30 (alerta temprana, no incumplimiento).
  const cumplDocRes = await db.execute<{ total: number; con_vencidos: number; con_por_vencer: number }>(sql`
    WITH conductores AS (SELECT id FROM users WHERE es_conductor = true AND active = true)
    SELECT
      (SELECT COUNT(*) FROM conductores)::int AS total,
      (SELECT COUNT(DISTINCT dd.user_id)
         FROM driver_documents dd
         JOIN conductores c ON c.id = dd.user_id
        WHERE dd.estado <> 'archivado'
          AND dd.vigencia_hasta IS NOT NULL
          AND dd.vigencia_hasta < ${today}::date)::int AS con_vencidos,
      (SELECT COUNT(DISTINCT dd.user_id)
         FROM driver_documents dd
         JOIN conductores c ON c.id = dd.user_id
        WHERE dd.estado <> 'archivado'
          AND dd.vigencia_hasta IS NOT NULL
          AND dd.vigencia_hasta >= ${today}::date
          AND dd.vigencia_hasta <= ${today}::date + INTERVAL '30 days')::int AS con_por_vencer
  `);
  const cumplRow = ((cumplDocRes as any).rows ?? cumplDocRes as any[])[0] ?? { total: 0, con_vencidos: 0, con_por_vencer: 0 };
  const totalCond = Number(cumplRow.total);
  const conVencidos = Number(cumplRow.con_vencidos);
  const conPorVencer = Number(cumplRow.con_por_vencer);
  const pctCumplDoc = totalCond > 0 ? Number((((totalCond - conVencidos) / totalCond) * 100).toFixed(2)) : null;

  // % capacitación: conductores con al menos 1 capacitación asistida en el año del 'hasta'.
  const yearHasta = parseInt(hasta.slice(0, 4), 10);
  const capRes = await db.execute<{ total: number; capacitados: number }>(sql`
    WITH conductores AS (SELECT id FROM users WHERE es_conductor = true AND active = true)
    SELECT COUNT(*)::int AS total,
           COUNT(DISTINCT ta.user_id) FILTER (
             WHERE ta.asistio = true
               AND EXTRACT(YEAR FROM st.fecha) = ${yearHasta}
           )::int AS capacitados
      FROM conductores c
      LEFT JOIN training_attendees ta ON ta.user_id = c.id
      LEFT JOIN safety_trainings st  ON st.id = ta.training_id
  `);
  const capRow = ((capRes as any).rows ?? capRes as any[])[0] ?? { total: 0, capacitados: 0 };
  const pctCap = Number(capRow.total) > 0
    ? Number(((Number(capRow.capacitados) / Number(capRow.total)) * 100).toFixed(2))
    : null;

  // Top conductores por incidentes (graves o fatales).
  const topRes = await db.execute<any>(sql`
    SELECT u.id AS user_id, u.name,
           COUNT(*)::int AS incidentes_count,
           SUM(CASE WHEN ri.gravedad = 'fatal' THEN 1 ELSE 0 END)::int AS fatales,
           SUM(ri.victimas_count)::int AS victimas
      FROM road_incidents ri
      LEFT JOIN users u ON u.id = ri.conductor_id
     WHERE ri.fecha BETWEEN ${desde}::date AND ${hasta}::date
       AND ri.tipo = 'accidente'
       AND ri.conductor_id IS NOT NULL
     GROUP BY u.id, u.name
     HAVING COUNT(*) > 0
     ORDER BY incidentes_count DESC, victimas DESC
     LIMIT 10
  `);
  const topRows = ((topRes as any).rows ?? topRes as any[]) as any[];

  res.json({
    desde, hasta,
    accidentes,
    casi_accidentes: Number(incRow.casi_accidentes ?? 0),
    comparendos: Number(incRow.comparendos ?? 0),
    lesionados,
    fatales,
    dias_perdidos_total: diasPerdidos,
    costo_total: Number(incRow.costo_total ?? 0),
    km_recorridos: km,
    tasa_accidentalidad: tasaAccidentalidad,
    tasa_lesionados: tasaLesionados,
    tasa_fatales: tasaFatales,
    severidad,
    cumplimiento_documental_pct: pctCumplDoc,
    capacitacion_pct: pctCap,
    total_conductores: totalCond,
    top_conductores: topRows.map((r) => ({
      userId: r.user_id, name: r.name,
      incidentes: r.incidentes_count, fatales: r.fatales, victimas: r.victimas,
    })),
  });
});

export default router;
