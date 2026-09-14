// HU #12081 — Lectura del catálogo de funciones (AC5). Montado en /api/permisos.
// HU #12082 — `GET /mios`: el conjunto efectivo del PROPIO usuario, ya resuelto (AC7).
// HU #12084 — Mantenimiento de roles (CF-03/04/05) y el cuadro rol × función (CF-02).
//
// El catálogo de FUNCIONES sigue siendo de solo lectura: `permisos_funciones` la declara el producto y
// la siembra la migración (CF-23). Lo que el administrador edita son los ROLES y qué concede cada uno.
//
// Cada ruta lleva su `exigirFuncion('<literal>')` (ADR-0016 §2: a nivel de ruta, nunca de router).
// Errores de forma → 400 con `details` de Zod; errores de dominio → clases del servicio mapeadas aquí.
// La invalidación de la caché del motor (`invalidarPermisosDeRol`) va SIEMPRE después del commit.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { TIPOS_ENLACE, TIPOS_PRINCIPALES } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { invalidarPermisosDeRol, resolverPermisos } from '../../shared/permisos-efectivos.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { catalogoAgrupado } from './permisos.service.js';
import {
  CodigoReservadoError, FuncionesInexistentesError, RolConflictoError, RolNoEncontradoError,
  borrarRol, crearRol, cuadroDe, editarRol, guardarCuadro, listarRoles,
} from './permisos-roles.service.js';

const router = Router();
router.use(authMiddleware);

/** GET /funciones — el catálogo agrupado por módulo. */
router.get('/funciones', exigirFuncion('permisos.catalogo.ver'), async (_req: Request, res: Response) => {
  res.json({ grupos: await catalogoAgrupado() });
});

/**
 * GET /mios — lo que ESTE usuario puede, tal cual lo usa el servidor: el mismo resolutor, la misma
 * foto cacheada, sin recalcular la regla aquí. Sin guarda de permiso a propósito: cualquier
 * autenticado ve SU conjunto y solo el suyo (la query se ignora: `?userId=8` no existe para esta
 * ruta). Entra en `RUTAS_PERMITIDAS_CLIENTE` para que el canal externo también tenga menú.
 *
 * `version` es el hash del conjunto: cambia cuando cambia lo que este usuario puede, y es lo que la
 * pantalla compara para saber si refrescar. `resueltoEn` dice cuán vieja es la foto (≤ 60 s).
 *
 * 503 y no 403 si el resolutor no pudo leer: no es una decisión de permiso, es una lectura que
 * falló, y a la SPA le sirve más un «reintenta» que un 403 que la haría cerrar el menú.
 */
router.get('/mios', async (req: Request, res: Response) => {
  const p = await resolverPermisos(req.user!.sub);
  if (!p.ok) { res.status(503).json({ error: 'No se pudieron resolver los permisos' }); return; }
  res.json({
    funciones: [...p.funciones].sort(),
    rol: p.rol,
    tipoPrincipal: p.tipoPrincipal,
    version: p.version,
    resueltoEn: p.resueltoEn.toISOString(),
  });
});

// ── Roles (HU #12084) ───────────────────────────────────────────────────────────────────────────

const codigoRol = z.string().regex(/^[a-z0-9_]+$/).max(40);
const listaFunciones = z.array(z.string().max(80)).max(1000);

const crearSchema = z.object({
  codigo: codigoRol,
  nombre: z.string().trim().min(1).max(80),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  tipoEnlace: z.enum(TIPOS_ENLACE),
  // Sin default, a propósito (AC1): equivocarse por omisión abre la superficie interna a un rol de cliente.
  tipoPrincipal: z.enum(TIPOS_PRINCIPALES),
  funciones: listaFunciones.default([]),
});

// `.strict()`: `codigo` (ADR-0015 §1), `esSistema` (el candado) y `funciones` (otra ruta) → 400.
const editarSchema = z.object({
  nombre: z.string().trim().min(1).max(80).optional(),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  tipoEnlace: z.enum(TIPOS_ENLACE).optional(),
  tipoPrincipal: z.enum(TIPOS_PRINCIPALES).optional(),
  activo: z.boolean().optional(),
}).strict();

const cuadroSchema = z.object({ funciones: listaFunciones });

/** Los errores de dominio del servicio, a su código HTTP. Devuelve `false` si no era uno de ellos. */
function responderErrorDeDominio(res: Response, e: unknown): boolean {
  if (e instanceof RolNoEncontradoError) { res.status(404).json({ error: e.message }); return true; }
  if (e instanceof RolConflictoError) {
    res.status(409).json({ error: e.message, ...(e.usuarios !== undefined ? { usuarios: e.usuarios } : {}) });
    return true;
  }
  if (e instanceof BloqueoAdministracionError) { res.status(409).json({ error: e.message, funcion: e.funcion }); return true; }
  if (e instanceof FuncionesInexistentesError) { res.status(400).json({ error: e.message, funciones: e.funciones }); return true; }
  if (e instanceof CodigoReservadoError) { res.status(400).json({ error: e.message }); return true; }
  return false;
}

function codigoDeRuta(req: Request, res: Response): string | null {
  const parsed = codigoRol.safeParse(req.params.codigo);
  if (!parsed.success) { res.status(400).json({ error: 'Código de rol inválido' }); return null; }
  return parsed.data;
}

/** GET /roles — todos, con conteo de usuarios y si se pueden borrar. Sin PII: ni un nombre viaja. */
router.get('/roles', exigirFuncion('permisos.rol.listar'), async (_req: Request, res: Response) => {
  res.json({ roles: await listarRoles() });
});

/** POST /roles — CF-03. 201 con el rol; 409 duplicado; 400 funciones inexistentes o código reservado. */
router.post('/roles', exigirFuncion('permisos.rol.crear'), async (req: Request, res: Response) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const rol = await crearRol(parsed.data, actorDeRequest(req));
    res.status(201).json({ rol });
  } catch (e) {
    if (!responderErrorDeDominio(res, e)) throw e;
  }
});

/** PATCH /roles/:codigo — CF-04. `codigo` nunca; el resto según la tabla de §2.3 del diseño. */
router.patch('/roles/:codigo', exigirFuncion('permisos.rol.editar'), async (req: Request, res: Response) => {
  const codigo = codigoDeRuta(req, res);
  if (codigo === null) return;
  const parsed = editarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const r = await editarRol(codigo, parsed.data, actorDeRequest(req));
    if (r.estado === 'sin_cambios') { res.status(400).json({ error: 'Sin cambios' }); return; }
    // Después del commit. Siempre que hubo cambios: el resolutor solo lee `tipo_principal`, pero un
    // `if` que alguien olvide cuesta más que un recorrido de la caché.
    invalidarPermisosDeRol(codigo);
    res.json({ rol: r.rol });
  } catch (e) {
    if (!responderErrorDeDominio(res, e)) throw e;
  }
});

/** DELETE /roles/:codigo — CF-05 / RN-A8. 204; 409 «rol del sistema» o «N usuarios…». */
router.delete('/roles/:codigo', exigirFuncion('permisos.rol.borrar'), async (req: Request, res: Response) => {
  const codigo = codigoDeRuta(req, res);
  if (codigo === null) return;
  try {
    await borrarRol(codigo, actorDeRequest(req));
    // No hay usuarios, pero la caché puede tener entradas de un usuario reasignado hace < 60 s.
    invalidarPermisosDeRol(codigo);
    res.status(204).end();
  } catch (e) {
    if (!responderErrorDeDominio(res, e)) throw e;
  }
});

/** GET /roles/:codigo/funciones — CF-02: el cuadro, ordenado por código. */
router.get('/roles/:codigo/funciones', exigirFuncion('permisos.cuadro.ver'), async (req: Request, res: Response) => {
  const codigo = codigoDeRuta(req, res);
  if (codigo === null) return;
  try {
    res.json(await cuadroDe(codigo));
  } catch (e) {
    if (!responderErrorDeDominio(res, e)) throw e;
  }
});

/**
 * PUT /roles/:codigo/funciones — CF-02 / RN-A1. El conjunto COMPLETO: se reescribe, no se suma.
 * 400 con la lista de inexistentes; 409 del invariante; `aviso` si el rol es externo y hay funciones
 * fuera de su canal. No cierra sesiones (decisión del 10/09): invalida la caché del rol y aplica en
 * la siguiente petición de cada usuario.
 */
router.put('/roles/:codigo/funciones', exigirFuncion('permisos.cuadro.guardar'), async (req: Request, res: Response) => {
  const codigo = codigoDeRuta(req, res);
  if (codigo === null) return;
  const parsed = cuadroSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const r = await guardarCuadro(codigo, parsed.data.funciones, actorDeRequest(req));
    invalidarPermisosDeRol(codigo);
    res.json(r);
  } catch (e) {
    if (!responderErrorDeDominio(res, e)) throw e;
  }
});

export default router;
