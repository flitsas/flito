import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';

const router = Router();
router.use(authMiddleware, requirePage('rndc'));

function parseDateRange(req: Request) {
  const desde = (req.query.desde as string | undefined) ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const hasta = (req.query.hasta as string | undefined) ?? new Date().toISOString().slice(0, 10);
  return { desde, hasta };
}

// Resumen general del tablero RNDC
router.get('/resumen', async (req: Request, res: Response) => {
  const { desde, hasta } = parseDateRange(req);

  const [byEstado] = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'borrador')      AS borradores,
      COUNT(*) FILTER (WHERE estado = 'listo')         AS listos,
      COUNT(*) FILTER (WHERE estado = 'radicado_rndc') AS radicados,
      COUNT(*) FILTER (WHERE estado = 'aceptado')      AS aceptados,
      COUNT(*) FILTER (WHERE estado = 'rechazado')     AS rechazados,
      COUNT(*) FILTER (WHERE estado = 'cumplido')      AS cumplidos,
      COUNT(*) FILTER (WHERE estado = 'anulado')       AS anulados,
      COUNT(*)                                          AS total
    FROM manifiestos
    WHERE deleted_at IS NULL
      AND fecha_expedicion BETWEEN ${desde} AND ${hasta}
  `) as any;

  const [revenue] = await db.execute(sql`
    SELECT
      COALESCE(SUM(valor_flete_total)::bigint, 0) AS revenue_total,
      COALESCE(SUM(valor_flete_total) FILTER (WHERE estado IN ('cumplido', 'aceptado'))::bigint, 0) AS revenue_facturable,
      COALESCE(SUM(valor_anticipo)::bigint, 0) AS anticipos
    FROM manifiestos
    WHERE deleted_at IS NULL
      AND fecha_expedicion BETWEEN ${desde} AND ${hasta}
  `) as any;

  const [remesasResumen] = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'borrador') AS borradores,
      COUNT(*) FILTER (WHERE estado = 'activa')   AS activas_sin_manifiesto,
      COUNT(*) FILTER (WHERE estado = 'cumplida') AS cumplidas,
      COUNT(*) FILTER (WHERE estado = 'anulada')  AS anuladas,
      COUNT(*) AS total
    FROM remesas
    WHERE deleted_at IS NULL
      AND fecha_cargue BETWEEN ${desde} AND ${hasta}
  `) as any;

  res.json({
    rango: { desde, hasta },
    manifiestos: byEstado,
    remesas: remesasResumen,
    revenue,
  });
});

// Top conductores por número de manifiestos cumplidos
router.get('/top-conductores', async (req: Request, res: Response) => {
  const { desde, hasta } = parseDateRange(req);
  const rows = await db.execute(sql`
    SELECT
      u.id AS conductor_id,
      u.name AS conductor_nombre,
      COUNT(m.id) AS total_manifiestos,
      COUNT(*) FILTER (WHERE m.estado = 'cumplido') AS cumplidos,
      COALESCE(SUM(m.valor_flete_total)::bigint, 0) AS valor_flete_acumulado
    FROM manifiestos m
    JOIN users u ON u.id = m.conductor_id
    WHERE m.deleted_at IS NULL
      AND m.fecha_expedicion BETWEEN ${desde} AND ${hasta}
    GROUP BY u.id, u.name
    ORDER BY total_manifiestos DESC
    LIMIT 10
  `);
  res.json({ data: rows });
});

// Top vehículos por uso
router.get('/top-vehiculos', async (req: Request, res: Response) => {
  const { desde, hasta } = parseDateRange(req);
  const rows = await db.execute(sql`
    SELECT
      v.id AS vehiculo_id,
      v.plate AS placa,
      v.alias,
      COUNT(m.id) AS total_manifiestos,
      COUNT(*) FILTER (WHERE m.estado = 'cumplido') AS cumplidos,
      COALESCE(SUM(m.valor_flete_total)::bigint, 0) AS valor_flete_acumulado
    FROM manifiestos m
    JOIN vehicles v ON v.id = m.vehiculo_principal_id
    WHERE m.deleted_at IS NULL
      AND m.fecha_expedicion BETWEEN ${desde} AND ${hasta}
    GROUP BY v.id, v.plate, v.alias
    ORDER BY total_manifiestos DESC
    LIMIT 10
  `);
  res.json({ data: rows });
});

// Rutas más activas (origen → destino)
router.get('/top-rutas', async (req: Request, res: Response) => {
  const { desde, hasta } = parseDateRange(req);
  const rows = await db.execute(sql`
    SELECT
      mo.nombre AS origen_nombre,
      md.nombre AS destino_nombre,
      m.municipio_origen_dane,
      m.municipio_destino_dane,
      COUNT(*) AS total,
      COALESCE(SUM(m.valor_flete_total)::bigint, 0) AS valor_acumulado
    FROM manifiestos m
    LEFT JOIN rndc_municipios mo ON mo.codigo_dane = m.municipio_origen_dane
    LEFT JOIN rndc_municipios md ON md.codigo_dane = m.municipio_destino_dane
    WHERE m.deleted_at IS NULL
      AND m.fecha_expedicion BETWEEN ${desde} AND ${hasta}
    GROUP BY mo.nombre, md.nombre, m.municipio_origen_dane, m.municipio_destino_dane
    ORDER BY total DESC
    LIMIT 10
  `);
  res.json({ data: rows });
});

export default router;
