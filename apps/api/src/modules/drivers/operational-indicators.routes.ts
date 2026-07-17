import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function clampDate(raw: unknown, fallbackOffsetDays: number): string {
  const s = typeof raw === 'string' ? raw : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date(Date.now() + fallbackOffsetDays * 86_400_000).toISOString().slice(0, 10);
}

// Cuenta días laborales (lun-vie) entre dos fechas inclusive.
function diasLaborales(desde: string, hasta: string): number {
  const start = new Date(desde + 'T00:00:00Z');
  const end = new Date(hasta + 'T00:00:00Z');
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

router.get('/', async (req: Request, res: Response) => {
  const desde = clampDate(req.query.desde, -30);
  const hasta = clampDate(req.query.hasta, 0);
  const umbralAlcohol = Number(req.query.umbralAlcohol ?? 1);

  // Inspecciones realizadas vs esperadas.
  const conductoresRes = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM users WHERE es_conductor = true AND active = true
  `);
  const conductoresActivos = Number(((conductoresRes as any).rows ?? conductoresRes as any[])[0]?.count ?? 0);
  const labDays = diasLaborales(desde, hasta);
  const inspeccionesEsperadas = conductoresActivos * labDays;

  const inspRealizadasRes = await db.execute<{ count: number; no_aptos: number }>(sql`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE decision = 'no_apto')::int AS no_aptos
    FROM checklists
    WHERE fecha_hora >= ${desde}::date
      AND fecha_hora < (${hasta}::date + INTERVAL '1 day')
      AND anulado_at IS NULL
  `);
  const inspRow = ((inspRealizadasRes as any).rows ?? inspRealizadasRes as any[])[0] ?? { count: 0, no_aptos: 0 };
  const inspeccionesRealizadas = Number(inspRow.count);
  const noAptosCount = Number(inspRow.no_aptos);
  const inspeccionesPct = inspeccionesEsperadas > 0
    ? Number(((inspeccionesRealizadas / inspeccionesEsperadas) * 100).toFixed(2))
    : null;

  // Alcoholimetría.
  const alcoholRes = await db.execute<{ total: number; positivos: number }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resultado = 'positivo')::int AS positivos
    FROM alcohol_tests
    WHERE fecha_hora >= ${desde}::date
      AND fecha_hora < (${hasta}::date + INTERVAL '1 day')
  `);
  const alcRow = ((alcoholRes as any).rows ?? alcoholRes as any[])[0] ?? { total: 0, positivos: 0 };
  const alcoholTotal = Number(alcRow.total);
  const alcoholPositivos = Number(alcRow.positivos);
  const alcoholPositivosPct = alcoholTotal > 0
    ? Number(((alcoholPositivos / alcoholTotal) * 100).toFixed(2))
    : null;
  const alertaAlcohol = alcoholPositivosPct != null && alcoholPositivosPct > umbralAlcohol;

  // Simulacros año actual.
  const yearActual = new Date().getFullYear();
  const drillRes = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM emergency_drills
    WHERE EXTRACT(YEAR FROM fecha) = ${yearActual}
  `);
  const simulacrosCount = Number(((drillRes as any).rows ?? drillRes as any[])[0]?.count ?? 0);

  // Top conductores con no-aptos.
  const topCondRes = await db.execute<any>(sql`
    SELECT u.id AS user_id, u.name, COUNT(*)::int AS no_aptos
      FROM checklists c
      LEFT JOIN users u ON u.id = c.conductor_id
     WHERE c.decision = 'no_apto'
       AND c.fecha_hora >= ${desde}::date
       AND c.fecha_hora < (${hasta}::date + INTERVAL '1 day')
       AND c.anulado_at IS NULL
     GROUP BY u.id, u.name
     ORDER BY no_aptos DESC
     LIMIT 10
  `);
  const topConductores = ((topCondRes as any).rows ?? topCondRes as any[]) as any[];

  // Top vehículos con no-aptos.
  const topVehRes = await db.execute<any>(sql`
    SELECT v.id AS vehicle_id, v.plate, COUNT(*)::int AS no_aptos
      FROM checklists c
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
     WHERE c.decision = 'no_apto'
       AND c.fecha_hora >= ${desde}::date
       AND c.fecha_hora < (${hasta}::date + INTERVAL '1 day')
       AND c.anulado_at IS NULL
     GROUP BY v.id, v.plate
     ORDER BY no_aptos DESC
     LIMIT 10
  `);
  const topVehiculos = ((topVehRes as any).rows ?? topVehRes as any[]) as any[];

  res.json({
    desde, hasta, umbralAlcohol,
    conductores_activos: conductoresActivos,
    inspecciones: {
      realizadas: inspeccionesRealizadas,
      esperadas: inspeccionesEsperadas,
      dias_laborales: labDays,
      pct: inspeccionesPct,
      no_aptos: noAptosCount,
    },
    alcoholimetria: {
      total: alcoholTotal,
      positivos: alcoholPositivos,
      positivos_pct: alcoholPositivosPct,
      alerta_umbral: alertaAlcohol,
    },
    simulacros: {
      ejecutados_anio: simulacrosCount,
      meta_anual: 1,
      cumple: simulacrosCount >= 1,
    },
    top_conductores_no_aptos: topConductores.map((r) => ({ userId: r.user_id, name: r.name, noAptos: r.no_aptos })),
    top_vehiculos_no_aptos: topVehiculos.map((r) => ({ vehicleId: r.vehicle_id, plate: r.plate, noAptos: r.no_aptos })),
  });
});

export default router;
