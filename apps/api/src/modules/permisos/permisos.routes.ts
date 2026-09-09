// HU #12081 — Lectura del catálogo de funciones (AC5). Montado en /api/permisos.
//
// Solo LECTURA, y a propósito: `permisos_funciones` la declara el producto y la siembra la migración
// (CF-23). No hay POST, ni PATCH, ni DELETE porque el administrador reparte funciones, no las crea;
// lo que sí edita —qué concede cada rol— es la HU #12082 y va en otra ruta.
import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { catalogoAgrupado } from './permisos.service.js';

const router = Router();
router.use(authMiddleware);

// La guarda de administración. Sigue siendo un `requireRole` cableado y no una función del catálogo:
// cambiar las guardas por el catálogo es la HU #12082, y hacerlo aquí antes de tiempo dejaría esta
// ruta dependiendo de un motor que todavía no existe.
const ADMINISTRACION = requireRole('admin');

/** GET / — el catálogo agrupado por módulo. */
router.get('/funciones', ADMINISTRACION, async (_req: Request, res: Response) => {
  res.json({ grupos: await catalogoAgrupado() });
});

export default router;
