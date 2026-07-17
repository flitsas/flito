import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import crypto from 'crypto';
import argon2 from 'argon2';
import { db } from '../../db/client.js';
import {
  checklistTemplates, checklistTemplateItems, checklists, checklistResponses,
  vehicles, users, driverProfile, vehicleMeasurements,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// QR público — endpoint sin auth para validación en ruta. Rate-limited globalmente por apiLimiter.
router.get('/qr/:token', async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token || token.length > 64) { res.status(400).json({ error: 'Token inválido' }); return; }
  const [row] = await db.select({
    id: checklists.id,
    decision: checklists.decision,
    fechaHora: checklists.fechaHora,
    plate: vehicles.plate,
    conductorName: users.name,
    anuladoAt: checklists.anuladoAt,
  })
    .from(checklists)
    .leftJoin(vehicles, eq(vehicles.id, checklists.vehicleId))
    .leftJoin(users, eq(users.id, checklists.conductorId))
    .where(eq(checklists.qrToken, token))
    .limit(1);
  if (!row) { res.status(404).json({ valido: false }); return; }
  res.json({
    valido: row.anuladoAt === null,
    decision: row.decision,
    fechaHora: row.fechaHora,
    placa: row.plate,
    conductor: row.conductorName,
  });
});

// El resto requiere auth + permiso PESV.
router.use(authMiddleware, requirePage('pesv'));

// --- Plantillas ---

router.get('/templates', async (_req, res: Response) => {
  const tpls = await db.select().from(checklistTemplates)
    .where(eq(checklistTemplates.vigente, true))
    .orderBy(checklistTemplates.titulo);
  res.json({ data: tpls });
});

router.get('/templates/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [tpl] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
  if (!tpl) { res.status(404).json({ error: 'No encontrado' }); return; }
  const items = await db.select().from(checklistTemplateItems)
    .where(eq(checklistTemplateItems.templateId, id))
    .orderBy(checklistTemplateItems.orden);
  res.json({ data: tpl, items });
});

// --- Ejecuciones (listado) ---

router.get('/', async (req: Request, res: Response) => {
  const vehicleId = req.query.vehicleId ? parseId(String(req.query.vehicleId)) : null;
  const conductorId = req.query.conductorId ? parseId(String(req.query.conductorId)) : null;
  const decision = req.query.decision as string | undefined;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;
  const conds: any[] = [];
  if (vehicleId) conds.push(eq(checklists.vehicleId, vehicleId));
  if (conductorId) conds.push(eq(checklists.conductorId, conductorId));
  if (decision) conds.push(eq(checklists.decision, decision as any));
  if (desde) conds.push(gte(checklists.fechaHora, new Date(desde) as any));
  if (hasta) conds.push(lte(checklists.fechaHora, new Date(hasta + 'T23:59:59') as any));

  const rows = await db.select({
    id: checklists.id,
    plate: vehicles.plate,
    vehicleId: checklists.vehicleId,
    conductorId: checklists.conductorId,
    conductorName: users.name,
    fechaHora: checklists.fechaHora,
    decision: checklists.decision,
    anuladoAt: checklists.anuladoAt,
    qrToken: checklists.qrToken,
  })
    .from(checklists)
    .leftJoin(vehicles, eq(vehicles.id, checklists.vehicleId))
    .leftJoin(users, eq(users.id, checklists.conductorId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(checklists.fechaHora))
    .limit(500);
  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [c] = await db.select().from(checklists).where(eq(checklists.id, id)).limit(1);
  if (!c) { res.status(404).json({ error: 'No encontrado' }); return; }
  const responses = await db.select({
    id: checklistResponses.id,
    itemId: checklistResponses.itemId,
    label: checklistTemplateItems.label,
    categoria: checklistTemplateItems.categoria,
    criterio: checklistTemplateItems.criterio,
    critico: checklistTemplateItems.critico,
    valorBool: checklistResponses.valorBool,
    valorEstado: checklistResponses.valorEstado,
    valorNum: checklistResponses.valorNum,
    observacion: checklistResponses.observacion,
  })
    .from(checklistResponses)
    .leftJoin(checklistTemplateItems, eq(checklistTemplateItems.id, checklistResponses.itemId))
    .where(eq(checklistResponses.checklistId, id))
    .orderBy(checklistTemplateItems.orden);
  res.json({ data: c, responses });
});

// --- Setear PIN del conductor (autocrédito o admin) ---

router.post('/me/set-pin', async (req: Request, res: Response) => {
  const schema = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN debe ser 4-6 dígitos') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const userId = req.user?.sub;
  if (!userId) { res.status(401).json({ error: 'No autenticado' }); return; }
  const hash = await argon2.hash(parsed.data.pin);
  await db.update(driverProfile).set({ checklistPinHash: hash, updatedAt: new Date() }).where(eq(driverProfile.userId, userId));
  await audit(req, { action: 'update', resource: 'driver_profile', resourceId: String(userId), detail: 'set_checklist_pin' });
  res.json({ ok: true });
});

// --- Crear checklist (cierre transaccional) ---

const responseSchema = z.object({
  itemId: z.number().int().positive(),
  valorBool: z.boolean().optional(),
  valorEstado: z.enum(['bueno', 'regular', 'malo']).optional(),
  valorNum: z.number().optional(),
  observacion: z.string().max(500).optional(),
}).refine((r) => r.valorBool !== undefined || r.valorEstado !== undefined || r.valorNum !== undefined, {
  message: 'Cada respuesta debe tener al menos un valor',
});

const createSchema = z.object({
  vehicleId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  conductorId: z.number().int().positive().optional(),
  medicionActual: z.number().int().min(0).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  pin: z.string().regex(/^\d{4,6}$/),
  observacionesGenerales: z.string().max(2000).optional(),
  responses: z.array(responseSchema).min(1),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const conductorId = data.conductorId ?? req.user?.sub;
  if (!conductorId) { res.status(400).json({ error: 'conductorId requerido' }); return; }

  // Verificar PIN del conductor.
  const [profile] = await db.select({
    checklistPinHash: driverProfile.checklistPinHash,
    suspendidoPorAlcohol: driverProfile.suspendidoPorAlcohol,
  }).from(driverProfile).where(eq(driverProfile.userId, conductorId)).limit(1);
  if (!profile) { res.status(404).json({ error: 'Conductor no encontrado' }); return; }
  if (profile.suspendidoPorAlcohol) { res.status(403).json({ error: 'Conductor suspendido por alcoholimetría positiva' }); return; }
  if (!profile.checklistPinHash) { res.status(400).json({ error: 'El conductor no ha configurado PIN. Hacerlo desde su perfil.' }); return; }
  const pinOk = await argon2.verify(profile.checklistPinHash, data.pin);
  if (!pinOk) { res.status(401).json({ error: 'PIN incorrecto' }); return; }

  // Cargar plantilla + items.
  const [template] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, data.templateId)).limit(1);
  if (!template || !template.vigente) { res.status(404).json({ error: 'Plantilla no encontrada o no vigente' }); return; }
  const items = await db.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, data.templateId));

  // Validar items obligatorios cubiertos.
  const respondedIds = new Set(data.responses.map((r) => r.itemId));
  const faltantes = items.filter((it) => it.obligatorio && !respondedIds.has(it.id)).map((it) => it.label);
  if (faltantes.length > 0) {
    res.status(400).json({ error: `Items obligatorios faltantes: ${faltantes.join(', ')}` });
    return;
  }

  // Calcular decisión.
  const itemMap = new Map(items.map((it) => [it.id, it]));
  let decision: 'apto' | 'no_apto' | 'condicional' = 'apto';
  for (const r of data.responses) {
    const it = itemMap.get(r.itemId);
    if (!it) continue;
    const malo = (it.criterio === 'tres_estados' && r.valorEstado === 'malo')
              || (it.criterio === 'booleano' && r.valorBool === false);
    if (malo && it.critico) { decision = 'no_apto'; break; }
    if (malo && !it.critico && decision === 'apto') decision = 'condicional';
  }

  const qrToken = crypto.randomBytes(24).toString('base64url');

  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx.insert(checklists).values({
        vehicleId: data.vehicleId,
        conductorId,
        templateId: data.templateId,
        templateVersion: template.version,
        medicionActual: data.medicionActual ?? null,
        lat: data.lat != null ? String(data.lat) : null,
        lng: data.lng != null ? String(data.lng) : null,
        decision,
        firmaPinVerificado: true,
        qrToken,
        observacionesGenerales: data.observacionesGenerales ?? null,
      } as any).returning();

      for (const r of data.responses) {
        await tx.insert(checklistResponses).values({
          checklistId: created.id,
          itemId: r.itemId,
          valorBool: r.valorBool ?? null,
          valorEstado: r.valorEstado ?? null,
          valorNum: r.valorNum != null ? String(r.valorNum) : null,
          observacion: r.observacion ?? null,
        } as any);
      }

      // Si reportó medición, alimenta vehicle_measurements (fuente=app).
      if (data.medicionActual && data.medicionActual > 0) {
        await tx.insert(vehicleMeasurements).values({
          vehicleId: data.vehicleId,
          fecha: new Date().toISOString().slice(0, 10),
          odometro: data.medicionActual,
          fuente: 'app',
          usuarioId: conductorId,
          nota: `Checklist preoperacional #${created.id}`,
        } as any);
      }

      return created;
    });

    await audit(req, { action: 'create', resource: 'checklist', resourceId: String(result.id), detail: `decision=${decision}` });
    res.status(201).json({ data: result, decision });
  } catch (err) {
    throw err;
  }
});

router.post('/:id/anular', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ motivo: z.string().min(5).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Motivo requerido (mín 5 chars)' }); return; }
  const [updated] = await db.update(checklists)
    .set({ anuladoAt: new Date(), anuladoPor: req.user?.sub ?? null, anuladoMotivo: parsed.data.motivo })
    .where(and(eq(checklists.id, id), sql`${checklists.anuladoAt} IS NULL`))
    .returning();
  if (!updated) { res.status(409).json({ error: 'Checklist no encontrado o ya anulado' }); return; }
  await audit(req, { action: 'update', resource: 'checklist', resourceId: String(id), detail: 'anulado' });
  res.json({ data: updated });
});

export default router;
