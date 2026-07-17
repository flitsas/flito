import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, asc, sql, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, driverProfile } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { encryptPii, decryptPii, hmacCedula, newUuid, normalizeDocument } from '../../shared/utils/crypto.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const CATEGORIAS = ['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'] as const;

// ============================================================================
// Helpers de cifrado para driver_profile (Ola C-1).
// ----------------------------------------------------------------------------
// Cada cifrado bind a la fila vía AAD = table|column|userId|aadNonce|keyVersion,
// previniendo que el ciphertext de una fila se reutilice en otra. Si la lectura
// falla (por dato corrupto o key rotada sin re-cifrar), caemos al campo
// *_legacy_plain durante la ventana de gracia de 7 días.
// ============================================================================

interface DriverFieldCipher {
  cipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
  aadNonce: string;
  keyVersion: number;
}

function encryptField(plain: string | null | undefined, column: 'cedula' | 'licencia_numero' | 'runt_payload', userId: number): DriverFieldCipher | null {
  if (plain == null || plain === '') return null;
  const aadNonce = newUuid();
  const bundle = encryptPii(plain, { table: 'driver_profile', column, empresaNit: String(userId), aadNonce });
  return { cipher: bundle.cipher, iv: bundle.iv, authTag: bundle.authTag, aadNonce, keyVersion: bundle.keyVersion };
}

function decryptField(row: any, field: 'cedula' | 'licenciaNumero' | 'runtPayload', column: string, userId: number): string | null {
  const cipher = row[`${field}Cipher`];
  if (cipher) {
    try {
      return decryptPii(
        { cipher, iv: row[`${field}Iv`], authTag: row[`${field}AuthTag`], keyVersion: row[`${field}KeyVersion`] ?? 1 },
        { table: 'driver_profile', column, empresaNit: String(userId), aadNonce: row[`${field}AadNonce`] },
      );
    } catch {
      return null;
    }
  }
  // Fallback durante ventana T+7d: leer del campo legacy_plain si existe.
  const legacy = row[`${field}LegacyPlain`];
  if (legacy == null) return null;
  return typeof legacy === 'string' ? legacy : JSON.stringify(legacy);
}

router.get('/', async (req: Request, res: Response) => {
  const q = req.query.q ? String(req.query.q).slice(0, 100) : null;
  const vencidos = req.query.vencidos === 'true';
  const today = new Date().toISOString().slice(0, 10);

  const conds: any[] = [eq(users.esConductor, true), eq(users.active, true)];
  if (q) {
    // Búsqueda exacta por cédula vía HMAC si q es solo dígitos; siempre acepta name/username.
    const onlyDigits = normalizeDocument(q);
    if (onlyDigits.length >= 6 && onlyDigits.length <= 12) {
      const hash = hmacCedula(onlyDigits);
      conds.push(or(
        ilike(users.name, `%${q}%`),
        ilike(users.username, `%${q}%`),
        eq(driverProfile.cedulaHash, hash),
      )!);
    } else {
      conds.push(or(ilike(users.name, `%${q}%`), ilike(users.username, `%${q}%`))!);
    }
  }

  const rows = await db.select({
    id: users.id,
    name: users.name,
    username: users.username,
    email: users.email,
    userId: driverProfile.userId,
    cedulaCipher: driverProfile.cedulaCipher,
    cedulaIv: driverProfile.cedulaIv,
    cedulaAuthTag: driverProfile.cedulaAuthTag,
    cedulaAadNonce: driverProfile.cedulaAadNonce,
    cedulaKeyVersion: driverProfile.cedulaKeyVersion,
    licenciaNumeroCipher: driverProfile.licenciaNumeroCipher,
    licenciaNumeroIv: driverProfile.licenciaNumeroIv,
    licenciaNumeroAuthTag: driverProfile.licenciaNumeroAuthTag,
    licenciaNumeroAadNonce: driverProfile.licenciaNumeroAadNonce,
    licenciaNumeroKeyVersion: driverProfile.licenciaNumeroKeyVersion,
    categorias: driverProfile.categorias,
    licenciaVigencia: driverProfile.licenciaVigencia,
    examenPsicoVigencia: driverProfile.examenPsicoVigencia,
    contratoTipo: driverProfile.contratoTipo,
  })
    .from(users)
    .leftJoin(driverProfile, eq(driverProfile.userId, users.id))
    .where(and(...conds))
    .orderBy(asc(users.name))
    .limit(500);

  const data = rows.map((r) => {
    const cedula = r.userId ? decryptField(r, 'cedula', 'cedula', r.userId) : null;
    const licenciaNumero = r.userId ? decryptField(r, 'licenciaNumero', 'licencia_numero', r.userId) : null;
    return {
      id: r.id, name: r.name, username: r.username, email: r.email,
      cedula, licenciaNumero,
      categorias: r.categorias, licenciaVigencia: r.licenciaVigencia,
      examenPsicoVigencia: r.examenPsicoVigencia, contratoTipo: r.contratoTipo,
    };
  });

  const filtered = vencidos
    ? data.filter((r) =>
        (r.licenciaVigencia && (r.licenciaVigencia as string) <= today) ||
        (r.examenPsicoVigencia && (r.examenPsicoVigencia as string) <= today),
      )
    : data;

  res.json({ data: filtered });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [user] = await db.select({
    id: users.id, name: users.name, username: users.username, email: users.email, esConductor: users.esConductor,
  }).from(users).where(eq(users.id, id)).limit(1);
  if (!user || !user.esConductor) { res.status(404).json({ error: 'Conductor no encontrado' }); return; }

  const [profileRow] = await db.select().from(driverProfile).where(eq(driverProfile.userId, id)).limit(1);
  const docsCount = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM driver_documents WHERE user_id = ${id} AND estado <> 'archivado'`);
  const incCount = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM road_incidents WHERE conductor_id = ${id}`);

  const docsRow = ((docsCount as any).rows ?? docsCount as any[])[0];
  const incRow = ((incCount as any).rows ?? incCount as any[])[0];

  // Descifrar antes de responder. Omitir columnas cipher del JSON al cliente.
  // PESV-S6 Ley 1581 art. 17: registrar acceso a PII en pii_access_log.
  let profile: any = null;
  if (profileRow) {
    const r: any = profileRow;
    const cedula = decryptField(r, 'cedula', 'cedula', id);
    const licenciaNumero = decryptField(r, 'licenciaNumero', 'licencia_numero', id);
    const runtPayloadStr = decryptField(r, 'runtPayload', 'runt_payload', id);
    // Best-effort fuera de tx, no aborta lectura si falla outbox.
    const camposReales = [
      cedula ? 'cedula' : null,
      licenciaNumero ? 'licencia_numero' : null,
      runtPayloadStr ? 'runt_payload' : null,
    ].filter(Boolean) as string[];
    if (camposReales.length) {
      const { logPiiAccess } = await import('../../shared/pii-audit.js');
      logPiiAccess(req, {
        resourceTipo: 'driver_profile', resourceId: id,
        accion: 'decrypt', camposAccedidos: camposReales,
        motivo: 'GET driver detail',
      }).catch(() => { /* noop, helper ya loggea */ });
    }
    let runtPayload: unknown = null;
    if (runtPayloadStr) {
      try { runtPayload = JSON.parse(runtPayloadStr); } catch { runtPayload = runtPayloadStr; }
    }
    // Construir DTO sin las columnas cifradas/legacy.
    profile = {
      userId: r.userId,
      cedula, licenciaNumero, runtPayload,
      fechaNacimiento: r.fechaNacimiento,
      categorias: r.categorias,
      licenciaVigencia: r.licenciaVigencia,
      examenPsicoFecha: r.examenPsicoFecha,
      examenPsicoVigencia: r.examenPsicoVigencia,
      restriccionesMedicas: r.restriccionesMedicas,
      arl: r.arl, eps: r.eps, fondoPensiones: r.fondoPensiones,
      contratoTipo: r.contratoTipo,
      experienciaAnios: r.experienciaAnios,
      sancionesCount: r.sancionesCount,
      fotoStorageKey: r.fotoStorageKey,
      runtConsultadoAt: r.runtConsultadoAt,
      suspendidoPorAlcohol: r.suspendidoPorAlcohol,
      fechaSuspension: r.fechaSuspension,
      motivoSuspension: r.motivoSuspension,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  res.json({
    user, profile,
    documentosCount: Number(docsRow?.count ?? 0),
    incidentesCount: Number(incRow?.count ?? 0),
  });
});

const profileSchema = z.object({
  cedula: z.string().regex(/^\d{6,12}$/, 'Cédula debe tener 6-12 dígitos'),
  fechaNacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  licenciaNumero: z.string().min(1).max(40),
  categorias: z.array(z.enum(CATEGORIAS)).min(1).refine((arr) => new Set(arr).size === arr.length, 'No duplicar categorías'),
  licenciaVigencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  examenPsicoFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  examenPsicoVigencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  restriccionesMedicas: z.array(z.string().max(80)).max(20).default([]),
  arl: z.string().max(80).optional().nullable(),
  eps: z.string().max(80).optional().nullable(),
  fondoPensiones: z.string().max(80).optional().nullable(),
  contratoTipo: z.enum(['directo', 'contratista', 'temporal']).optional().nullable(),
  experienciaAnios: z.number().min(0).max(60).default(0),
});

const createSchema = z.object({
  userId: z.number().int().positive(),
  profile: profileSchema,
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const { userId, profile } = parsed.data;

  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // Cifrado PII previo a la transacción (sin I/O, no agrava lock).
  const cedNorm = normalizeDocument(profile.cedula);
  const cedB = encryptField(cedNorm, 'cedula', userId);
  const licB = encryptField(profile.licenciaNumero, 'licencia_numero', userId);
  const cedHash = hmacCedula(cedNorm);

  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ esConductor: true }).where(eq(users.id, userId));
      await tx.insert(driverProfile).values({
        userId,
        cedulaCipher: cedB!.cipher,
        cedulaIv: cedB!.iv,
        cedulaAuthTag: cedB!.authTag,
        cedulaAadNonce: cedB!.aadNonce,
        cedulaKeyVersion: cedB!.keyVersion,
        cedulaHash: cedHash,
        fechaNacimiento: profile.fechaNacimiento ?? null,
        licenciaNumeroCipher: licB!.cipher,
        licenciaNumeroIv: licB!.iv,
        licenciaNumeroAuthTag: licB!.authTag,
        licenciaNumeroAadNonce: licB!.aadNonce,
        licenciaNumeroKeyVersion: licB!.keyVersion,
        categorias: profile.categorias,
        licenciaVigencia: profile.licenciaVigencia ?? null,
        examenPsicoFecha: profile.examenPsicoFecha ?? null,
        examenPsicoVigencia: profile.examenPsicoVigencia ?? null,
        restriccionesMedicas: profile.restriccionesMedicas,
        arl: profile.arl ?? null,
        eps: profile.eps ?? null,
        fondoPensiones: profile.fondoPensiones ?? null,
        contratoTipo: profile.contratoTipo ?? null,
        experienciaAnios: String(profile.experienciaAnios),
      } as any);
    });
    await audit(req, { action: 'create', resource: 'driver', resourceId: String(userId), detail: u.username });
    res.status(201).json({ ok: true });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Cédula o licencia ya existen' });
      return;
    }
    throw err;
  }
});

router.patch('/:id/profile', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = profileSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data: any = { ...parsed.data, updatedAt: new Date() };

  // Cifrar campos PII si vienen en el patch. Mantener separado del set genérico.
  if (typeof data.cedula === 'string') {
    const norm = normalizeDocument(data.cedula);
    const ced = encryptField(norm, 'cedula', id);
    if (ced) {
      data.cedulaCipher = ced.cipher;
      data.cedulaIv = ced.iv;
      data.cedulaAuthTag = ced.authTag;
      data.cedulaAadNonce = ced.aadNonce;
      data.cedulaKeyVersion = ced.keyVersion;
      data.cedulaHash = hmacCedula(norm);
    }
    delete data.cedula;
  }
  if (typeof data.licenciaNumero === 'string') {
    const lic = encryptField(data.licenciaNumero, 'licencia_numero', id);
    if (lic) {
      data.licenciaNumeroCipher = lic.cipher;
      data.licenciaNumeroIv = lic.iv;
      data.licenciaNumeroAuthTag = lic.authTag;
      data.licenciaNumeroAadNonce = lic.aadNonce;
      data.licenciaNumeroKeyVersion = lic.keyVersion;
    }
    delete data.licenciaNumero;
  }
  if (data.experienciaAnios != null) data.experienciaAnios = String(data.experienciaAnios);

  const [updated] = await db.update(driverProfile)
    .set(data)
    .where(eq(driverProfile.userId, id))
    .returning();
  if (!updated) { res.status(404).json({ error: 'Perfil no encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'driver_profile', resourceId: String(id) });
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(users).set({ esConductor: false }).where(eq(users.id, id)).returning({ id: users.id });
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
  await audit(req, { action: 'delete', resource: 'driver', resourceId: String(id), detail: 'soft_delete' });
  res.json({ ok: true });
});

// Lista de users que NO son aún conductores (para promover desde UI)
router.get('/candidates/non-driver', requireRole('admin'), async (_req, res: Response) => {
  const rows = await db.select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(and(eq(users.esConductor, false), eq(users.active, true)))
    .orderBy(asc(users.name));
  res.json({ data: rows });
});

export default router;
