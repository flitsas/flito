// HU #12081 — Lectura del catálogo de funciones (AC5). Montado en /api/permisos.
// HU #12082 — `GET /mios`: el conjunto efectivo del PROPIO usuario, ya resuelto (AC7).
//
// Solo LECTURA, y a propósito: `permisos_funciones` la declara el producto y la siembra la migración
// (CF-23). No hay POST, ni PATCH, ni DELETE porque el administrador reparte funciones, no las crea;
// lo que sí edita —qué concede cada rol— es la HU #12084 y va en otra ruta.
import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { resolverPermisos } from '../../shared/permisos-efectivos.js';
import { catalogoAgrupado } from './permisos.service.js';

const router = Router();
router.use(authMiddleware);

// La guarda de administración. Sigue siendo un `requireRole` cableado: el motor ya existe (HU #12082,
// `exigirFuncion`), pero montarlo en las rutas de producto —esta incluida— es la HU #12083.
const ADMINISTRACION = requireRole('admin');

/** GET /funciones — el catálogo agrupado por módulo. Solo administración. */
router.get('/funciones', ADMINISTRACION, async (_req: Request, res: Response) => {
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

export default router;
