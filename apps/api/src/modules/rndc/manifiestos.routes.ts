import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, gte, lte, inArray, isNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db/client.js';
import {
  manifiestos, manifiestoRemesas, remesas, vehicles, users, tenedores,
  rndcMunicipios, vehicleEquipmentLinks, vehicleDocuments, documentTypes,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { listOperaciones } from './operaciones.repo.js';
import { encolarManifiesto, procesarManifiesto } from './envio.service.js';
import { encryptPii, decryptPii, newUuid, normalizeDocument } from '../../shared/utils/crypto.js';

const router = Router();

// Nota: el endpoint público de QR fue movido a qr.routes.ts (publicRouter)
// montado bajo /api/rndc/public/manifiestos para eliminar ambigüedad con /:id.
router.use(authMiddleware, requirePage('rndc'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Genera correlativo serializado bajo pg_advisory_xact_lock (migration 0048).
// La función SQL evita race conditions bajo concurrencia (cluster PM2 + pool 50).
// Debe invocarse dentro de una transacción para que el lock sea efectivo.
// Acepta el tipo de db o de transacción Drizzle: ambos tienen .execute().
type Executor = { execute: (q: any) => Promise<any> };
async function nextManifiestoNumero(executor: Executor): Promise<string> {
  const result = await executor.execute(sql`SELECT fn_next_manifiesto_numero() AS numero`);
  const numero = (result as any)[0]?.numero;
  if (!numero) throw new Error('No se pudo generar número de manifiesto');
  return numero as string;
}

const manifiestoBaseSchema = z.object({
  vehiculoPrincipalId: z.number().int().positive(),
  vehiculoRemolqueId: z.number().int().positive().optional().nullable(),
  conductorId: z.number().int().positive(),
  tenedorId: z.number().int().positive().optional().nullable(),
  municipioOrigenDane: z.string().length(5),
  municipioDestinoDane: z.string().length(5),
  fechaExpedicion: z.string(),
  fechaPactadaPago: z.string().optional().nullable(),
  valorFleteTotal: z.number().min(0).default(0),
  valorAnticipo: z.number().min(0).default(0),
  retencionFuente: z.number().min(0).default(0),
  retencionIca: z.number().min(0).default(0),
  titularPagoTipo: z.enum(['propietario', 'conductor', 'empresa', 'tercero']).default('conductor'),
  // Normalizado antes de persistir para que privacy/forget matchee. Vacío → null.
  titularPagoDoc: z.string().max(20).optional().nullable().transform((v) => v == null ? v : normalizeDocument(v) || null),
  titularPagoNombre: z.string().max(200).optional().nullable(),
  titularPagoCuenta: z.string().max(40).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
  remesaIds: z.array(z.number().int().positive()).optional(),
});

const manifiestoSchema = manifiestoBaseSchema.refine(
  (r) => r.valorAnticipo <= r.valorFleteTotal,
  { message: 'Anticipo no puede superar el flete total' },
);

// LISTADO
router.get('/', async (req: Request, res: Response) => {
  const estado = req.query.estado as string | undefined;
  const vehiculoId = req.query.vehiculoId ? parseId(String(req.query.vehiculoId)) : null;
  const conductorId = req.query.conductorId ? parseId(String(req.query.conductorId)) : null;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;

  const conds: any[] = [isNull(manifiestos.deletedAt)];
  if (estado) conds.push(eq(manifiestos.estado, estado as any));
  if (vehiculoId) conds.push(eq(manifiestos.vehiculoPrincipalId, vehiculoId));
  if (conductorId) conds.push(eq(manifiestos.conductorId, conductorId));
  if (desde) conds.push(gte(manifiestos.fechaExpedicion, desde));
  if (hasta) conds.push(lte(manifiestos.fechaExpedicion, hasta));

  const rows = await db.select({
    id: manifiestos.id,
    numero: manifiestos.numero,
    consecutivoRndc: manifiestos.consecutivoRndc,
    estado: manifiestos.estado,
    fechaExpedicion: manifiestos.fechaExpedicion,
    valorFleteTotal: manifiestos.valorFleteTotal,
    placaPrincipal: vehicles.plate,
    conductorNombre: users.name,
    origenDane: manifiestos.municipioOrigenDane,
    destinoDane: manifiestos.municipioDestinoDane,
    radicadoAt: manifiestos.radicadoAt,
    cumplidoAt: manifiestos.cumplidoAt,
  })
    .from(manifiestos)
    .leftJoin(vehicles, eq(vehicles.id, manifiestos.vehiculoPrincipalId))
    .leftJoin(users, eq(users.id, manifiestos.conductorId))
    .where(and(...conds))
    .orderBy(desc(manifiestos.fechaExpedicion), desc(manifiestos.id))
    .limit(500);
  res.json({ data: rows });
});

// DETALLE (incluye remesas asociadas)
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(manifiestos).where(eq(manifiestos.id, id)).limit(1);
  if (!row || row.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }

  const remesasAsoc = await db.select({
    remesaId: manifiestoRemesas.remesaId,
    orden: manifiestoRemesas.orden,
    numero: remesas.numero,
    estado: remesas.estado,
    cantidadCargada: remesas.cantidadCargada,
    cantidadEntregada: remesas.cantidadEntregada,
    valorFlete: remesas.valorFlete,
    cumplidoAt: remesas.cumplidoAt,
  })
    .from(manifiestoRemesas)
    .leftJoin(remesas, eq(remesas.id, manifiestoRemesas.remesaId))
    .where(eq(manifiestoRemesas.manifiestoId, id))
    .orderBy(manifiestoRemesas.orden);

  // Descifrar titularPagoCuenta antes de responder. Quitar columnas internas cipher/iv/etc.
  const r: any = row;
  let titularPagoCuenta: string | null = null;
  if (r.titularPagoCuentaCipher) {
    try {
      titularPagoCuenta = decryptPii(
        { cipher: r.titularPagoCuentaCipher, iv: r.titularPagoCuentaIv, authTag: r.titularPagoCuentaAuthTag, keyVersion: r.titularPagoCuentaKeyVersion ?? 1 },
        { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: r.numero, aadNonce: r.titularPagoCuentaAadNonce },
      );
    } catch { titularPagoCuenta = null; }
  } else if (r.titularPagoCuentaLegacyPlain) {
    titularPagoCuenta = r.titularPagoCuentaLegacyPlain;
  }
  const {
    titularPagoCuentaCipher, titularPagoCuentaIv, titularPagoCuentaAuthTag,
    titularPagoCuentaAadNonce, titularPagoCuentaKeyVersion, titularPagoCuentaLegacyPlain,
    ...rest
  } = r;
  res.json({ data: { ...rest, titularPagoCuenta }, remesas: remesasAsoc });
});

// VALIDACIÓN PRE-RADICACIÓN — semáforo.
// Helper reutilizable: ejecuta las 4 reglas de validación normativa PESV + RNDC.
// Usado por GET /:id/validar (informativo) y por POST /:id/marcar-listo (bloqueante).
//
// Reglas validadas (Decreto 1079 + Res. 12379 + ISO PESV):
//   1. Conductor apto (PESV + alcoholimetría + último checklist) — fn_conductor_apto.
//   2. SOAT, RTM y póliza vigentes en el vehículo principal.
//   3. Vinculación cabezote-remolque activa (si aplica).
//   4. Al menos una remesa asociada.
type ValidacionCheck = { regla: string; ok: boolean; detalle?: string };

async function ejecutarValidacionesManifiesto(m: typeof manifiestos.$inferSelect, id: number): Promise<ValidacionCheck[]> {
  const checks: ValidacionCheck[] = [];

  const aptoResult = await db.execute(sql`SELECT fn_conductor_apto(${m.conductorId}, ${m.vehiculoPrincipalId}) AS ok`);
  const conductorOk = (aptoResult as any)[0]?.ok === true;
  checks.push({
    regla: 'Conductor apto (PESV + alcoholimetría + último checklist)',
    ok: conductorOk,
    detalle: conductorOk ? undefined : 'Conductor suspendido o último checklist no_apto',
  });

  const docsVehic = await db.select({
    tipoNombre: documentTypes.nombre,
    estado: vehicleDocuments.estado,
  }).from(vehicleDocuments)
    .leftJoin(documentTypes, eq(documentTypes.id, vehicleDocuments.tipoId))
    .where(and(
      eq(vehicleDocuments.vehicleId, m.vehiculoPrincipalId),
      inArray(vehicleDocuments.estado, ['vigente', 'por_vencer'] as any),
    ));
  for (const dr of ['soat', 'rtm', 'poliza']) {
    const found = docsVehic.find((d) => d.tipoNombre?.toLowerCase().includes(dr));
    checks.push({
      regla: `Vehículo: ${dr.toUpperCase()} vigente`,
      ok: !!found,
      detalle: found ? undefined : `No se encontró ${dr} vigente`,
    });
  }

  if (m.vehiculoRemolqueId) {
    const [link] = await db.select().from(vehicleEquipmentLinks)
      .where(and(
        eq(vehicleEquipmentLinks.vehiculoPrincipalId, m.vehiculoPrincipalId),
        eq(vehicleEquipmentLinks.vehiculoVinculadoId, m.vehiculoRemolqueId),
        eq(vehicleEquipmentLinks.esActual, true),
      )).limit(1);
    checks.push({
      regla: 'Vinculación cabezote-remolque actual',
      ok: !!link,
      detalle: link ? undefined : 'No existe vinculación activa entre los dos vehículos',
    });
  }

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(manifiestoRemesas).where(eq(manifiestoRemesas.manifiestoId, id));
  checks.push({
    regla: 'Al menos una remesa asignada',
    ok: count > 0,
    detalle: count === 0 ? 'Asocie remesas antes de radicar' : undefined,
  });

  return checks;
}

router.get('/:id/validar', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [m] = await db.select().from(manifiestos).where(eq(manifiestos.id, id)).limit(1);
  if (!m || m.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  const checks = await ejecutarValidacionesManifiesto(m, id);
  const todoOk = checks.every((c) => c.ok);
  res.json({ ok: todoOk, checks });
});

// CREAR (borrador) — retry on 23505 si dos requests concurrentes generan mismo numero.
router.post('/', async (req: Request, res: Response) => {
  const parsed = manifiestoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const qrToken = crypto.randomBytes(24).toString('base64url');

  // El correlativo se genera DENTRO de la transacción para que pg_advisory_xact_lock
  // serialize concurrencia. Sin retry-on-23505: con el lock el UNIQUE no se viola.
  try {
    const result = await db.transaction(async (tx) => {
      const numero = await nextManifiestoNumero(tx);
      // Cifrado AES-256-GCM de la cuenta bancaria del titular de pago.
      // rowKey = numero (UNIQUE) → previene swap de ciphertext entre manifiestos.
      const tpcInput = data.titularPagoCuenta ?? null;
      const tpcAad = tpcInput ? newUuid() : null;
      const tpcCipher = tpcInput
        ? encryptPii(tpcInput, { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: numero, aadNonce: tpcAad! })
        : null;
      const [row] = await tx.insert(manifiestos).values({
        numero,
        vehiculoPrincipalId: data.vehiculoPrincipalId,
        vehiculoRemolqueId: data.vehiculoRemolqueId ?? null,
        conductorId: data.conductorId,
        tenedorId: data.tenedorId ?? null,
        municipioOrigenDane: data.municipioOrigenDane,
        municipioDestinoDane: data.municipioDestinoDane,
        fechaExpedicion: data.fechaExpedicion,
        fechaPactadaPago: data.fechaPactadaPago ?? null,
        valorFleteTotal: String(data.valorFleteTotal),
        valorAnticipo: String(data.valorAnticipo),
        retencionFuente: String(data.retencionFuente),
        retencionIca: String(data.retencionIca),
        titularPagoTipo: data.titularPagoTipo,
        titularPagoDoc: data.titularPagoDoc ?? null,
        titularPagoNombre: data.titularPagoNombre ?? null,
        titularPagoCuentaCipher: tpcCipher?.cipher ?? null,
        titularPagoCuentaIv: tpcCipher?.iv ?? null,
        titularPagoCuentaAuthTag: tpcCipher?.authTag ?? null,
        titularPagoCuentaAadNonce: tpcAad,
        titularPagoCuentaKeyVersion: tpcCipher?.keyVersion ?? null,
        observaciones: data.observaciones ?? null,
        qrToken,
        estado: 'borrador',
        createdBy: req.user?.sub ?? null,
      } as any).returning();

      // Asociar remesas y marcarlas con manifiesto_id (solo no eliminadas, en estado activa, sin manifiesto previo).
      if (data.remesaIds && data.remesaIds.length > 0) {
        const elegibles = await tx.select({ id: remesas.id })
          .from(remesas)
          .where(and(
            inArray(remesas.id, data.remesaIds),
            isNull(remesas.deletedAt),
            eq(remesas.estado, 'activa'),
            isNull(remesas.manifiestoId),
          ))
          .for('update');
        const elegiblesIds = elegibles.map((r) => r.id);
        if (elegiblesIds.length !== data.remesaIds.length) {
          throw new Error(`Algunas remesas no son elegibles (eliminadas, ya asignadas, o no activas): ${data.remesaIds.filter((id) => !elegiblesIds.includes(id)).join(', ')}`);
        }
        for (let i = 0; i < elegiblesIds.length; i++) {
          await tx.insert(manifiestoRemesas).values({
            manifiestoId: row.id,
            remesaId: elegiblesIds[i],
            orden: i + 1,
          });
        }
        await tx.update(remesas).set({ manifiestoId: row.id, updatedAt: new Date() })
          .where(and(inArray(remesas.id, elegiblesIds), isNull(remesas.deletedAt)));
      }
      return row;
    });
    await audit(req, { action: 'create', resource: 'manifiesto', resourceId: String(result.id), detail: result.numero });
    res.status(201).json({ data: result });
    return;
  } catch (err: any) {
    if (err?.code === '23514' || err?.message?.includes('Conductor')) {
      res.status(403).json({ error: err.message ?? 'Conductor no apto' });
      return;
    }
    if (err?.message?.startsWith('Algunas remesas no son elegibles')) {
      res.status(409).json({ error: err.message }); return;
    }
    throw err;
  }
});

// EDITAR (solo borrador|listo)
router.put('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [current] = await db.select().from(manifiestos).where(eq(manifiestos.id, id)).limit(1);
  if (!current || current.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (!['borrador', 'listo'].includes(current.estado)) {
    res.status(409).json({ error: `No editable en estado "${current.estado}"` }); return;
  }
  const parsed = manifiestoBaseSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const d = parsed.data;
  const updates: any = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || k === 'remesaIds' || k === 'titularPagoCuenta') continue;
    if (['valorFleteTotal', 'valorAnticipo', 'retencionFuente', 'retencionIca'].includes(k) && typeof v === 'number') {
      updates[k] = String(v);
    } else {
      updates[k] = v;
    }
  }
  // Re-cifrar titularPagoCuenta si viene en el patch (rowKey = numero del manifiesto).
  if (typeof d.titularPagoCuenta === 'string' || d.titularPagoCuenta === null) {
    if (d.titularPagoCuenta) {
      const aadNonce = newUuid();
      const c = encryptPii(d.titularPagoCuenta, { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: current.numero, aadNonce });
      updates.titularPagoCuentaCipher = c.cipher;
      updates.titularPagoCuentaIv = c.iv;
      updates.titularPagoCuentaAuthTag = c.authTag;
      updates.titularPagoCuentaAadNonce = aadNonce;
      updates.titularPagoCuentaKeyVersion = c.keyVersion;
    } else {
      updates.titularPagoCuentaCipher = null;
      updates.titularPagoCuentaIv = null;
      updates.titularPagoCuentaAuthTag = null;
      updates.titularPagoCuentaAadNonce = null;
      updates.titularPagoCuentaKeyVersion = null;
    }
  }
  try {
    const [row] = await db.update(manifiestos).set(updates).where(eq(manifiestos.id, id)).returning();
    await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id) });
    res.json({ data: row });
  } catch (err: any) {
    if (err?.message?.includes('Conductor')) { res.status(403).json({ error: err.message }); return; }
    throw err;
  }
});

// MARCAR LISTO (borrador → listo). Bloqueante: ejecuta las 4 validaciones normativas
// PESV+RNDC; si alguna falla, devuelve 422 con el detalle de los checks fallidos.
// Razón: hasta hoy el GET /validar era informativo y NO impedía radicar manifiestos
// con SOAT/RTM/conductor inválido (hueco identificado por auditoría compliance 2026-05-07).
router.post('/:id/marcar-listo', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [m] = await db.select().from(manifiestos).where(eq(manifiestos.id, id)).limit(1);
  if (!m || m.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (m.estado !== 'borrador') { res.status(409).json({ error: `No está en borrador (estado actual: ${m.estado})` }); return; }

  const checks = await ejecutarValidacionesManifiesto(m, id);
  const fallidos = checks.filter((c) => !c.ok);
  if (fallidos.length) {
    await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id), detail: `marcar_listo_bloqueado checks_fail=${fallidos.length}` });
    res.status(422).json({
      error: 'Validación normativa falló',
      checksFallidos: fallidos,
      message: `${fallidos.length} regla(s) de cumplimiento PESV/RNDC no se satisfacen. Corregir antes de marcar listo.`,
    });
    return;
  }

  // Transición atómica WHERE estado='borrador' (anti race con otra request concurrente).
  const [row] = await db.update(manifiestos)
    .set({ estado: 'listo', updatedAt: new Date() })
    .where(and(eq(manifiestos.id, id), eq(manifiestos.estado, 'borrador'), isNull(manifiestos.deletedAt)))
    .returning();
  if (!row) { res.status(409).json({ error: 'Estado cambió durante la operación (concurrencia)' }); return; }
  await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id), detail: 'marcar_listo' });
  res.json({ data: row });
});

// CUMPLIR — cierra el manifiesto (offline en Fase 4.1; en 4.2/4.3 también dispara cumplido al RNDC).
// Invariante de negocio: un manifiesto solo se cumple si TODAS sus remesas asociadas (vivas) están cumplidas.
router.post('/:id/cumplir', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [current] = await db.select().from(manifiestos).where(eq(manifiestos.id, id)).limit(1);
  if (!current || current.deletedAt) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (!['listo', 'aceptado'].includes(current.estado)) {
    res.status(409).json({ error: `No se puede cumplir en estado "${current.estado}"` }); return;
  }

  // Validar que TODAS las remesas asociadas (vivas) estén cumplidas. Audit-grade.
  const pendientes = await db.select({ id: remesas.id, numero: remesas.numero, estado: remesas.estado })
    .from(manifiestoRemesas)
    .innerJoin(remesas, eq(remesas.id, manifiestoRemesas.remesaId))
    .where(and(
      eq(manifiestoRemesas.manifiestoId, id),
      isNull(remesas.deletedAt),
      sql`${remesas.estado} <> 'cumplida'`,
    ));
  if (pendientes.length > 0) {
    res.status(422).json({
      error: 'No se puede cumplir el manifiesto: hay remesas asociadas sin cumplir',
      remesasPendientes: pendientes.map((r) => ({ id: r.id, numero: r.numero, estado: r.estado })),
    });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.update(manifiestos)
      .set({ estado: 'cumplido', cumplidoAt: new Date(), updatedAt: new Date() })
      .where(eq(manifiestos.id, id)).returning();
    return row;
  });
  await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id), detail: 'cumplir' });
  res.json({ data: result });
});

// ANULAR — cualquier estado distinto de cumplido/anulado.
router.post('/:id/anular', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ motivo: z.string().min(5).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Motivo requerido (mín 5 chars)' }); return; }

  const [row] = await db.update(manifiestos)
    .set({
      estado: 'anulado', anuladoAt: new Date(), anuladoMotivo: parsed.data.motivo,
      anuladoPor: req.user?.sub ?? null, updatedAt: new Date(),
    })
    .where(and(eq(manifiestos.id, id), isNull(manifiestos.deletedAt)))
    .returning();
  if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id), detail: 'anular' });
  res.json({ data: row });
});

// ELIMINAR (soft, solo borrador)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.update(manifiestos)
    .set({ deletedAt: new Date(), deletedBy: req.user?.sub ?? null })
    .where(and(eq(manifiestos.id, id), eq(manifiestos.estado, 'borrador'), isNull(manifiestos.deletedAt)))
    .returning();
  if (!row) { res.status(409).json({ error: 'Solo se eliminan manifiestos en borrador' }); return; }
  await audit(req, { action: 'delete', resource: 'manifiesto', resourceId: String(id), detail: 'soft_delete' });
  res.json({ data: row });
});

// ENCOLAR ENVÍO RNDC (admin) — marca pendiente_envio para que cron retry lo procese.
router.post('/:id/encolar-envio', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  await encolarManifiesto(id);
  await audit(req, { action: 'update', resource: 'manifiesto', resourceId: String(id), detail: 'encolar_envio_rndc' });
  res.json({ ok: true });
});

// REINTENTAR AHORA (admin) — ejecuta procesarManifiesto sincrónicamente.
router.post('/:id/reintentar-envio', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || undefined;
  const result = await procesarManifiesto(id, ip);
  await audit(req, {
    action: 'update', resource: 'manifiesto', resourceId: String(id),
    detail: `reintentar_envio:${result.estadoFinal}`,
  });
  res.json(result);
});

// LOG WORM operaciones — visor del historial RNDC del manifiesto.
router.get('/:id/operaciones', async (req: Request, res: Response) => {
  const id = parseId(req.params.id); if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const incluirXml = req.query.incluirXml === '1';
  const rows = await listOperaciones({ entidadTipo: 'manifiesto', entidadId: id, incluirXml });
  res.json({ data: rows });
});

export default router;
