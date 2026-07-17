import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { authMiddleware, requireRole, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { isValidPage } from '../../shared/permissions.js';
import { ALL_ROLES, isKnownOrganismoCodigo } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('users');

const router = Router();

// Roles asignables: fuente única en @operaciones/shared-types (incluye 'auditor').
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])/;
const PASSWORD_MSG = 'Mín 8 caracteres, 1 mayúscula, 1 minúscula, 1 número, 1 especial';

// Cambio de contraseña — auth solo, el handler valida que sea propio o admin.
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).regex(PASSWORD_REGEX, PASSWORD_MSG),
});

router.patch('/:id/password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    if (req.user!.sub !== id && req.user!.role !== 'admin') { res.status(403).json({ error: 'Sin permisos' }); return; }

    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    // Si el admin cambia la contraseña de otro, no necesita la actual; si la cambia propia, sí.
    const requiresCurrent = req.user!.sub === id;
    if (requiresCurrent) {
      const valid = await argon2.verify(user.passwordHash, parsed.data.currentPassword);
      if (!valid) { res.status(401).json({ error: 'Contraseña actual incorrecta' }); return; }
    }

    const newHash = await argon2.hash(parsed.data.newPassword);
    await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, id));
    await audit(req, { action: 'update', resource: 'user', resourceId: String(id), detail: 'Contraseña actualizada' });
    res.json({ ok: true });
  } catch (e) {
    log.error({ err: e, userId: req.params.id }, 'password update failed');
    res.status(500).json({ error: 'Error interno' });
  }
});

// Resto del módulo — solo admin
router.use(authMiddleware, requireRole('admin'));

const allowedPagesSchema = z.array(z.string()).max(50).transform((arr) => arr.filter(isValidPage));

const transitoCodigoSchema = z.string().regex(/^\d{5}$/, 'Código DIVIPOLA de 5 dígitos')
  .refine((c) => isKnownOrganismoCodigo(c), 'Organismo de tránsito desconocido')
  .nullable()
  .optional();

const createSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/, 'Solo letras, números y guion bajo'),
  name: z.string().min(1).max(100),
  email: z.string().email().max(150).optional().or(z.literal('').transform(() => undefined)),
  password: z.string().min(8).regex(PASSWORD_REGEX, PASSWORD_MSG),
  role: z.enum(ALL_ROLES),
  allowedPages: allowedPagesSchema.optional(),
  transitoCodigo: transitoCodigoSchema,
}).superRefine((d, ctx) => {
  if (d.role === 'transito' && !d.transitoCodigo) {
    ctx.addIssue({ code: 'custom', path: ['transitoCodigo'], message: 'Organismo de tránsito requerido para rol tránsito' });
  }
  if (d.role !== 'transito' && d.transitoCodigo) {
    ctx.addIssue({ code: 'custom', path: ['transitoCodigo'], message: 'Solo usuarios tránsito pueden tener organismo asignado' });
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(150).optional().or(z.literal('').transform(() => null)).nullable(),
  role: z.enum(ALL_ROLES).optional(),
  allowedPages: allowedPagesSchema.optional(),
  transitoCodigo: transitoCodigoSchema,
});

const userSelect = {
  id: users.id,
  username: users.username,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  allowedPages: users.allowedPages,
  transitoCodigo: users.transitoCodigo,
  createdAt: users.createdAt,
};

// === Listar usuarios =========================================================
router.get('/', async (req: Request, res: Response) => {
  const result = await db.select(userSelect).from(users).orderBy(users.username);
  await audit(req, { action: 'export', resource: 'user', detail: `Lista usuarios (${result.length})` });
  res.json(result);
});

// === Crear usuario ===========================================================
router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const { username, name, email, password, role, allowedPages, transitoCodigo } = parsed.data;

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: 'Username ya registrado' });
    return;
  }

  const passwordHash = await argon2.hash(password);
  // Si no envía allowedPages, queda vacío y el backend usa defaults del rol vía getEffectivePages.
  // Si envía un array (incluso vacío), se respeta y SOLO se aplican los defaults del rol al unir.
  const [user] = await db.insert(users).values({
    username, name, email: email ?? null, passwordHash, role,
    allowedPages: allowedPages ?? [],
    transitoCodigo: role === 'transito' ? transitoCodigo! : null,
  }).returning(userSelect);

  await audit(req, { action: 'create', resource: 'user', resourceId: String(user.id), detail: `Usuario creado: ${username} (${role})` });
  res.status(201).json(user);
});

// === Editar usuario (nombre, email, rol) =====================================
router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [before] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!before) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // Si se está degradando a un admin, asegurar que quede al menos otro admin activo.
  if (data.role && data.role !== 'admin' && before.role === 'admin') {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true), ne(users.id, id)));
    if (count === 0) { res.status(409).json({ error: 'No se puede cambiar el rol del último admin activo' }); return; }
  }

  const roleEfectivo = data.role ?? before.role;
  if (roleEfectivo === 'transito' && data.transitoCodigo === null) {
    res.status(400).json({ error: 'Organismo de tránsito requerido para rol tránsito' });
    return;
  }
  if (data.transitoCodigo && roleEfectivo !== 'transito') {
    res.status(400).json({ error: 'Solo usuarios tránsito pueden tener organismo asignado' });
    return;
  }
  if (roleEfectivo === 'transito' && data.role === 'transito' && data.transitoCodigo === undefined && !before.transitoCodigo) {
    res.status(400).json({ error: 'Organismo de tránsito requerido para rol tránsito' });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.email !== undefined) updates.email = data.email;
  if (data.role !== undefined) updates.role = data.role;
  if (data.allowedPages !== undefined) updates.allowedPages = data.allowedPages;
  if (data.transitoCodigo !== undefined) updates.transitoCodigo = data.transitoCodigo;
  if (data.role !== undefined && data.role !== 'transito' && data.transitoCodigo === undefined) {
    updates.transitoCodigo = null;
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'Sin cambios' }); return; }

  // Si cambian role, allowedPages o transitoCodigo, invalidar sesiones — el JWT cachea scope.
  const debeInvalidar = data.role !== undefined || data.allowedPages !== undefined || data.transitoCodigo !== undefined;
  if (debeInvalidar) {
    (updates as any).sessionInvalidatedAt = new Date();
  }

  const [updated] = await db.update(users).set(updates).where(eq(users.id, id)).returning(userSelect);
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  if (debeInvalidar) invalidateSessionCacheFor(id);

  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: `Cambios: ${Object.keys(updates).join(', ')}${data.role ? ` (rol: ${before.role}→${data.role})` : ''}${debeInvalidar ? ' [sesiones invalidadas]' : ''}`,
  });
  res.json(updated);
});

// === Toggle activo/inactivo ==================================================
router.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

  // Guard 1: el admin no puede desactivarse a sí mismo (prevenir lock-out).
  if (id === req.user!.sub) {
    res.status(400).json({ error: 'No puede desactivarse a sí mismo' }); return;
  }

  const [before] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!before) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // Guard 2: si va a desactivar a un admin activo, asegurar que quede al menos otro admin activo.
  if (before.active && before.role === 'admin') {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true), ne(users.id, id)));
    if (count === 0) { res.status(409).json({ error: 'No se puede desactivar al último admin activo' }); return; }
  }

  const [updated] = await db.update(users)
    .set({ active: sql`NOT active`, sessionInvalidatedAt: new Date() })
    .where(eq(users.id, id))
    .returning(userSelect);

  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // Al desactivar/reactivar también invalidamos sesiones para que un usuario reactivado
  // vuelva a entrar limpio y un desactivado pierda acceso inmediatamente.
  invalidateSessionCacheFor(id);

  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: `Estado: ${before.active ? 'activo' : 'inactivo'} → ${updated.active ? 'activo' : 'inactivo'} [sesiones invalidadas]`,
  });
  res.json(updated);
});

// === Forzar logout (admin manual) ============================================
// Útil cuando se detecta sesión comprometida o tras cambios de seguridad puntuales.
router.post('/:id/invalidate-sessions', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(users)
    .set({ sessionInvalidatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id, username: users.username });
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
  invalidateSessionCacheFor(id);
  await audit(req, { action: 'update', resource: 'user_session', resourceId: String(id), detail: 'Sesiones invalidadas manualmente' });
  res.json({ ok: true, user: updated });
});

export default router;
