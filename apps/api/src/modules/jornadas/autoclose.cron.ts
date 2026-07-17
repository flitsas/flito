import os from 'os';
import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jornadasConductor, jornadasAlarmas, jornadasPausas } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { JORNADA_LIMITS, computarAlarmasCierre } from './limits.js';
import { notifyJornadaAlarmas } from './notify.js';

const log = loggerFor('jornada-autoclose');

const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 30 * 60_000; // cada 30 min
const LOCK_TTL_MS = 25 * 60_000;
let timer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  await withLock(`jornada-autoclose:${HOST_ID}`, LOCK_TTL_MS, async () => {
    const threshold = new Date(Date.now() - JORNADA_LIMITS.AUTOCLOSE_HORAS * 60 * 60_000);
    const candidatas = await db.select().from(jornadasConductor)
      .where(and(eq(jornadasConductor.cerrada, false), lte(jornadasConductor.inicioAt, threshold)));
    if (!candidatas.length) {
      log.info({ candidatos: 0 }, 'sin jornadas zombi');
      return;
    }
    log.info({ candidatos: candidatas.length }, 'cerrando jornadas zombi');
    let cerradas = 0;
    for (const j of candidatas) {
      try {
        await db.transaction(async (tx) => {
          // Re-check con FOR UPDATE para evitar race con cierre manual.
          const [current] = await tx.select().from(jornadasConductor).where(eq(jornadasConductor.id, j.id)).for('update').limit(1);
          if (!current || current.cerrada) return;
          const finAt = new Date();
          // Cerrar pausa abierta si la hubiera.
          await tx.update(jornadasPausas).set({ finAt }).where(and(eq(jornadasPausas.jornadaId, j.id), eq(jornadasPausas.finAt, null as any)));
          const [closed] = await tx.update(jornadasConductor).set({
            finAt,
            cerrada: true,
            cerradaAutomatica: true,
            optimisticV: current.optimisticV + 1,
            observaciones: 'Cierre automático por exceder ' + JORNADA_LIMITS.AUTOCLOSE_HORAS + 'h sin cerrar',
          }).where(eq(jornadasConductor.id, j.id)).returning();
          // Computar alarmas (incluye semanal acumulada)
          const pausas = await tx.select().from(jornadasPausas).where(eq(jornadasPausas.jornadaId, j.id));
          const pausasMin = pausas.reduce((s, p) => s + (p.duracionMin ?? 0), 0);
          const horasCond = Number(closed.horasConduccion ?? 0);
          const horasDescPre = closed.horasDescansoPre !== null ? Number(closed.horasDescansoPre) : null;
          const semanaRows = await tx.execute(sql`
            SELECT COALESCE(SUM(horas_conduccion), 0)::float AS horas
            FROM jornadas_conductor
            WHERE conductor_id = ${j.conductorId}
              AND cerrada = true
              AND date_trunc('week', inicio_at) = date_trunc('week', ${new Date(closed.inicioAt as any).toISOString()}::timestamptz)
          ` as any) as any;
          const horasSemana = Number((semanaRows?.rows?.[0] ?? semanaRows?.[0])?.horas ?? 0);
          const alarmas = computarAlarmasCierre({ horasConduccion: horasCond, horasDescansoPre: horasDescPre, pausasMinTotales: pausasMin, horasSemanaAcumulada: horasSemana });
          if (alarmas.length) {
            await tx.insert(jornadasAlarmas).values(alarmas.map((a) => ({
              jornadaId: j.id,
              tipo: a.tipo,
              valorObservado: String(a.valorObservado),
              valorLimite: String(a.valorLimite),
              unidad: a.unidad,
            })));
          }
          cerradas++;
          // Notificar admins post-cierre auto (best-effort fuera de tx).
          if (alarmas.length) {
            notifyJornadaAlarmas({ conductorId: j.conductorId, jornadaId: j.id, alarmas })
              .catch((e) => log.error({ err: e?.message, jornadaId: j.id }, 'fallo notificar alarmas autoclose'));
          }
        });
      } catch (e: any) {
        log.error({ err: e?.message, jornadaId: j.id }, 'fallo cerrando jornada zombi');
      }
    }
    log.info({ cerradas, candidatos: candidatas.length }, 'autoclose corrida completada');
  });
}

export function startJornadaAutocloseCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalMin: RUN_INTERVAL_MS / 60_000, autocloseHoras: JORNADA_LIMITS.AUTOCLOSE_HORAS }, 'cron activo');
  timer = setInterval(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'runOnce throw')); }, RUN_INTERVAL_MS);
  // Primera corrida tras 60s para no chocar con boot.
  setTimeout(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'first runOnce throw')); }, 60_000);
}

export function stopJornadaAutocloseCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron detenido');
}
