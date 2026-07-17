import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import { laftRosDrafts, laftUnusualOperations, laftCounterparties } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { laftAudit } from './audit.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const writeLimiter = rateLimit({
  windowMs: 60_000, max: 20,
  keyGenerator: userOrIpKey('laft-ros'),
  message: { error: 'Demasiadas operaciones, espere 1 minuto' },
});

// SLA ROS: 24h desde clasificación (Resolución UIAF 122/2021).
// El timer NO arranca con la creación del borrador — arranca cuando el oficial de
// cumplimiento clasifica la operación como reportable. Ese momento es el que la
// UIAF considera para evaluar oportunidad del reporte.
const SLA_HOURS = 24;

// Estructura del payload SIREL — formato simplificado.
// El envío real al portal SIREL (https://reportes.uiaf.gov.co) es manual: el Empleado
// de Cumplimiento descarga este JSON, lo carga al portal y registra el radicado de vuelta.
function buildSirelPayload(args: {
  operation: typeof laftUnusualOperations.$inferSelect;
  counterparty: typeof laftCounterparties.$inferSelect | null;
  reportingEntity: { name: string; nit: string };
  generatedBy: { username: string };
}) {
  const { operation, counterparty, reportingEntity, generatedBy } = args;
  return {
    encabezado: {
      tipo_reporte: 'ROS',
      fecha_generacion: new Date().toISOString(),
      entidad_reportante: reportingEntity,
      empleado_cumplimiento: generatedBy.username,
    },
    operacion: {
      id_interno: operation.id,
      fecha_deteccion: operation.detectedAt,
      origen: operation.source,
      monto: operation.amount,
      moneda: operation.currency,
      descripcion: operation.description,
      senales_alerta: operation.signals,
      analisis: operation.analysisText,
    },
    contraparte: counterparty ? {
      tipo: counterparty.kind,
      tipo_documento: counterparty.docType,
      numero_documento: counterparty.docNumber,
      nombre_completo: counterparty.fullName,
      pais: counterparty.country,
      ciudad: counterparty.city,
      es_pep: counterparty.isPep,
      cargo_pep: counterparty.pepRole,
      origen_fondos_declarado: counterparty.fundOrigin,
      nivel_riesgo: counterparty.riskLevel,
      estado_actual: counterparty.status,
    } : null,
    notas: 'Este es un borrador del ROS para envío al SIREL. El envío al portal de la UIAF debe ser realizado manualmente por el Empleado de Cumplimiento.',
  };
}

// === Listar borradores ROS ==================================================
router.get('/', async (_req: Request, res: Response) => {
  const rows = await db.select({
    id: laftRosDrafts.id,
    operationId: laftRosDrafts.operationId,
    generatedAt: laftRosDrafts.generatedAt,
    sentToUiafAt: laftRosDrafts.sentToUiafAt,
    sirelRadicado: laftRosDrafts.sirelRadicado,
    notes: laftRosDrafts.notes,
    counterpartyName: laftCounterparties.fullName,
    counterpartyDoc: laftCounterparties.docNumber,
  }).from(laftRosDrafts)
    .leftJoin(laftUnusualOperations, eq(laftRosDrafts.operationId, laftUnusualOperations.id))
    .leftJoin(laftCounterparties, eq(laftUnusualOperations.counterpartyId, laftCounterparties.id))
    .orderBy(desc(laftRosDrafts.generatedAt))
    .limit(200);
  res.json(rows);
});

// === Detalle ================================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [r] = await db.select().from(laftRosDrafts).where(eq(laftRosDrafts.id, id));
  if (!r) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json(r);
});

// === Generar borrador desde una operación inusual ============================
router.post('/from-operation/:opId', writeLimiter, async (req: Request, res: Response) => {
  const opId = parseInt(req.params.opId, 10);
  if (!Number.isFinite(opId) || opId <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [op] = await db.select().from(laftUnusualOperations).where(eq(laftUnusualOperations.id, opId));
  if (!op) { res.status(404).json({ error: 'Operación no encontrada' }); return; }

  if (op.decision !== 'reportada' && op.decision !== 'escalada') {
    res.status(400).json({ error: 'La operación debe estar en decisión "escalada" o "reportada" para generar ROS' });
    return;
  }

  const [cp] = op.counterpartyId
    ? await db.select().from(laftCounterparties).where(eq(laftCounterparties.id, op.counterpartyId))
    : [null];

  const payload = buildSirelPayload({
    operation: op,
    counterparty: cp ?? null,
    reportingEntity: { name: 'FLIT SAS', nit: 'pendiente' },
    generatedBy: { username: req.user!.username },
  });

  const [created] = await db.insert(laftRosDrafts).values({
    operationId: opId,
    sirelPayload: payload,
    generatedBy: req.user!.sub,
  }).returning();

  await laftAudit(req, {
    action: 'generate_ros_draft', resource: 'document', resourceId: created.id,
    after: { operationId: opId, counterpartyId: op.counterpartyId },
  });

  res.status(201).json(created);
});

// === Clasificar (arranca timer SLA 24h) =====================================
// Idempotency-Key obligatorio: doble click del oficial NO debe duplicar el evento
// de clasificación. FOR UPDATE garantiza que dos requests concurrentes serializan.
router.post('/:id/clasificar', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const idempKey = req.header('Idempotency-Key');
  if (!idempKey || idempKey.length < 8 || idempKey.length > 80) {
    res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(laftRosDrafts).where(eq(laftRosDrafts.id, id)).for('update').limit(1);
    if (!r) return { code: 404 as const };
    // Idempotente: si ya está clasificado, devolver el mismo registro (200).
    if (r.clasificadoAt) return { code: 200 as const, row: r, idempotent: true };

    const now = new Date();
    const due = new Date(now.getTime() + SLA_HOURS * 60 * 60 * 1000);
    const [updated] = await tx.update(laftRosDrafts).set({
      clasificadoAt: now,
      slaDueAt: due,
    }).where(eq(laftRosDrafts.id, id)).returning();
    return { code: 200 as const, row: updated, idempotent: false };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (!result.idempotent) {
    await laftAudit(req, {
      action: 'ros_clasificado', resource: 'document', resourceId: id,
      after: { clasificadoAt: result.row.clasificadoAt, slaDueAt: result.row.slaDueAt },
    });
  }
  res.json(result.row);
});

// === Marcar como enviado al SIREL ===========================================
const sentSchema = z.object({
  sirelRadicado: z.string().min(3).max(50),
  sentAt: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

router.post('/:id/sent', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = sentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const sentAt = parsed.data.sentAt ? new Date(parsed.data.sentAt) : new Date();
  // UPDATE atómico: solo si todavía está sin enviar (sentToUiafAt IS NULL).
  // Marcar también sirelAcuseAt cierra el SLA del cron F4 (deja de alertar).
  const [updated] = await db.update(laftRosDrafts).set({
    sentToUiafAt: sentAt,
    sirelRadicado: parsed.data.sirelRadicado,
    sirelAcuseAt: sentAt,
    notes: parsed.data.notes ?? null,
  }).where(and(eq(laftRosDrafts.id, id), isNull(laftRosDrafts.sentToUiafAt))).returning();

  if (!updated) {
    // Si no actualizó es porque ya estaba enviado o no existe. Distinguimos:
    const [exists] = await db.select({ id: laftRosDrafts.id }).from(laftRosDrafts).where(eq(laftRosDrafts.id, id));
    if (!exists) { res.status(404).json({ error: 'No encontrado' }); return; }
    res.status(409).json({ error: 'Ya fue marcado como enviado' });
    return;
  }

  await laftAudit(req, { action: 'mark_ros_sent', resource: 'document', resourceId: id, after: { radicado: parsed.data.sirelRadicado } });
  res.json(updated);
});

// === Registrar radicado SIREL (cierre formal del SLA) =======================
// Endpoint canónico F4: tras data-entry humano en https://www.uiaf.gov.co/sirel,
// el oficial pega aquí el número de radicado retornado por el portal. FOR UPDATE
// + UPDATE atómico evitan que dos oficiales registren radicados distintos.
const radicadoSchema = z.object({
  sirelRadicado: z.string().min(3).max(60),
  notes: z.string().max(2000).optional(),
});

router.post('/:id/sirel-radicado', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const idempKey = req.header('Idempotency-Key');
  if (!idempKey || idempKey.length < 8 || idempKey.length > 80) {
    res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' });
    return;
  }
  const parsed = radicadoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(laftRosDrafts).where(eq(laftRosDrafts.id, id)).for('update').limit(1);
    if (!r) return { code: 404 as const };
    // Idempotente: mismo radicado ya registrado → 200; radicado distinto → 409.
    if (r.sirelAcuseAt) {
      if (r.sirelRadicado === parsed.data.sirelRadicado) return { code: 200 as const, row: r };
      return { code: 409 as const, msg: `Ya tiene radicado registrado (${r.sirelRadicado})` };
    }
    const [updated] = await tx.update(laftRosDrafts).set({
      sirelRadicado: parsed.data.sirelRadicado,
      sirelAcuseAt: now,
      sentToUiafAt: r.sentToUiafAt ?? now,
      notes: parsed.data.notes ?? r.notes ?? null,
    }).where(eq(laftRosDrafts.id, id)).returning();
    return { code: 200 as const, row: updated, fresh: true };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (result.code === 409) { res.status(409).json({ error: result.msg }); return; }
  if ((result as { fresh?: boolean }).fresh) {
    await laftAudit(req, {
      action: 'ros_sirel_radicado', resource: 'document', resourceId: id,
      after: { radicado: parsed.data.sirelRadicado, acuseAt: now },
    });
  }
  res.json(result.row);
});

// === Lista SLA pendiente ====================================================
// Para el dashboard del oficial: ROS clasificados pero aún sin radicado, ordenados
// por urgencia. Incluye el flag breached para resaltar en UI.
router.get('/sla/abiertos', async (_req: Request, res: Response) => {
  const rows = await db.select({
    id: laftRosDrafts.id,
    operationId: laftRosDrafts.operationId,
    clasificadoAt: laftRosDrafts.clasificadoAt,
    slaDueAt: laftRosDrafts.slaDueAt,
    slaBreached: laftRosDrafts.slaBreached,
    exportSha256: laftRosDrafts.exportSha256,
    counterpartyName: laftCounterparties.fullName,
  }).from(laftRosDrafts)
    .leftJoin(laftUnusualOperations, eq(laftRosDrafts.operationId, laftUnusualOperations.id))
    .leftJoin(laftCounterparties, eq(laftUnusualOperations.counterpartyId, laftCounterparties.id))
    .where(and(
      isNull(laftRosDrafts.sirelAcuseAt),
      sql`${laftRosDrafts.clasificadoAt} IS NOT NULL`,
    ))
    .orderBy(laftRosDrafts.slaDueAt)
    .limit(500);
  res.json(rows);
});

export default router;
