// Vistas de columnas persistidas (ADR-0043). Montado en /api/flito/vistas-columnas.
//
// Guardas (ADR-0025, ADR-0043 §Guardas):
//   · authMiddleware en todo el router.
//   · Acceso a la tabla: la función que dice el catálogo (`tramites.cola.ver` para flito-tramites),
//     aplicada por `guardaTabla` con `exigirFuncion`. Un tablaId desconocido responde 404.
//   · Columnas: `funcionesConcedidas` decide qué claves puede ver/guardar el usuario (RN-VC2, RN-VC3).
//   · Vistas compartidas y predeterminada general: solo rol `admin` (`requireRole('admin')` en la ruta
//     de la general; en las compartidas, el mismo rol decide en el servicio, porque el alcance viene en
//     el cuerpo y la ruta es la misma).
//
// Auditoría: POST, PUT, DELETE y los dos PUT de predeterminada van por `audit()`. Solo CLAVES de columna
// y ids; nunca el nombre de la vista ni valores de datos del titular (RN-VC10).
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { exigirFuncion, funcionesConcedidas } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  obtenerTablaVistas, funcionesDeColumnas, type TablaVistas,
} from './flito-vistas-columnas.catalogo.js';
import {
  actualizarVista, borrarVista, crearVista, fijarPredeterminadaGeneral, fijarPredeterminadaPersonal,
  listarVistas, VistasColumnasError, type ActorVistas,
} from './flito-vistas-columnas.service.js';
import {
  actualizarVistaSchema, crearVistaSchema, predeterminadaSchema, vistaIdParamSchema,
} from './flito-vistas-columnas.schemas.js';

const router = Router();
router.use(authMiddleware);

const RECURSO = 'flito_vistas_columnas';
const RECURSO_PREF = 'flito_vistas_columnas_preferencias';

/** Resuelve la tabla de la ruta y aplica su permiso de acceso. Sin tabla → 404; sin permiso → lo dice exigirFuncion. */
function guardaTabla(req: Request, res: Response, next: NextFunction): void {
  const tabla = obtenerTablaVistas(String(req.params.tablaId ?? ''));
  if (!tabla) {
    res.status(404).json({ error: 'Tabla no encontrada', codigo: 'TABLA_NO_ENCONTRADA' });
    return;
  }
  res.locals.tabla = tabla;
  const guarda: RequestHandler = exigirFuncion(tabla.funcionAcceso);
  guarda(req, res, next);
}

const tablaDe = (res: Response): TablaVistas => res.locals.tabla as TablaVistas;

async function actorDe(req: Request): Promise<ActorVistas> {
  const user = req.user!;
  return { userId: Number(user.sub), esAdmin: user.role === 'admin' };
}

/** Claves que el usuario puede ver en esta tabla (una sola consulta de permisos). */
async function permitidasDe(req: Request, tabla: TablaVistas): Promise<ReadonlySet<string>> {
  return funcionesConcedidas(req, funcionesDeColumnas(tabla));
}

/** Envoltorio: errores de dominio → su HTTP; cualquier otro sigue al manejador global. */
function envolver(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof VistasColumnasError) {
        res.status(e.status).json({ error: e.message, codigo: e.codigo });
        return;
      }
      next(e);
    });
  };
}

const invalido = (res: Response): void => { res.status(400).json({ error: 'Datos inválidos' }); };

// GET /:tablaId — columnas disponibles, vista activa, sistema, vistas visibles.
router.get('/:tablaId', guardaTabla, envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const respuesta = await listarVistas(tabla, await actorDe(req), await permitidasDe(req, tabla));
  res.json(respuesta);
}));

// POST /:tablaId/vistas — crea vista personal (cualquiera con acceso) o compartida (admin).
router.post('/:tablaId/vistas', guardaTabla, envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const cuerpo = crearVistaSchema.safeParse(req.body);
  if (!cuerpo.success) return invalido(res);
  const actor = await actorDe(req);
  const creada = await crearVista(tabla, actor, await permitidasDe(req, tabla), cuerpo.data);
  audit(req, {
    action: 'create', resource: RECURSO, resourceId: String(creada.id),
    detail: `tabla=${tabla.tablaId}; alcance=${cuerpo.data.alcance}; columnas=${cuerpo.data.columnas.join(',')}`,
  });
  res.status(201).json(creada);
}));

// PUT /:tablaId/vistas/:vistaId — nombre y/o columnas, con control de versión.
router.put('/:tablaId/vistas/:vistaId', guardaTabla, envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const vistaId = vistaIdParamSchema.safeParse(req.params.vistaId);
  const cuerpo = actualizarVistaSchema.safeParse(req.body);
  if (!vistaId.success || !cuerpo.success) return invalido(res);
  const actualizada = await actualizarVista(
    tabla, await actorDe(req), await permitidasDe(req, tabla), vistaId.data, cuerpo.data,
  );
  audit(req, {
    action: 'update', resource: RECURSO, resourceId: String(vistaId.data),
    detail: `tabla=${tabla.tablaId}${cuerpo.data.columnas ? `; columnas=${cuerpo.data.columnas.join(',')}` : ''}`,
  });
  res.json(actualizada);
}));

// DELETE /:tablaId/vistas/:vistaId — los punteros que la usaban caen a su siguiente nivel (RN-VC7).
router.delete('/:tablaId/vistas/:vistaId', guardaTabla, envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const vistaId = vistaIdParamSchema.safeParse(req.params.vistaId);
  if (!vistaId.success) return invalido(res);
  await borrarVista(tabla, await actorDe(req), vistaId.data);
  audit(req, { action: 'delete', resource: RECURSO, resourceId: String(vistaId.data), detail: `tabla=${tabla.tablaId}` });
  res.status(204).end();
}));

// PUT /:tablaId/predeterminada/personal — `null` = restablecer (vista del sistema).
router.put('/:tablaId/predeterminada/personal', guardaTabla, envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const cuerpo = predeterminadaSchema.safeParse(req.body);
  if (!cuerpo.success) return invalido(res);
  await fijarPredeterminadaPersonal(tabla, await actorDe(req), cuerpo.data.vistaId);
  audit(req, {
    action: 'update', resource: RECURSO_PREF,
    detail: `tabla=${tabla.tablaId}; ambito=personal; ${cuerpo.data.vistaId === null ? 'restablecer' : 'vista'}`,
  });
  res.json({ vistaId: cuerpo.data.vistaId });
}));

// PUT /:tablaId/predeterminada/general — solo admin. `null` = quitar la general.
router.put('/:tablaId/predeterminada/general', guardaTabla, requireRole('admin'), envolver(async (req, res) => {
  const tabla = tablaDe(res);
  const cuerpo = predeterminadaSchema.safeParse(req.body);
  if (!cuerpo.success) return invalido(res);
  await fijarPredeterminadaGeneral(tabla, await actorDe(req), cuerpo.data.vistaId);
  audit(req, {
    action: 'update', resource: RECURSO_PREF,
    detail: `tabla=${tabla.tablaId}; ambito=general; ${cuerpo.data.vistaId === null ? 'quitar' : 'vista'}`,
  });
  res.json({ vistaId: cuerpo.data.vistaId });
}));

export default router;
