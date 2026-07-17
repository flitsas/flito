// PESV-S9 · Paso 19 — Cron de retención documental Ley 594/2000
//
// Modo DRY-RUN diario seguro: para cada política habilitada cuenta cuántos registros
// están fuera del periodo de retención y deja huella en pesv_retencion_log. NO toca
// datos productivos automáticamente.
//
// La ejecución real debe iniciarse vía endpoint admin POST /api/pesv/retencion/run con
// confirm:true (auditoría manual + revisión humana). Esto cumple Ley 594/2000 (existe
// política + se documenta cumplimiento) sin riesgo de borrado autónomo.

import os from 'os';
import { eq, lte, sql, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvRetencionPoliticas, pesvRetencionLog } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('pesv-retencion');
const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60_000; // diario
const LOCK_TTL_MS = 23 * 60 * 60_000;
let timer: NodeJS.Timeout | null = null;

// Mapa tipoDocumento → SQL count para DRY-RUN. Conservador: tablas que existen hoy.
const COUNT_QUERIES: Record<string, (cutoff: string) => any> = {
  pii_access_log: (cutoff) => sql`SELECT count(*)::int AS c FROM pii_access_log WHERE accessed_at < ${cutoff}::timestamptz`,
  audit_log: (cutoff) => sql`SELECT count(*)::int AS c FROM audit_logs WHERE created_at < ${cutoff}::timestamptz`,
  alcohol_test: (cutoff) => sql`SELECT count(*)::int AS c FROM alcohol_tests WHERE created_at < ${cutoff}::timestamptz`,
  checklist: (cutoff) => sql`SELECT count(*)::int AS c FROM checklists WHERE created_at < ${cutoff}::timestamptz`,
  manifiesto: (cutoff) => sql`SELECT count(*)::int AS c FROM manifiestos WHERE created_at < ${cutoff}::timestamptz`,
  incidente_vial: (cutoff) => sql`SELECT count(*)::int AS c FROM road_incidents WHERE created_at < ${cutoff}::timestamptz`,
  acta_comite: (cutoff) => sql`SELECT count(*)::int AS c FROM pesv_comite_actas WHERE created_at < ${cutoff}::timestamptz`,
  // Evidencia documental del auto-diagnóstico PHVA: total de claves MinIO (no items) en
  // diagnósticos cerrados anteriores al cutoff. El borrado real (sprint 2) tendrá que
  // recorrer evidencia_keys[] y eliminar objects en bucket.
  pesv_diagnostico_evidencia: (cutoff) => sql`
    SELECT COALESCE(SUM(array_length(i.evidencia_keys, 1)), 0)::int AS c
      FROM pesv_diagnostico_items i
      JOIN pesv_diagnosticos d ON d.id = i.diagnostico_id
     WHERE d.estado = 'cerrado'
       AND d.cerrado_at < ${cutoff}::timestamptz
       AND array_length(i.evidencia_keys, 1) > 0
  `,
};

async function runDryRun(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const slot = `pesv-retencion-${today}`;
  await withLock(slot, LOCK_TTL_MS, async () => {
    const politicas = await db.select().from(pesvRetencionPoliticas).where(eq(pesvRetencionPoliticas.habilitado, true));
    if (!politicas.length) {
      log.info('sin políticas habilitadas');
      return;
    }
    for (const p of politicas) {
      try {
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - p.retencionAnios);
        const cutoffDate = cutoff.toISOString().slice(0, 10);
        const counter = COUNT_QUERIES[p.tipoDocumento];
        let cantidad = 0;
        let detalle = `DRY-RUN ${cutoffDate}. `;
        if (counter) {
          const result = await db.execute(counter(cutoff.toISOString())) as any;
          const rows = (result?.rows ?? result ?? []) as any[];
          cantidad = Number(rows[0]?.c ?? 0);
          detalle += `count=${cantidad}.`;
        } else {
          detalle += 'tipo sin query implementada (placeholder).';
        }
        await db.insert(pesvRetencionLog).values({
          politicaId: p.id,
          tipoDocumento: p.tipoDocumento,
          cantidadAfectada: 0, // DRY-RUN: nunca toca datos
          cutoffDate,
          accion: p.accion,
          ejecutadoPorCron: true,
          ejecutadoPorUser: null,
          detalleMd: detalle,
        });
        if (cantidad > 0) {
          log.info({ tipo: p.tipoDocumento, cantidad, cutoffDate }, 'política con registros fuera de retención');
        }
      } catch (e: any) {
        log.error({ err: e?.message, tipo: p.tipoDocumento }, 'error procesando política');
      }
    }
  });
}

export function startRetencionCron(): void {
  if (timer) return;
  log.info({ host: HOST_ID, intervalH: 24 }, 'cron PESV retención (DRY-RUN) activo');
  // Primer disparo en 10 min, luego cada 24h.
  setTimeout(() => { runDryRun().catch((e) => log.error({ err: e?.message }, 'first runDryRun throw')); }, 10 * 60_000);
  timer = setInterval(() => { runDryRun().catch((e) => log.error({ err: e?.message }, 'runDryRun throw')); }, RUN_INTERVAL_MS);
}

export function stopRetencionCron(): void {
  if (timer) { clearInterval(timer); timer = null; }
  log.info('cron PESV retención detenido');
}

export const _internal = { runDryRun, COUNT_QUERIES };
