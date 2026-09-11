import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, permisosRoles, users } from '../../db/schema.js';
import { authMiddleware, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { invalidarPermisosDe } from '../../shared/permisos-efectivos.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { audit } from '../../shared/middleware/audit.js';
import { sendExcel } from '../../shared/utils/excel.js';
import { errorPg } from '../../shared/utils/pg-error.js';
import {
  ALL_ROLES, EFECTOS_PERMISO_USUARIO, ENTIDADES_AUDITABLES, ROLE_LABELS,
  codificarExcepcion, isKnownOrganismoCodigo, type FuncionDeUsuario, type UserRole,
} from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';
import {
  actualizarUsuario, cambiarActivo, crearUsuario, funcionesDeVarios, listarUsuarios, nombresDeAmbito,
  organismosDe, organismosDeVarios, organismosInexistentes, proveedorSoatExiste, restablecerContrasena,
  resumenUsuarios, rolAsignable,
  type FiltrosUsuarios, type PaginacionUsuarios,
} from './users.service.js';
import { handleDarDeBaja, handleReactivar } from './users-baja.js';
// HU #12087: la existencia de los códigos se pregunta al mismo sitio que el cuadro del rol
// (dependencia en un solo sentido: `users` → `permisos`; `permisos` no importa nada de aquí).
import { FuncionesInexistentesError, funcionesInexistentes } from '../permisos/permisos-roles.service.js';
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
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'ID inválido' });
            return;
        }
        if (req.user!.sub !== id && !(await tieneFuncion(req, 'usuarios.contrasena.cambiar_ajena'))) {
            res.status(403).json({ error: 'Sin permisos' });
            return;
        }
        const parsed = passwordSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
            return;
        }
        const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!user) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        if (user.deletedAt) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        // Si el admin cambia la contraseña de otro, no necesita la actual; si la cambia propia, sí.
        const requiresCurrent = req.user!.sub === id;
        if (requiresCurrent) {
            const valid = await argon2.verify(user.passwordHash, parsed.data.currentPassword);
            if (!valid) {
                res.status(401).json({ error: 'Contraseña actual incorrecta' });
                return;
            }
        }
        const newHash = await argon2.hash(parsed.data.newPassword);
        // HU #12171: el hash y la fila del historial (`password`, sin valores) entran en una transacción.
        await restablecerContrasena(id, user.role, newHash, actorDeRequest(req));
        await audit(req, { action: 'update', resource: 'user', resourceId: String(id), detail: 'Contraseña actualizada' });
        res.json({ ok: true });
    }
    catch (e) {
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
    // HU #12089: default excluye bajas; `incluirBajas` las trae; `soloBajas` = solo con deleted_at.
    incluirBajas: z.enum(['true', 'false']).optional(),
    soloBajas: z.enum(['true', 'false']).optional(),
});
/** `undefined` cuando la query no valida; el llamador ya respondió el 400. */
function leerConsulta(req: Request, res: Response): { filtros: FiltrosUsuarios; paginacion: PaginacionUsuarios } | undefined {
    const parsed = listadoQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() });
        return undefined;
    }
    const { rol, activo, q, pagina, porPagina, incluirBajas, soloBajas } = parsed.data;
    const texto = q?.trim();
    const solo = soloBajas === 'true';
    return {
        filtros: {
            rol: rol,
            activo: activo === undefined ? undefined : activo === 'true',
            q: texto ? texto : undefined,
            incluirBajas: solo ? true : incluirBajas === 'true',
            soloBajas: solo || undefined,
        },
        paginacion: { pagina, porPagina },
    };
}
/** El texto de la columna «Ámbito» del Excel: por `tipoEnlace` del rol, no por literal de role. */
function textoAmbito(
  tipoEnlace: string,
  u: { companiaId: number | null; flitoProveedorSoatId: string | null },
  organismos: string[],
  companias: Map<number, string>,
  proveedores: Map<string, string>,
): string {
    if (tipoEnlace === 'organismos_transito')
        return organismos.join(', ');
    if (tipoEnlace === 'compania')
        return u.companiaId ? (companias.get(u.companiaId) ?? `Compañía ${u.companiaId}`) : '';
    if (tipoEnlace === 'proveedor_soat')
        return u.flitoProveedorSoatId ? (proveedores.get(u.flitoProveedorSoatId) ?? 'Proveedor') : '';
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
    if (!consulta)
        return;
    // Sin paginar: se baja TODO lo que casa con los filtros, no la página que se está viendo. Una
    // descarga partida en páginas no le sirve a nadie.
    const { filas, total } = await listarUsuarios(consulta.filtros);
    const porUsuario = await organismosDeVarios(filas.map((u) => u.id));
    const { companias, proveedores } = await nombresDeAmbito(filas.map((u) => u.companiaId).filter((c) => c !== null), filas.map((u) => u.flitoProveedorSoatId).filter((p) => p !== null));
    const rolesUnicos = [...new Set(filas.map((u) => u.role))];
    const enlacePorRol = new Map<string, string>();
    if (rolesUnicos.length > 0) {
        const filasRol = await db.select({ codigo: permisosRoles.codigo, tipoEnlace: permisosRoles.tipoEnlace })
            .from(permisosRoles).where(inArray(permisosRoles.codigo, rolesUnicos));
        for (const r of filasRol) enlacePorRol.set(r.codigo, r.tipoEnlace);
    }
    const rows = filas.map((u) => ({
        username: u.username,
        name: u.name,
        email: u.email ?? '',
        role: ROLE_LABELS[u.role as UserRole] ?? u.role,
        estado: u.deletedAt ? 'Dado de baja' : (u.active ? 'Activo' : 'Inactivo'),
        ambito: textoAmbito(enlacePorRol.get(u.role) ?? 'ninguno', u, porUsuario.get(u.id) ?? [], companias, proveedores),
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
        { header: 'Estado', key: 'estado', width: 14 },
        { header: 'Ámbito', key: 'ambito', width: 32 },
        { header: 'Fecha de creación', key: 'createdAt', width: 20 },
    ], rows);
});
// === Conteo por rol y por estado =============================================
router.get('/resumen', exigirFuncion('usuarios.usuario.ver_resumen'), async (req: Request, res: Response) => {
    const consulta = leerConsulta(req, res);
    if (!consulta)
        return;
    const resumen = await resumenUsuarios(consulta.filtros);
    await audit(req, { action: 'view', resource: 'user', detail: `Resumen usuarios (${resumen.activos + resumen.inactivos + resumen.dadosDeBaja})` });
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
    if (d === undefined)
        return undefined;
    const fecha = new Date(`${d}T00:00:00.000Z`);
    return Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== d ? null : fecha;
}
router.get('/auditoria', exigirFuncion('usuarios.auditoria.ver'), async (req: Request, res: Response) => {
    const parsed = auditoriaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() });
        return;
    }
    const { titularUserId, entidad, rolCodigo, desde, hasta, limite, offset } = parsed.data;
    const desdeF = fechaUtc(desde);
    const hastaF = fechaUtc(hasta);
    if (desdeF === null || hastaF === null) {
        const fieldErrors: Record<string, string[]> = {};
        if (desdeF === null)
            fieldErrors.desde = ['Fecha inexistente'];
        if (hastaF === null)
            fieldErrors.hasta = ['Fecha inexistente'];
        res.status(400).json({ error: 'Filtros inválidos', details: { fieldErrors } });
        return;
    }
    // Rango invertido: 400 sin tocar la base. Un `[desde, hasta)` vacío daría 200 con `items: []`, que
    // es indistinguible de «no hubo cambios» y esconde el error de quien escribió las fechas.
    if (desdeF && hastaF && desdeF > hastaF) {
        res.status(400).json({ error: 'Filtros inválidos', details: { fieldErrors: { hasta: ['Debe ser posterior o igual a desde'] } } });
        return;
    }
    const respuesta = await listarAuditoria({ titularUserId, entidad, rolCodigo, desde: desdeF, hasta: hastaF }, { limite, offset });
    res.json(respuesta);
});
router.get('/auditoria/titulares', exigirFuncion('usuarios.auditoria.filtrar'), async (_req: Request, res: Response) => {
    res.json(await titularesAuditoria());
});
/**
 * HU #12087 — las excepciones por usuario. Presente = REEMPLAZO COMPLETO del conjunto (`[]` = quitar
 * todas); ausente = no tocar. Es la semántica de `organismosCodigos` y de `PUT …/roles/:codigo/funciones`.
 *
 * Capa 1 de 3 (las otras: `funcionesInexistentes` en el handler y la PK + CHECK de la 0179): un mismo
 * código con DOS efectos es un 400 de validación, no un 23505 servido en un 500; el mismo par repetido
 * se pliega a uno. Los `z.enum` se construyen desde `EFECTOS_PERMISO_USUARIO` (patrón `USER_ROLES`).
 *
 * `allowedPages` ya NO está en ningún esquema: obsoleto, no roto (AC6). Los esquemas no son `.strict()`,
 * así que un cliente viejo que lo mande recibe 200 y la clave se descarta; el handler lo registra con
 * `log.warn` para verlo. NO se traduce a `conceder pagina.*`: en un PATCH pisaría las excepciones
 * `operacion.*` que ese cliente no conoce.
 */
const funcionesSchema = z.array(z.object({
    codigo: z.string().min(1).max(80),
    efecto: z.enum(EFECTOS_PERMISO_USUARIO),
})).max(1000).superRefine((fs, ctx) => {
    const efectoPor = new Map<string, FuncionDeUsuario['efecto']>();
    fs.forEach((f, i) => {
        const ya = efectoPor.get(f.codigo);
        if (ya !== undefined && ya !== f.efecto) {
            ctx.addIssue({ code: 'custom', path: [i, 'efecto'], message: `La función ${f.codigo} no puede concederse y revocarse a la vez` });
        }
        efectoPor.set(f.codigo, f.efecto);
    });
}).transform((fs) => {
    const porClave = new Map<string, FuncionDeUsuario>();
    for (const f of fs)
        porClave.set(codificarExcepcion(f), f);
    return [...porClave.values()];
}).optional();
/** El aviso de AC6: el cliente mandó la clave obsoleta. Sin 400 y sin escribirla. */
function avisarAllowedPagesObsoleto(req: Request, verbo: string): void {
    if (req.body && typeof req.body === 'object' && 'allowedPages' in req.body) {
        log.warn({ verbo, actor: req.user?.sub }, 'allowedPages obsoleto en el body (HU #12087): se descarta');
    }
}
/** HU #12088: `transitoCodigo` en el body es OBSOLETO (como allowedPages). Warn + descartar; no se traduce a organismos. */
function avisarTransitoCodigoObsoleto(req: Request, verbo: string): void {
    if (req.body && typeof req.body === 'object' && 'transitoCodigo' in req.body) {
        log.warn({ verbo, actor: req.user?.sub }, 'transitoCodigo obsoleto en el body (HU #12088): se descarta');
    }
}
// FLITO — Cliente (Feature #11912): la compañía del usuario con tipo_enlace=compania. Mismo patrón
// que el resto de ataduras: obligatoriedad CONDICIONAL AL tipoEnlace, resuelta en el handler tras
// `rolAsignable` (HU #12088), no en superRefine por literal de rol.
//
// Que el id EXISTA no lo puede comprobar un schema: lo comprueba el handler contra `clients` antes
// de escribir, para que una compañía inventada no salga como un 23503 servido en un 500.
const companiaIdSchema = z.number().int().positive('Compañía inválida').nullable().optional();
// FLITO (HU #12053) — el proveedor SOAT del tipo_enlace=proveedor_soat. Mismo patrón que `companiaId`.
const proveedorSoatIdSchema = z.string().uuid('Proveedor SOAT inválido').nullable().optional();
/**
 * Los organismos del tipo_enlace=organismos_transito. Es una LISTA y no un código porque el AC2 pide varios.
 *
 * El `isKnownOrganismoCodigo` se conserva como pre-filtro, pero NO basta: el catálogo de
 * `shared-types` es el nacional y la atadura se hace contra el PARAMETRIZADO. La existencia real
 * la comprueba el handler.
 *
 * Se DEDUPLICA antes de escribir: sin esto, `["05001","05001"]` choca con la PK compuesta y
 * devuelve un 23505 servido en un 500.
 */
const organismosCodigosSchema = z.array(z.string().regex(/^\d{5}$/, 'Código DIVIPOLA de 5 dígitos')
    .refine((c) => isKnownOrganismoCodigo(c), 'Organismo de tránsito desconocido')).max(200).transform((arr) => [...new Set(arr)]).optional();
// HU #12088: mensajes genéricos por tipo de enlace (el admin puede haber creado un rol con otro nombre).
const MSG_COMPANIA_REQUERIDA = 'Compañía requerida para este rol';
const MSG_COMPANIA_SOBRA = 'Solo los roles con ámbito de compañía pueden tener compañía asignada';
const MSG_COMPANIA_NO_EXISTE = 'La compañía no existe';
const MSG_PROVEEDOR_REQUERIDO = 'Proveedor SOAT requerido para este rol';
const MSG_PROVEEDOR_SOBRA = 'Solo los roles con ámbito de proveedor SOAT pueden tener proveedor asignado';
const MSG_PROVEEDOR_NO_EXISTE = 'El proveedor SOAT no existe';
const MSG_ORGANISMOS_REQUERIDOS = 'Organismos requeridos para este rol';
const MSG_ORGANISMOS_SOBRAN = 'Solo los roles con ámbito de organismos pueden tener organismos asignados';
const MSG_ORGANISMOS_NO_EXISTE = 'Alguno de los organismos no existe';
// HU #12169 — el rol es DATO, no una constante compilada. Mismo tratamiento que la compañía y el
// proveedor: el mensaje lo lee el admin en la pantalla, y el 400 sale antes de escribir nada.
const MSG_ROL_NO_ASIGNABLE = 'El rol no existe o está inactivo';

type AmbitoBody = {
    companiaId?: number | null;
    flitoProveedorSoatId?: string | null;
    organismosCodigos?: string[];
};

/**
 * HU #12088 — validación de ámbito por `tipoEnlace` (no por literales de rol).
 * Devuelve el mensaje 400 o null si el cuerpo cuadra con el enlace.
 */
function assertAmbitoSegunEnlace(tipoEnlace: string, body: AmbitoBody): string | null {
    const tieneCompania = body.companiaId != null;
    const tieneProveedor = body.flitoProveedorSoatId != null;
    const tieneOrgs = (body.organismosCodigos?.length ?? 0) > 0;
    switch (tipoEnlace) {
        case 'compania':
            if (tieneProveedor) return MSG_PROVEEDOR_SOBRA;
            if (tieneOrgs) return MSG_ORGANISMOS_SOBRAN;
            if (!tieneCompania) return MSG_COMPANIA_REQUERIDA;
            return null;
        case 'proveedor_soat':
            if (tieneCompania) return MSG_COMPANIA_SOBRA;
            if (tieneOrgs) return MSG_ORGANISMOS_SOBRAN;
            if (!tieneProveedor) return MSG_PROVEEDOR_REQUERIDO;
            return null;
        case 'organismos_transito':
            if (tieneCompania) return MSG_COMPANIA_SOBRA;
            if (tieneProveedor) return MSG_PROVEEDOR_SOBRA;
            if (!tieneOrgs) return MSG_ORGANISMOS_REQUERIDOS;
            return null;
        case 'ninguno':
        default:
            if (tieneCompania) return MSG_COMPANIA_SOBRA;
            if (tieneProveedor) return MSG_PROVEEDOR_SOBRA;
            if (tieneOrgs) return MSG_ORGANISMOS_SOBRAN;
            return null;
    }
}/**
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
    funciones: funcionesSchema,
    // HU #12088: sin literales de ámbito en Zod; la obligatoriedad vive en `assertAmbitoSegunEnlace`
    // tras `rolAsignable`. `transitoCodigo` ni siquiera entra al schema (warn+descartar en el handler).
    companiaId: companiaIdSchema,
    flitoProveedorSoatId: proveedorSoatIdSchema,
    organismosCodigos: organismosCodigosSchema,
});
const updateSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().max(150).optional().or(z.literal('').transform(() => null)).nullable(),
    role: codigoRolSchema.optional(),
    funciones: funcionesSchema,
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
    if (!consulta)
        return;
    const { filas, total } = await listarUsuarios(consulta.filtros, consulta.paginacion);
    // AC5: UNA consulta más para toda la página, agrupada por usuario. Una por fila sería N+1. HU #12087:
    // lo mismo para las excepciones (`funciones`), que el formulario de edición lee de la fila cargada.
    const ids = filas.map((u) => u.id);
    const porUsuario = await organismosDeVarios(ids);
    const funcionesPorUsuario = await funcionesDeVarios(ids);
    // `view`, no `export`: esto no genera ningún archivo. La descarga real es `/export`, y allí sí se
    // audita como `export` (HU #12172 — antes las dos cosas se registraban igual y el rastro mentía).
    await audit(req, { action: 'view', resource: 'user', detail: `Lista usuarios (${filas.length} de ${total})` });
    res.setHeader('X-Total-Count', String(total));
    res.json(filas.map((u) => ({
        ...u, organismosCodigos: porUsuario.get(u.id) ?? [], funciones: funcionesPorUsuario.get(u.id) ?? [],
    })));
});
// === Crear usuario ===========================================================
/**
 * HU #12084 (TC-32 #12466): los triggers de ámbito de la 0178 (`users_ambito_requerido` y el de
 * organismos) rechazan con `23514` un usuario cuyo rol exige compañía/proveedor/organismos y no la
 * trae. El handler por `tipoEnlace` (HU #12088) lo cubre en API; para un rol del catálogo con
 * `tipo_enlace` distinto de `ninguno` la última palabra la tiene la base, y su mensaje («El rol X
 * exige compañía y el usuario N no la tiene») es la respuesta: se devuelve tal cual, en 400, sin
 * inventar texto. `errorHandler` solo conoce el `23514` de la rúbrica; cualquier otro sería un 500.
 */
function ambitoRechazado(e: unknown): string | null {
    const pg = errorPg(e, '23514');
    return pg?.message ?? null;
}
router.post('/', exigirFuncion('usuarios.usuario.crear'), async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
        return;
    }
    const { username, name, email, password, role, funciones, companiaId, flitoProveedorSoatId, organismosCodigos, } = parsed.data;
    avisarAllowedPagesObsoleto(req, 'POST');
    avisarTransitoCodigoObsoleto(req, 'POST');
    // AC6: la pertenencia se pregunta al CATÁLOGO, no a una constante. Va lo primero porque un rol que
    // no existe no merece ni la consulta del username, y porque la FK `users_role_fkey` lo rechazaría
    // igual pero como un 23503 servido en un 500.
    const rol = await rolAsignable(role);
    if (!rol) {
        res.status(400).json({ error: MSG_ROL_NO_ASIGNABLE });
        return;
    }
    // HU #12088: ámbito por tipoEnlace — ANTES de username, para no escribir ni consultar de más.
    const errorAmbito = assertAmbitoSegunEnlace(rol.tipoEnlace, { companiaId, flitoProveedorSoatId, organismosCodigos });
    if (errorAmbito) {
        res.status(400).json({ error: errorAmbito });
        return;
    }
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0) {
        // AC6: 409 también si la fila está de baja (username no se libera). Mensaje sugiere reactivar
        // sin confirmar el estado (evita enumeración fina).
        res.status(409).json({ error: 'Username ya registrado. Si corresponde a un usuario dado de baja, use reactivar.' });
        return;
    }
    if (email) {
        const [porEmail] = await db.select({ id: users.id }).from(users)
            .where(sql`lower(${users.email}) = lower(${email})`).limit(1);
        if (porEmail) {
            res.status(409).json({ error: 'Email ya registrado. Si corresponde a un usuario dado de baja, use reactivar.' });
            return;
        }
    }
    if (rol.tipoEnlace === 'compania' && !(await companiaExiste(companiaId!))) {
        res.status(400).json({ error: MSG_COMPANIA_NO_EXISTE });
        return;
    }
    if (rol.tipoEnlace === 'proveedor_soat' && !(await proveedorSoatExiste(flitoProveedorSoatId!))) {
        res.status(400).json({ error: MSG_PROVEEDOR_NO_EXISTE });
        return;
    }
    if (rol.tipoEnlace === 'organismos_transito') {
        const faltan = await organismosInexistentes(organismosCodigos!);
        if (faltan.length > 0) {
            res.status(400).json({ error: `${MSG_ORGANISMOS_NO_EXISTE}: ${faltan.join(', ')}` });
            return;
        }
    }
    // HU #12087 (AC1): los códigos se comprueban ANTES de abrir la transacción, como `guardarCuadro`:
    // un 400 por función inexistente no escribe nada.
    if (funciones?.length) {
        const faltan = await funcionesInexistentes(funciones.map((f) => f.codigo));
        if (faltan.length > 0) {
            res.status(400).json({ error: 'Funciones inexistentes', funciones: faltan });
            return;
        }
    }
    const passwordHash = await argon2.hash(password);
    // Ámbito por tipoEnlace; `transitoCodigo` siempre null (fuente = puente, HU #12088).
    let user;
    try {
        user = await crearUsuario({
            username, name, email: email ?? null, passwordHash, role,
            funciones: funciones ?? [],
            transitoCodigo: null,
            companiaId: rol.tipoEnlace === 'compania' ? companiaId! : null,
            flitoProveedorSoatId: rol.tipoEnlace === 'proveedor_soat' ? flitoProveedorSoatId! : null,
            organismosCodigos: rol.tipoEnlace === 'organismos_transito' ? organismosCodigos! : [],
        }, actorDeRequest(req));
    }
    catch (e) {
        if (e instanceof FuncionesInexistentesError) {
            res.status(400).json({ error: e.message, funciones: e.funciones });
            return;
        }
        const ambito = ambitoRechazado(e);
        if (ambito) {
            res.status(400).json({ error: ambito });
            return;
        }
        throw e;
    }
    // Por simetría con la edición: un id nuevo no tiene entrada en la caché de permisos que borrar,
    // pero si la tuviera (ids reciclados en pruebas) sería una foto de otro usuario.
    invalidarPermisosDe(user.id);
    await audit(req, { action: 'create', resource: 'user', resourceId: String(user.id), detail: `Usuario creado: ${username} (${role})` });
    res.status(201).json(user);
});
// === Editar usuario (nombre, email, rol) =====================================
router.patch('/:id', exigirFuncion('usuarios.usuario.editar'), async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'ID inválido' });
        return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
        return;
    }
    const data = parsed.data;
    avisarAllowedPagesObsoleto(req, 'PATCH');
    avisarTransitoCodigoObsoleto(req, 'PATCH');
    const [before] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!before) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    // HU #12089: operaciones de escritura sobre baja → 404 (salvo reactivar).
    if (before.deletedAt) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    // AC6: SOLO si el cuerpo trae `role` se pregunta al catálogo. Editar nombre a un usuario cuyo
    // rol se desactivó no puede fallar por un campo que el admin no tocó.
    // HU #12088: si vienen campos de ámbito sin cambiar rol, sí hace falta el tipoEnlace del actual.
    const traeAmbito = data.companiaId !== undefined || data.flitoProveedorSoatId !== undefined
        || data.organismosCodigos !== undefined;
    let tipoEnlaceEfectivo: string | null = null;
    if (data.role !== undefined) {
        const rolNuevo = await rolAsignable(data.role);
        if (!rolNuevo) {
            res.status(400).json({ error: MSG_ROL_NO_ASIGNABLE });
            return;
        }
        tipoEnlaceEfectivo = rolNuevo.tipoEnlace;
    }
    else if (traeAmbito) {
        const rolActual = await rolAsignable(before.role);
        tipoEnlaceEfectivo = rolActual?.tipoEnlace ?? 'ninguno';
    }
    // Si se está degradando a un admin, asegurar que quede al menos otro admin activo.
    if (data.role && data.role !== 'admin' && before.role === 'admin') {
        const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users)
            .where(and(eq(users.role, 'admin'), eq(users.active, true), ne(users.id, id)));
        if (count === 0) {
            res.status(409).json({ error: 'No se puede cambiar el rol del último admin activo' });
            return;
        }
    }
    if (tipoEnlaceEfectivo !== null) {
        // Sobra: solo campos TRAÍDOS en el body que no corresponden al enlace destino.
        if (tipoEnlaceEfectivo !== 'compania' && data.companiaId != null) {
            res.status(400).json({ error: MSG_COMPANIA_SOBRA });
            return;
        }
        if (tipoEnlaceEfectivo !== 'proveedor_soat' && data.flitoProveedorSoatId != null) {
            res.status(400).json({ error: MSG_PROVEEDOR_SOBRA });
            return;
        }
        if (tipoEnlaceEfectivo !== 'organismos_transito' && (data.organismosCodigos?.length ?? 0) > 0) {
            res.status(400).json({ error: MSG_ORGANISMOS_SOBRAN });
            return;
        }
        // Requerido: valor efectivo (body ∪ estado previo / puente).
        if (tipoEnlaceEfectivo === 'compania') {
            const c = data.companiaId !== undefined ? data.companiaId : before.companiaId;
            if (c == null) {
                res.status(400).json({ error: MSG_COMPANIA_REQUERIDA });
                return;
            }
        }
        if (tipoEnlaceEfectivo === 'proveedor_soat') {
            const p = data.flitoProveedorSoatId !== undefined ? data.flitoProveedorSoatId : before.flitoProveedorSoatId;
            if (p == null) {
                res.status(400).json({ error: MSG_PROVEEDOR_REQUERIDO });
                return;
            }
        }
        if (tipoEnlaceEfectivo === 'organismos_transito') {
            const orgs = data.organismosCodigos !== undefined ? data.organismosCodigos : await organismosDe(id);
            if (orgs.length === 0) {
                res.status(400).json({ error: MSG_ORGANISMOS_REQUERIDOS });
                return;
            }
        }
    }
    if (data.companiaId && !(await companiaExiste(data.companiaId))) {
        res.status(400).json({ error: MSG_COMPANIA_NO_EXISTE });
        return;
    }
    if (data.flitoProveedorSoatId && !(await proveedorSoatExiste(data.flitoProveedorSoatId))) {
        res.status(400).json({ error: MSG_PROVEEDOR_NO_EXISTE });
        return;
    }
    if (data.organismosCodigos?.length) {
        const faltan = await organismosInexistentes(data.organismosCodigos);
        if (faltan.length > 0) {
            res.status(400).json({ error: `${MSG_ORGANISMOS_NO_EXISTE}: ${faltan.join(', ')}` });
            return;
        }
    }
    // HU #12087 (AC1): antes de la transacción, como en el alta. Un código inexistente → 400 sin escribir.
    if (data.funciones?.length) {
        const faltan = await funcionesInexistentes(data.funciones.map((f) => f.codigo));
        if (faltan.length > 0) {
            res.status(400).json({ error: 'Funciones inexistentes', funciones: faltan });
            return;
        }
    }
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined)
        updates.name = data.name;
    if (data.email !== undefined)
        updates.email = data.email;
    if (data.role !== undefined)
        updates.role = data.role;
    // HU #12088: columna obsoleta — NULL al cambiar de rol (create siempre manda null).
    // No meterla en updates al tocar solo organismos: inventaría un cambio de columna.
    if (data.role !== undefined) {
        updates.transitoCodigo = null;
    }
    if (data.companiaId !== undefined)
        updates.companiaId = data.companiaId;
    // Degradar desde compania le quita la compañía.
    if (data.role !== undefined && tipoEnlaceEfectivo !== 'compania' && data.companiaId === undefined) {
        updates.companiaId = null;
    }
    if (data.flitoProveedorSoatId !== undefined)
        updates.flitoProveedorSoatId = data.flitoProveedorSoatId;
    if (data.role !== undefined && tipoEnlaceEfectivo !== 'proveedor_soat' && data.flitoProveedorSoatId === undefined) {
        updates.flitoProveedorSoatId = null;
    }
    /**
     * Conjunto destino de organismos, o `null` para no tocarlo. Degradar desde organismos_transito
     * lo VACÍA (`[]`), por el mismo motivo que las otras dos ataduras.
     */
    const organismosDestino = data.organismosCodigos !== undefined
        ? data.organismosCodigos
        : (data.role !== undefined && tipoEnlaceEfectivo !== 'organismos_transito' ? [] : null);
    const invalidarPorCampos = data.role !== undefined
        || data.companiaId !== undefined
        || data.flitoProveedorSoatId !== undefined
        || data.organismosCodigos !== undefined;
    // HU #12084 (AC4): la guarda de «último admin» de arriba es el pre-check con mensaje claro; la
    // verdad la decide el invariante DENTRO de la transacción.
    let r;
    try {
        r = await actualizarUsuario(id, {
            updates, organismosDestino, funcionesDestino: data.funciones ?? null, invalidarPorCampos,
        }, actorDeRequest(req));
    }
    catch (e) {
        if (e instanceof BloqueoAdministracionError) {
            res.status(409).json({ error: e.message, funcion: e.funcion });
            return;
        }
        if (e instanceof FuncionesInexistentesError) {
            res.status(400).json({ error: e.message, funciones: e.funciones });
            return;
        }
        const ambito = ambitoRechazado(e);
        if (ambito) {
            res.status(400).json({ error: ambito });
            return;
        }
        throw e;
    }
    if (r.estado === 'sin_cambios') {
        res.status(400).json({ error: 'Sin cambios' });
        return;
    }
    if (r.estado === 'no_encontrado') {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    if (r.invalidada)
        invalidateSessionCacheFor(id);
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
    if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'ID inválido' });
        return;
    }
    // Guard 1: el admin no puede desactivarse a sí mismo (prevenir lock-out).
    if (id === req.user!.sub) {
        res.status(400).json({ error: 'No puede desactivarse a sí mismo' });
        return;
    }
    const [before] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!before) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    // HU #12089: no se suspende (toggle) a quien ya está de baja.
    if (before.deletedAt) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    // Guard 2: si va a desactivar a un admin activo, asegurar que quede al menos otro admin activo.
    if (before.active && before.role === 'admin') {
        const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users)
            .where(and(eq(users.role, 'admin'), eq(users.active, true), ne(users.id, id)));
        if (count === 0) {
            res.status(409).json({ error: 'No se puede desactivar al último admin activo' });
            return;
        }
    }
    // HU #12171: el `UPDATE` y su fila de historial (`active`, antes/después) van en una transacción
    // del servicio; el «antes» sale del propio UPDATE atómico, no del `before` de las guardas.
    let updated;
    try {
        updated = await cambiarActivo(id, actorDeRequest(req));
    }
    catch (e) {
        // HU #12084 (AC4): el invariante decide dentro de la transacción; el Guard 2 es el pre-check.
        if (e instanceof BloqueoAdministracionError) {
            res.status(409).json({ error: e.message, funcion: e.funcion });
            return;
        }
        throw e;
    }
    if (!updated) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
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
    if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'ID inválido' });
        return;
    }
    const [updated] = await db.update(users)
        .set({ sessionInvalidatedAt: new Date() })
        .where(and(eq(users.id, id), sql`${users.deletedAt} is null`))
        .returning({ id: users.id, username: users.username });
    if (!updated) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }
    invalidateSessionCacheFor(id);
    invalidarPermisosDe(id);
    await audit(req, { action: 'update', resource: 'user_session', resourceId: String(id), detail: 'Sesiones invalidadas manualmente' });
    res.json({ ok: true, user: updated });
});

// HU #12089: baja lógica (DELETE) y reactivación. Handlers en users-baja.ts (techo 800 líneas).
// Literales `exigirFuncion('…')` aquí: el lector de montajes de permisos lee este fichero.
router.delete('/:id', exigirFuncion('usuarios.usuario.baja'), handleDarDeBaja);
router.post('/:id/reactivar', exigirFuncion('usuarios.usuario.reactivar'), handleReactivar);

export default router;
