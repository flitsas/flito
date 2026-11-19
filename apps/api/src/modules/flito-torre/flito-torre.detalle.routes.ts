// Torre de Control Gerencial (Épica #14590, ADR-0047) — `/api/flito/torre/detalle`: los registros detrás de una cifra.
// Montado en `app.ts` ANTES de `/api/flito/torre` y SIN `conAlcance` (cerrado a todo enlace, como `/tableros`); el
// alcance llega por `alcanceDe(req)`.
//
// `POST /consultar` (body `ConsultaDetalle`): `torre.detalle.ver` + `torreConsultaLimiter`.
// `POST /exportar` (body `ExportarDetalle`): `torre.detalle.exportar` + `torre.detalle.ver` + `torreExportLimiter` (la de
// exportar va primero: es la que lee `inventario-guardas`, que toma la primera guarda de cada ruta).
// La placa del filtro viaja SOLO en el body (AGENTS §14). El acceso al conjunto exige además una de sus funciones de
// origen: se leen aquí con `tieneFuncion` y el código literal (lo lee `inventario-guardas`) y viajan al servicio.
// RN-TOR-D14 (Ley 1581, regla 16): toda petición válida cuyo detalle proyecta la placa se registra en `pii_access_log`
//   (`read` al consultar, `export` al exportar), aunque traiga 0 filas. Falla ABIERTO (bandeja de lectura): el fallo
//   queda en el log. Ni la ruta ni el servicio loguean el body ni `filtrosDetalle`.
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ExportarDetalle } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { torreConsultaLimiter, torreExportLimiter } from '../../shared/middleware/rateLimiter.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { exportarDetalle } from './flito-torre.detalle-export.js';
import {
  DetalleExcedeTopeError, DetalleSinDineroError, DetalleSinOrigenError, consultarDetalle, datosExportacion,
  proyectaPlaca, tablaPiiDe, type AccesoDetalle,
} from './flito-torre.detalle.service.js';
import { consultaDetalleSchema, detalleZod, exportarDetalleSchema } from './flito-torre.esquemas.js';
import { errorTorreAHttp } from './flito-torre.routes.js';

const router = Router();
router.use(authMiddleware);

async function acceso(req: Request): Promise<AccesoDetalle> {
  const [alcance, dinero, ejecutivo, comercial, operativo, financiero, metricas, productos] = await Promise.all([
    alcanceDe(req),
    tieneFuncion(req, 'torre.metricas.dinero'),
    tieneFuncion(req, 'torre.tablero_ejecutivo.ver'),
    tieneFuncion(req, 'torre.tablero_comercial.ver'),
    tieneFuncion(req, 'torre.tablero_operativo.ver'),
    tieneFuncion(req, 'torre.tablero_financiero.ver'),
    tieneFuncion(req, 'torre.metricas.consultar'),
    tieneFuncion(req, 'torre.tablero_productos.ver'),
  ]);
  const funciones = new Set<string>();
  if (ejecutivo) funciones.add('torre.tablero_ejecutivo.ver');
  if (comercial) funciones.add('torre.tablero_comercial.ver');
  if (operativo) funciones.add('torre.tablero_operativo.ver');
  if (financiero) funciones.add('torre.tablero_financiero.ver');
  if (metricas) funciones.add('torre.metricas.consultar');
  if (productos) funciones.add('torre.tablero_productos.ver');
  return { alcance, dinero, funciones };
}

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof DetalleSinOrigenError || e instanceof DetalleSinDineroError) { res.status(403).json({ error: e.message, code: e.code }); return; }
  if (e instanceof DetalleExcedeTopeError) { res.status(422).json({ error: e.message, code: e.code }); return; }
  if (errorTorreAHttp(e, res)) return;
  next(e);
}

const registrarPlaca = (req: Request, c: ExportarDetalle, accion: 'read' | 'export'): Promise<void> => {
  if (!proyectaPlaca(c)) return Promise.resolve();
  const que = c.origen.tipo === 'conjunto' ? c.origen.conjunto : c.origen.metrica;
  return logPiiAccess(req, { resourceTipo: tablaPiiDe(c), accion, camposAccedidos: ['placa'], motivo: `Torre de Control: detalle ${que}` });
};

router.post('/consultar', exigirFuncion('torre.detalle.ver'), torreConsultaLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = consultaDetalleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: `Datos inválidos: ${detalleZod(parsed.error)}`, code: 'DATOS_INVALIDOS' }); return; }
  try {
    const r = await consultarDetalle(parsed.data, await acceso(req));
    await registrarPlaca(req, parsed.data, 'read');
    res.setHeader('Cache-Control', 'no-store');
    res.json(r);
  } catch (e) { manejar(e, res, next); }
});

router.post('/exportar', exigirFuncion('torre.detalle.exportar'), exigirFuncion('torre.detalle.ver'), torreExportLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = exportarDetalleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: `Datos inválidos: ${detalleZod(parsed.error)}`, code: 'DATOS_INVALIDOS' }); return; }
  try {
    const datos = await datosExportacion(parsed.data, await acceso(req));
    await registrarPlaca(req, parsed.data, 'export');
    await exportarDetalle(res, datos, parsed.data.filtro);
  } catch (e) { manejar(e, res, next); }
});

export default router;
