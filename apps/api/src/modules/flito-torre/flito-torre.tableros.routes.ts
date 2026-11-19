// Torre de Control Gerencial (Épica #14590) — `/api/flito/torre/tableros`: los cuatro tableros (ejecutivo o 360°,
// comercial, operativo y financiero). POST con `{ filtro: FiltroTorre }` en el body: los filtros pueden llevar
// compañías y organismos, que no van en la URL (AGENTS §14). Mismo montaje que `flito-torre.routes.ts` (SIN
// `conAlcance`: cerrado a todo enlace). Cada ruta exige la función de SU tablero, así que tener uno no abre otro.
// Sin permiso de dinero (`torre.metricas.dinero` = `FUNCION_TORRE_DINERO`) el tablero responde igual, con los campos de dinero en `null`.
// `POST /<tablero>/exportar` (body = `FiltroTorre`): la función de ESE tablero + `torre.metricas.exportar`, con
// `torreExportLimiter` detrás; Excel de una hoja por bloque (`flito-torre.tablero-export.ts`). Rutas literales, una
// por tablero, para que `inventario-guardas` lea el código de cada guarda; otro `:tablero` no existe (404).
// B2: `POST /operativa/inventario` (body `{ filtro, organismo? }`) y `POST /operativa/soportes` (body `{ filtro }`), con
// la función del tablero Operativo: son sus pestañas «Inventario por estado» y «Soportes» (solo conteos, sin PII).
// B3: `POST /productos` (+ `/productos/exportar`), con `torre.tablero_productos.ver`: el área Productos (SOAT ·
// Impuestos · Derechos), solo conteos y sumas (sin PII); la lista de cada cifra va por el detalle universal.
// B4: `POST /logistica` (+ `/logistica/exportar`), con `torre.tablero_logistica.ver`: el área Logística (Traslados ·
// Entregas, un tablero por pestañas como Productos). Financiera gana dos subvistas con SU función (`torre.tablero_financiero.ver`):
// `POST /financiera/facturacion` y `POST /financiera/bolsas` (+ `/exportar` de cada una). Van como rutas aparte y no
// dentro de `/financiera` porque el Resumen lo reusa el 360° y cada pestaña carga y falla por su cuenta (UX B4 §0).
// B5: `POST /operativa/equipo` (body `{ filtro }`), con `torre.equipo.ver` (solo gerencia_general y admin): la pestaña
// Equipo de Operativa. SIN `/exportar` en v1 (UX B5: es información de desempeño de personas; cada detalle exporta su
// lista con las reglas de siempre). Del funcionario solo viaja el nombre.
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { torreExportLimiter } from '../../shared/middleware/rateLimiter.js';
import { tableroBolsas } from './flito-torre.bolsas.service.js';
import { tableroComercial } from './flito-torre.comercial.service.js';
import { tableroEquipo } from './flito-torre.equipo.service.js';
import { tableroFacturacion } from './flito-torre.facturacion.service.js';
import { tableroEjecutivo } from './flito-torre.ejecutivo.service.js';
import { detalleZod, inventarioSchema, tableroSchema } from './flito-torre.esquemas.js';
import { tableroFinanciero } from './flito-torre.financiera.service.js';
import { inventarioEstado, soportesFaltantes } from './flito-torre.inventario.service.js';
import { tableroLogistica } from './flito-torre.logistica.service.js';
import { tableroOperativo } from './flito-torre.operativa.service.js';
import { tableroProductos } from './flito-torre.productos.service.js';
import { errorTorreAHttp } from './flito-torre.routes.js';
import type { ContextoTablero } from './flito-torre.tablero-comun.js';
import { exportarTablero, type TableroExportable } from './flito-torre.tablero-export.js';

const router = Router();
router.use(authMiddleware);

/** El body validado: `{ filtro }` en los tableros; el inventario añade `organismo` (B2). */
type CuerpoTablero = z.infer<typeof inventarioSchema>;

function tablero(calcular: (ctx: ContextoTablero, cuerpo: CuerpoTablero) => Promise<unknown>, esquema: typeof tableroSchema | typeof inventarioSchema = tableroSchema) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = esquema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: `Datos inválidos: ${detalleZod(parsed.error)}`, code: 'DATOS_INVALIDOS' }); return; }
    try {
      const [alcance, dinero] = await Promise.all([alcanceDe(req), tieneFuncion(req, 'torre.metricas.dinero')]);
      const r = await calcular({ filtro: parsed.data.filtro, alcance, dinero }, parsed.data);
      res.setHeader('Cache-Control', 'no-store');
      res.json(r);
    } catch (e) {
      if (errorTorreAHttp(e, res)) return;
      next(e);
    }
  };
}

function exportar(tablero: TableroExportable) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = tableroSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: `Datos inválidos: ${detalleZod(parsed.error)}`, code: 'DATOS_INVALIDOS' }); return; }
    try {
      const [alcance, dinero] = await Promise.all([alcanceDe(req), tieneFuncion(req, 'torre.metricas.dinero')]);
      await exportarTablero(res, tablero, { filtro: parsed.data.filtro, alcance, dinero });
    } catch (e) {
      if (errorTorreAHttp(e, res)) return;
      next(e);
    }
  };
}

router.post('/ejecutivo', exigirFuncion('torre.tablero_ejecutivo.ver'), tablero(tableroEjecutivo));
router.post('/comercial', exigirFuncion('torre.tablero_comercial.ver'), tablero(tableroComercial));
router.post('/operativa', exigirFuncion('torre.tablero_operativo.ver'), tablero(tableroOperativo));
router.post('/financiera', exigirFuncion('torre.tablero_financiero.ver'), tablero(tableroFinanciero));
router.post('/operativa/inventario', exigirFuncion('torre.tablero_operativo.ver'), tablero((ctx, c) => inventarioEstado(ctx, c.organismo ?? null), inventarioSchema));
router.post('/operativa/soportes', exigirFuncion('torre.tablero_operativo.ver'), tablero(soportesFaltantes));
router.post('/operativa/equipo', exigirFuncion('torre.equipo.ver'), tablero(tableroEquipo));
router.post('/productos', exigirFuncion('torre.tablero_productos.ver'), tablero(tableroProductos));
router.post('/logistica', exigirFuncion('torre.tablero_logistica.ver'), tablero(tableroLogistica));
router.post('/financiera/facturacion', exigirFuncion('torre.tablero_financiero.ver'), tablero(tableroFacturacion));
router.post('/financiera/bolsas', exigirFuncion('torre.tablero_financiero.ver'), tablero(tableroBolsas));

router.post('/ejecutivo/exportar', exigirFuncion('torre.tablero_ejecutivo.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('ejecutivo'));
router.post('/comercial/exportar', exigirFuncion('torre.tablero_comercial.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('comercial'));
router.post('/operativa/exportar', exigirFuncion('torre.tablero_operativo.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('operativa'));
router.post('/financiera/exportar', exigirFuncion('torre.tablero_financiero.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('financiera'));
router.post('/productos/exportar', exigirFuncion('torre.tablero_productos.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('productos'));
router.post('/logistica/exportar', exigirFuncion('torre.tablero_logistica.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('logistica'));
router.post('/financiera/facturacion/exportar', exigirFuncion('torre.tablero_financiero.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('facturacion'));
router.post('/financiera/bolsas/exportar', exigirFuncion('torre.tablero_financiero.ver'), exigirFuncion('torre.metricas.exportar'), torreExportLimiter, exportar('bolsas'));

export default router;
