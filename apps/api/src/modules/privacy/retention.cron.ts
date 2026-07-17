import os from 'os';
import { and, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesValidaciones } from '../../db/schema.js';
import { withLock } from '../../shared/utils/lock.js';
import { logger } from '../../shared/logger.js';
import { deletePhoto } from '../../services/storage.js';
import { env } from '../../config/env.js';

/**
 * Cron de retención PII para tramites_validaciones — Ley 1581 art. 11 (no más
 * tiempo del necesario) e ISO 27001 A.8.10 (eliminación de información).
 *
 * Política: 90 días después de expira_at, anonimizar fotos selfie/cédula y
 * geolocalización. Conservamos metadata (token, score, estado, fechas) por
 * trazabilidad y posibles disputas.
 *
 * Excluye explícitamente registros en estado 'en_disputa' o 'en_revision'
 * para no destruir evidencia activa.
 *
 * Por defecto DESHABILITADO. Se enciende vía env `PRIVACY_RETENTION_CRON_ENABLED=1`
 * solo después de que P0-NEG-3 (privacy/forget completo) y P0-NEG-4 (cifrado PII)
 * estén desplegados y estables 48h en producción.
 */

const log = logger.child({ component: 'privacy-retention' });
const HOST_ID = `${os.hostname()}-${process.pid}`;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 min, idempotente
const RETENTION_DAYS = 90;

const EXCLUDED_ESTADOS = ['en_disputa', 'en_revision'] as const;

interface PurgeResult {
  scanned: number;
  anonymized: number;
  dryRun: boolean;
}

/**
 * Ejecuta una pasada de la purga. Si dryRun=true solo cuenta candidatos sin tocar BD.
 * Si otra instancia tiene el lock, retorna scanned=0/anonymized=0 (no es error).
 */
export async function runRetentionOnce(opts: { dryRun?: boolean } = {}): Promise<PurgeResult> {
  const dryRun = opts.dryRun ?? false;

  const result = await withLock('privacy-retention-cron', LOCK_TTL_MS, async (): Promise<PurgeResult> => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const baseWhere = and(
      lt(tramitesValidaciones.expiraAt, cutoff),
      // Solo filas que aún tienen al menos UNA foto cargada (idempotencia).
      sql`(${tramitesValidaciones.fotoRostro} IS NOT NULL
           OR ${tramitesValidaciones.fotoCedulaFrontal} IS NOT NULL
           OR ${tramitesValidaciones.fotoCedulaReverso} IS NOT NULL)`,
      notInArray(tramitesValidaciones.estado, EXCLUDED_ESTADOS as unknown as string[]),
    );

    if (dryRun) {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(tramitesValidaciones)
        .where(baseWhere);
      log.info({ candidates: count, cutoff: cutoff.toISOString() }, 'dry-run: candidatos a anonimizar');
      return { scanned: count, anonymized: 0, dryRun: true };
    }

    // Snapshot previo para conocer las keys S3 que hay que borrar.
    // Si no las borramos del object storage, dejamos PII huérfana en MinIO incumpliendo
    // Ley 1581 art. 11 ("no más tiempo del necesario"). Lifecycle MinIO es red de respaldo.
    const candidates = await db.select({
      id: tramitesValidaciones.id,
      fotoRostro: tramitesValidaciones.fotoRostro,
      fotoCedulaFrontal: tramitesValidaciones.fotoCedulaFrontal,
      fotoCedulaReverso: tramitesValidaciones.fotoCedulaReverso,
    }).from(tramitesValidaciones).where(baseWhere);

    let s3Deleted = 0;
    for (const r of candidates) {
      for (const v of [r.fotoRostro, r.fotoCedulaFrontal, r.fotoCedulaReverso]) {
        // Solo intentar borrar si parece una key S3 (formato `validaciones/<tramiteId>/<tipo>_<hex>.jpg`).
        // Las legacy cifradas (`<iv>:<tag>:<b64>`) o base64 plano se anonimizan vía UPDATE BD.
        if (v && v.startsWith('validaciones/')) {
          try { await deletePhoto(v); s3Deleted++; }
          catch (e) { log.warn({ key: v, err: (e as Error).message }, 'no se pudo borrar objeto S3 (continúa)'); }
        }
      }
    }

    const updated = await db.update(tramitesValidaciones)
      .set({
        fotoRostro: null,
        fotoCedulaFrontal: null,
        fotoCedulaReverso: null,
        ipAddress: null,
        lat: null,
        lng: null,
        userAgent: null,
      })
      .where(and(
        baseWhere,
        isNotNull(tramitesValidaciones.id),
      ))
      .returning({ id: tramitesValidaciones.id });

    if (updated.length > 0) {
      log.info({ anonymized: updated.length, s3Deleted, cutoff: cutoff.toISOString() }, 'fotos PII anonimizadas por retención');
    }
    return { scanned: updated.length, anonymized: updated.length, dryRun: false };
  });

  return result ?? { scanned: 0, anonymized: 0, dryRun };
}

let timer: NodeJS.Timeout | null = null;

export function startRetentionCron(): void {
  if (timer) return;
  if (!env.PRIVACY_RETENTION_CRON_ENABLED) {
    log.info({ host: HOST_ID }, 'cron de retención DESHABILITADO (PRIVACY_RETENTION_CRON_ENABLED!=1)');
    return;
  }
  log.info({ host: HOST_ID, intervalHours: 24, retentionDays: RETENTION_DAYS }, 'cron de retención ACTIVO');

  // Primera corrida tras 5 min para no competir con startup.
  setTimeout(async () => {
    try { await runRetentionOnce(); }
    catch (e) { log.error({ err: e }, 'error en primera corrida'); }
  }, 5 * 60 * 1000).unref();

  timer = setInterval(async () => {
    try { await runRetentionOnce(); }
    catch (e) { log.error({ err: e }, 'error en corrida periódica'); }
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopRetentionCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('cron detenido'); }
}
