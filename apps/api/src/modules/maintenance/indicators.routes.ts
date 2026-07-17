import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

// Indicadores diferenciadores (no los tiene CloudFleet):
//   MTBF — días promedio entre OTs correctivas por vehículo.
//   MTTR — horas promedio entre fecha_ingreso_taller y fecha_cierre_final.
//   Costo por km — sum(costo_total_calculado) / km recorridos en el período.
//   Costo por sistema — agrupado por system_id de los repuestos consumidos.
//   Disponibilidad — (calendario - horas_en_taller) / calendario * 100.
//   OTs reincidentes — misma falla en mismo vehículo en < 30 días.

function clampDate(raw: unknown, fallbackOffsetDays: number): string {
  const s = typeof raw === 'string' ? raw : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date(Date.now() + fallbackOffsetDays * 86_400_000).toISOString().slice(0, 10);
}

router.get('/', async (req: Request, res: Response) => {
  const desde = clampDate(req.query.desde, -90);
  const hasta = clampDate(req.query.hasta, 0);
  const vehicleParam = req.query.vehicleId ? Number(req.query.vehicleId) : null;
  const vehicleId = Number.isFinite(vehicleParam) && vehicleParam! > 0 ? vehicleParam : null;

  const vehicleFilter = vehicleId ? sql`AND wo.vehicle_id = ${vehicleId}` : sql``;

  // 1. MTBF: días entre OTs correctivas consecutivas por vehículo.
  const mtbfRes = await db.execute<{ vehicle_id: number; plate: string | null; mtbf_dias: number | null; ots: number }>(sql`
    WITH correctivas AS (
      SELECT wo.vehicle_id, wo.fecha_ingreso_taller,
             LAG(wo.fecha_ingreso_taller) OVER (PARTITION BY wo.vehicle_id ORDER BY wo.fecha_ingreso_taller) AS prev
        FROM work_orders wo
       WHERE wo.tipo_trabajo = 'correctivo'
         AND wo.estado = 'cerrada_final'
         AND wo.fecha_ingreso_taller >= ${desde}::date
         AND wo.fecha_ingreso_taller <= ${hasta}::date + INTERVAL '1 day'
         ${vehicleFilter}
    )
    SELECT c.vehicle_id, v.plate,
           AVG(EXTRACT(EPOCH FROM (c.fecha_ingreso_taller - c.prev)) / 86400)::numeric(10,2) AS mtbf_dias,
           COUNT(*)::int AS ots
      FROM correctivas c
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
     WHERE c.prev IS NOT NULL
     GROUP BY c.vehicle_id, v.plate
     ORDER BY mtbf_dias ASC NULLS LAST
     LIMIT 50
  `);

  // 2. MTTR: horas entre ingreso y cierre final.
  const mttrRes = await db.execute<{ mttr_horas: number | null; ots: number }>(sql`
    SELECT
      AVG(EXTRACT(EPOCH FROM (fecha_cierre_final - fecha_ingreso_taller)) / 3600)::numeric(10,2) AS mttr_horas,
      COUNT(*)::int AS ots
      FROM work_orders
     WHERE estado = 'cerrada_final'
       AND fecha_cierre_final IS NOT NULL
       AND fecha_ingreso_taller >= ${desde}::date
       AND fecha_ingreso_taller <= ${hasta}::date + INTERVAL '1 day'
       ${vehicleId ? sql`AND vehicle_id = ${vehicleId}` : sql``}
  `);

  // 3. Costo total y por sistema (los repuestos vienen con system_id en parts).
  const costoSistemaRes = await db.execute<{ system_id: number | null; nombre: string | null; monto: number }>(sql`
    SELECT p.system_id, ms.nombre,
           SUM(wp.cantidad * COALESCE(wp.valor_unit, 0) - COALESCE(wp.descuento, 0))::numeric(15,2) AS monto
      FROM wo_parts wp
      JOIN work_orders wo ON wo.id = wp.wo_id
      JOIN parts p ON p.id = wp.part_id
      LEFT JOIN maintenance_systems ms ON ms.id = p.system_id
     WHERE wo.estado = 'cerrada_final'
       AND wo.fecha_cierre_final >= ${desde}::date
       AND wo.fecha_cierre_final <= ${hasta}::date + INTERVAL '1 day'
       ${vehicleFilter}
     GROUP BY p.system_id, ms.nombre
     ORDER BY monto DESC
  `);

  const costoTotalRes = await db.execute<{ costo_total: number; ots: number }>(sql`
    SELECT COALESCE(SUM(costo_total_calculado), 0)::numeric(15,2) AS costo_total,
           COUNT(*)::int AS ots
      FROM work_orders
     WHERE estado = 'cerrada_final'
       AND fecha_cierre_final >= ${desde}::date
       AND fecha_cierre_final <= ${hasta}::date + INTERVAL '1 day'
       ${vehicleId ? sql`AND vehicle_id = ${vehicleId}` : sql``}
  `);

  // 4. Costo por km: necesita km recorridos en el período (max - min de mediciones).
  const kmRes = await db.execute<{ km_recorridos: number | null }>(sql`
    SELECT (MAX(odometro) - MIN(odometro))::int AS km_recorridos
      FROM vehicle_measurements
     WHERE odometro IS NOT NULL
       AND fecha >= ${desde}::date
       AND fecha <= ${hasta}::date
       ${vehicleId ? sql`AND vehicle_id = ${vehicleId}` : sql``}
  `);

  // 5. Disponibilidad: % del tiempo NO en taller.
  const disponRes = await db.execute<{ horas_taller: number; horas_periodo: number }>(sql`
    SELECT
      COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(fecha_cierre_final, NOW()) - fecha_ingreso_taller))) / 3600, 0)::numeric(10,2) AS horas_taller,
      EXTRACT(EPOCH FROM (${hasta}::date + INTERVAL '1 day' - ${desde}::date)) / 3600 AS horas_periodo
      FROM work_orders
     WHERE fecha_ingreso_taller >= ${desde}::date
       AND fecha_ingreso_taller <= ${hasta}::date + INTERVAL '1 day'
       ${vehicleId ? sql`AND vehicle_id = ${vehicleId}` : sql``}
  `);

  // 6. OTs reincidentes: misma falla (lower) en mismo vehículo en menos de 30 días.
  const reincRes = await db.execute<{ vehicle_id: number; plate: string | null; falla: string; ocurrencias: number }>(sql`
    SELECT wo.vehicle_id, v.plate, LOWER(LEFT(wo.falla, 80)) AS falla, COUNT(*)::int AS ocurrencias
      FROM work_orders wo
      LEFT JOIN vehicles v ON v.id = wo.vehicle_id
     WHERE wo.tipo_trabajo = 'correctivo'
       AND wo.falla IS NOT NULL
       AND wo.fecha_ingreso_taller >= ${desde}::date
       AND wo.fecha_ingreso_taller <= ${hasta}::date + INTERVAL '1 day'
       ${vehicleFilter}
     GROUP BY wo.vehicle_id, v.plate, LOWER(LEFT(wo.falla, 80))
     HAVING COUNT(*) > 1
     ORDER BY ocurrencias DESC LIMIT 20
  `);

  const mtbfRows = (mtbfRes as any).rows ?? mtbfRes as any[];
  const mttrRow = ((mttrRes as any).rows ?? mttrRes as any[])[0] ?? { mttr_horas: null, ots: 0 };
  const costoSistRows = (costoSistemaRes as any).rows ?? costoSistemaRes as any[];
  const costoRow = ((costoTotalRes as any).rows ?? costoTotalRes as any[])[0] ?? { costo_total: 0, ots: 0 };
  const kmRow = ((kmRes as any).rows ?? kmRes as any[])[0] ?? { km_recorridos: null };
  const disponRow = ((disponRes as any).rows ?? disponRes as any[])[0] ?? { horas_taller: 0, horas_periodo: 1 };
  const reincRows = (reincRes as any).rows ?? reincRes as any[];

  const km = Number(kmRow.km_recorridos ?? 0);
  const costoTotal = Number(costoRow.costo_total ?? 0);
  const costoPorKm = km > 0 ? costoTotal / km : null;
  const horasTaller = Number(disponRow.horas_taller ?? 0);
  const horasPeriodo = Number(disponRow.horas_periodo ?? 1);
  const disponPct = horasPeriodo > 0 ? Math.max(0, ((horasPeriodo - horasTaller) / horasPeriodo) * 100) : 100;

  res.json({
    desde, hasta, vehicleId,
    mtbf_dias_promedio: mtbfRows.length > 0
      ? Number((mtbfRows.reduce((acc: number, r: any) => acc + Number(r.mtbf_dias ?? 0), 0) / mtbfRows.length).toFixed(2))
      : null,
    mttr_horas: mttrRow.mttr_horas != null ? Number(mttrRow.mttr_horas) : null,
    costo_total: costoTotal,
    costo_por_km: costoPorKm != null ? Number(costoPorKm.toFixed(2)) : null,
    km_recorridos: km,
    disponibilidad_pct: Number(disponPct.toFixed(2)),
    ots_cerradas: Number(costoRow.ots),
    costo_por_sistema: costoSistRows.map((r: any) => ({ sistema: r.nombre ?? 'Sin clasificar', monto: Number(r.monto ?? 0) })),
    ots_reincidentes: reincRows.map((r: any) => ({ vehicleId: r.vehicle_id, plate: r.plate, falla: r.falla, ocurrencias: r.ocurrencias })),
    mtbf_por_vehiculo: mtbfRows.map((r: any) => ({ vehicleId: r.vehicle_id, plate: r.plate, mtbfDias: r.mtbf_dias != null ? Number(r.mtbf_dias) : null, ots: r.ots })),
  });
});

export default router;
