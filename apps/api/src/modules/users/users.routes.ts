import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, users } from '../../db/schema.js';
import { authMiddleware, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { invalidarPermisosDe } from '../../shared/permisos-efectivos.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { audit } from '../../shared/middleware/audit.js';
import { sendExcel } from '../../shared/utils/excel.js';
import { isValidPage } from '../../shared/permissions.js';
import { ALL_ROLES, ENTIDADES_AUDITABLES, ROLE_LABELS, isKnownOrganismoCodigo, type UserRole } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';
import {
  actualizarUsuario, cambiarActivo, crearUsuario, listarUsuarios, nombresDeAmbito, organismosDe, organismosDeVarios,
  organismosInexistentes, proveedorSoatExiste, restablecerContrasena, resumenUsuarios, rolAsignable,
  type FiltrosUsuarios, type PaginacionUsuarios,
} from './users.service.js';
import { listarAuditoria, titularesAuditoria } from './users-auditoria.service.js';

const log = loggerFor('users');

const router = Router();

// Roles asignables: fuente única en @operaciones/shared-types (incluye 'auditor').
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])/;
const PASSWORD_MSG = 'Mín 8 caracteres, 1 mayúscula, 1 minúscula, 1 número, 1 especial';

// Cambio de contraseña — auth solo; el handler decide: la propia siempre, la AJENA con la función
// `usuarios.contrasena.cambiar_ajena` (guarda en línea, HU #12083; de partida solo `admin`).
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).regex(PASSWORD_REGEX, PASSWORD_MSG),
});

router.patch('/:id/password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    if (req.user!.sub !== id && !(await tieneFuncion(req, 'usuarios.contrasena.cambiar_ajena'))) {
      res.status(403).json({ error: 'Sin permisos' }); return;
    }

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
    // HU #12171: el hash y la fila del historial (`password`, sin valores) entran en una transacción.
    await restablecerContrasena(id, user.role, newHash, actorDeRequest(req));
    await audit(req, { action: 'update', resource: 'user', resourceId: String(id), detail: 'Contraseña actualizada' });
    res.json({ ok: true });
  } catch (e) {
    log.error({ err: e, userId: req.params.id }, 'password update failed');
    res.status(500).json({ error: 'Error interno' });
  }
});

// === Filtros del listado (HU #12172) =========================================
//
// Los MISMOS tres filtros los comparten el listado y la descarga: `/export` baja lo que la pantalla
// está mostrando, no la tabla entera. Por eso el schema es uno solo.
//
// `rol` se valida contra `ALL_ROLES` —los doce códigos de SISTEMA— y no contra una lista escrita a
// mano: un código inexistente sale como 400 de validación y no como una lista vacía que parece un dato.
// Desde la HU #12169 `ALL_ROLES` ya NO es el catálogo vivo (eso es la tabla `permisos_roles`), así que
// este filtro no sabe de un rol creado por el administrador. Es deuda DECLARADA y acotada al filtro:
// la pantalla que ofrece el catálogo completo es la #12085, y ella trae este `z.enum` con ella.
// `q` vacío (`?q=`) NO es un error: es «sin filtro», que es lo que manda el front al borrar la caja.
const listadoQuerySchema = z.object({
  rol: z.enum(ALL_ROLES).optional(),
  activo: z.enum(['true', 'false']).optional(),
  q: z.string().max(100).optional(),
  pagina: z.coerce.number().int().positive().max(100000).optional(),
  porPagina: z.coerce.number().int().positive().max(500).optional(),
});

interface ConsultaListado { filtros: FiltrosUsuarios; paginacion: PaginacionUsuarios }

/** `undefined` cuando la query no valida; el llamador ya respondió el 400. */
function leerConsulta(req: Request, res: Response): ConsultaListado | undefined {
  const parsed = listadoQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() });
    return undefined;
  }
  const { rol, activo, q, pagina, porPagina } = parsed.data;
  const texto = q?.trim();
  return {
    filtros: {
      rol: rol as UserRole | undefined,
      activo: activo === undefined ? undefined : activo === 'true',
      q: texto ? texto : undefined,
    },
    paginacion: { pagina, porPagina },
  };
}

/** El texto de la columna «Ámbito» del Excel: cada rol tiene el suyo, y la mayoría no tiene ninguno. */
function textoAmbito(
  u: { role: string; transitoCodigo: string | null; companiaId: number | null; flitoProveedorSoatId: string | null },
  organismos: string[], companias: Map<number, string>, proveedores: Map<string, string>,
): string {
  if (u.role === 'gestor_impuestos') return organismos.join(', ');
  if (u.role === 'transito') return u.transitoCodigo ?? '';
  if (u.role === 'cliente') return u.companiaId ? (companias.get(u.companiaId) ?? `Compañía ${u.companiaId}`) : '';
  if (u.role === 'proveedor') return u.flitoProveedorSoatId ? (proveedores.get(u.flitoProveedorSoatId) ?? 'Proveedor') : '';
  return '';
}

// Resto del módulo: `authMiddleware` a nivel de router y la función `usuarios.*` en cada ruta
// (`exigirFuncion`, HU #12083). De partida todas son solo de `admin` (0181).
router.use(authMiddleware);

// === ORDEN DE RUTAS ==========================================================
// `/export` y `/resumen` son LITERALES y van declaradas ANTES que el listado y que CUALQUIER `/:id`.
// Express casa por orden de declaración: un `router.get('/:id', …)` añadido más arriba se las
// tragaría y `id` valdría la cadena "export". Quien añada rutas nuevas al módulo: los literales
// primero, los parámetros después.
//
// Van DEBAJO del `router.use` de arriba, así que heredan `authMiddleware`; la guarda de función va
// en cada una. El orden literal-antes-de-paramétrica no obliga a nada más: basta con estar por
// encima del `/:id`.

// === Descargar el listado en Excel ===========================================
router.get('/export', exigirFuncion('usuarios.usuario.exportar'), async (req: Request, res: Response) => {
  const consulta = leerConsulta(req, res);
  if (!consulta) return;

  // Sin paginar: se baja TODO lo que casa con los filtros, no la página que se está viendo. Una
  // descarga partida en páginas no le sirve a nadie.
  const { filas, total } = await listarUsuarios(consulta.filtros);
  const porUsuario = await organismosDeVarios(filas.map((u) => u.id));
  const { companias, proveedores } = await nombresDeAmbito(
    filas.map((u) => u.companiaId).filter((c): c is number => c !== null),
    filas.map((u) => u.flitoProveedorSoatId).filter((p): p is string => p !== null),
  );

  const rows = filas.map((u) => ({
    username: u.username,
    name: u.name,
    email: u.email ?? '',
    role: ROLE_LABELS[u.role as UserRole] ?? u.role,
    estado: u.active ? 'Activo' : 'Inactivo',
    ambito: textoAmbito(u, porUsuario.get(u.id) ?? [], companias, proveedores),
    createdAt: u.createdAt,
  }));

  const { rol, activo, q } = consulta.filtros;
  await audit(req, {
    action: 'export',
    resource: 'user',
    detail: `Descarga usuarios (${total}) — filtros: rol=${rol ?? '·'} activo=${activo ?? '·'} q=${q ? 'sí' : '·'}`,
  });

  await sendExcel(res, 'usuarios.xlsx', [
    { header: 'Usuario', key: 'username', width: 20 },
    { header: 'Nombre', key: 'name', width: 28 },
    { header: 'Correo', key: 'email', width: 28 },
    { header: 'Rol', key: 'role', width: 22 },
    { header: 'Estado', key: 'estado', width: 12 },
    { header: 'Ámbito', key: 'ambito', width: 32 },
    { header: 'Fecha de creación', key: 'createdAt', width: 20 },
  ], rows);
});

// === Conteo por rol y por estado =============================================
router.get('/resumen', exigirFuncion('usuarios.usuario.ver_resumen'), async (req: Request, res: Response) => {
  const resumen = await resumenUsuarios();
  await audit(req, { action: 'view', resource: 'user', detail: `Resumen usuarios (${resumen.activos + resumen.inactivos})` });
  res.json(resumen);
});

// === Historial de cambios de usuarios, roles y permisos (HU #12171, CF-19) ====
//
// Literales también, y por eso viven aquí arriba. `GET` con query y no `POST …/buscar`: ningún
// filtro es PII ni cuasi-PII (AGENTS.md §14): un entero interno, un enum, un código de rol y dos
// fechas. Dos rutas con dos códigos porque el catálogo es «una función por ruta» (precedente:
// `soat.cola.ver` / `soat.cola.filtrar`). `admin` y `auditor` las tienen sembradas por la 0185.
const auditoriaQuerySchema = z.object({
  titularUserId: z.coerce.number().int().positive().optional(),
  entidad: z.enum(ENTIDADES_AUDITABLES).optional(),
  rolCodigo: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `YYYY-MM-DD` → medianoche UTC, o `null` si el día no existe (V8 convierte «2026-02-31» en marzo
 * sin quejarse: se exige que la fecha vuelva a escribirse igual). El rango es medio abierto `[desde, hasta)`.
 */
function fechaUtc(d: string | undefined): Date | null | undefined {
  if (d === undefined) return undefined;
  const fecha = new Date(`${d}T00:00:00.000Z`);
  return Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== d ? null : fecha;
}

router.get('/auditoria', exigirFuncion('usuarios.auditoria.ver'), async (req: Request, res: Response) => {
  const parsed = auditoriaQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() }); return; }
  const { titularUserId, entidad, rolCodigo, desde, hasta, limite, offset } = parsed.data;
  const desdeF = fechaUtc(desde);
  const hastaF = fechaUtc(hasta);
  if (desdeF === null || hastaF === null) {
    const fieldErrors: Record<string, string[]> = {};
    if (desdeF === null) fieldErrors.desde = ['Fecha inexistente'];
    if (hastaF === null) fieldErrors.hasta = ['Fecha inexistente'];
    res.status(400).json({ error: 'Filtros inválidos', details: { fieldErrors } }); return;
  }
  // Rango invertido: 400 sin tocar la base. Un `[desde, hasta)` vacío daría 200 con `items: []`, que
  // es indistinguible de «no hubo cambios» y esconde el error de quien escribió las fechas.
  if (desdeF && hastaF && desdeF > hastaF) {
    res.status(400).json({ error: 'Filtros inválidos', details: { fieldErrors: { hasta: ['Debe ser posterior o igual a desde'] } } }); return;
  }
  const respuesta = await listarAuditoria(
    { titularUserId, entidad, rolCodigo, desde: desdeF, hasta: hastaF },
    { limite, offset },
  );
  res.json(respuesta);
});

router.get('/auditoria/titulares', exigirFuncion('usuarios.auditoria.filtrar'), async (_req: Request, res: Response) => {
  res.json(await titularesAuditoria());
});

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

// HU #12169 — el rol es DATO, no una constante compilada. Mismo tratamiento que la compañía y el
// proveedor: el mensaje lo lee el admin en la pantalla, y el 400 sale antes de escribir nada.
const MSG_ROL_NO_ASIGNABLE = 'El rol no existe o está inactivo';

/**
 * El código de un rol: FORMA, no pertenencia (HU #12169, AC6). Sustituye a `z.enum(ALL_ROLES)`, que
 * cerraba la lista en tiempo de compilación y hacía imposible asignar un rol recién creado (CF-03).
 *
 * Que el código EXISTA y esté activo no lo puede comprobar un esquema: lo comprueba el handler
 * contra `permisos_roles` con `rolAsignable()`, igual que `companiaExiste()`. Es el precedente
 * explícito del repo: «validación de existencia — en el handler, no en Zod».
 *
 * El regex es el mismo alfabeto de los doce códigos actuales y el que la #12084 impondrá al crear:
 * minúsculas, dígitos y guion bajo, empezando por letra. `max(40)` es el ancho de la PK.
 */
const codigoRolSchema = z.string().min(1).max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'El código de rol solo admite minúsculas, números y guion bajo');

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
  role: codigoRolSchema,
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
  role: codigoRolSchema.optional(),
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
// La respuesta sigue siendo un ARRAY PLANO, igual que antes de la HU #12172: hay consumidores. El
// total de coincidencias del filtro —que no es el largo del array cuando se pagina— viaja en la
// cabecera `X-Total-Count`, expuesta por CORS en `app.ts`.
router.get('/', exigirFuncion('usuarios.usuario.listar'), async (req: Request, res: Response) => {
  const consulta = leerConsulta(req, res);
  if (!consulta) return;

  const { filas, total } = await listarUsuarios(consulta.filtros, consulta.paginacion);
  // AC5: UNA consulta más para toda la página, agrupada por usuario. Una por fila sería N+1.
  const porUsuario = await organismosDeVarios(filas.map((u) => u.id));
  // `view`, no `export`: esto no genera ningún archivo. La descarga real es `/export`, y allí sí se
  // audita como `export` (HU #12172 — antes las dos cosas se registraban igual y el rastro mentía).
  await audit(req, { action: 'view', resource: 'user', detail: `Lista usuarios (${filas.length} de ${total})` });
  res.setHeader('X-Total-Count', String(total));
  res.json(filas.map((u) => ({ ...u, organismosCodigos: porUsuario.get(u.id) ?? [] })));
});

// === Crear usuario ===========================================================
router.post('/', exigirFuncion('usuarios.usuario.crear'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const {
    username, name, email, password, role, allowedPages, transitoCodigo, companiaId,
    flitoProveedorSoatId, organismosCodigos,
  } = parsed.data;

  // AC6: la pertenencia se pregunta al CATÁLOGO, no a una constante. Va lo primero porque un rol que
  // no existe no merece ni la consulta del username, y porque la FK `users_role_fkey` lo rechazaría
  // igual pero como un 23503 servido en un 500.
  if (!(await rolAsignable(role))) {
    res.status(400).json({ error: MSG_ROL_NO_ASIGNABLE });
    return;
  }

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
  }, actorDeRequest(req));
  // Por simetría con la edición: un id nuevo no tiene entrada en la caché de permisos que borrar,
  // pero si la tuviera (ids reciclados en pruebas) sería una foto de otro usuario.
  invalidarPermisosDe(user.id);

  await audit(req, { action: 'create', resource: 'user', resourceId: String(user.id), detail: `Usuario creado: ${username} (${role})` });
  res.status(201).json(user);
});

// === Editar usuario (nombre, email, rol) =====================================
router.patch('/:id', exigirFuncion('usuarios.usuario.editar'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [before] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!before) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // AC6, misma comprobación que en el alta y SOLO si el cuerpo trae `role`: editarle el nombre a un
  // usuario cuyo rol se desactivó después no puede fallar por un campo que el admin no tocó.
  if (data.role !== undefined && !(await rolAsignable(data.role))) {
    res.status(400).json({ error: MSG_ROL_NO_ASIGNABLE });
    return;
  }

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
  // sesiones — el JWT cachea el ROL (las páginas ya no: desde la HU #12082 se resuelven en cada
  // petición contra la base). Los ámbitos NO viajan en el token (se leen de la BD), pero el ROL sí,
  // y cambiar un ámbito cambia qué datos ve esa persona: que vuelva a entrar limpia.
  //
  // Lo de los organismos no se decide aquí: `actualizarUsuario` compara el conjunto anterior con el
  // destino DENTRO de la transacción y suma su veredicto a este (AC4).
  const invalidarPorCampos = data.role !== undefined || data.allowedPages !== undefined
    || data.transitoCodigo !== undefined || data.companiaId !== undefined
    || data.flitoProveedorSoatId !== undefined;

  // HU #12084 (AC4): la guarda de «último admin» de arriba es el pre-check con mensaje claro; la
  // verdad la decide el invariante DENTRO de la transacción (dos administradores a la vez, roles que
  // no se llaman `admin`). Su 409 llega como excepción y se mapea aquí.
  let r;
  try {
    r = await actualizarUsuario(id, { updates, organismosDestino, invalidarPorCampos }, actorDeRequest(req));
  } catch (e) {
    if (e instanceof BloqueoAdministracionError) { res.status(409).json({ error: e.message, funcion: e.funcion }); return; }
    throw e;
  }
  if (r.estado === 'sin_cambios') { res.status(400).json({ error: 'Sin cambios' }); return; }
  if (r.estado === 'no_encontrado') { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // DESPUÉS del commit, como ya se hacía: invalidar la caché de una transacción que luego revierte
  // deja fuera a quien no había que sacar. La caché de PERMISOS (HU #12082) se invalida siempre que
  // hubo cambios: la siguiente petición de este usuario decide con la configuración nueva, sin
  // reiniciar el API y sin esperar los 60 s del TTL.
  if (r.invalidada) invalidateSessionCacheFor(id);
  invalidarPermisosDe(id);

  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: `Cambios: ${r.camposCambiados.join(', ')}${data.role ? ` (rol: ${before.role}→${data.role})` : ''}${r.invalidada ? ' [sesiones invalidadas]' : ''}`,
  });
  res.json(r.usuario);
});

// === Toggle activo/inactivo ==================================================
router.patch('/:id/toggle', exigirFuncion('usuarios.usuario.activar'), async (req: Request, res: Response) => {
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

  // HU #12171: el `UPDATE` y su fila de historial (`active`, antes/después) van en una transacción
  // del servicio; el «antes» sale del propio UPDATE atómico, no del `before` de las guardas.
  let updated;
  try {
    updated = await cambiarActivo(id, actorDeRequest(req));
  } catch (e) {
    // HU #12084 (AC4): el invariante decide dentro de la transacción; el Guard 2 es el pre-check.
    if (e instanceof BloqueoAdministracionError) { res.status(409).json({ error: e.message, funcion: e.funcion }); return; }
    throw e;
  }
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

  // Al desactivar/reactivar también invalidamos sesiones para que un usuario reactivado
  // vuelva a entrar limpio y un desactivado pierda acceso inmediatamente. DESPUÉS del commit.
  invalidateSessionCacheFor(id);
  invalidarPermisosDe(id);

  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: `Estado: ${before.active ? 'activo' : 'inactivo'} → ${updated.active ? 'activo' : 'inactivo'} [sesiones invalidadas]`,
  });
  res.json(updated);
});

// === Forzar logout (admin manual) ============================================
// Útil cuando se detecta sesión comprometida o tras cambios de seguridad puntuales.
router.post('/:id/invalidate-sessions', exigirFuncion('usuarios.sesiones.invalidar'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(users)
    .set({ sessionInvalidatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id, username: users.username });
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
  invalidateSessionCacheFor(id);
  invalidarPermisosDe(id);
  await audit(req, { action: 'update', resource: 'user_session', resourceId: String(id), detail: 'Sesiones invalidadas manualmente' });
  res.json({ ok: true, user: updated });
});

export default router;
