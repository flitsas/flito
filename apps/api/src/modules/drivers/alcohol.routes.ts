import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { alcoholTests, driverProfile, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { sendEmail, isSmtpConfigured } from '../../services/email.js';
import { pesvAlertRecipients } from '../../config/env.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Calcula grado_alcohol por Ley 1696/2013.
function gradoAlcohol(valorMg: number): number {
  if (valorMg < 0.20) return 0;
  if (valorMg < 0.40) return 1;
  if (valorMg < 0.80) return 2;
  return 3;
}

router.get('/', async (req: Request, res: Response) => {
  const conductorId = req.query.conductorId ? parseId(String(req.query.conductorId)) : null;
  const tipo = req.query.tipo as string | undefined;
  const resultado = req.query.resultado as string | undefined;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;
  const conds: any[] = [];
  if (conductorId) conds.push(eq(alcoholTests.conductorId, conductorId));
  if (tipo) conds.push(eq(alcoholTests.tipo, tipo as any));
  if (resultado) conds.push(eq(alcoholTests.resultado, resultado as any));
  if (desde) conds.push(gte(alcoholTests.fechaHora, new Date(desde) as any));
  if (hasta) conds.push(lte(alcoholTests.fechaHora, new Date(hasta + 'T23:59:59') as any));

  const rows = await db.select({
    id: alcoholTests.id,
    conductorId: alcoholTests.conductorId,
    conductorName: users.name,
    fechaHora: alcoholTests.fechaHora,
    tipo: alcoholTests.tipo,
    valorMg: alcoholTests.valorMg,
    gradoAlcohol: alcoholTests.gradoAlcohol,
    resultado: alcoholTests.resultado,
    operadorId: alcoholTests.operadorId,
    accionTomada: alcoholTests.accionTomada,
  })
    .from(alcoholTests)
    .leftJoin(users, eq(users.id, alcoholTests.conductorId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(alcoholTests.fechaHora))
    .limit(500);
  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [t] = await db.select().from(alcoholTests).where(eq(alcoholTests.id, id)).limit(1);
  if (!t) { res.status(404).json({ error: 'No encontrado' }); return; }
  res.json({ data: t });
});

const createSchema = z.object({
  conductorId: z.number().int().positive(),
  tipo: z.enum(['preoperacional', 'aleatoria', 'post_incidente', 'periodica']),
  valorMg: z.number().min(0).max(9.99),
  equipoSerial: z.string().max(60).optional().nullable(),
  equipoCalibracionFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  incidentId: z.number().int().positive().optional().nullable(),
  accionTomada: z.string().max(2000).optional().nullable(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const operadorId = req.user?.sub;
  if (!operadorId) { res.status(401).json({ error: 'No autenticado' }); return; }

  // Política CERO ALCOHOL: cualquier valor > 0 es positivo.
  const resultado: 'negativo' | 'positivo' = data.valorMg > 0 ? 'positivo' : 'negativo';
  const grado = gradoAlcohol(data.valorMg);

  // Cargar info del conductor para email.
  const [conductor] = await db.select({ id: users.id, name: users.name, email: users.email })
    .from(users).where(eq(users.id, data.conductorId)).limit(1);
  if (!conductor) { res.status(404).json({ error: 'Conductor no encontrado' }); return; }

  const test = await db.transaction(async (tx) => {
    const [created] = await tx.insert(alcoholTests).values({
      conductorId: data.conductorId,
      tipo: data.tipo,
      valorMg: String(data.valorMg),
      gradoAlcohol: grado,
      resultado,
      equipoSerial: data.equipoSerial ?? null,
      equipoCalibracionFecha: data.equipoCalibracionFecha ?? null,
      operadorId,
      incidentId: data.incidentId ?? null,
      accionTomada: data.accionTomada ?? null,
    } as any).returning();

    // Si positivo: suspender automáticamente (idempotente — solo si no estaba suspendido).
    if (resultado === 'positivo') {
      await tx.update(driverProfile).set({
        suspendidoPorAlcohol: true,
        fechaSuspension: new Date(),
        motivoSuspension: `Alcoholimetría positiva — test #${created.id} (${data.valorMg} mg/L, grado ${grado})`,
        updatedAt: new Date(),
      } as any).where(and(
        eq(driverProfile.userId, data.conductorId),
        eq(driverProfile.suspendidoPorAlcohol, false),
      ));
    }
    return created;
  });

  await audit(req, {
    action: 'create',
    resource: 'alcohol_test',
    resourceId: String(test.id),
    detail: `${data.tipo} ${resultado} ${data.valorMg}mg/L`,
  });

  // Alerta PESV: destinatarios desde PESV_ALERT_RECIPIENTS (env). Fallback a admins activos.
  // Decisión: jamás dirigir alerta operacional al proveedor del software (kyverum.com).
  if (resultado === 'positivo' && isSmtpConfigured()) {
    let recipients: string[] = pesvAlertRecipients;
    if (recipients.length === 0) {
      const admins = await db.select({ email: users.email })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.active, true)));
      recipients = admins.map((a) => a.email).filter((e): e is string => !!e && e.includes('@'));
    }
    if (recipients.length > 0) {
      sendEmail({
        to: recipients,
        subject: `ALERTA PESV — Conductor suspendido por alcoholimetría positiva: ${conductor.name}`,
        html: `<p>Se registró una prueba de alcoholimetría POSITIVA para el conductor <strong>${conductor.name}</strong>.</p>
<p>Valor: ${data.valorMg} mg/L · Grado: ${grado}<br/>Tipo: ${data.tipo}<br/>Fecha: ${new Date().toISOString()}</p>
<p>El conductor fue suspendido automáticamente del sistema. Solo un administrador puede levantar la suspensión.</p>
<p style="font-size:11px;color:#9ca3af;">Notificación PESV automática.</p>`,
      }).catch(() => { /* best-effort, no bloquea respuesta; logger lo capturará si falla */ });
    }
  }

  res.status(201).json({ data: test, suspendido: resultado === 'positivo' });
});

router.post('/:id/levantar-suspension', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ motivo: z.string().min(5).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Motivo requerido (mín 5 chars)' }); return; }

  const [test] = await db.select().from(alcoholTests).where(eq(alcoholTests.id, id)).limit(1);
  if (!test) { res.status(404).json({ error: 'Test no encontrado' }); return; }

  const [updated] = await db.update(driverProfile).set({
    suspendidoPorAlcohol: false,
    suspensionLevantadaPor: req.user?.sub ?? null,
    suspensionLevantadaAt: new Date(),
    motivoSuspension: `${parsed.data.motivo} (levantada admin)`,
    updatedAt: new Date(),
  } as any).where(and(
    eq(driverProfile.userId, test.conductorId),
    eq(driverProfile.suspendidoPorAlcohol, true),
  )).returning();

  if (!updated) { res.status(409).json({ error: 'Conductor no estaba suspendido' }); return; }
  await audit(req, { action: 'update', resource: 'driver_profile', resourceId: String(test.conductorId), detail: 'levantar_suspension_alcohol' });
  res.json({ ok: true });
});

export default router;
