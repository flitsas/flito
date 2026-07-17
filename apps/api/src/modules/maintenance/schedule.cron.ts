import os from 'os';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('maintenance-schedule');

// Cron diario que recalcula schedule de mantenimiento para vehículos de flota.
// Algoritmo por (vehículo, rutina aplicable):
//   1. Calcula última medición real del vehículo
//   2. Busca última fecha de ejecución de esa rutina en este vehículo
//   3. Calcula próxima medición objetivo = última_medicion + km_periodo
//   4. Estima fecha = hoy + (next_medicion - odom_actual) / promedio_dia
//   5. Si dias_periodo también está, fecha = MIN(estimada, last_fecha + dias_periodo)
//   6. UPSERT en schedule (UNIQUE parcial garantiza idempotencia)
// Idempotencia: UNIQUE(vehicle_id, routine_id, fecha_programada) WHERE estado='pendiente'.

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;
const TARGET_HOUR = 6;
const TARGET_MIN = 15;
const PROMEDIO_DIA_DEFAULT = 100; // fallback si vehículo no lo tiene configurado

interface ScheduleStats {
  vehiculos: number;
  rutinas_evaluadas: number;
  schedules_creados: number;
  schedules_actualizados: number;
  vencidas_marcadas: number;
}

export async function runScheduleOnce(): Promise<ScheduleStats> {
  const result = await withLock('maintenance-schedule', LOCK_TTL_MS, async () => {
    const stats: ScheduleStats = {
      vehiculos: 0, rutinas_evaluadas: 0, schedules_creados: 0,
      schedules_actualizados: 0, vencidas_marcadas: 0,
    };

    // 1) Marcar como vencidas las pendientes con fecha + 7 días en el pasado.
    const vencidas = await db.execute(sql`
      UPDATE maintenance_schedule
         SET estado = 'vencida', updated_at = NOW()
       WHERE estado = 'pendiente'
         AND fecha_programada < CURRENT_DATE - INTERVAL '7 days'
       RETURNING id
    `);
    stats.vencidas_marcadas = ((vencidas as any).rows ?? vencidas as any[]).length;

    // 2) Para cada vehículo de flota propia, evaluar rutinas aplicables.
    // Usa SQL para resolver criterios y last measurements en una sola query por vehículo.
    const vehiculos = await db.execute<{ id: number; tipo_vehiculo: string | null; combustible: string | null; promedio_dia: number | null; odom_actual: number | null }>(sql`
      SELECT
        v.id,
        v.tipo_vehiculo::text AS tipo_vehiculo,
        v.combustible_principal::text AS combustible,
        v.dist_promedio_dia AS promedio_dia,
        (SELECT MAX(odometro) FROM vehicle_measurements WHERE vehicle_id = v.id) AS odom_actual
      FROM vehicles v
      WHERE v.es_flota_propia = true
    `);
    const vehRows = (vehiculos as any).rows ?? vehiculos as any[];
    stats.vehiculos = vehRows.length;

    for (const v of vehRows) {
      // Rutinas aplicables: por vehículo, por tipo, o por combustible.
      const rutinas = await db.execute<{ routine_id: number; km_periodo: number | null; horas_periodo: number | null; dias_periodo: number | null }>(sql`
        SELECT DISTINCT rp.routine_id, rp.km_periodo, rp.horas_periodo, rp.dias_periodo
          FROM routine_periodicity rp
          JOIN maintenance_routines mr ON mr.id = rp.routine_id AND mr.activo = true
         WHERE (rp.criterio = 'vehicle' AND rp.ref_id = ${v.id})
            OR (rp.criterio = 'tipo_vehiculo' AND rp.tipo_vehiculo::text = ${v.tipo_vehiculo})
            OR (rp.criterio = 'combustible' AND rp.combustible::text = ${v.combustible})
      `);
      const rutRows = (rutinas as any).rows ?? rutinas as any[];

      for (const r of rutRows) {
        stats.rutinas_evaluadas++;

        // Última ejecución de la rutina en este vehículo (cuando exista módulo OT).
        // Por ahora se considera "última" la del schedule ejecutado más reciente.
        const ultExecRes = await db.execute<{ fecha: string | null; medicion: number | null }>(sql`
          SELECT fecha_programada::text AS fecha, medicion_programada AS medicion
            FROM maintenance_schedule
           WHERE vehicle_id = ${v.id} AND routine_id = ${r.routine_id} AND estado = 'ejecutada'
           ORDER BY fecha_programada DESC LIMIT 1
        `);
        const ultExec = ((ultExecRes as any).rows ?? ultExecRes as any[])[0];

        const promedioDia = v.promedio_dia && v.promedio_dia > 0 ? v.promedio_dia : PROMEDIO_DIA_DEFAULT;
        const baseMedicion = ultExec?.medicion ?? v.odom_actual ?? 0;
        const baseFecha = ultExec?.fecha ? new Date(ultExec.fecha) : new Date();

        let proxFecha: Date | null = null;
        let proxMedicion: number | null = null;

        if (r.km_periodo) {
          const next = baseMedicion + r.km_periodo;
          proxMedicion = next;
          if (v.odom_actual != null) {
            const diasFalta = Math.max(0, Math.round((next - v.odom_actual) / promedioDia));
            proxFecha = new Date(Date.now() + diasFalta * 86_400_000);
          }
        }
        if (r.dias_periodo) {
          const fechaPorDias = new Date(baseFecha.getTime() + r.dias_periodo * 86_400_000);
          if (!proxFecha || fechaPorDias < proxFecha) proxFecha = fechaPorDias;
        }
        if (!proxFecha) continue;

        // UPSERT con índice único parcial (vehicle_id, routine_id, fecha_programada) WHERE estado='pendiente'.
        const fechaStr = proxFecha.toISOString().slice(0, 10);
        const upsert = await db.execute(sql`
          INSERT INTO maintenance_schedule (vehicle_id, routine_id, fecha_programada, medicion_programada, tipo, estado)
          VALUES (${v.id}, ${r.routine_id}, ${fechaStr}::date, ${proxMedicion ?? null}, 'automatica', 'pendiente')
          ON CONFLICT (vehicle_id, routine_id, fecha_programada) WHERE estado = 'pendiente'
          DO UPDATE SET medicion_programada = EXCLUDED.medicion_programada, updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `);
        const upsertRow = ((upsert as any).rows ?? upsert as any[])[0];
        if (upsertRow?.inserted) stats.schedules_creados++;
        else stats.schedules_actualizados++;
      }
    }
    return stats;
  });
  return result ?? { vehiculos: 0, rutinas_evaluadas: 0, schedules_creados: 0, schedules_actualizados: 0, vencidas_marcadas: 0 };
}

function msUntilTarget(): number {
  const now = new Date();
  const next = new Date();
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export function startScheduleCron(): void {
  if (firstTimer || intervalTimer) return;
  const delay = msUntilTarget();
  log.info({ host: HOST_ID, firstRunMin: Math.round(delay / 60_000), intervalH: 24 }, 'Activo');

  firstTimer = setTimeout(async () => {
    try {
      const r = await runScheduleOnce();
      log.info({ vehiculos: r.vehiculos, rutinas: r.rutinas_evaluadas, creados: r.schedules_creados, actualizados: r.schedules_actualizados, vencidas: r.vencidas_marcadas }, 'corrida completada');
    } catch (e) { log.error({ err: e }, 'corrida falló'); }
    intervalTimer = setInterval(async () => {
      try {
        const r = await runScheduleOnce();
        log.info({ vehiculos: r.vehiculos, rutinas: r.rutinas_evaluadas, creados: r.schedules_creados, actualizados: r.schedules_actualizados, vencidas: r.vencidas_marcadas }, 'corrida completada');
      } catch (e) { log.error({ err: e }, 'corrida falló'); }
    }, RUN_INTERVAL_MS);
    intervalTimer.unref();
  }, delay);
  firstTimer.unref();
}

export function stopScheduleCron(): void {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  log.info('Detenido');
}
