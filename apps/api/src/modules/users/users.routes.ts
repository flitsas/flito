import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, users } from '../../db/schema.js';
import { authMiddleware, requireRole, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { isValidPage } from '../../shared/permissions.js';
import { ALL_ROLES, isKnownOrganismoCodigo } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import {
  actualizarUsuario, crearUsuario, organismosDe, organismosDeVarios, organismosInexistentes,
  proveedorSoatExiste, userSelect,
} from './users.service.js';

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

// FLITO — Cliente (Feature #11912): la compañía del usuario `cliente`. Mismo patrón que
// `transitoCodigo` —nullable + optional, con la obligatoriedad CONDICIONAL AL ROL resuelta en el
// `superRefine`— porque es la misma idea: un ámbito que solo tiene sentido para un rol.
//
// Que el id EXISTA no lo puede comprobar un schema: lo comprueba el handler contra `clients` antes
// de escribir, para que una compañía inventada no salga como un 23503 servido en un 500.
const companiaIdSchema = z.number().int().positive('Compañía inválida').nullable().optional();

// FLITO (HU #12053) — el proveedor SOAT del rol `proveedor`. Mismo patrón que `companiaId`: la
// obligatoriedad es CONDICIONAL AL ROL y vive en el `superRefine`; que el uuid EXISTA lo comprueba
// el handler contra `flito_proveedores_soat`.
const proveedorSoatIdSchema = z.string().uuid('Proveedor SOAT inválido').nullable().optional();

/**
 * Los organismos del `gestor_impuestos`. Es una LISTA y no un código porque el AC2 pide varios.
 *
 * El `isKnownOrganismoCodigo` se conserva como pre-filtro (mismo mensaje que un typo en
 * `transitoCodigo`), pero NO basta: el catálogo de `shared-types` es el nacional y la atadura se
 * hace contra el PARAMETRIZADO. La existencia real la comprueba el handler.
 *
 * Se DEDUPLICA antes de escribir: sin esto, `["05001","05001"]` choca con la PK compuesta y devuelve
 * un 23505 servido en un 500.
 */
const organismosCodigosSchema = z.array(
  z.string().regex(/^\d{5}$/, 'Código DIVIPOLA de 5 dígitos')
    .refine((c) => isKnownOrganismoCodigo(c), 'Organismo de tránsito desconocido'),
).max(200).transform((arr) => [...new Set(arr)]).optional();

// Literales del copy de UX (docs/ux/identidad-rol-cliente-y-soat-sin-tramite.md §1.4). El front los
// muestra prefijados con el nombre del campo (`ApiError.toUserMessage`): es el comportamiento que ya
// tiene `transitoCodigo` y no se arregla en esta HU.
const MSG_COMPANIA_REQUERIDA = 'Compañía requerida para el rol Cliente';
const MSG_COMPANIA_SOBRA = 'Solo los usuarios Cliente pueden tener compañía asignada';
const MSG_COMPANIA_NO_EXISTE = 'La compañía no existe';

// FLITO — ámbito del Proveedor y del Gestor de Impuestos (HU #12053). Literales de
// docs/ux/usuarios-ambito-proveedor-y-gestor-impuestos.md §5.2, con el mismo tratamiento que los de
// arriba: el front los muestra prefijados con el nombre del campo (`ApiError.toUserMessage`).
const MSG_PROVEEDOR_REQUERIDO = 'Proveedor SOAT requerido para el rol Proveedor';
const MSG_PROVEEDOR_SOBRA = 'Solo los usuarios Proveedor pueden tener proveedor SOAT asignado';
const MSG_PROVEEDOR_NO_EXISTE = 'El proveedor SOAT no existe';
const MSG_ORGANISMOS_REQUERIDOS = 'Organismos requeridos para el rol Gestor de Impuestos';
const MSG_ORGANISMOS_SOBRAN = 'Solo los usuarios Gestor de Impuestos pueden tener organismos asignados';
const MSG_ORGANISMOS_NO_EXISTE = 'Alguno de los organismos no existe';

/** ¿Existe esa compañía? Sin esto, un id inventado sería un 23503 sin mensaje útil. */
async function companiaExiste(id: number): Promise<boolean> {
  const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id)).limit(1);
  return !!c;
}

const createSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/, 'Solo letras, números y guion bajo'),
  name: z.string().min(1).max(100),
  email: z.string().email().max(150).optional().or(z.literal('').transform(() => undefined)),
  password: z.string().min(8).regex(PASSWORD_REGEX, PASSWORD_MSG),
  role: z.enum(ALL_ROLES),
  allowedPages: allowedPagesSchema.optional(),
  transitoCodigo: transitoCodigoSchema,
  companiaId: companiaIdSchema,
  flitoProveedorSoatId: proveedorSoatIdSchema,
  organismosCodigos: organismosCodigosSchema,
}).superRefine((d, ctx) => {
  if (d.role === 'transito' && !d.transitoCodigo) {
    ctx.addIssue({ code: 'custom', path: ['transitoCodigo'], message: 'Organismo de tránsito requerido para rol tránsito' });
  }
  if (d.role !== 'transito' && d.transitoCodigo) {
    ctx.addIssue({ code: 'custom', path: ['transitoCodigo'], message: 'Solo usuarios tránsito pueden tener organismo asignado' });
  }
  // AC2, capa 1 de 3 (las otras dos: el CHECK de la migración 0168 y el `return null` de
  // `contextoSoat`). Esta es la que produce el mensaje que el admin lee en la pantalla.
  if (d.role === 'cliente' && !d.companiaId) {
    ctx.addIssue({ code: 'custom', path: ['companiaId'], message: MSG_COMPANIA_REQUERIDA });
  }
  if (d.role !== 'cliente' && d.companiaId) {
    ctx.addIssue({ code: 'custom', path: ['companiaId'], message: MSG_COMPANIA_SOBRA });
  }
  // AC3 de la #12053, las dos ataduras y sus dos inversos. Esta es la capa que produce el mensaje
  // que el admin lee, y la que garantiza que un alta inválida NO escriba nada: el 400 sale antes de
  // consultar siquiera si el username está libre.
  if (d.role === 'proveedor' && !d.flitoProveedorSoatId) {
    ctx.addIssue({ code: 'custom', path: ['flitoProveedorSoatId'], message: MSG_PROVEEDOR_REQUERIDO });
  }
  if (d.role !== 'proveedor' && d.flitoProveedorSoatId) {
    ctx.addIssue({ code: 'custom', path: ['flitoProveedorSoatId'], message: MSG_PROVEEDOR_SOBRA });
  }
  if (d.role === 'gestor_impuestos' && !d.organismosCodigos?.length) {
    ctx.addIssue({ code: 'custom', path: ['organismosCodigos'], message: MSG_ORGANISMOS_REQUERIDOS });
  }
  if (d.role !== 'gestor_impuestos' && d.organismosCodigos?.length) {
    ctx.addIssue({ code: 'custom', path: ['organismosCodigos'], message: MSG_ORGANISMOS_SOBRAN });
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(150).optional().or(z.literal('').transform(() => null)).nullable(),
  role: z.enum(ALL_ROLES).optional(),
  allowedPages: allowedPagesSchema.optional(),
  transitoCodigo: transitoCodigoSchema,
  companiaId: companiaIdSchema,
  flitoProveedorSoatId: proveedorSoatIdSchema,
  organismosCodigos: organismosCodigosSchema,
});

// `userSelect` vive en el servicio: lo comparten las cuatro respuestas y las dos escrituras
// transaccionales. Los organismos NO están ahí —son otra tabla y `.returning()` no hace join— y se
// componen en cada respuesta.

// === Listar usuarios =========================================================
router.get('/', async (req: Request, res: Response) => {
  const result = await db.select(userSelect).from(users).orderBy(users.username);
  // AC5: UNA consulta más para toda la página, agrupada por usuario. Una por fila sería N+1.
  const porUsuario = await organismosDeVarios(result.map((u) => u.id));
  await audit(req, { action: 'export', resource: 'user', detail: `Lista usuarios (${result.length})` });
  res.json(result.map((u) => ({ ...u, organismosCodigos: porUsuario.get(u.id) ?? [] })));
});

// === Crear usuario ===========================================================
router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const {
    username, name, email, password, role, allowedPages, transitoCodigo, companiaId,
    flitoProveedorSoatId, organismosCodigos,
  } = parsed.data;

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: 'Username ya registrado' });
    return;
  }

  if (role === 'cliente' && !(await companiaExiste(companiaId!))) {
    res.status(400).json({ error: MSG_COMPANIA_NO_EXISTE });
    return;
  }

  if (role === 'proveedor' && !(await proveedorSoatExiste(flitoProveedorSoatId!))) {
    res.status(400).json({ error: MSG_PROVEEDOR_NO_EXISTE });
    return;
  }

  if (role === 'gestor_impuestos') {
    const faltan = await organismosInexistentes(organismosCodigos!);
    if (faltan.length > 0) {
      res.status(400).json({ error: `${MSG_ORGANISMOS_NO_EXISTE}: ${faltan.join(', ')}` });
      return;
    }
  }

  const passwordHash = await argon2.hash(password);
  // Si no envía allowedPages, queda vacío y el backend usa defaults del rol vía getEffectivePages.
  // Si envía un array (incluso vacío), se respeta y SOLO se aplican los defaults del rol al unir.
  //
  // Los tres ternarios de ámbito hacen lo mismo: el `superRefine` ya rechazó las combinaciones
  // inválidas, y esto impide que un rol distinto conserve un ámbito por un cuerpo con campos de más.
  const user = await crearUsuario({
    username, name, email: email ?? null, passwordHash, role,
    allowedPages: allowedPages ?? [],
    transitoCodigo: role === 'transito' ? transitoCodigo! : null,
    companiaId: role === 'cliente' ? companiaId! : null,
    flitoProveedorSoatId: role === 'proveedor' ? flitoProveedorSoatId! : null,
    organismosCodigos: role === 'gestor_impuestos' ? organismosCodigos! : [],
  });

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

  // Las mismas tres guardas que `transitoCodigo`, para la compañía del `cliente` (AC2):
  //   1. quitarle la compañía a un cliente;
  //   2. ponerle compañía a quien no es cliente;
  //   3. ascender a `cliente` a alguien que no traía compañía en el cuerpo ni la tenía antes.
  // La tercera es la que de verdad importa: sin ella, un PATCH que solo cambia el rol dejaría un
  // `cliente` sin compañía — el usuario que el AC2 declara imposible.
  if (roleEfectivo === 'cliente' && data.companiaId === null) {
    res.status(400).json({ error: MSG_COMPANIA_REQUERIDA });
    return;
  }
  if (data.companiaId && roleEfectivo !== 'cliente') {
    res.status(400).json({ error: MSG_COMPANIA_SOBRA });
    return;
  }
  if (roleEfectivo === 'cliente' && data.companiaId === undefined && !before.companiaId) {
    res.status(400).json({ error: MSG_COMPANIA_REQUERIDA });
    return;
  }
  if (data.companiaId && !(await companiaExiste(data.companiaId))) {
    res.status(400).json({ error: MSG_COMPANIA_NO_EXISTE });
    return;
  }

  // Las MISMAS cuatro guardas, para las dos ataduras de la HU #12053. La tercera —ascender al rol
  // sin traer la atadura en el cuerpo ni tenerla antes— es la que de verdad importa: sin ella un
  // PATCH que solo cambia el rol crea el usuario que el AC3 declara imposible.
  if (roleEfectivo === 'proveedor' && data.flitoProveedorSoatId === null) {
    res.status(400).json({ error: MSG_PROVEEDOR_REQUERIDO });
    return;
  }
  if (data.flitoProveedorSoatId && roleEfectivo !== 'proveedor') {
    res.status(400).json({ error: MSG_PROVEEDOR_SOBRA });
    return;
  }
  if (roleEfectivo === 'proveedor' && data.flitoProveedorSoatId === undefined && !before.flitoProveedorSoatId) {
    res.status(400).json({ error: MSG_PROVEEDOR_REQUERIDO });
    return;
  }
  if (data.flitoProveedorSoatId && !(await proveedorSoatExiste(data.flitoProveedorSoatId))) {
    res.status(400).json({ error: MSG_PROVEEDOR_NO_EXISTE });
    return;
  }

  const organismosPedidos = data.organismosCodigos;
  // Una lista VACÍA sobre un gestor es «quitarle todos los organismos»: el mismo 400 que quitarle la
  // compañía a un cliente. El `[]` no es «sin cambios»: es un ámbito vacío, y un gestor sin ámbito
  // no ve nada.
  if (roleEfectivo === 'gestor_impuestos' && organismosPedidos !== undefined && organismosPedidos.length === 0) {
    res.status(400).json({ error: MSG_ORGANISMOS_REQUERIDOS });
    return;
  }
  if (organismosPedidos?.length && roleEfectivo !== 'gestor_impuestos') {
    res.status(400).json({ error: MSG_ORGANISMOS_SOBRAN });
    return;
  }
  if (roleEfectivo === 'gestor_impuestos' && organismosPedidos === undefined
      && (await organismosDe(id)).length === 0) {
    res.status(400).json({ error: MSG_ORGANISMOS_REQUERIDOS });
    return;
  }
  if (organismosPedidos?.length) {
    const faltan = await organismosInexistentes(organismosPedidos);
    if (faltan.length > 0) {
      res.status(400).json({ error: `${MSG_ORGANISMOS_NO_EXISTE}: ${faltan.join(', ')}` });
      return;
    }
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
  if (data.companiaId !== undefined) updates.companiaId = data.companiaId;
  // Degradar a un `cliente` le quita la compañía, igual que degradar a un `transito` le quita el
  // organismo: dejársela sería un ámbito colgado que nadie vuelve a mirar. El CHECK de la base no lo
  // impediría (solo exige compañía CUANDO el rol es cliente), así que la limpieza es cosa de aquí.
  if (data.role !== undefined && data.role !== 'cliente' && data.companiaId === undefined) {
    updates.companiaId = null;
  }
  if (data.flitoProveedorSoatId !== undefined) updates.flitoProveedorSoatId = data.flitoProveedorSoatId;
  // Degradar desde `proveedor` le quita el proveedor SOAT, igual que degradar a un `cliente` le
  // quita la compañía: dejárselo sería un ámbito colgado que nadie vuelve a mirar.
  if (data.role !== undefined && data.role !== 'proveedor' && data.flitoProveedorSoatId === undefined) {
    updates.flitoProveedorSoatId = null;
  }

  /**
   * Conjunto destino de organismos, o `null` para no tocarlo. Degradar desde `gestor_impuestos`
   * lo VACÍA (`[]`), por el mismo motivo que las otras dos ataduras.
   */
  const organismosDestino: string[] | null = organismosPedidos !== undefined
    ? organismosPedidos
    : (data.role !== undefined && data.role !== 'gestor_impuestos' ? [] : null);

  // Si cambian role, allowedPages, transitoCodigo, companiaId o el proveedor SOAT, invalidar
  // sesiones — el JWT cachea scope. Los ámbitos NO viajan en el token (se leen de la BD), pero el
  // ROL sí, y cambiar un ámbito cambia qué datos ve esa persona: que vuelva a entrar limpia.
  //
  // Lo de los organismos no se decide aquí: `actualizarUsuario` compara el conjunto anterior con el
  // destino DENTRO de la transacción y suma su veredicto a este (AC4).
  const invalidarPorCampos = data.role !== undefined || data.allowedPages !== undefined
    || data.transitoCodigo !== undefined || data.companiaId !== undefined
    || data.flitoProveedorSoatId !== undefined;

  const r = await actualizarUsuario(id, { updates, organismosDestino, invalidarPorCampos });
  if (r.estado === 'sin_cambios') { res.status(400).json({ error: 'Sin cambios' }); return; }
  if (r.estado === 'no_encontrado') { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // DESPUÉS del commit, como ya se hacía: invalidar la caché de una transacción que luego revierte
  // deja fuera a quien no había que sacar.
  if (r.invalidada) invalidateSessionCacheFor(id);

  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: `Cambios: ${r.camposCambiados.join(', ')}${data.role ? ` (rol: ${before.role}→${data.role})` : ''}${r.invalidada ? ' [sesiones invalidadas]' : ''}`,
  });
  res.json(r.usuario);
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
  // Aquí SÍ hay que leerlos: devolver `[]` haría que el front borrase de la fila los organismos del
  // gestor con solo activarlo o desactivarlo. Una consulta puntual por `user_id`; la PK la sirve.
  res.json({ ...updated, organismosCodigos: await organismosDe(id) });
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
