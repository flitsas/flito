import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// Pool de conexiones. 50 default cubre el peak combinado: OCR pipeline (5 páginas × 1-2 conn),
// 7 crons activos (reconciler, purge, laft-review, fleet-alerts, maintenance-schedule,
// driver-alerts, rndc-retry), y request handlers (1-3 conn cada uno). Bajo burst de 100 req
// concurrentes, 50 evita queueing indefinido y 504 timeouts.
// Override vía DB_POOL_MAX en .env si se requiere ajustar bajo carga.
const POOL_MAX = parseInt(process.env.DB_POOL_MAX || '50', 10);

const connection = postgres(env.DATABASE_URL, {
  max: POOL_MAX,
  idle_timeout: 30,
  ssl: false,
});

export const db = drizzle(connection, { schema });
export type Database = typeof db;

// Métricas de pool — exposed via /api/health/pool para monitoreo externo.
export interface PoolStats {
  max: number;
  activeBackends: number;
  waitingClients: number;
  utilization: number;
}

export async function getPoolStats(): Promise<PoolStats> {
  // pg_stat_activity = backends de PostgreSQL activos para esta BD/usuario.
  const rows = await db.execute<{ active: number; waiting: number }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE state IN ('active', 'idle in transaction'))::int AS active,
      COUNT(*) FILTER (WHERE wait_event_type = 'Client')::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database() AND application_name <> ''
  `);
  const r = (rows as unknown as Array<{ active: number; waiting: number }>)[0] ?? { active: 0, waiting: 0 };
  return {
    max: POOL_MAX,
    activeBackends: r.active,
    waitingClients: r.waiting,
    utilization: POOL_MAX > 0 ? Number((r.active / POOL_MAX).toFixed(2)) : 0,
  };
}
