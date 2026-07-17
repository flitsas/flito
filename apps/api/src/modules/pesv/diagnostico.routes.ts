// PESV Auto-diagnóstico PHVA · Rutas API. Sprint UX rediseño estrategia A
// (split de rollout): backend retrocompatible con slider 0-100 mientras AURA
// termina el frontend nuevo de rúbrica. La validación estricta a {0,50,75,100}
// se activa en migración 0070 + endurecimiento de itemPatchSchema en deploy
// coordinado. BICHO A1..A7 + BRUNO D1..D8 aplicados.

import { Router, Request, Response } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db/client.js';
import { pesvDiagnosticos, pesvDiagnosticoItems, pesvEstandaresCatalogo, auditLogs } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { pesvDiagnosticoCerradoTotal } from '../../shared/metrics.js';
import { loggerFor } from '../../shared/logger.js';
import {
  diagnosticoCreateSchema, itemPatchSchema,
  NIVEL_RUBRICA_TO_SCORE, scoreToNivelRubrica,
  type PreflightBloqueo, type PreflightAdvertencia, type PreflightResponse,
} from './diagnostico.schemas.js';
import evidenciasRouter from './diagnostico-evidencias.routes.js';

const log = loggerFor('pesv.diagnostico');
const router = Router();
router.use(authMiddleware, requirePage('pesv'));
router.use('/', evidenciasRouter);  // upload/delete/get presigned + view audit

// Orden enum para filtrar catálogo por nivel acumulativo (basico<estandar<avanzado).
const NIVEL_RANK: Record<'basico' | 'estandar' | 'avanzado', number> = {
  basico: 1,
  estandar: 2,
  avanzado: 3,
};

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================================
// GET / — listado de diagnósticos
// ============================================================================
router.get('/', async (_req: Request, res: Response) => {
  const rows = await db.select().from(pesvDiagnosticos).orderBy(desc(pesvDiagnosticos.anio));
  res.json({ data: rows });
});

// ============================================================================
// GET /:id — detalle (con view=auditoria opcional)
// ============================================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'id inválido' }); return; }
  const view = String(req.query.view ?? '').toLowerCase();
  const auditoria = view === 'auditoria';

  const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
  if (!diag) { res.status(404).json({ error: 'no encontrado' }); return; }

  // Compliance sin view=auditoria: el frontend decide cómo redirigir.
  if (!auditoria && req.user?.role === 'compliance') {
    res.setHeader('X-Redirect-To', `/pesv/diagnostico/${id}/auditoria`);
  }
  if (auditoria && !['compliance', 'lider_pesv', 'admin'].includes(req.user!.role)) {
    res.status(403).json({ error: 'Sin permisos para vista auditoría' }); return;
  }

  // PESV-08 (B10): registrar el acceso a la vista de auditoría — trazabilidad de
  // quién inspeccionó el diagnóstico (especialmente compliance/revisor).
  if (auditoria) {
    await audit(req, { action: 'view', resource: 'pesv_diag', resourceId: String(id), detail: `view=auditoria rol=${req.user!.role}` });
  }

  const items = await db.execute(sql`
    SELECT i.diagnostico_id, i.estandar_id, i.score_pct, i.nivel_rubrica,
           i.evidencia_keys, i.comentarios, i.updated_at,
           c.codigo, c.paso, c.fase, c.nombre, c.descripcion, c.peso, c.orden
      FROM pesv_diagnostico_items i
      JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
     WHERE i.diagnostico_id = ${id}
     ORDER BY c.paso, c.orden
  ` as any) as any;
  const itemsArr = ((items?.rows ?? items ?? []) as any[]).map((r) => ({
    diagnosticoId: r.diagnostico_id,
    estandarId: r.estandar_id,
    codigo: r.codigo,
    paso: r.paso,
    fase: r.fase,
    nombre: r.nombre,
    descripcion: r.descripcion,
    peso: String(r.peso),
    orden: r.orden,
    scorePct: String(r.score_pct),
    nivelRubrica: r.nivel_rubrica,
    comentarios: r.comentarios,
    evidencias: ((r.evidencia_keys ?? []) as string[]).map((k) => evidenciaPublic(k, diag.createdBy, r.updated_at)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));

  // Vista auditoría: enriquecer con historial corto (10 últimos audit_logs).
  let historial: Array<{ createdAt: string; userId: number | null; action: string; detail: string | null; resourceId: string | null }> = [];
  if (auditoria) {
    const h = await db.select({
      createdAt: auditLogs.createdAt, userId: auditLogs.userId,
      action: auditLogs.action, detail: auditLogs.detail, resourceId: auditLogs.resourceId,
    }).from(auditLogs)
      .where(and(eq(auditLogs.resource, 'pesv_diag_item'), sql`${auditLogs.resourceId} LIKE ${`${id}/%`}`))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10);
    historial = h.map((r) => ({
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      userId: r.userId, action: r.action, detail: r.detail, resourceId: r.resourceId,
    }));
  }

  res.json({ ...diag, items: itemsArr, historial });
});

// Representación pública mínima de evidencia. ADR-PESV-001: el frontend usa
// keyHash, nunca la storageKey real. sizeBytes=0 acá porque no consultamos
// stat en bulk (lo hace el GET presigned). Frontend lo trata como "desconocido".
function evidenciaPublic(storageKey: string, uploadedBy: number, updatedAt: Date | string) {
  const filename = storageKey.split('/').pop()?.replace(/^\d+_[0-9a-f]+_/, '') ?? 'archivo';
  const keyHash = crypto.createHash('sha256').update(storageKey).digest('hex').slice(0, 16);
  return {
    keyHash, filename, sizeBytes: 0, mime: inferMime(filename),
    uploadedAt: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
    uploadedBy,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
function inferMime(name: string): string {
  return MIME_BY_EXT[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';
}

// ============================================================================
// POST / — crear diagnóstico (filtrado de catálogo por nivelEmpresa)
// ============================================================================
router.post('/', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const parsed = diagnosticoCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }
  const data = parsed.data;
  const userId = req.user!.sub;
  const rank = NIVEL_RANK[data.nivelEmpresa];

  try {
    const result = await db.transaction(async (tx) => {
      // Filtrado por nivel acumulativo: la empresa nivel `avanzado` incluye básico+estándar+avanzado.
      // Catálogo actual (24 estándares) está marcado nivel_minimo='avanzado' por default — el seed
      // 0069 ajustará basico/estandar tras concepto MOLANO.
      const estandares = await tx.execute(sql`
        SELECT id FROM pesv_estandares_catalogo
         WHERE vigente = true
           AND CASE nivel_minimo
                 WHEN 'basico'   THEN 1
                 WHEN 'estandar' THEN 2
                 WHEN 'avanzado' THEN 3
               END <= ${rank}
         ORDER BY paso, orden
      ` as any) as any;
      const arr = ((estandares?.rows ?? estandares ?? []) as Array<{ id: number }>);
      if (!arr.length) {
        // Caso "nivel basico con catálogo solo avanzado" — error claro al cliente.
        return { __err: 400 as const, msg: `catálogo PESV no tiene estándares para nivel ${data.nivelEmpresa} (revisar seed 0069)` };
      }
      const [diag] = await tx.insert(pesvDiagnosticos).values({
        anio: data.anio,
        fecha: data.fecha,
        responsableId: data.responsableId ?? userId,
        observaciones: data.observaciones ?? null,
        nivelEmpresa: data.nivelEmpresa,
        nivelCriterioJustificacion: data.nivelCriterioJustificacion ?? null,
        createdBy: userId,
      }).returning();
      await tx.insert(pesvDiagnosticoItems).values(
        arr.map((e) => ({ diagnosticoId: diag.id, estandarId: e.id, scorePct: '0' })),
      );
      return { diag, count: arr.length };
    });

    if ((result as any).__err) {
      res.status((result as any).__err).json({ error: (result as any).msg });
      return;
    }
    const ok = result as { diag: typeof pesvDiagnosticos.$inferSelect; count: number };
    await audit(req, { action: 'create', resource: 'pesv_diag', resourceId: String(ok.diag.id), detail: `anio=${data.anio} nivel=${data.nivelEmpresa} count=${ok.count}` });
    res.status(201).json({ ...ok.diag, count: ok.count });
  } catch (e: any) {
    if (e?.code === '23505') { res.status(409).json({ error: 'ya hay diagnóstico para ese año' }); return; }
    throw e;
  }
});

// ============================================================================
// PATCH /:id/items/:estandarId — actualizar item (rúbrica permisiva)
// ============================================================================
router.patch('/:id/items/:estandarId', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const estandarId = parseId(req.params.estandarId);
  if (!id || !estandarId) { res.status(400).json({ error: 'parámetros inválidos' }); return; }

  // BICHO A6: si llega evidenciaKeys, lo ignoramos silenciosamente (warn) — las evidencias
  // se manejan SOLO por endpoints dedicados POST/DELETE /evidencias.
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'evidenciaKeys')) {
    log.warn({ id, estandarId, userId: req.user?.sub }, 'PATCH item con evidenciaKeys ignorado — usar endpoint dedicado');
    delete req.body.evidenciaKeys;
  }

  const parsed = itemPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }

  const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
  if (!diag) { res.status(404).json({ error: 'diagnóstico no encontrado' }); return; }
  if (diag.estado === 'cerrado') { res.status(409).json({ error: 'diagnóstico cerrado (WORM)' }); return; }

  // Derivación score ↔ nivelRubrica. Prioridad: si llegan ambos → usar nivelRubrica (canónico).
  let scorePct: number | undefined = parsed.data.scorePct;
  let nivelRubrica = parsed.data.nivelRubrica;
  if (nivelRubrica !== undefined) {
    scorePct = NIVEL_RUBRICA_TO_SCORE[nivelRubrica];
  } else if (scorePct !== undefined) {
    nivelRubrica = scoreToNivelRubrica(scorePct);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (scorePct !== undefined) updates.scorePct = String(scorePct);
  if (nivelRubrica !== undefined) updates.nivelRubrica = nivelRubrica;
  if (parsed.data.comentarios !== undefined) updates.comentarios = parsed.data.comentarios ?? null;

  const [row] = await db.update(pesvDiagnosticoItems)
    .set(updates as any)
    .where(and(eq(pesvDiagnosticoItems.diagnosticoId, id), eq(pesvDiagnosticoItems.estandarId, estandarId)))
    .returning();

  if (!row) { res.status(404).json({ error: 'ítem no encontrado' }); return; }
  await audit(req, {
    action: 'update', resource: 'pesv_diag_item', resourceId: `${id}/${estandarId}`,
    detail: `score=${row.scorePct} nivel=${row.nivelRubrica}`,
  });
  res.json(row);
});

// ============================================================================
// Preflight (factor común — server + cliente)
// ============================================================================
async function computePreflight(diagnosticoId: number): Promise<PreflightResponse> {
  const rows = await db.execute(sql`
    SELECT i.estandar_id, i.score_pct::float AS score, i.nivel_rubrica, i.comentarios,
           c.codigo, c.peso::float AS peso,
           COALESCE(array_length(i.evidencia_keys, 1), 0)::int AS evid_count
      FROM pesv_diagnostico_items i
      JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
     WHERE i.diagnostico_id = ${diagnosticoId}
     ORDER BY c.paso, c.orden
  ` as any) as any;
  const arr = ((rows?.rows ?? rows ?? []) as any[]);

  let sumWS = 0;
  let sumW = 0;
  let evaluados = 0;
  let conEvidencia = 0;
  const bloqueos: PreflightBloqueo[] = [];
  const advertencias: PreflightAdvertencia[] = [];

  for (const r of arr) {
    sumWS += Number(r.score) * Number(r.peso);
    sumW += Number(r.peso);
    if (r.nivel_rubrica !== 'no_implementado' || Number(r.score) > 0) evaluados += 1;
    if (r.evid_count > 0) conEvidencia += 1;

    if (r.nivel_rubrica === 'no_implementado' && Number(r.score) === 0) {
      bloqueos.push({ estandarId: r.estandar_id, codigo: r.codigo, motivo: 'sin_evaluar' });
    }
    if (r.nivel_rubrica === 'implementado' && r.evid_count === 0) {
      bloqueos.push({ estandarId: r.estandar_id, codigo: r.codigo, motivo: 'nivel_implementado_sin_evidencia' });
    }
    if (r.nivel_rubrica === 'sostenido' && r.evid_count === 0) {
      bloqueos.push({ estandarId: r.estandar_id, codigo: r.codigo, motivo: 'nivel_sostenido_sin_evidencia' });
    }
    if (r.nivel_rubrica === 'en_desarrollo' && (r.comentarios == null || String(r.comentarios).trim().length < 10)) {
      advertencias.push({ estandarId: r.estandar_id, codigo: r.codigo, motivo: 'en_desarrollo_sin_comentario' });
    }
  }

  const scoreProyectado = sumW > 0 ? Math.max(0, Math.min(100, sumWS / sumW)) : 0;
  return {
    scoreProyectado: Number(scoreProyectado.toFixed(2)),
    totalEstandares: arr.length,
    evaluados,
    conEvidencia,
    bloqueos,
    advertencias,
    puedeCerrar: bloqueos.length === 0,
  };
}

// ============================================================================
// GET /:id/preflight — diagnóstico previo al cierre
// ============================================================================
router.get('/:id/preflight', requireRole('admin', 'lider_pesv', 'compliance'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'id inválido' }); return; }
  const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
  if (!diag) { res.status(404).json({ error: 'no encontrado' }); return; }
  const pre = await computePreflight(id);
  res.json(pre);
});

// ============================================================================
// POST /:id/cerrar — cierre WORM con preflight server-side (BICHO A5)
// ============================================================================
router.post('/:id/cerrar', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'id inválido' }); return; }

  // Defensa en profundidad: el cliente NO es la única autoridad para cerrar.
  const pre = await computePreflight(id);
  if (!pre.puedeCerrar) {
    res.status(409).json({
      error: 'no se puede cerrar — hay bloqueos pendientes',
      bloqueos: pre.bloqueos,
      advertencias: pre.advertencias,
      scoreProyectado: pre.scoreProyectado,
    });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [diag] = await tx.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).for('update').limit(1);
    if (!diag) return { code: 404 as const };
    if (diag.estado === 'cerrado') return { code: 409 as const, msg: 'ya cerrado' };

    const rows = await tx.execute(sql`
      SELECT COALESCE(SUM(i.score_pct * c.peso) / NULLIF(SUM(c.peso), 0), 0) AS score
        FROM pesv_diagnostico_items i
        JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
       WHERE i.diagnostico_id = ${id}
    ` as any) as any;
    const scoreNum = Number((rows?.rows?.[0] ?? rows?.[0])?.score ?? 0);
    const score = Math.max(0, Math.min(100, scoreNum)).toFixed(2);

    const [row] = await tx.update(pesvDiagnosticos).set({
      estado: 'cerrado',
      scoreGlobal: score,
      cerradoAt: new Date(),
      optimisticV: diag.optimisticV + 1,
    }).where(eq(pesvDiagnosticos.id, id)).returning();
    return { code: 200 as const, row };
  });

  if (result.code !== 200) {
    res.status(result.code).json({ error: (result as any).msg || 'no encontrado' });
    return;
  }
  await audit(req, { action: 'update', resource: 'pesv_diag', resourceId: String(id), detail: `cerrado score=${result.row.scoreGlobal}` });
  pesvDiagnosticoCerradoTotal.inc();  // PESV-07
  res.json(result.row);
});

// ============================================================================
// GET /:id/items/:estandarId/historial — audit log corto del item
// ============================================================================
router.get('/:id/items/:estandarId/historial', requireRole('admin', 'lider_pesv', 'compliance'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const estandarId = parseId(req.params.estandarId);
  if (!id || !estandarId) { res.status(400).json({ error: 'parámetros inválidos' }); return; }

  const rows = await db.select({
    createdAt: auditLogs.createdAt,
    userId: auditLogs.userId,
    action: auditLogs.action,
    detail: auditLogs.detail,
  }).from(auditLogs)
    .where(and(eq(auditLogs.resource, 'pesv_diag_item'), eq(auditLogs.resourceId, `${id}/${estandarId}`)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  res.json({
    data: rows.map((r) => ({
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      userId: r.userId,
      action: r.action,
      detail: r.detail,
    })),
  });
});

// ============================================================================
// Catálogo público (autenticado) — usado por modal de creación
// ============================================================================
const estandaresRouter = Router();
estandaresRouter.use(authMiddleware, requirePage('pesv'));
estandaresRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await db.select().from(pesvEstandaresCatalogo)
    .where(eq(pesvEstandaresCatalogo.vigente, true))
    .orderBy(pesvEstandaresCatalogo.paso, pesvEstandaresCatalogo.orden);
  res.json({ data: rows });
});

export { estandaresRouter };
export default router;
