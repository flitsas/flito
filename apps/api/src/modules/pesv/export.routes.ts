// Export PESV — genera paquete ZIP con PDF resumen + XML estructurado + anexos
// para presentación a SuperTransporte (SISI/PESV — sin API pública, upload manual).
//
// Genera on-the-fly y stream al cliente. NO persiste el ZIP (volumen variable);
// los PDFs individuales sí se persisten en S3 cuando se firman.

import { Router, Request, Response } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import archiver from 'archiver';
import crypto from 'crypto';
import { db } from '../../db/client.js';
import {
  pesvPolicy, pesvPlanAnual, pesvPlanObjetivos, pesvDiagnosticos,
  pesvComite, pesvComiteActas, users,
  jornadasConductor, routes, routeRiskAnalyses,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { JORNADA_LIMITS } from '../jornadas/limits.js';
import { buildResumenSisiPdf, buildPolicyPdf, buildPlanPdf, buildDiagnosticoPdf } from './pdf-builder.js';
import diagnosticoExportRouter from './export-diagnostico.routes.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

// Sub-router con endpoints del expediente del rediseño UX
// (export por estándar + expediente completo). Separado por cap 400L.
router.use('/', diagnosticoExportRouter);

const KYVERUM = 'Kyverum LLC';

function escXml(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

router.post('/sisi', requireRole('admin'), async (req: Request, res: Response) => {
  const anio = parseInt(req.body?.anio as string, 10) || new Date().getUTCFullYear();
  const trimestre = `${anio}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
  const inicioMes = new Date(Date.UTC(anio, new Date().getUTCMonth(), 1));

  // Recolectar datos PESV
  const [politicaVigente] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.estado, 'vigente')).limit(1);
  const [plan] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anio)).limit(1);
  const objetivos = plan ? await db.select().from(pesvPlanObjetivos).where(eq(pesvPlanObjetivos.planId, plan.id)) : [];
  const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.anio, anio)).limit(1);
  let estandares: any[] = [];
  if (diag) {
    const r = await db.execute(sql`
      SELECT c.codigo, c.fase, c.nombre, i.score_pct::float AS score
        FROM pesv_diagnostico_items i
        JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
       WHERE i.diagnostico_id = ${diag.id} ORDER BY c.paso
    ` as any) as any;
    estandares = ((r?.rows ?? r ?? []) as any[]);
  }

  // KPIs jornadas
  const inicioMesIso = inicioMes.toISOString();
  const jornadasRows = await db.execute(sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE cerrada_automatica = true)::int AS auto, COALESCE(SUM(horas_conduccion), 0)::float AS horas
      FROM jornadas_conductor WHERE inicio_at >= ${inicioMesIso}::timestamptz
  ` as any) as any;
  const jornadasKpi = (jornadasRows?.rows?.[0] ?? jornadasRows?.[0]) ?? { total: 0, auto: 0, horas: 0 };
  const alarmasRows = await db.execute(sql`
    SELECT COUNT(*)::int AS total FROM jornadas_alarmas WHERE generada_at >= ${inicioMesIso}::timestamptz
  ` as any) as any;
  const alarmasMes = Number((alarmasRows?.rows?.[0] ?? alarmasRows?.[0])?.total ?? 0);
  const over60Rows = await db.execute(sql`
    SELECT conductor_id FROM jornadas_conductor
     WHERE cerrada = true AND date_trunc('week', inicio_at) = date_trunc('week', now())
     GROUP BY conductor_id HAVING SUM(horas_conduccion) > ${JORNADA_LIMITS.MAX_SEMANAL_HORAS}
  ` as any) as any;
  const conductoresOver60 = ((over60Rows?.rows ?? over60Rows ?? []) as any[]).length;

  // Rutas
  const rutas = await db.select().from(routes).where(eq(routes.activo, true));
  const rutasIds = rutas.map((r) => r.id);
  let rutasConAnalisis = 0;
  if (rutasIds.length) {
    const idsList = sql.join(rutasIds.map((i) => sql`${i}`), sql`, `);
    const r = await db.execute(sql`
      SELECT COUNT(DISTINCT route_id)::int AS c FROM route_risk_analyses
       WHERE route_id IN (${idsList}) AND trimestre = ${trimestre}
    ` as any) as any;
    rutasConAnalisis = Number((r?.rows?.[0] ?? r?.[0])?.c ?? 0);
  }

  // Comité
  const [comite] = await db.select().from(pesvComite).where(eq(pesvComite.activo, true)).limit(1);
  const actas = comite ? await db.select().from(pesvComiteActas)
    .where(and(eq(pesvComiteActas.comiteId, comite.id), eq(pesvComiteActas.estado, 'cerrada')))
    .orderBy(desc(pesvComiteActas.fecha)).limit(12) : [];

  // Build XML estructurado (formato Kyverum — SISI/PESV no tiene esquema XSD oficial publicado)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pesv-export>
  <metadata>
    <empresa>${escXml(KYVERUM)}</empresa>
    <anio>${anio}</anio>
    <trimestre>${trimestre}</trimestre>
    <generadoAt>${new Date().toISOString()}</generadoAt>
    <generadoPor>${req.user!.sub}</generadoPor>
  </metadata>
  <politica-vigente>
    ${politicaVigente ? `<version>${politicaVigente.version}</version><titulo>${escXml(politicaVigente.titulo)}</titulo><vigenciaDesde>${politicaVigente.vigenciaDesde}</vigenciaDesde><firmadaAt>${politicaVigente.firmadaAt?.toISOString() ?? ''}</firmadaAt>` : '<sin-politica/>'}
  </politica-vigente>
  <plan-anual>
    ${plan ? `<anio>${plan.anio}</anio><estado>${plan.estado}</estado><presupuestoCop>${plan.presupuestoCop}</presupuestoCop><objetivoGeneral>${escXml(plan.objetivoGeneral)}</objetivoGeneral>
      <objetivos>${objetivos.map((o) => `<objetivo><codigo>${escXml(o.codigo)}</codigo><descripcion>${escXml(o.descripcion)}</descripcion><metaPct>${o.metaPct}</metaPct></objetivo>`).join('')}</objetivos>` : '<sin-plan/>'}
  </plan-anual>
  <diagnostico>
    ${diag ? `<anio>${diag.anio}</anio><scoreGlobal>${diag.scoreGlobal}</scoreGlobal><estado>${diag.estado}</estado>
      <estandares>${estandares.map((e: any) => `<estandar codigo="${escXml(e.codigo)}" fase="${escXml(e.fase)}" score="${e.score}"><nombre>${escXml(e.nombre)}</nombre></estandar>`).join('')}</estandares>` : '<sin-diagnostico/>'}
  </diagnostico>
  <indicadores-mes>
    <jornadas total="${jornadasKpi.total}" cerradasAutomatica="${jornadasKpi.auto}" horasTotales="${Number(jornadasKpi.horas).toFixed(2)}"/>
    <alarmas total="${alarmasMes}"/>
    <conductoresExcedenSemanal>${conductoresOver60}</conductoresExcedenSemanal>
  </indicadores-mes>
  <rutas>
    <total>${rutas.length}</total>
    <conAnalisisTrimestre>${rutasConAnalisis}</conAnalisisTrimestre>
    <sinAnalisisTrimestre>${Math.max(0, rutas.length - rutasConAnalisis)}</sinAnalisisTrimestre>
  </rutas>
  <comite>
    ${comite ? `<nombre>${escXml(comite.nombre)}</nombre><periodicidad>${comite.periodicidad}</periodicidad>
      <actas-recientes>${actas.map((a) => `<acta numero="${a.numero}" fecha="${a.fecha}" estado="${a.estado}"/>`).join('')}</actas-recientes>` : '<sin-comite/>'}
  </comite>
</pesv-export>`;

  // PDF resumen
  const resumenPdf = await buildResumenSisiPdf({
    anio, trimestre, empresa: KYVERUM,
    politicaVigente: politicaVigente ? { version: politicaVigente.version, titulo: politicaVigente.titulo, firmadaAt: politicaVigente.firmadaAt?.toISOString() ?? null } : null,
    planActual: plan ? { anio: plan.anio, estado: plan.estado, presupuestoCop: plan.presupuestoCop } : null,
    diagnostico: diag ? { anio: diag.anio, scoreGlobal: Number(diag.scoreGlobal) } : null,
    jornadasMes: { total: jornadasKpi.total, alarmasMes, conductoresExcedenSemanal: conductoresOver60 },
    rutas: { total: rutas.length, conAnalisisTrimestre: rutasConAnalisis, sinAnalisisTrimestre: Math.max(0, rutas.length - rutasConAnalisis) },
  });

  // PDF política firmada (si existe)
  let politicaPdf: Buffer | null = null;
  if (politicaVigente && politicaVigente.firmadaAt) {
    const [signer] = await db.select().from(users).where(eq(users.id, politicaVigente.firmadaPor!)).limit(1);
    politicaPdf = await buildPolicyPdf({
      version: politicaVigente.version, titulo: politicaVigente.titulo,
      contenidoMd: politicaVigente.contenidoMd,
      vigenciaDesde: String(politicaVigente.vigenciaDesde),
      vigenciaHasta: politicaVigente.vigenciaHasta ? String(politicaVigente.vigenciaHasta) : null,
      signer: { nombre: signer?.name ?? `User #${politicaVigente.firmadaPor}`, rol: signer?.role ?? 'admin', userId: politicaVigente.firmadaPor!, timestamp: politicaVigente.firmadaAt },
    });
  }

  let planPdf: Buffer | null = null;
  if (plan) {
    planPdf = await buildPlanPdf({
      anio: plan.anio, objetivoGeneral: plan.objetivoGeneral,
      presupuestoCop: plan.presupuestoCop, estado: plan.estado,
      objetivos: objetivos.map((o) => ({ codigo: o.codigo, descripcion: o.descripcion, metaPct: o.metaPct })),
    });
  }

  let diagPdf: Buffer | null = null;
  if (diag) {
    diagPdf = await buildDiagnosticoPdf({
      anio: diag.anio, fecha: String(diag.fecha), scoreGlobal: Number(diag.scoreGlobal),
      estado: diag.estado,
      estandares: estandares.map((e: any) => ({ codigo: e.codigo, fase: e.fase, nombre: e.nombre, scorePct: Number(e.score) })),
    });
  }

  // Hash del paquete (incluye XML + resumen)
  const pkgHash = crypto.createHash('sha256').update(xml).update(resumenPdf).digest('hex');

  // Stream ZIP al cliente
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `pesv-export-${anio}-${ts}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('error', (err) => { res.status(500).end(`zip error: ${err.message}`); });
  zip.pipe(res);
  zip.append(resumenPdf, { name: `01-resumen-ejecutivo.pdf` });
  zip.append(xml, { name: `02-pesv-data.xml` });
  if (politicaPdf) zip.append(politicaPdf, { name: `03-politica-vigente-v${politicaVigente!.version}.pdf` });
  if (planPdf) zip.append(planPdf, { name: `04-plan-anual-${anio}.pdf` });
  if (diagPdf) zip.append(diagPdf, { name: `05-diagnostico-${anio}.pdf` });
  zip.append(`Empresa: ${KYVERUM}\nFecha generación: ${new Date().toISOString()}\nGenerado por: userId=${req.user!.sub}\nHash SHA-256 del paquete (resumen+xml): ${pkgHash}\n\nEste paquete es el material de cargue para SISI/PESV (SuperTransporte). Subir manualmente al portal:\nhttps://www.supertransporte.gov.co/index.php/sistemas-pesv/\n`, { name: `00-manifiesto.txt` });

  await audit(req, { action: 'export', resource: 'pesv_sisi', resourceId: String(anio), detail: `pkg_sha256=${pkgHash.slice(0, 16)}...` });
  await zip.finalize();
});


export default router;
