// Torre de Control Gerencial (Épica #14590) — `/api/flito/torre`: Explorador de métricas, ficha de placa y umbrales.
// Montado en `app.ts` SIN `conAlcance`: `guardiaFrontera` da 403 a todo enlace distinto de `ninguno` aunque su rol
// tenga la función (la Torre es de la operación y de la gerencia, nunca de un cliente, proveedor u organismo).
// Los tableros viven en `flito-torre.tableros.routes.ts` (`/api/flito/torre/tableros`).
//
// Cada ruta lleva su `exigirFuncion` con el código literal (lo lee `inventario-guardas`), nunca `router.use`.
// Consultar, exportar y placa llevan `rateLimiter` DETRÁS de la función. Placa va por body (cuasi-PII, AGENTS §14).
// Consultar y exportar usan el motor (`flito-torre.metricas.service.ts`); el permiso de dinero se lee aquí con
// `tieneFuncion('torre.metricas.dinero')` (literal: lo lee el inventario de guardas) y viaja al motor. Placa: `logPiiAccess` (search, campo placa) en TODA búsqueda,
// encontrada o no, y el mismo 404 para «no existe» y «fuera de alcance». Exportar a PDF sigue en 501.
// `POST /placa/sugerencias` (ADR-0044 D4/D8, RN-TOR-P5/P6): texto parcial en el body, `torre.placa.buscar` (la misma
// función de la ficha: sin permiso nuevo), limiter propio de 60/min, `logPiiAccess` en toda petición válida, `no-store`
// y lista vacía = 200. La ruta queda completa en el contract-first; `sugerirPlacas()` responde 501 hasta el bloque (ii).
// `GET /opciones`: opciones de la barra de filtros con el alcance del motor; exige `torre.metricas.consultar`, que la
// 0303 da a los cinco roles de la Torre (`REPARTO_TORRE`: todos llevan `accion.torre_explorador.consultar`).
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { CLAVES_UMBRAL_TORRE, UMBRAL_TORRE_VALOR_MAX } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import {
  torreConsultaLimiter, torreExportLimiter, torrePlacaLimiter, torrePlacaSugerirLimiter,
} from '../../shared/middleware/rateLimiter.js';
import {
  buscarPlacaSchema, consultaMetricaSchema, detalleZod, exportarMetricaSchema, sugerirPlacaSchema,
} from './flito-torre.esquemas.js';
import { exportarMetrica } from './flito-torre.export.js';
import { RangoTorreExcedidoError } from './flito-torre.filtro.js';
import { TorreConsultaError, TorreDineroDenegadoError, consultarMetrica } from './flito-torre.metricas.service.js';
import { opcionesFiltroTorre } from './flito-torre.opciones.service.js';
import { PlacaTorreNoEncontradaError, buscarPlaca, sugerirPlacas } from './flito-torre.placa.service.js';
import { TorreNoImplementadoError, noImplementado } from './flito-torre.service.js';
import {
  UmbralTorreFueraDeRangoError, UmbralTorreNoEncontradoError, actualizarUmbral, errorDeRangoUmbral, listarUmbrales,
  unidadDeUmbral,
} from './flito-torre.umbrales.service.js';

const router = Router();
router.use(authMiddleware);

const claveUmbralSchema = z.enum(CLAVES_UMBRAL_TORRE);
const editarUmbralSchema = z.object({
  valor: z.number({ error: 'debe ser un número' }).nonnegative('no puede ser negativo')
    .max(UMBRAL_TORRE_VALOR_MAX, 'supera el máximo admitido')
    .refine((n) => Math.round(n * 100) / 100 === n, 'admite a lo sumo dos decimales'),
}).strict();

const invalido = (res: Response, e: z.ZodError): void => {
  res.status(400).json({ error: `Datos inválidos: ${detalleZod(e)}`, code: 'DATOS_INVALIDOS' });
};

/** Errores de dominio de la Torre → HTTP (compartido con `flito-torre.tableros.routes.ts`). */
export function errorTorreAHttp(e: unknown, res: Response): boolean {
  if (e instanceof TorreNoImplementadoError) { res.status(501).json({ error: e.message, code: e.code }); return true; }
  if (e instanceof RangoTorreExcedidoError) { res.status(400).json({ error: e.message, code: e.code, campo: 'rango' }); return true; }
  if (e instanceof TorreDineroDenegadoError) { res.status(403).json({ error: e.message, code: e.code }); return true; }
  if (e instanceof TorreConsultaError) { res.status(e.status).json({ error: e.message, code: e.code }); return true; }
  return false;
}

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (errorTorreAHttp(e, res)) return;
  if (e instanceof PlacaTorreNoEncontradaError) { res.status(404).json({ error: e.message, code: e.code }); return; }
  if (e instanceof UmbralTorreNoEncontradoError) { res.status(404).json({ error: e.message, code: e.code }); return; }
  if (e instanceof UmbralTorreFueraDeRangoError) { res.status(400).json({ error: e.message, code: e.code, campo: 'valor' }); return; }
  next(e);
}

router.post('/metricas/consultar', exigirFuncion('torre.metricas.consultar'), torreConsultaLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = consultaMetricaSchema.safeParse(req.body);
  if (!parsed.success) { invalido(res, parsed.error); return; }
  try {
    const [alcance, dinero] = await Promise.all([alcanceDe(req), tieneFuncion(req, 'torre.metricas.dinero')]);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await consultarMetrica(parsed.data, alcance, { dinero }));
  } catch (e) { manejar(e, res, next); }
});

router.post('/metricas/exportar', exigirFuncion('torre.metricas.exportar'), torreExportLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = exportarMetricaSchema.safeParse(req.body);
  if (!parsed.success) { invalido(res, parsed.error); return; }
  try {
    if (parsed.data.formato === 'pdf') noImplementado('Exportar a PDF');
    const [alcance, dinero] = await Promise.all([alcanceDe(req), tieneFuncion(req, 'torre.metricas.dinero')]);
    await exportarMetrica(res, parsed.data.consulta, alcance, { dinero });
  } catch (e) { manejar(e, res, next); }
});

router.post('/placa/buscar', exigirFuncion('torre.placa.buscar'), torrePlacaLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = buscarPlacaSchema.safeParse(req.body);
  if (!parsed.success) { invalido(res, parsed.error); return; }
  try {
    const alcance = await alcanceDe(req);
    // RN-TOR-P2/§16: se registra toda búsqueda (también la que no encuentra); el log no lleva la placa en claro.
    await logPiiAccess(req, { resourceTipo: 'flito_tramite', accion: 'search', camposAccedidos: ['placa'], motivo: 'Torre de Control: ficha de placa' });
    const resultado = await buscarPlaca(parsed.data.placa, alcance);
    res.setHeader('Cache-Control', 'no-store');
    res.json(resultado);
  } catch (e) { manejar(e, res, next); }
});

router.post('/placa/sugerencias', exigirFuncion('torre.placa.buscar'), torrePlacaSugerirLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = sugerirPlacaSchema.safeParse(req.body);
  if (!parsed.success) { invalido(res, parsed.error); return; }
  try {
    // RN-TOR-P6: sin caché en ningún punto (el texto parcial no vive en Redis ni en el navegador).
    res.setHeader('Cache-Control', 'no-store');
    const alcance = await alcanceDe(req);
    // RN-TOR-P6: toda petición válida se registra (fail-open, como la ficha); el log no lleva el texto.
    await logPiiAccess(req, { resourceTipo: 'flito_tramite', accion: 'search', camposAccedidos: ['placa'], motivo: 'Torre de Control: sugerencias de placa' });
    res.json(await sugerirPlacas(parsed.data.texto.toUpperCase(), alcance));
  } catch (e) { manejar(e, res, next); }
});

router.get('/opciones', exigirFuncion('torre.metricas.consultar'), torreConsultaLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alcance = await alcanceDe(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await opcionesFiltroTorre(alcance));
  } catch (e) { manejar(e, res, next); }
});

router.get('/umbrales', exigirFuncion('torre.umbrales.ver'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await listarUmbrales());
  } catch (e) { manejar(e, res, next); }
});

router.put('/umbrales/:clave', exigirFuncion('torre.umbrales.editar'), async (req: Request, res: Response, next: NextFunction) => {
  const clave = claveUmbralSchema.safeParse(req.params.clave);
  if (!clave.success) { res.status(400).json({ error: 'Datos inválidos: clave no es un umbral de la Torre', code: 'DATOS_INVALIDOS' }); return; }
  const parsed = editarUmbralSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: `Datos inválidos: ${detalleZod(parsed.error)}`, code: 'DATOS_INVALIDOS', campo: 'valor' }); return; }
  // RN-TOR-U2 antes de tocar la base (el servicio y el CHECK lo vuelven a exigir).
  const fuera = errorDeRangoUmbral(unidadDeUmbral(clave.data), parsed.data.valor);
  if (fuera) { res.status(400).json({ error: fuera, code: 'UMBRAL_FUERA_DE_RANGO', campo: 'valor' }); return; }
  try {
    const { anterior, umbral } = await actualizarUmbral(clave.data, parsed.data.valor, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_torre_umbral', resourceId: umbral.clave,
      detail: `Umbral ${umbral.clave} (${umbral.unidad}): ${anterior} → ${umbral.valor}`,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(umbral);
  } catch (e) { manejar(e, res, next); }
});

export default router;
