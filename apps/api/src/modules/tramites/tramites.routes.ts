import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import multer from 'multer';
import { mkdir, writeFile, access } from 'fs/promises';
import path from 'path';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramitesDocumentos } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import express from 'express';
import {
  vehiculoSchema, compradorSchema, documentosSchema, validacionIdentidadSchema,
} from './tramites.schemas.js';
import {
  VALID_ESTADOS, listTramites, getTramiteWithDocs, createTramite, patchTramite, generarFur,
  generarContrato, generarImprontas,
  TramiteVinConflictError, transicionarEstadoStt,
  TRAMITE_TIPOLOGIAS, getChecklistForTramite,
} from './tramites.service.js';
import { computePreflight, getLatestPreflight } from './preflight.js';
import { emitEvento, sha256, getTimeline, generateVerifyToken } from './eventos.js';
import { buildExpedientePdf, resolveVerifyUrl, timelineToPdfEventos, maskVin, loadOrganismoLogoBytes, type OrganismoBranding } from './expediente-pdf.js';
import { getOrganismoConfig } from './transito-config.js';
import { getTipologia, extractOrganismoCodigoFromVehiculo, esDocTipoStt } from '@operaciones/shared-types';
import { assertTraspasoMutacion } from './traspaso-gates.js';
import { crearInvitaciones, listarParticipantesPendientes, VALID_ROLES } from './portal.js';
import { notifyEstado, notifConfig } from './notificaciones.js';
import { appendEventoSafe } from '../vehicles/vehiculo-historial.js';
import { parseCsv, previewLote, confirmarLote, getLote, getLoteEstado, iniciarLoteAsync, reprocesarErroresLote, exportResultadosCsv, listLotes, confirmarLoteDesdeCsv, PLANTILLA_CSV, MAX_FILAS } from './lote.js';
import { getTramitesMetrics, getTramitesMetricsGestor } from './metrics.js';
import { sugerirChecklist } from './copiloto.js';
import { rechazarOtTramite } from './rechazar-ot.js';
import { getEmbudo } from './embudo.js';
import { parseFechaRangoQuery, tieneFiltroFecha } from '../../shared/utils/fecha-rango.js';
import { MOTIVOS_RECHAZO_OT, isValidCtaId } from '@operaciones/shared-types';
import { tramPreflightCtaClickedTotal } from '../../shared/metrics.js';
import { consultarImpuestoVehicular } from './impuesto-vehicular.js';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import { useLocalPdf } from './docs/mode.js';

// TRAM-12a: la lógica de negocio (CRUD, transiciones, FUR) vive en
// `tramites.service.ts`. Aquí solo: auth, parseo Zod, llamada al servicio y
// respuesta HTTP. La subida de documentos (multer + FS) se mantiene en la ruta.
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.use(authMiddleware, requireRole('admin', 'transito'));

// S4: Sanitizar filename
const sanitizeFilename = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
// F2: Tipos de documento permitidos
const VALID_DOC_TYPES = ['factura', 'aduana', 'impronta', 'soat', 'certificado_ambiental', 'compraventa', 'acta_remate', 'oficio_judicial', 'declaracion_aduana', 'comprobante_derechos', 'acta_entrega', 'runt_respuesta', 'stt_anexo', 'otro'] as const;

// TRAM-INNOV A5: catálogo de tipologías (estático, desde shared-types). ANTES de
// /:id para que Express no matchee "tipologias" como un ID.
router.get('/tipologias', (_req: Request, res: Response) => {
  res.json(TRAMITE_TIPOLOGIAS);
});

// TRAM-OPS-02: catálogo de motivos de rechazo OT (antes de /:id).
router.get('/motivos-rechazo-ot', (_req: Request, res: Response) => {
  res.json(MOTIVOS_RECHAZO_OT);
});

// TRAM-OPS-01: embudo operativo por etapas (antes de /:id).
router.get('/embudo', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const rango = parseFechaRangoQuery(req.query as Record<string, unknown>);
  const modalidadRaw = req.query.modalidadEntrada;
  const modalidadEntrada = modalidadRaw === 'traspaso' || modalidadRaw === 'matricula_inicial' ? modalidadRaw : undefined;
  const embudo = await getEmbudo(limit, tieneFiltroFecha(rango) ? rango : undefined, modalidadEntrada);
  res.json(embudo);
});

// TRAM-INNOV A4: capacidades de notificación (para que la UI degrade su mensaje).
router.get('/notif-config', (_req: Request, res: Response) => {
  res.json(notifConfig());
});

// TRAMITES-ABCD Sprint A: KPIs del epic (panel admin). SOLO admin (route-level
// requireRole restringe sobre el router-level admin|transito). Literal ANTES de /:id.
router.get('/metrics/summary', requireRole('admin'), async (req: Request, res: Response) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  try {
    const summary = await getTramitesMetrics(days);
    res.json({ ok: true, ...summary });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'metrics failed' });
  }
});

// TRAM-DASH-01: KPIs del gestor (solo trámites creados por el usuario autenticado).
router.get('/metrics/gestor', async (req: Request, res: Response) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const userId = req.user?.sub;
  if (!userId) { res.status(401).json({ error: 'No autenticado' }); return; }
  try {
    const summary = await getTramitesMetricsGestor(userId, days);
    res.json({ ok: true, ...summary });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'metrics gestor failed' });
  }
});

// TRAM-INNOV B4: trámites en lote (CSV de flota). Rutas literales ANTES de /:id.
router.get('/lote/plantilla.csv', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_lote_flota.csv"');
  res.send(PLANTILLA_CSV);
});

// Preview: parsea CSV + pre-vuelo A1 por fila, SIN crear trámites.
router.post('/lote/preview', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Archivo CSV requerido' }); return; }
  const parsed = parseCsv(req.file.buffer.toString('utf-8'));
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const preview = await previewLote(parsed.filas, req.user?.sub ?? null);
  res.json(preview);
});

// LOTE-PLUS-04 (G5): historial paginado de lotes. ANTES de /lote/:id.
router.get('/lote', async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 20;
  res.json(await listLotes({ page, limit }));
});

// LOTE-PLUS-01: confirmar en background (202). Re-parsea CSV en servidor (G4).
router.post('/lote/async', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Archivo CSV requerido' }); return; }
  const nombre = (req.body?.nombre as string | undefined)?.slice(0, 120) || undefined;
  const r = await iniciarLoteAsync(req.file.buffer.toString('utf-8'), nombre, req.user!.sub);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  await audit(req, { action: 'create', resource: 'tramite_lote', resourceId: String(r.loteId), detail: `Lote async iniciado: ${r.totalFilas} filas` });
  res.status(202).json({
    loteId: r.loteId, estado: r.estado, totalFilas: r.totalFilas,
    ...(r.idempotente ? { idempotente: true } : {}),
  });
});

// LOTE-PLUS-04 (G4): confirmar re-parseando el CSV EN EL SERVIDOR (síncrono, legacy).
router.post('/lote/confirm', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Archivo CSV requerido' }); return; }
  const nombre = (req.body?.nombre as string | undefined)?.slice(0, 120) || undefined;
  const r = await confirmarLoteDesdeCsv(req.file.buffer.toString('utf-8'), nombre, req.user!.sub);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  await audit(req, { action: 'create', resource: 'tramite_lote', resourceId: String(r.result.loteId), detail: `Lote (CSV servidor): ${r.result.ok} ok, ${r.result.errores} errores` });
  res.status(201).json(r.result);
});

const loteConfirmSchema = z.object({
  nombre: z.string().max(120).optional(),
  tipologiaDefault: z.string().max(40).optional(),
  filas: z.array(z.object({
    vin: z.string().max(17),
    placa: z.string().max(10).nullable().optional(),
    tipologiaCodigo: z.string().max(40).nullable().optional(),
    preflightOverall: z.string().max(10).nullable().optional(),
    fila: z.number().int().optional(),
    // LOTE-PLUS-02
    compradorDoc: z.string().max(15).nullable().optional(),
    compradorNombre: z.string().max(200).nullable().optional(),
    laftStatus: z.string().max(10).nullable().optional(),
    laftMatches: z.number().int().nullable().optional(),
  })).min(1).max(MAX_FILAS),
});

// Confirmar: crea N borradores en chunks de ≤50.
router.post('/lote', async (req: Request, res: Response) => {
  const parsed = loteConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const result = await confirmarLote(parsed.data, req.user!.sub);
  await audit(req, { action: 'create', resource: 'tramite_lote', resourceId: String(result.loteId), detail: `Lote: ${result.ok} ok, ${result.errores} errores` });
  res.status(201).json(result);
});

// LOTE-PLUS-01: polling de progreso. ANTES de GET /lote/:id.
router.get('/lote/:id/estado', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const estado = await getLoteEstado(id);
  if (!estado) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
  res.json(estado);
});

router.get('/lote/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const lote = await getLote(id);
  if (!lote) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
  res.json(lote);
});

// LOTE-PLUS-03: reintenta las filas en error del lote (solo admin).
router.post('/lote/:id/reprocesar-errores', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const result = await reprocesarErroresLote(id, req.user!.sub);
  if (!result) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'tramite_lote', resourceId: String(id), detail: `Reproceso lote: ${result.recuperadas} recuperadas, ${result.errores} errores restantes` });
  res.json(result);
});

// LOTE-PLUS-03: export CSV de resultados del lote (solo admin).
router.get('/lote/:id/resultados.csv', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const csv = await exportResultadosCsv(id);
  if (csv == null) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
  await audit(req, { action: 'export', resource: 'tramite_lote', resourceId: String(id), detail: 'Export CSV resultados lote' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lote_${id}_resultados.csv"`);
  res.send(csv);
});

// TRAM-INNOV A1: pre-vuelo (semáforo SOAT/SIMIT/RUNT). Puede correr en el paso 1
// con solo VIN/placa (antes de crear el trámite). Degradación elegante: cada
// fuente caída → check `unknown` (nunca 500 por integración).
const preflightSchema = z.object({
  vin: z.string().max(17).optional(),
  placa: z.string().max(10).optional(),
  compradorDoc: z.string().max(30).optional(),
  compradorTipoDoc: z.string().max(10).optional(),
  compradorNombre: z.string().max(200).optional(),
  vendedorDoc: z.string().max(30).optional(),
  vendedorTipoDoc: z.string().max(10).optional(),
  vendedorNombre: z.string().max(200).optional(),
  tramiteId: z.number().int().positive().optional(),
}).refine((d) => d.vin || d.placa, { message: 'Se requiere VIN o placa' });

router.post('/preflight', async (req: Request, res: Response) => {
  const parsed = preflightSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const snapshot = await computePreflight(parsed.data, req.user?.sub ?? null);
  // A4: si hay trámite y el pre-vuelo quedó amarillo, avisar a participantes opt-in.
  if (parsed.data.tramiteId && snapshot.overall === 'yellow') notifyEstado(parsed.data.tramiteId, 'preflight_amarillo').catch(() => {});
  res.json(snapshot);
});

const impuestoConsultaSchema = z.object({
  placa: z.string().min(4).max(10),
  docNumber: z.string().max(30).optional(),
  organismoCodigo: z.string().max(10).optional(),
  departamento: z.string().max(30).optional(),
}).strict();

// TRAM-TRASPASO-P1 — consulta impuesto vehicular (integración directa).
router.post('/impuesto-vehicular/consultar', async (req: Request, res: Response) => {
  const parsed = impuestoConsultaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const r = await consultarImpuestoVehicular(parsed.data);
  if (!r.ok) { res.status(r.status).json({ ok: false, error: r.error, code: r.code }); return; }
  res.json({ ok: true, fuente: r.fuente, datos: r.datos, advertencia: r.advertencia ?? null });
});

// F9: Stats ANTES de /:id para que Express no lo matchee como ID
// #19: Métricas temporales de trámites
router.get('/stats/metricas', async (_req: Request, res: Response) => {
  try {
    const hoy = new Date();
    const hace30d = new Date(hoy.getTime() - 30 * 24 * 60 * 60 * 1000);

    const porEstado = await db.select({
      estado: tramitesDigitales.estado,
      count: sql<number>`count(*)::int`,
    }).from(tramitesDigitales).groupBy(tramitesDigitales.estado);

    const recientes = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(tramitesDigitales).where(sql`${tramitesDigitales.createdAt} >= ${hace30d}`);

    const completados = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(tramitesDigitales).where(and(
      eq(tramitesDigitales.estado, 'completado'),
      sql`${tramitesDigitales.updatedAt} >= ${hace30d}`
    ));

    res.json({
      porEstado: Object.fromEntries(porEstado.map(r => [r.estado, r.count])),
      tramites30d: recientes[0]?.count || 0,
      completados30d: completados[0]?.count || 0,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/stats/resumen', async (_req: Request, res: Response) => {
  const result = await db.select({
    estado: tramitesDigitales.estado,
    count: sql<number>`count(*)::int`,
  }).from(tramitesDigitales).groupBy(tramitesDigitales.estado);
  const stats: Record<string, number> = { borrador: 0, radicado: 0, en_validacion: 0, documentos: 0, identidad: 0, aprobado: 0, rechazado: 0 };
  result.forEach((r) => { stats[r.estado] = r.count; });
  res.json(stats);
});

// D4: Listar con paginacion + filtros por estado y búsqueda
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const rango = parseFechaRangoQuery(req.query as Record<string, unknown>);
  const modalidadRaw = req.query.modalidadEntrada;
  const modalidadEntrada = modalidadRaw === 'traspaso' || modalidadRaw === 'matricula_inicial' ? modalidadRaw : undefined;
  const { items, total } = await listTramites({
    etapa: typeof req.query.etapa === 'string' ? req.query.etapa : undefined,
    estado: req.query.estado as string | undefined,
    search: (req.query.search as string | undefined)?.slice(0, 100),
    rango: tieneFiltroFecha(rango) ? rango : undefined,
    modalidadEntrada,
    limit, offset,
  });
  res.json({ items, total, limit, offset });
});

// Obtener tramite por ID
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const t = await getTramiteWithDocs(id);
  if (!t) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  res.json(t);
});

// TRAM-INNOV A5: estado computado del checklist de la tipología del trámite.
// `checklist: null` si el trámite no tiene tipología elegida.
router.get('/:id/checklist', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const result = await getChecklistForTramite(id);
  if (!result.ok) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  res.json({ checklist: result.checklist });
});

// TRAM-INNOV B2 (Sprint D): copiloto IA del checklist (HITL). Sugerencias para
// priorizar ítems pendientes — NUNCA auto-marca ni envía a tránsito. Sin IA
// configurada → 503 (degradación). Sin PII en el prompt.
router.post('/:id/checklist/sugerir', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const result = await getChecklistForTramite(id);
  if (!result.ok) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  if (!result.checklist) { res.status(400).json({ error: 'Selecciona una tipología antes de pedir sugerencias' }); return; }

  const ia = await sugerirChecklist(result.checklist);
  if (!ia.ok) { res.status(ia.status).json({ error: ia.message, code: 'ia_no_disponible' }); return; }

  await audit(req, { action: 'view', resource: 'tramite', resourceId: String(id), detail: `Copiloto checklist: ${ia.sugerencias.length} sugerencia(s)` });
  res.json({ sugerencias: ia.sugerencias, disclaimer: ia.disclaimer, hitl: true });
});

// TRAM-INNOV A1: último snapshot de pre-vuelo del trámite (o null).
router.get('/:id/preflight', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const snapshot = await getLatestPreflight(id);
  res.json({ preflight: snapshot });
});

// TRAM-INNOV-PRE-02: telemetría de click en CTA accionable del pre-vuelo.
// Best-effort: registra el evento + métrica. `ctaId` validado contra el catálogo
// canónico (shared-types) para no contaminar la telemetría.
const preflightCtaSchema = z.object({
  checkKey: z.string().max(40),
  ctaId: z.string().max(40),
  overall: z.enum(['green', 'yellow', 'red']).optional(),
});
router.post('/:id/preflight/cta', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = preflightCtaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  if (!isValidCtaId(parsed.data.ctaId)) { res.status(400).json({ error: 'ctaId no reconocido' }); return; }

  tramPreflightCtaClickedTotal.inc({ cta_id: parsed.data.ctaId });
  emitEvento({
    tramiteId: id, tipo: 'preflight_cta_clicked',
    actorUserId: req.user!.sub, actorRole: req.user!.role,
    payload: { checkKey: parsed.data.checkKey, ctaId: parsed.data.ctaId, overall: parsed.data.overall ?? null },
  });
  res.json({ ok: true });
});

// TRAM-OPS-02: rechazo OT con motivo tipificado (admin|transito).
const rechazarOtSchema = z.object({
  codigo: z.enum(['doc_faltante', 'comparendo', 'laft', 'datos_runt', 'otro']),
  nota: z.string().max(2000).optional(),
});

router.post('/:id/rechazar-ot', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = rechazarOtSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const result = await rechazarOtTramite(id, parsed.data, req.user!.sub);
  if (!result.ok) {
    if (result.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    if (result.code === 'invalid_codigo') { res.status(400).json({ error: 'Código de motivo inválido' }); return; }
    if (result.code === 'estado_no_elegible') { res.status(409).json({ error: 'El trámite no admite rechazo OT en este estado', estado: result.estado }); return; }
    if (result.code === 'invalid_transition') { res.status(409).json({ error: `Transición no permitida: ${result.from} → ${result.to}` }); return; }
    res.status(409).json({ error: 'Conflicto de concurrencia — el trámite fue modificado por otro usuario' }); return;
  }

  const { codigo, nota } = parsed.data;
  await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: `Rechazo OT: ${codigo}` });
  emitEvento({
    tramiteId: id,
    tipo: 'rechazado_ot',
    actorUserId: req.user!.sub,
    actorRole: req.user!.role,
    payload: { codigo, nota: nota ?? null, checklistSugeridos: result.checklistSugeridos },
  });
  notifyEstado(id, 'rechazado_ot').catch(() => {});
  res.json({ ok: true, tramite: result.tramite, checklistSugeridos: result.checklistSugeridos });
});

// TRAM-INNOV A2: timeline del expediente (cronológico).
router.get('/:id/timeline', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  res.json({ eventos: await getTimeline(id) });
});

// TRAM-INNOV A3: invitar participantes externos (genera magic links por rol).
const invitarSchema = z.object({
  participantes: z.array(z.object({
    rol: z.enum(VALID_ROLES),
    nombre: z.string().max(200).optional(),
    email: z.string().email().max(150).optional(),
    telefono: z.string().max(30).optional(),
    whatsappOptIn: z.boolean().optional(),
  })).min(1).max(3),
});

router.post('/:id/invitar', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = invitarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const links = await crearInvitaciones(id, parsed.data.participantes, { userId: req.user!.sub, role: req.user!.role });
  if (!links) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  await audit(req, { action: 'create', resource: 'tramite', resourceId: String(id), detail: `Invitó ${links.length} participante(s)` });
  res.status(201).json({ links });
});

// TRAM-COMMS-02: participantes pendientes (no completados) + su último recordatorio.
// Para que el gestor vea quién falta y cuándo se le recordó por última vez.
router.get('/:id/participantes-pendientes', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const participantes = await listarParticipantesPendientes(id);
  res.json({ participantes });
});

// TRAM-INNOV-EXP-PDF: expediente certificado PDF + QR embebido (on-demand).
router.get('/:id/expediente.pdf', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const tramite = await getTramiteWithDocs(id);
  if (!tramite) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  const eventos = await getTimeline(id);
  if (eventos.length === 0) { res.status(400).json({ error: 'Sin eventos en el expediente' }); return; }
  const verify = await resolveVerifyUrl(id, { userId: req.user!.sub, role: req.user!.role }, env.PUBLIC_URL);
  if (!verify) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  const tip = getTipologia(tramite.tipologiaCodigo);
  const pdfEventos = timelineToPdfEventos(eventos);

  // Fase 3 — branding del organismo destino (alias/logo) si el trámite tiene STT.
  const orgCodigo = tramite.organismoCodigo ?? extractOrganismoCodigoFromVehiculo(tramite.vehiculo);
  let organismo: OrganismoBranding | null = null;
  let logoPng: Buffer | null = null;
  if (orgCodigo) {
    const cfg = await getOrganismoConfig(orgCodigo);
    if (cfg) {
      organismo = { codigo: cfg.codigo, nombre: cfg.nombre, ciudad: cfg.ciudad, alias: cfg.alias };
      logoPng = await loadOrganismoLogoBytes({ storageKey: cfg.logoStorageKey, externalUrl: cfg.logoUrlExterno });
    }
  }

  const meta = {
    tramiteId: id,
    estado: tramite.estado,
    placa: tramite.placa,
    vinMasked: maskVin(tramite.vin),
    tipologia: tramite.tipologiaCodigo,
    tipologiaNombre: tip?.nombre ?? tramite.tipologiaCodigo,
    verifyUrl: verify.url,
    verifyExpires: verify.expires,
    eventos: pdfEventos,
    organismo,
    logoPng,
  };
  const pdf = await buildExpedientePdf(meta);
  await audit(req, {
    action: 'export',
    resource: 'tramite',
    resourceId: String(id),
    detail: orgCodigo ? `Expediente PDF generado · organismo ${orgCodigo}` : 'Expediente PDF generado',
  });
  emitEvento({
    tramiteId: id,
    tipo: 'expediente_pdf_generado',
    actorUserId: req.user!.sub,
    actorRole: req.user!.role,
    payload: { eventosIncluidos: pdfEventos.length, verifyExpires: verify.expires },
  });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="expediente-${id}-${stamp}.pdf"`);
  res.send(pdf);
});

// TRAM-INNOV A2: generar token de verificación pública (QR), TTL 7d, revocable.
router.post('/:id/verify-token', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const result = await generateVerifyToken(id, { userId: req.user!.sub, role: req.user!.role });
  if (!result.ok) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  await audit(req, { action: 'export', resource: 'tramite', resourceId: String(id), detail: 'Token verificación QR generado' });
  const url = `${env.PUBLIC_URL}/tramite/verificar?t=${result.token}`;
  const qrPng = `data:image/png;base64,${(await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' })).toString('base64')}`;
  res.json({ token: result.token, expires: result.expires, url, qrPng });
});

// Crear tramite
const createSchema = z.object({
  vin: z.string().min(1).max(17).optional(),
  placa: z.string().max(10).optional(),
  vehiculo: vehiculoSchema.optional(),  // TRAM-08: validado (antes z.any())
  // TRAM-TRASPASO-F1: modalidad de entrada (default matricula_inicial).
  modalidadEntrada: z.enum(['matricula_inicial', 'traspaso']).optional(),
}).refine(
  (d) => (d.modalidadEntrada === 'traspaso' ? !!d.placa : !!d.vin),
  { message: 'Matrícula inicial requiere VIN; traspaso requiere placa' },
);

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  let tramite;
  try {
    tramite = await createTramite(parsed.data, req.user!.sub);
  } catch (e) {
    if (e instanceof TramiteVinConflictError) {
      res.status(409).json({
        error: e.message,
        code: e.code,
        existingTramite: e.existingTramite,
      });
      return;
    }
    throw e;
  }
  await audit(req, { action: 'create', resource: 'tramite', resourceId: String(tramite.id), detail: `VIN: ${tramite.vin}` });
  emitEvento({ tramiteId: tramite.id, tipo: 'creado', actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { vin: tramite.vin } });
  notifyEstado(tramite.id, 'tramite_creado').catch(() => {}); // A4: best-effort, gated por config
  if (tramite.vin) await appendEventoSafe({ vin: tramite.vin, eventoTipo: 'tramite_creado', payload: { placa: tramite.placa }, referenciaTramiteId: tramite.id }); // B1
  res.status(201).json(tramite);
});

// TRAM-TRASPASO-F1 — transición de estado STT del traspaso (admin|transito).
const estadoSttSchema = z.object({
  estado: z.string().min(1).max(20),
  nota: z.string().max(500).optional(),
}).strict();

router.patch('/:id/estado', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = estadoSttSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const r = await transicionarEstadoStt({
    tramiteId: id, estado: parsed.data.estado, nota: parsed.data.nota,
    userId: req.user!.sub, username: req.user!.username,
    actorRole: req.user!.role, transitoCodigo: req.user!.transitoCodigo ?? null,
  });
  if (!r.ok) {
    const status = r.code === 'not_found' ? 404
      : r.code === 'no_traspaso' || r.code === 'biometria_gate' ? 409
        : r.code === 'organismo_forbidden' ? 403 : 400;
    res.status(status).json({ error: r.message, code: r.code });
    return;
  }
  await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: `Estado STT → ${r.estado}` });
  emitEvento({ tramiteId: id, tipo: 'cambio_estado', actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { estado: r.estado, radicado: r.numeroRadicado } });
  res.json({ ok: true, estado: r.estado, numeroRadicado: r.numeroRadicado });
});

// F4: Validar estado contra enum + C2: Optimistic locking
const updateSchema = z.object({
  paso: z.number().int().min(1).max(6).optional(),
  estado: z.enum(VALID_ESTADOS).optional(),
  // TRAM-08: campos JSONB con contrato Zod (cierra TODO #10).
  vehiculo: vehiculoSchema.optional(),
  comprador: compradorSchema.optional(),
  documentos: documentosSchema.optional(),
  validacionIdentidad: validacionIdentidadSchema.optional(),
  notas: z.string().max(5000).optional(),
  placa: z.string().max(10).optional(),
  // TRAM-INNOV A5: tipología elegida + overrides manuales del checklist.
  tipologiaCodigo: z.string().max(40).nullable().optional(),
  checklistEstado: z.record(z.string(), z.boolean()).optional(),
});

router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const vehPatch = parsed.data.vehiculo as Record<string, unknown> | undefined;
  if (vehPatch && '_forzarContinuar' in vehPatch) {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Solo administradores pueden forzar continuar', code: 'forzar_admin' });
      return;
    }
    if (vehPatch._forzarContinuar === null || vehPatch._forzarContinuar === false) {
      delete vehPatch._forzarContinuar;
    } else if (typeof vehPatch._forzarContinuar === 'object') {
      vehPatch._forzarContinuar = {
        ...(vehPatch._forzarContinuar as Record<string, unknown>),
        at: new Date().toISOString(),
        userId: req.user!.sub,
      };
    }
  }

  const result = await patchTramite(id, parsed.data, req.user!.sub, { actorRole: req.user!.role });
  if (!result.ok) {
    if (result.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    if (result.code === 'invalid_transition') { res.status(409).json({ error: `Transición no permitida: ${result.from} → ${result.to}` }); return; }
    if (result.code === 'checklist_incompleto') {
      res.status(409).json({ error: 'Faltan documentos/ítems obligatorios del checklist para enviar a tránsito', code: 'checklist_incompleto', faltan: result.faltan, tipologia: result.tipologia });
      return;
    }
    if (result.code === 'organismo_requerido') {
      res.status(409).json({ error: 'Seleccione la secretaría de tránsito antes de enviar', code: 'organismo_requerido' });
      return;
    }
    if (result.code === 'simit_gate') {
      res.status(409).json({ error: result.message, code: 'simit_gate' });
      return;
    }
    if (result.code === 'partes_duplicadas') {
      res.status(400).json({ error: result.message, code: 'partes_duplicadas' });
      return;
    }
    if (result.code === 'paso_gate' || result.code === 'comercial_gate' || result.code === 'paso_cerrado' || result.code === 'identidad_requerida' || result.code === 'gestion_cerrada') {
      res.status(409).json({ error: result.message, code: result.code });
      return;
    }
    res.status(409).json({ error: 'Conflicto de concurrencia — el trámite fue modificado por otro usuario' }); return;
  }

  await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: `Paso: ${result.updated.paso}, Estado: ${result.updated.estado}` });
  if (vehPatch && '_forzarContinuar' in vehPatch) {
    await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: 'Admin: forzarContinuar traspaso activado' });
  }
  // A2: registrar cambio de estado en el expediente (no para ediciones de solo paso/datos).
  if (parsed.data.estado !== undefined) {
    const tipo = parsed.data.estado === 'enviado_transito' ? 'enviado_transito'
      : parsed.data.estado === 'rechazado' ? 'rechazado_ot' : 'cambio_estado';
    emitEvento({ tramiteId: id, tipo, actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { estado: result.updated.estado, paso: result.updated.paso } });
    // A4: notificar a participantes con opt-in en hitos clave (best-effort, gated).
    if (parsed.data.estado === 'enviado_transito') notifyEstado(id, 'enviado_transito').catch(() => {});
    else if (parsed.data.estado === 'rechazado') notifyEstado(id, 'rechazado_ot').catch(() => {});
    // B1: pasaporte VIN en envío a tránsito.
    if (parsed.data.estado === 'enviado_transito' && result.updated.vin) {
      await appendEventoSafe({ vin: result.updated.vin, eventoTipo: 'tramite_enviado_transito', payload: { placa: result.updated.placa }, referenciaTramiteId: id });
    }
  }
  res.json(result.updated);
});

// S4: Subir documento con filename sanitizado
router.post('/:id/documentos', upload.single('file'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
  const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED_MIME.includes(req.file.mimetype)) { res.status(400).json({ error: 'Tipo de archivo no permitido. Use PDF, JPEG, PNG o WebP.' }); return; }
  const rawTipo = (req.body.tipo || 'otro') as string;
  const tipo = VALID_DOC_TYPES.includes(rawTipo as any) ? rawTipo : 'otro';

  const [tramite] = await db.select({ id: tramitesDigitales.id, modalidad: tramitesDigitales.modalidadEntrada, estado: tramitesDigitales.estado }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  if (!tramite) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
  // Dual-actor: docs STT solo en flujo STT; docs de gestión solo con expediente abierto.
  const mutacion = esDocTipoStt(tipo) ? 'stt_documento' as const : 'gestion_expediente' as const;
  const gateExp = await assertTraspasoMutacion(id, req.user!.role, mutacion, tipo);
  if (!gateExp.ok) {
    if (gateExp.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    res.status(409).json({ error: gateExp.message, code: gateExp.code });
    return;
  }

  const dir = path.join(process.cwd(), 'uploads', 'tramites', String(id));
  await mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(req.file.originalname);
  const filename = `${tipo}_${Date.now()}_${safeName}`;
  await writeFile(path.join(dir, filename), req.file.buffer);

  const [doc] = await db.insert(tramitesDocumentos).values({
    tramiteId: id, tipo,
    filename: `uploads/tramites/${id}/${filename}`,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype, size: req.file.size,
  }).returning();
  await audit(req, { action: 'upload', resource: 'tramite_doc', resourceId: String(id), detail: `${tipo}: ${safeName}` });
  // A2: evento con hash SHA-256 del archivo (trazabilidad de integridad).
  emitEvento({ tramiteId: id, tipo: 'documento_subido', actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { tipo }, docHash: sha256(req.file.buffer) });
  res.status(201).json(doc);
});

router.get('/:id/documentos', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const docs = await db.select().from(tramitesDocumentos).where(eq(tramitesDocumentos.tramiteId, id));
  res.json(docs);
});

// Descargar archivo de documento
router.get('/:tramiteId/documentos/:docId/archivo', async (req: Request, res: Response) => {
  const tramiteId = parseInt(req.params.tramiteId, 10);
  const docId = parseInt(req.params.docId, 10);
  if (!Number.isFinite(tramiteId) || !Number.isFinite(docId)) { res.status(400).json({ error: 'IDs inválidos' }); return; }
  const [doc] = await db.select().from(tramitesDocumentos)
    .where(and(eq(tramitesDocumentos.id, docId), eq(tramitesDocumentos.tramiteId, tramiteId))).limit(1);
  if (!doc) { res.status(404).json({ error: 'Documento no encontrado' }); return; }
  const filePath = path.resolve(process.cwd(), doc.filename);
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!filePath.startsWith(uploadsDir)) { res.status(403).json({ error: 'Acceso denegado' }); return; }
  try { await access(filePath); } catch { res.status(404).json({ error: 'Archivo no encontrado en disco' }); return; }
  res.setHeader('Content-Type', doc.mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.originalName || 'documento')}`);
  res.sendFile(filePath);
});

// Endpoint viejo eliminado — usar DELETE /:tramiteId/documentos/:docId con ownership check

// F1: DELETE documento verifica ownership + gate dual-actor (paridad POST upload).
router.delete('/:tramiteId/documentos/:docId', async (req: Request, res: Response) => {
  const tramiteId = parseInt(req.params.tramiteId, 10);
  const docId = parseInt(req.params.docId, 10);
  if (!Number.isFinite(tramiteId) || !Number.isFinite(docId)) { res.status(400).json({ error: 'IDs inválidos' }); return; }
  const [doc] = await db.select().from(tramitesDocumentos)
    .where(and(eq(tramitesDocumentos.id, docId), eq(tramitesDocumentos.tramiteId, tramiteId))).limit(1);
  if (!doc) { res.status(404).json({ error: 'Documento no encontrado en este trámite' }); return; }

  const mutacion = esDocTipoStt(doc.tipo) ? 'stt_documento' as const : 'gestion_expediente' as const;
  const gateExp = await assertTraspasoMutacion(tramiteId, req.user!.role, mutacion, doc.tipo);
  if (!gateExp.ok) {
    if (gateExp.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    res.status(409).json({ error: gateExp.message, code: gateExp.code });
    return;
  }

  const [deleted] = await db.delete(tramitesDocumentos)
    .where(and(eq(tramitesDocumentos.id, docId), eq(tramitesDocumentos.tramiteId, tramiteId)))
    .returning();
  if (!deleted) { res.status(404).json({ error: 'Documento no encontrado en este trámite' }); return; }
  // Borrar archivo físico del disco
  const filePath = path.resolve(process.cwd(), deleted.filename);
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (filePath.startsWith(uploadsDir)) {
    const { unlink } = await import('fs/promises');
    await unlink(filePath).catch(() => {});
  }
  await audit(req, { action: 'delete', resource: 'tramite_doc', resourceId: String(docId), detail: `Trámite ${tramiteId}: ${deleted.tipo} — ${deleted.originalName}` });
  res.json({ ok: true });
});

// Generar FUR (orquestación en el servicio; resiliencia TRAM-10 preservada)
router.post('/:id/generar-fur', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const gateExp = await assertTraspasoMutacion(id, req.user!.role, 'generar_legal');
  if (!gateExp.ok) {
    if (gateExp.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    res.status(409).json({ error: gateExp.message, code: gateExp.code });
    return;
  }

  const result = await generarFur(id, { orgNombre: req.body.orgNombre, orgCiudad: req.body.orgCiudad, orgCodigo: req.body.orgCodigo });
  if (!result.ok) {
    if (result.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    const payload: Record<string, unknown> = { error: result.error, code: result.code };
    if (result.code === 'fur_upstream') payload.upstreamStatus = result.upstreamStatus;
    res.status(result.status).json(payload);
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="FUR_${result.placa || 'vehiculo'}.pdf"`);
  res.send(result.pdf);
  audit(req, { action: 'export', resource: 'tramite', resourceId: String(id), detail: `FUR placa=${result.placa}` }).catch(() => {});
});

// TRAM-TRASPASO-F2 / ADR-OPS-001 F2 — PDF local o proxy CEA.
function docsGeneracionHabilitada(res: Response): boolean {
  if (useLocalPdf()) return true;
  if (!env.CEA_DOCS_PROXY_ENABLED) {
    res.status(503).json({ error: 'La generación de documentos no está disponible. Contacta soporte.', code: 'docs_disabled' });
    return false;
  }
  return true;
}

function sendDoc(res: Response, tipo: string, filename: string, result: Awaited<ReturnType<typeof generarContrato>>) {
  if (!result.ok) {
    if (result.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return false; }
    const payload: Record<string, unknown> = { error: result.error, code: result.code };
    if (result.code === 'doc_upstream') payload.upstreamStatus = result.upstreamStatus;
    res.status(result.status).json(payload); return false;
  }
  res.setHeader('Content-Type', result.contentType);
  if (result.hash) res.setHeader('X-Doc-Hash', result.hash);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(result.pdf);
  return true;
}

router.post('/:id/generar-contrato', async (req: Request, res: Response) => {
  if (!docsGeneracionHabilitada(res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const gateExp = await assertTraspasoMutacion(id, req.user!.role, 'generar_legal');
  if (!gateExp.ok) {
    if (gateExp.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    res.status(409).json({ error: gateExp.message, code: gateExp.code });
    return;
  }
  const result = await generarContrato(id, { orgNombre: req.body.orgNombre, orgCiudad: req.body.orgCiudad });
  if (sendDoc(res, 'contrato', `Contrato_Compraventa_${id}.pdf`, result)) {
    audit(req, { action: 'export', resource: 'tramite', resourceId: String(id), detail: 'Contrato compraventa generado' }).catch(() => {});
  }
});

router.post('/:id/generar-improntas', async (req: Request, res: Response) => {
  if (!docsGeneracionHabilitada(res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const gateExp = await assertTraspasoMutacion(id, req.user!.role, 'generar_legal');
  if (!gateExp.ok) {
    if (gateExp.code === 'not_found') { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    res.status(409).json({ error: gateExp.message, code: gateExp.code });
    return;
  }
  const result = await generarImprontas(id, { orgNombre: req.body.orgNombre, orgCiudad: req.body.orgCiudad });
  if (sendDoc(res, 'improntas', `Improntas_${id}.pdf`, result)) {
    audit(req, { action: 'export', resource: 'tramite', resourceId: String(id), detail: `Improntas generadas${result.ok && result.hash ? ` hash=${result.hash.slice(0, 12)}` : ''}` }).catch(() => {});
  }
});

export default router;
