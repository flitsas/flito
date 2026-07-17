// Cron único PESV que corre cada hora y despacha 5 lógicas según fecha/hora actual:
//
// 1. reportes-mensuales-jornada — día 1 del mes a las 02:00. Genera/regenera
//    jornadas_reportes_mensuales para todos los conductores activos del mes anterior.
// 2. scan-60h-semanal — lunes a las 06:00. Detecta conductores que cerraron la semana
//    anterior con >60h acumuladas y encola alerta email (sin esperar a próxima jornada).
// 3. recordatorio-diagnostico-anual — 1-nov a las 09:00. Si no hay pesv_diagnosticos del
//    año en curso, encola email a admins para crearlo (Res. 40595 exige diagnóstico anual).
// 4. recordatorio-plan-pesv — 1-dic a las 09:00. Cierra plan vigente del año + recordatorio
//    para crear el del próximo año.
// 5. analisis-riesgo-trimestral — 1° de cada Q a las 09:00. Por cada ruta activa sin
//    análisis del trimestre actual, encola email recordatorio.
//
// Patrón de concurrencia: withLock por periodo único (e.g. 'pesv-reporte-2026-05')
// previene doble disparo entre instancias. Idempotencia BD-side via UNIQUE constraints.

import os from 'os';
import { and, eq, gte, lte, sql, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  jornadasConductor, jornadasReportesMensuales, users,
  pesvDiagnosticos, pesvPlanAnual, routes, routeRiskAnalyses,
  pesvNormativa,
} from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';
import { JORNADA_LIMITS } from '../jornadas/limits.js';
import { notifyPesvAdmin } from '../jornadas/notify.js';

const log = loggerFor('pesv-recordatorios');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 60 * 60_000; // cada hora
const LOCK_TTL_MS = 50 * 60_000;
let timer: NodeJS.Timeout | null = null;

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function periodoMes(d: Date): { anio: number; mes: number } { return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }; }
function semanaLunes(d: Date): Date { const x = new Date(d); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() - day + 1); x.setUTCHours(0, 0, 0, 0); return x; }
function trimestreDe(d: Date): string { const q = Math.floor(d.getUTCMonth() / 3) + 1; return `${d.getUTCFullYear()}-Q${q}`; }

// ============ 1. Reportes mensuales jornada ============
async function tryReportesMensualesJornada(now: Date): Promise<void> {
  if (now.getUTCDate() !== 1 || now.getUTCHours() !== 2) return;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const { anio, mes } = periodoMes(prev);
  const slot = `pesv-reporte-mensual-${anio}-${pad2(mes)}`;
  await withLock(slot, LOCK_TTL_MS, async () => {
    const inicio = new Date(Date.UTC(anio, mes - 1, 1));
    const fin = new Date(Date.UTC(anio, mes, 1));
    const inicioIso = inicio.toISOString();
    const finIso = fin.toISOString();
    // Conductores con al menos 1 jornada cerrada en el mes.
    const rows = await db.execute(sql`
      SELECT DISTINCT conductor_id FROM jornadas_conductor
       WHERE cerrada = true AND inicio_at >= ${inicioIso}::timestamptz AND inicio_at < ${finIso}::timestamptz
    ` as any) as any;
    const conductorIds = ((rows?.rows ?? rows ?? []) as any[]).map((r: any) => Number(r.conductor_id));
    log.info({ anio, mes, candidatos: conductorIds.length }, 'reportes mensuales — generando');
    let creados = 0;
    for (const cid of conductorIds) {
      try {
        await db.transaction(async (tx) => {
          const jornadasMes = await tx.select().from(jornadasConductor)
            .where(and(eq(jornadasConductor.conductorId, cid), gte(jornadasConductor.inicioAt, inicio), lte(jornadasConductor.inicioAt, fin)));
          const cerradasIds = jornadasMes.filter((j) => j.cerrada).map((j) => j.id);
          let alarmasCount = 0;
          if (cerradasIds.length) {
            const idsList = sql.join(cerradasIds.map((i) => sql`${i}`), sql`, `);
            const aRows = await tx.execute(sql`
              SELECT count(*)::int AS c FROM jornadas_alarmas WHERE jornada_id IN (${idsList})
            ` as any) as any;
            alarmasCount = Number((aRows?.rows?.[0] ?? aRows?.[0])?.c ?? 0);
          }
          const horasTotales = jornadasMes.reduce((s, j) => s + Number(j.horasConduccion ?? 0), 0);
          const cumple = alarmasCount === 0 && horasTotales <= JORNADA_LIMITS.MAX_MENSUAL_HORAS;
          await tx.delete(jornadasReportesMensuales)
            .where(and(eq(jornadasReportesMensuales.conductorId, cid), eq(jornadasReportesMensuales.anio, anio), eq(jornadasReportesMensuales.mes, mes)));
          await tx.insert(jornadasReportesMensuales).values({
            conductorId: cid, anio, mes,
            jornadasCount: jornadasMes.length,
            horasTotales: horasTotales.toFixed(2),
            alarmasCount,
            cumpleNorma: cumple,
            detalleJsonb: { generadoPor: 'cron', host: HOST_ID, generadoEn: now.toISOString() },
          });
        });
        creados++;
      } catch (e: any) {
        log.error({ err: e?.message, conductorId: cid }, 'fallo generando reporte');
      }
    }
    log.info({ anio, mes, creados, candidatos: conductorIds.length }, 'reportes mensuales — completado');
  });
}

// ============ 2. Scan 60h semanal ============
async function tryScan60hSemanal(now: Date): Promise<void> {
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 6) return; // lunes 06:00 UTC
  const lunesPrev = semanaLunes(new Date(now.getTime() - 7 * 24 * 3600_000));
  const slot = `pesv-scan-60h-${lunesPrev.toISOString().slice(0, 10)}`;
  await withLock(slot, LOCK_TTL_MS, async () => {
    const fin = new Date(lunesPrev.getTime() + 7 * 24 * 3600_000);
    const lunesIso = lunesPrev.toISOString();
    const finIso = fin.toISOString();
    const rows = await db.execute(sql`
      SELECT conductor_id, SUM(horas_conduccion)::float AS horas
        FROM jornadas_conductor
       WHERE cerrada = true AND inicio_at >= ${lunesIso}::timestamptz AND inicio_at < ${finIso}::timestamptz
       GROUP BY conductor_id
       HAVING SUM(horas_conduccion) > ${JORNADA_LIMITS.MAX_SEMANAL_HORAS}
    ` as any) as any;
    const violadores = ((rows?.rows ?? rows ?? []) as any[]) as Array<{ conductor_id: number; horas: number }>;
    log.info({ semana: lunesPrev.toISOString().slice(0, 10), violadores: violadores.length }, 'scan 60h semanal — completado');
    if (!violadores.length) return;

    const items = violadores.map((v) => `<li>Conductor #${v.conductor_id} — <strong>${Number(v.horas).toFixed(2)}h</strong> (límite 60h)</li>`).join('');
    await notifyPesvAdmin({
      contextoTipo: 'pesv_scan_60h_semanal',
      asunto: `Alerta PESV — ${violadores.length} conductor(es) excedieron 60h en la semana del ${lunesPrev.toISOString().slice(0, 10)}`,
      cuerpoHtml: `<h3>Conductores con jornada acumulada >60h (Decreto 1079/2015)</h3><ul>${items}</ul><p>Revisar el módulo PESV → Control de jornada para detalle por conductor y considerar acciones correctivas.</p>`,
    });
  });
}

// ============ 3. Recordatorio diagnóstico anual ============
async function tryRecordatorioDiagnostico(now: Date): Promise<void> {
  if (now.getUTCMonth() !== 10 || now.getUTCDate() !== 1 || now.getUTCHours() !== 9) return; // 1-nov 09:00
  const anio = now.getUTCFullYear();
  await withLock(`pesv-recordatorio-diagnostico-${anio}`, LOCK_TTL_MS, async () => {
    const [existing] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.anio, anio)).limit(1);
    if (existing) {
      log.info({ anio }, 'diagnóstico ya existe — sin recordatorio');
      return;
    }
    await notifyPesvAdmin({
      contextoTipo: 'pesv_recordatorio_diagnostico',
      contextoId: anio,
      asunto: `Recordatorio PESV — falta diagnóstico anual ${anio}`,
      cuerpoHtml: `<p>La Resolución 40595/2022 exige <strong>diagnóstico anual</strong> del PESV. Aún no se ha registrado el diagnóstico ${anio}.</p><p>Acción: ingresar a PESV → Diagnóstico → "Nuevo diagnóstico" antes del 31 de diciembre.</p>`,
    });
  });
}

// ============ 4. Recordatorio plan PESV anual ============
async function tryRecordatorioPlanPesv(now: Date): Promise<void> {
  if (now.getUTCMonth() !== 11 || now.getUTCDate() !== 1 || now.getUTCHours() !== 9) return; // 1-dic 09:00
  const anioActual = now.getUTCFullYear();
  const anioProx = anioActual + 1;
  await withLock(`pesv-recordatorio-plan-${anioActual}`, LOCK_TTL_MS, async () => {
    const [planActual] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anioActual)).limit(1);
    const [planProx] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anioProx)).limit(1);

    const lineas: string[] = [];
    if (planActual && planActual.estado !== 'cerrado') lineas.push(`<li>Plan ${anioActual} aún en estado <strong>${planActual.estado}</strong> — debe cerrarse antes del 31 de diciembre.</li>`);
    if (!planProx) lineas.push(`<li>No hay plan PESV para <strong>${anioProx}</strong>. Crear y aprobar antes del 31 de diciembre.</li>`);
    if (!lineas.length) {
      log.info({ anioActual, anioProx }, 'plan PESV en orden — sin recordatorio');
      return;
    }
    await notifyPesvAdmin({
      contextoTipo: 'pesv_recordatorio_plan',
      contextoId: anioActual,
      asunto: `Recordatorio PESV — cierre ${anioActual} + plan ${anioProx}`,
      cuerpoHtml: `<h3>Acciones pendientes plan PESV</h3><ul>${lineas.join('')}</ul><p>Acceder a PESV → Plan Anual.</p>`,
    });
  });
}

// ============ 5. Análisis riesgo trimestral ============
async function tryAnalisisRiesgoTrimestral(now: Date): Promise<void> {
  // Disparar el 1° de enero, abril, julio, octubre a las 09:00 UTC.
  const firstOfQuarter = (now.getUTCMonth() % 3 === 0) && now.getUTCDate() === 1 && now.getUTCHours() === 9;
  if (!firstOfQuarter) return;
  const trimestre = trimestreDe(now);
  await withLock(`pesv-recordatorio-riesgo-${trimestre}`, LOCK_TTL_MS, async () => {
    const rutas = await db.select().from(routes).where(eq(routes.activo, true));
    if (!rutas.length) return;
    const rutaIds = rutas.map((r) => r.id);
    const idsList = sql.join(rutaIds.map((i) => sql`${i}`), sql`, `);
    const analyses = await db.execute(sql`
      SELECT route_id FROM route_risk_analyses
       WHERE route_id IN (${idsList}) AND trimestre = ${trimestre}
    ` as any) as any;
    const conAnalisis = new Set(((analyses?.rows ?? analyses ?? []) as any[]).map((a: any) => Number(a.route_id)));
    const faltantes = rutas.filter((r) => !conAnalisis.has(r.id));
    if (!faltantes.length) {
      log.info({ trimestre }, 'todas las rutas tienen análisis trimestral');
      return;
    }
    const items = faltantes.map((r) => `<li>${r.codigo} — ${r.nombre} (criticidad ${r.criticidad})</li>`).join('');
    await notifyPesvAdmin({
      contextoTipo: 'pesv_recordatorio_riesgo_trimestral',
      asunto: `Recordatorio PESV — ${faltantes.length} ruta(s) sin análisis de riesgo ${trimestre}`,
      cuerpoHtml: `<h3>Rutas sin análisis de riesgo del trimestre ${trimestre}</h3><ul>${items}</ul><p>Acción: PESV → Rutas → seleccionar ruta → Nuevo análisis.</p>`,
    });
  });
}

// ============ 6. Recordatorio revisión normativa (PESV-S9 Paso 1.7) ============
// Lunes a las 09:00 UTC. Encola email si hay normativa con próxima_revision_at <= now + 30 días.
async function tryRecordatorioRevisionNormativa(now: Date): Promise<void> {
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return;
  const semana = `${now.getUTCFullYear()}-W${pad2(Math.ceil(((now.getTime() - new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).getTime()) / 86400000 + 1) / 7))}`;
  await withLock(`pesv-norm-revision-${semana}`, LOCK_TTL_MS, async () => {
    const limite = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const proximas = await db.select({
      codigo: pesvNormativa.codigo, titulo: pesvNormativa.titulo,
      proxima: pesvNormativa.proximaRevisionAt,
    }).from(pesvNormativa)
      .where(and(eq(pesvNormativa.vigente, true), lte(pesvNormativa.proximaRevisionAt, limite)))
      .orderBy(pesvNormativa.proximaRevisionAt)
      .limit(50);
    if (!proximas.length) {
      log.info({ semana }, 'sin normativa próxima a revisar');
      return;
    }
    const items = proximas.map((n) => `<li><strong>${n.codigo}</strong> — ${n.titulo} (próxima rev: ${n.proxima?.toISOString().slice(0, 10)})</li>`).join('');
    await notifyPesvAdmin({
      contextoTipo: 'pesv_recordatorio_revision_normativa',
      asunto: `Recordatorio PESV — ${proximas.length} norma(s) por revisar en próximos 30 días`,
      cuerpoHtml: `<h3>Normativa próxima a revisar</h3><ul>${items}</ul><p>Acción: PESV → Tracker normativo → marcar como revisada.</p>`,
    });
    log.info({ semana, count: proximas.length }, 'recordatorio revisión normativa enviado');
  });
}

async function runOnce(): Promise<void> {
  const now = new Date();
  await Promise.allSettled([
    tryReportesMensualesJornada(now),
    tryScan60hSemanal(now),
    tryRecordatorioDiagnostico(now),
    tryRecordatorioPlanPesv(now),
    tryAnalisisRiesgoTrimestral(now),
    tryRecordatorioRevisionNormativa(now),
  ]);
}

export function startPesvRecordatoriosCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalH: 1 }, 'cron PESV recordatorios activo');
  // Primer disparo en 5 min (ventana de gracia post-boot), luego cada hora.
  setTimeout(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'first runOnce throw')); }, 5 * 60_000);
  timer = setInterval(() => { runOnce().catch((e) => log.error({ err: e?.message }, 'runOnce throw')); }, RUN_INTERVAL_MS);
}

export function stopPesvRecordatoriosCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron PESV recordatorios detenido');
}

// Exports para tests directos.
export const _internal = {
  tryReportesMensualesJornada, tryScan60hSemanal, tryRecordatorioDiagnostico,
  tryRecordatorioPlanPesv, tryAnalisisRiesgoTrimestral,
  tryRecordatorioRevisionNormativa,
  semanaLunes, trimestreDe, periodoMes,
};
