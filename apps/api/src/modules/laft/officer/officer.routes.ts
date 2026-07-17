// LAFT/SARLAFT v2 · F5 — Designación oficial cumplimiento (Resolución 4607/2026).
//
// Reglas de negocio:
//   - Solo UN principal vigente y UN suplente vigente a la vez (idéntico rol).
//   - Designar nuevo cierra al anterior atómicamente (UPDATE FOR UPDATE en TX).
//   - Certificación ISO/IEC 17024 es flag boolean + storage_key del documento.
//   - validFrom obligatorio, validTo opcional (NULL = vigente).
//   - revocar: marca revocado_at + motivo (NO borra fila — auditoría histórica).
//   - GET /exists: usado por dashboard para flag warn (no bloquea operación).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftComplianceOfficers, users } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { requirePage } from '../../../shared/permissions.js';
import { laftAudit } from '../audit.service.js';
import { uploadEntityDocument } from '../../../services/storage.js';
import { loggerFor } from '../../../shared/logger.js';

const slog = loggerFor('laft-officer');

const router = Router();

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones de oficial cumplimiento' },
});

// ============================================================================
// GET /exists — público (auth) usado por dashboard. No requiere page especial,
// es equivalente a una "señal de salud" del módulo LAFT.
// ============================================================================
router.get('/exists', authMiddleware, async (_req, res: Response) => {
  const rows = await db.select({
    rol: laftComplianceOfficers.rol,
    iso: laftComplianceOfficers.certificacionIso17024,
  })
    .from(laftComplianceOfficers)
    .where(and(
      isNull(laftComplianceOfficers.validTo),
      isNull(laftComplianceOfficers.revocadoAt),
    ));
  const principal = rows.find((r) => r.rol === 'principal');
  const suplente = rows.find((r) => r.rol === 'suplente');
  res.json({
    principal: Boolean(principal),
    suplente: Boolean(suplente),
    principalIso17024: Boolean(principal?.iso),
    suplenteIso17024: Boolean(suplente?.iso),
  });
});

// El resto de endpoints requiere page específica.
router.use(authMiddleware, requirePage('laft_oficial'));

const designarSchema = z.object({
  userId: z.coerce.number().int().positive(),
  rol: z.enum(['principal', 'suplente']),
  certificacionIso17024: z.preprocess(
    (v) => v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined,
    z.boolean().default(false),
  ),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const revocarSchema = z.object({
  motivo: z.string().min(5).max(2000),
});

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dayBefore(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// GET /vigentes — oficiales activos (no rev/no expirados)
// ============================================================================
router.get('/vigentes', async (_req, res: Response) => {
  const rows = await db.select({
    id: laftComplianceOfficers.id,
    userId: laftComplianceOfficers.userId,
    rol: laftComplianceOfficers.rol,
    certificacionIso17024: laftComplianceOfficers.certificacionIso17024,
    certificacionDocStorageKey: laftComplianceOfficers.certificacionDocStorageKey,
    validFrom: laftComplianceOfficers.validFrom,
    validTo: laftComplianceOfficers.validTo,
    actaJuntaStorageKey: laftComplianceOfficers.actaJuntaStorageKey,
    userName: users.name,
    userEmail: users.email,
  })
    .from(laftComplianceOfficers)
    .leftJoin(users, eq(users.id, laftComplianceOfficers.userId))
    .where(and(
      isNull(laftComplianceOfficers.validTo),
      isNull(laftComplianceOfficers.revocadoAt),
    ))
    .orderBy(laftComplianceOfficers.rol);
  res.json({ data: rows });
});

// ============================================================================
// GET / — historial completo paginado
// ============================================================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const rows = await db.select().from(laftComplianceOfficers)
    .orderBy(desc(laftComplianceOfficers.createdAt))
    .limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(laftComplianceOfficers);
  res.json({ data: rows, total: count, limit, offset });
});

// ============================================================================
// POST / — designar oficial (multipart: acta_junta + certificacion)
// ============================================================================
router.post(
  '/',
  writeLimiter,
  requireRole('admin'),
  upload.fields([
    { name: 'actaJunta', maxCount: 1 },
    { name: 'certificacion', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const parsed = designarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
      return;
    }
    const data = parsed.data;
    const designadoPor = req.user!.sub;

    // Validar que el usuario existe.
    const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, data.userId)).limit(1);
    if (!u) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    let actaKey: string | null = null;
    let certKey: string | null = null;
    try {
      if (files?.actaJunta?.[0]) {
        actaKey = await uploadEntityDocument(
          'laft/officer-acta', data.userId,
          files.actaJunta[0].originalname, files.actaJunta[0].buffer, files.actaJunta[0].mimetype,
        );
      }
      if (files?.certificacion?.[0]) {
        certKey = await uploadEntityDocument(
          'laft/officer-iso17024', data.userId,
          files.certificacion[0].originalname, files.certificacion[0].buffer, files.certificacion[0].mimetype,
        );
      }
    } catch (e: any) {
      slog.error({ err: e?.message }, 'fallo upload archivos oficial');
      res.status(500).json({ error: 'Error subiendo archivos' });
      return;
    }

    try {
      const created = await db.transaction(async (tx) => {
        // Cierre atómico del oficial vigente del mismo rol (FOR UPDATE evita race).
        const [actual] = await tx.select().from(laftComplianceOfficers)
          .where(and(
            eq(laftComplianceOfficers.rol, data.rol),
            isNull(laftComplianceOfficers.validTo),
            isNull(laftComplianceOfficers.revocadoAt),
          ))
          .for('update').limit(1);
        if (actual) {
          const yesterday = dayBefore(data.validFrom);
          await tx.update(laftComplianceOfficers)
            .set({ validTo: yesterday })
            .where(eq(laftComplianceOfficers.id, actual.id));
        }
        const [row] = await tx.insert(laftComplianceOfficers).values({
          userId: data.userId,
          rol: data.rol,
          certificacionIso17024: data.certificacionIso17024,
          certificacionDocStorageKey: certKey,
          designadoPor,
          actaJuntaStorageKey: actaKey,
          validFrom: data.validFrom,
          validTo: data.validTo ?? null,
        }).returning();
        return row;
      });

      await laftAudit(req, {
        action: 'officer_designar', resource: 'risk_assessment', resourceId: created.id,
        after: { userId: created.userId, rol: created.rol, validFrom: created.validFrom },
      });
      res.status(201).json(created);
    } catch (e: any) {
      slog.error({ err: e?.message }, 'fallo designar oficial');
      res.status(500).json({ error: 'Error designando oficial' });
    }
  },
);

// ============================================================================
// POST /:id/revocar — revocar designación (no borra)
// ============================================================================
router.post('/:id/revocar', writeLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = revocarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'motivo requerido (5-2000 chars)' }); return; }

  const [updated] = await db.update(laftComplianceOfficers).set({
    revocadoAt: new Date(),
    revocadoMotivo: parsed.data.motivo,
    revocadoPor: req.user!.sub,
  }).where(and(
    eq(laftComplianceOfficers.id, id),
    isNull(laftComplianceOfficers.revocadoAt),
  )).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrada o ya revocada' }); return; }

  await laftAudit(req, {
    action: 'officer_revocar', resource: 'risk_assessment', resourceId: id,
    after: { motivo: parsed.data.motivo },
  });
  res.json(updated);
});

export default router;
