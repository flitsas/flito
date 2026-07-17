// RUM — ingesta de Web Vitals de campo (FIONA PR2).
//
// POST /api/rum  — público (las vitals se reportan también pre-login), sin auth.
// El navegador envía cada métrica final vía navigator.sendBeacon. Guardamos una
// fila por métrica para poder calcular p75 por ruta/dispositivo sobre tráfico real.
//
// Defensa: rate-limit por IP, validación estricta del payload (whitelist de
// métricas + rango de valor), recorte de longitudes, y NUNCA fallar el beacon
// (responder 204 siempre; un error de telemetría no debe afectar al usuario).

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rumWebVitals } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

const router = Router();

const METRICS = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);

// 240/min/IP: holgado para una sesión (5 métricas × varias navegaciones SPA),
// pero corta inundación de filas desde un solo origen.
const rumLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate' },
});

const clip = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null;

// p75 por métrica/ruta/device — solo admin, para reportes FIONA sin acceso directo a BD.
router.get('/summary', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const minSamples = Math.min(100, Math.max(1, Number(req.query.min) || 3));

    const rows = await db.execute(sql`
      SELECT
        metric,
        COALESCE(route, '(unknown)') AS route,
        COALESCE(device, '(unknown)') AS device,
        count(*)::int AS samples,
        round((percentile_cont(0.75) WITHIN GROUP (ORDER BY value))::numeric, 2) AS p75,
        round(avg(value)::numeric, 2) AS avg,
        min(created_at) AS first_at,
        max(created_at) AS last_at
      FROM rum_web_vitals
      WHERE created_at > now() - (${days}::text || ' days')::interval
      GROUP BY 1, 2, 3
      HAVING count(*) >= ${minSamples}
      ORDER BY metric, route, samples DESC
    `);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(rumWebVitals)
      .where(sql`${rumWebVitals.createdAt} > now() - (${days}::text || ' days')::interval`);

    res.json({
      ok: true,
      windowDays: days,
      minSamples,
      totalRows: total ?? 0,
      groups: rows,
      note: total < minSamples
        ? 'Pocos datos de campo; el muestreo RUM es 20% en prod. Revisar en 24–48h.'
        : undefined,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'summary failed' });
  }
});

router.post('/', rumLimiter, async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const metric = String(b.metric ?? '');
    const value = Number(b.value);

    // Validación: métrica conocida y valor finito en rango sano (ms; CLS pequeño).
    if (!METRICS.has(metric) || !Number.isFinite(value) || value < 0 || value > 600_000) {
      res.status(204).end();
      return;
    }

    await db.insert(rumWebVitals).values({
      metric,
      value,
      rating: clip(b.rating, 20),
      route: clip(b.route, 200),
      navType: clip(b.navType, 24),
      device: clip(b.device, 12),
      conn: clip(b.conn, 12),
      sessionId: clip(b.sid, 40),
      ipOrigen: (req.ip ?? '').slice(0, 45) || null,
      userAgent: clip(req.headers['user-agent'], 500),
    });

    res.status(204).end();
  } catch {
    // Telemetría best-effort: jamás propagar el error al beacon del cliente.
    res.status(204).end();
  }
});

export default router;
