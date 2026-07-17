// Tablero ejecutivo PESV — agrega métricas de los 24 pasos PHVA + KPIs operativos
// para presentación a SuperTransporte / ONAC. Read-only; cualquiera con rol pesv lo ve.

import { Router, Request, Response } from 'express';
import { eq, and, desc, sql, gte, lte, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  pesvPolicy, pesvPlanAnual, pesvDiagnosticos, pesvDiagnosticoItems, pesvEstandaresCatalogo,
  pesvComite, pesvComiteActas,
  jornadasConductor, jornadasAlarmas,
  routes, routeRiskAnalyses,
} from '../../db/schema.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { JORNADA_LIMITS } from '../jornadas/limits.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

router.get('/tablero', async (_req: Request, res: Response) => {
  const anio = new Date().getUTCFullYear();
  const trimestre = `${anio}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
  const inicioMes = new Date(Date.UTC(anio, new Date().getUTCMonth(), 1));

  // Documentos vivos
  const [politicaVigente] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.estado, 'vigente')).limit(1);
  const [planActual] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anio)).limit(1);
  const [planProx] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anio + 1)).limit(1);
  const [diagActual] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.anio, anio)).limit(1);

  // Score por fase PHVA del último diagnóstico cerrado (o el actual si está cerrado)
  const [diagReferencia] = await db.select().from(pesvDiagnosticos)
    .where(eq(pesvDiagnosticos.estado, 'cerrado'))
    .orderBy(desc(pesvDiagnosticos.anio)).limit(1);

  let scoresPorFase: Record<string, { score: number; estandares: number; cubiertos: number; parciales: number; ausentes: number }> = {};
  let estandaresPorFase: Record<string, { codigo: string; nombre: string; score: number; estado: string }[]> = {};
  if (diagReferencia) {
    const items = await db.execute(sql`
      SELECT c.fase, c.codigo, c.nombre, c.peso::float AS peso, i.score_pct::float AS score
        FROM pesv_diagnostico_items i
        JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
       WHERE i.diagnostico_id = ${diagReferencia.id}
       ORDER BY c.paso
    ` as any) as any;
    const itemsArr = ((items?.rows ?? items ?? []) as any[]) as Array<{ fase: string; codigo: string; nombre: string; peso: number; score: number }>;
    for (const it of itemsArr) {
      if (!scoresPorFase[it.fase]) scoresPorFase[it.fase] = { score: 0, estandares: 0, cubiertos: 0, parciales: 0, ausentes: 0 };
      const fase = scoresPorFase[it.fase];
      fase.estandares++;
      if (it.score >= 80) fase.cubiertos++;
      else if (it.score >= 40) fase.parciales++;
      else fase.ausentes++;
      // ponderado parcial — calculamos al final
      if (!estandaresPorFase[it.fase]) estandaresPorFase[it.fase] = [];
      estandaresPorFase[it.fase].push({
        codigo: it.codigo, nombre: it.nombre, score: Number(it.score),
        estado: it.score >= 80 ? 'cubierto' : it.score >= 40 ? 'parcial' : 'ausente',
      });
    }
    // Score ponderado por fase
    for (const fase of Object.keys(scoresPorFase)) {
      const itemsFase = itemsArr.filter((i) => i.fase === fase);
      const num = itemsFase.reduce((s, i) => s + i.score * i.peso, 0);
      const den = itemsFase.reduce((s, i) => s + i.peso, 0);
      scoresPorFase[fase].score = den > 0 ? Number((num / den).toFixed(2)) : 0;
    }
  }

  // KPIs jornadas mes en curso
  const inicioMesIso = inicioMes.toISOString();
  const jornadasMesRows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE cerrada_automatica = true)::int AS auto_cerradas,
      COALESCE(SUM(horas_conduccion), 0)::float AS horas_totales
    FROM jornadas_conductor
    WHERE inicio_at >= ${inicioMesIso}::timestamptz
  ` as any) as any;
  const jornadasKpi = (jornadasMesRows?.rows?.[0] ?? jornadasMesRows?.[0]) ?? { total: 0, auto_cerradas: 0, horas_totales: 0 };

  const alarmasMesRows = await db.execute(sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ack_at IS NULL)::int AS pendientes
      FROM jornadas_alarmas WHERE generada_at >= ${inicioMesIso}::timestamptz
  ` as any) as any;
  const alarmasKpi = (alarmasMesRows?.rows?.[0] ?? alarmasMesRows?.[0]) ?? { total: 0, pendientes: 0 };

  const conductoresOver60Rows = await db.execute(sql`
    SELECT conductor_id, SUM(horas_conduccion)::float AS horas
      FROM jornadas_conductor
     WHERE cerrada = true AND date_trunc('week', inicio_at) = date_trunc('week', now())
     GROUP BY conductor_id HAVING SUM(horas_conduccion) > ${JORNADA_LIMITS.MAX_SEMANAL_HORAS}
  ` as any) as any;
  const conductoresOver60 = ((conductoresOver60Rows?.rows ?? conductoresOver60Rows ?? []) as any[]).length;

  // Comité — última acta cerrada
  const [comite] = await db.select().from(pesvComite).where(eq(pesvComite.activo, true)).limit(1);
  let ultimaActa = null as any;
  if (comite) {
    const [a] = await db.select().from(pesvComiteActas)
      .where(and(eq(pesvComiteActas.comiteId, comite.id), eq(pesvComiteActas.estado, 'cerrada')))
      .orderBy(desc(pesvComiteActas.fecha)).limit(1);
    ultimaActa = a ?? null;
  }

  // Rutas — análisis trimestral del Q actual
  const totalRutas = await db.select({ count: sql<number>`count(*)::int` }).from(routes).where(eq(routes.activo, true));
  const rutasConAnalisis = await db.execute(sql`
    SELECT COUNT(DISTINCT route_id)::int AS c
      FROM route_risk_analyses WHERE trimestre = ${trimestre}
  ` as any) as any;
  const rutasOk = Number((rutasConAnalisis?.rows?.[0] ?? rutasConAnalisis?.[0])?.c ?? 0);
  const rutasFaltantes = (totalRutas[0]?.count ?? 0) - rutasOk;

  res.json({
    anio,
    trimestre,
    documentos: {
      politicaVigente: politicaVigente ? { id: politicaVigente.id, version: politicaVigente.version, titulo: politicaVigente.titulo, firmadaAt: politicaVigente.firmadaAt } : null,
      planActual: planActual ? { id: planActual.id, anio: planActual.anio, estado: planActual.estado, presupuestoCop: planActual.presupuestoCop } : null,
      planProximo: planProx ? { id: planProx.id, anio: planProx.anio, estado: planProx.estado } : null,
      diagnosticoActual: diagActual ? { id: diagActual.id, estado: diagActual.estado, scoreGlobal: Number(diagActual.scoreGlobal) } : null,
      ultimaActaComite: ultimaActa ? { id: ultimaActa.id, comiteId: ultimaActa.comiteId, numero: ultimaActa.numero, fecha: ultimaActa.fecha, estado: ultimaActa.estado } : null,
    },
    cumplimiento: {
      diagnosticoReferencia: diagReferencia ? { id: diagReferencia.id, anio: diagReferencia.anio, scoreGlobal: Number(diagReferencia.scoreGlobal) } : null,
      scoresPorFase,
      estandaresPorFase,
      total24Pasos: Object.values(scoresPorFase).reduce((s, f) => s + f.estandares, 0),
    },
    jornadasMes: {
      total: jornadasKpi.total,
      cerradasAutomatica: jornadasKpi.auto_cerradas,
      horasTotales: Number(jornadasKpi.horas_totales).toFixed(2),
      alarmasMes: alarmasKpi.total,
      alarmasPendientes: alarmasKpi.pendientes,
      conductoresExcedenSemanal: conductoresOver60,
    },
    rutas: {
      total: totalRutas[0]?.count ?? 0,
      conAnalisisTrimestre: rutasOk,
      sinAnalisisTrimestre: Math.max(0, rutasFaltantes),
    },
  });
});

export default router;
