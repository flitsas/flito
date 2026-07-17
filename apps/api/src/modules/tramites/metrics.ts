// TRAMITES-ABCD · Sprint A (TRAM-METRICS) — KPIs del epic TRAM-INNOV.
//
// Agrega las consultas §11 del epic (docs/EPIC-TRAMITES-INNOVACION-MVP.md) en un
// solo resumen para el panel admin. Solo agregados/conteos: SIN PII (ni cédulas
// ni nombres). Ventana temporal parametrizada igual que RUM (`days`).

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export interface TramitesMetricsSummary {
  windowDays: number;
  preflight: { overall_status: string; n: number }[];
  tiempoTransito: { horas_mediana: number | null; n: number };
  rechazosOt: { rechazos: number; enviados: number };
  rechazosPorMotivo: { codigo: string; n: number }[];
  tipologias: { tipologia: string; n: number }[];
  notificaciones: { canal: string; n: number }[];
  portal: { rol: string; invitados: number; con_consentimiento: number }[];
  lotes: { lotes: number; filas: number; tramites_creados: number };
}

// Intervalo parametrizado seguro (mismo patrón que rum.routes.ts).
const since = (days: number) => sql`now() - (${days}::text || ' days')::interval`;

export async function getTramitesMetrics(days: number): Promise<TramitesMetricsSummary> {
  const win = since(days);

  // (M3) Pre-vuelo por resultado (A1).
  const preflight = await db.execute(sql`
    SELECT overall_status, count(*)::int AS n
    FROM tramite_preflight
    WHERE created_at > ${win}
    GROUP BY overall_status
    ORDER BY n DESC
  `) as unknown as { overall_status: string; n: number }[];

  // (M2) Mediana de horas wizard → enviado a tránsito.
  const tiempoRows = await db.execute(sql`
    SELECT
      round((percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (e.created_at - t.created_at)) / 3600
      ))::numeric, 1) AS horas_mediana,
      count(*)::int AS n
    FROM tramites_digitales t
    JOIN tramite_eventos e ON e.tramite_id = t.id AND e.tipo = 'enviado_transito'
    WHERE t.created_at > ${win}
  `) as unknown as { horas_mediana: string | number | null; n: number }[];

  // (M1) Rechazos OT vs enviados a tránsito (proxy).
  const rechazoRows = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE tipo = 'rechazado_ot')::int     AS rechazos,
      count(*) FILTER (WHERE tipo = 'enviado_transito')::int AS enviados
    FROM tramite_eventos
    WHERE created_at > ${win}
  `) as unknown as { rechazos: number; enviados: number }[];

  // TRAM-OPS-02: rechazos OT por motivo (payload.codigo, sin PII).
  const rechazosPorMotivo = await db.execute(sql`
    SELECT COALESCE(payload->>'codigo', '(sin código)') AS codigo, count(*)::int AS n
    FROM tramite_eventos
    WHERE tipo = 'rechazado_ot' AND created_at > ${win}
    GROUP BY 1
    ORDER BY n DESC
  `) as unknown as { codigo: string; n: number }[];

  // (A5) Adopción de tipologías.
  const tipologias = await db.execute(sql`
    SELECT COALESCE(tipologia_codigo, '(sin tipología)') AS tipologia, count(*)::int AS n
    FROM tramites_digitales
    WHERE created_at > ${win}
    GROUP BY 1
    ORDER BY n DESC
  `) as unknown as { tipologia: string; n: number }[];

  // (A4) Notificaciones de estado por canal.
  const notificaciones = await db.execute(sql`
    SELECT COALESCE(payload->>'canal', '(desconocido)') AS canal, count(*)::int AS n
    FROM tramite_eventos
    WHERE tipo = 'notificacion_enviada' AND created_at > ${win}
    GROUP BY 1
    ORDER BY n DESC
  `) as unknown as { canal: string; n: number }[];

  // (A3) Participación externa: invitados vs consentimiento 1581.
  const portal = await db.execute(sql`
    SELECT rol,
      count(*)::int                                       AS invitados,
      count(*) FILTER (WHERE consent_1581_at IS NOT NULL)::int AS con_consentimiento
    FROM tramite_participantes
    WHERE created_at > ${win}
    GROUP BY rol
    ORDER BY invitados DESC
  `) as unknown as { rol: string; invitados: number; con_consentimiento: number }[];

  // (B4) Lotes de flota.
  const loteRows = await db.execute(sql`
    SELECT
      count(DISTINCT l.id)::int   AS lotes,
      count(f.id)::int            AS filas,
      count(f.tramite_id)::int    AS tramites_creados
    FROM tramite_lotes l
    LEFT JOIN tramite_lote_filas f ON f.lote_id = l.id
    WHERE l.created_at > ${win}
  `) as unknown as { lotes: number; filas: number; tramites_creados: number }[];

  const t0 = tiempoRows[0] ?? { horas_mediana: null, n: 0 };
  return {
    windowDays: days,
    preflight: preflight ?? [],
    tiempoTransito: { horas_mediana: t0.horas_mediana == null ? null : Number(t0.horas_mediana), n: t0.n ?? 0 },
    rechazosOt: rechazoRows[0] ?? { rechazos: 0, enviados: 0 },
    rechazosPorMotivo: rechazosPorMotivo ?? [],
    tipologias: tipologias ?? [],
    notificaciones: notificaciones ?? [],
    portal: portal ?? [],
    lotes: loteRows[0] ?? { lotes: 0, filas: 0, tramites_creados: 0 },
  };
}

/** TRAM-DASH-01 — KPIs del gestor (solo trámites con `creado_por` = userId). Sin PII. */
export interface TramiteGestorMetrics {
  windowDays: number;
  totales: { creados: number; enviados: number; rechazados: number; activos: number };
  preflight: { overall_status: string; n: number }[];
  tipologias: { tipologia: string; n: number }[];
  tiempoTransito: { horas_mediana: number | null; n: number };
  rechazosPorMotivo: { codigo: string; n: number }[];
}

export async function getTramitesMetricsGestor(userId: number, days: number): Promise<TramiteGestorMetrics> {
  const win = since(days);

  const totalesRows = await db.execute(sql`
    SELECT
      count(*)::int AS creados,
      count(*) FILTER (WHERE estado = 'enviado_transito' OR estado IN ('recibido_transito','placa_preasignada','solicitud_soat','soat_comprado','soat_verificado','completado'))::int AS enviados,
      count(*) FILTER (WHERE estado = 'rechazado')::int AS rechazados,
      count(*) FILTER (WHERE estado NOT IN ('completado','rechazado'))::int AS activos
    FROM tramites_digitales
    WHERE creado_por = ${userId} AND created_at > ${win}
  `) as unknown as { creados: number; enviados: number; rechazados: number; activos: number }[];

  const preflight = await db.execute(sql`
    SELECT p.overall_status, count(*)::int AS n
    FROM tramite_preflight p
    INNER JOIN tramites_digitales t ON t.id = p.tramite_id
    WHERE t.creado_por = ${userId} AND p.created_at > ${win}
    GROUP BY p.overall_status
    ORDER BY n DESC
  `) as unknown as { overall_status: string; n: number }[];

  const tipologias = await db.execute(sql`
    SELECT COALESCE(tipologia_codigo, '(sin tipología)') AS tipologia, count(*)::int AS n
    FROM tramites_digitales
    WHERE creado_por = ${userId} AND created_at > ${win}
    GROUP BY 1
    ORDER BY n DESC
  `) as unknown as { tipologia: string; n: number }[];

  const tiempoRows = await db.execute(sql`
    SELECT
      round((percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (e.created_at - t.created_at)) / 3600
      ))::numeric, 1) AS horas_mediana,
      count(*)::int AS n
    FROM tramites_digitales t
    JOIN tramite_eventos e ON e.tramite_id = t.id AND e.tipo = 'enviado_transito'
    WHERE t.creado_por = ${userId} AND t.created_at > ${win}
  `) as unknown as { horas_mediana: string | number | null; n: number }[];

  const rechazosPorMotivo = await db.execute(sql`
    SELECT COALESCE(e.payload->>'codigo', '(sin código)') AS codigo, count(*)::int AS n
    FROM tramite_eventos e
    INNER JOIN tramites_digitales t ON t.id = e.tramite_id
    WHERE e.tipo = 'rechazado_ot' AND t.creado_por = ${userId} AND e.created_at > ${win}
    GROUP BY 1
    ORDER BY n DESC
  `) as unknown as { codigo: string; n: number }[];

  const t0 = totalesRows[0] ?? { creados: 0, enviados: 0, rechazados: 0, activos: 0 };
  const tm = tiempoRows[0] ?? { horas_mediana: null, n: 0 };
  return {
    windowDays: days,
    totales: t0,
    preflight: preflight ?? [],
    tipologias: tipologias ?? [],
    tiempoTransito: { horas_mediana: tm.horas_mediana == null ? null : Number(tm.horas_mediana), n: tm.n ?? 0 },
    rechazosPorMotivo: rechazosPorMotivo ?? [],
  };
}
