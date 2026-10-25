// FLITO — rama TRÁNSITO del catálogo único de bolsas (HTTP). HU #13907 (Feature #13887, ADR-0029).
//
// Sub-router montado por `flito-bolsas.routes.ts` ANTES del de compañía (`routerCatalogo`) y con LAS MISMAS
// rutas (`POST /`, `/bolsa/:bolsaId/…`). Cada ruta empieza con `deTransito(...)`, que decide por el alcance:
//   · `POST /`: el del body. Distinto de `transito` → `next('route')` y lo atiende el router de compañía.
//   · `/bolsa/:bolsaId/…`: el de la fila. Bolsa de compañía, inexistente o id inválido → `next('route')`.
//     Con enlace también se cede: el router de compañía responde 404 al leer y 403 al escribir una bolsa
//     que no es la suya, sin oráculo de «esta es de tránsito».
// Por qué un sub-router y no `exigirFuncionSegunAlcance`: el lector de montajes (`inventario-guardas.ts`) lee
// el código LITERAL de `exigirFuncion` por fichero + método + ruta y falla ante una guarda resuelta en tiempo
// de petición; en un fichero propio las rutas homónimas tienen llave distinta.
//
// Gestión de FLIT solamente: `soloSinEnlace()` en todas (AC8). Las rutas antiguas `/transito/…` siguen vivas
// hasta la HU #13911.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { alcanceDe, soloSinEnlace } from '../../shared/middleware/frontera-enlace.js';
import { companiaDeAlcance } from '../../shared/alcance-filas.js';
import { CodigoErrorBolsa, CONCEPTOS_BOLSA_TRANSITO } from '@operaciones/shared-types';
import { BolsaError, MSG_BOLSA_INACTIVA } from './flito-bolsas.libro.js';
import {
  type BolsaGuarda, bolsaDetalle, bolsaParaGuarda, buscarBolsas, crearBolsaTransito, editarBolsaTransito,
  inactivarBolsa, reactivarBolsa,
} from './flito-bolsas.catalogo.service.js';
import { movimientosTransitoDe } from './flito-bolsas-transito.service.js';
import { cerrarPeriodoDeBolsa, cierresDeBolsa, CoberturaOcupadaError } from './flito-bolsas.catalogo-transito.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function datosInvalidos(res: Response, error: string): void {
  res.status(400).json({ error, codigo: CodigoErrorBolsa.DATOS_INVALIDOS });
}

/** 409 `cobertura_ocupada` lleva `pares`; el resto de BolsaError, `{ error, codigo }`; lo demás sube. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof CoberturaOcupadaError) {
    res.status(e.estado).json({ error: e.message, codigo: e.codigo, pares: e.pares });
    return;
  }
  if (e instanceof BolsaError) {
    res.status(e.estado).json(e.codigo ? { error: e.message, codigo: e.codigo } : { error: e.message });
    return;
  }
  throw e;
}

function ctxDe(req: Request) {
  return { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
}

function bolsaDe(res: Response): BolsaGuarda {
  return res.locals.bolsa as BolsaGuarda;
}

/** Handlers de las rutas antiguas `/transito/*` que las rutas por bolsa reutilizan tal cual (HU #13907). */
export interface DelegadosTransito {
  recibirSoporte: RequestHandler;
  registrarCarga: RequestHandler;
}

/**
 * Ver la cabecera: atiende solo lo que es de tránsito; el resto pasa al router de compañía.
 * `body`: alta (con enlace → 403, AC8). `listado`: `POST /buscar` (con enlace cede: el router de compañía
 * acota a su compañía y con `alcance: 'transito'` no devuelve nada). `fila`: rutas por bolsa.
 */
function deTransito(origen: 'body' | 'listado' | 'fila') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (origen !== 'fila') {
      if (req.body?.alcance !== 'transito') { next('route'); return; }
      const conEnlace = companiaDeAlcance(await alcanceDe(req)) !== undefined;
      if (conEnlace && origen === 'listado') { next('route'); return; }
      // Con enlace, 403 (AC8) — además de `soloSinEnlace()`, por si la frontera llegara sin decidir el enlace.
      if (conEnlace) { res.status(403).json({ error: 'Sin permisos' }); return; }
      next();
      return;
    }
    if (companiaDeAlcance(await alcanceDe(req)) !== undefined) { next('route'); return; }
    const id = String(req.params.bolsaId);
    const bolsa = UUID.test(id) ? await bolsaParaGuarda(id) : undefined;
    if (!bolsa || bolsa.alcance !== 'transito') { next('route'); return; }
    res.locals.bolsa = bolsa;
    next();
  };
}

/** Recarga sobre una bolsa inactiva → 409 ANTES de recibir el archivo (sin soporte huérfano, Q7). */
function activa(_req: Request, res: Response, next: NextFunction): void {
  if (bolsaDe(res).activa) { next(); return; }
  res.status(409).json({ error: MSG_BOLSA_INACTIVA, codigo: CodigoErrorBolsa.BOLSA_INACTIVA });
}

const buscarSchema = z.object({
  alcance: z.literal('transito'),
  activa: z.boolean().optional(),
  texto: z.string().trim().max(120).optional(),
}).strict();

const datosTransito = {
  nombre: z.string().trim().min(3, 'El nombre de la bolsa debe tener al menos 3 caracteres').max(120),
  organismos: z.array(z.string().trim().min(1).max(5)).min(1, 'Selecciona al menos una secretaría').max(1200),
  conceptos: z.array(z.string().trim().min(1).max(30)).min(1, 'Selecciona al menos un concepto')
    .max(CONCEPTOS_BOLSA_TRANSITO.length * 2),
};

const crearSchema = z.object({ alcance: z.literal('transito'), ...datosTransito }).strict();
const editarSchema = z.object({ alcance: z.literal('transito').optional(), ...datosTransito }).strict();

const motivoSchema = z.object({
  motivo: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(500),
}).strict();

const cierreSchema = z.object({
  periodo: z.string().trim(),
  observaciones: z.string().max(1000).nullish(),
}).strict();

export function routerCatalogoTransito(d: DelegadosTransito): Router {
  const router = Router();
  // Redundante con el del router padre, a propósito (misma razón que `routerCatalogo`).
  router.use(authMiddleware);

  // POST /buscar con `alcance: 'transito'` — listado de tránsito (sustituye a `GET /transito`). Filtros en el BODY.
  router.post('/buscar', deTransito('listado'), soloSinEnlace(), exigirFuncion('bolsas.transito.listar'), async (req: Request, res: Response) => {
    if (Object.keys(req.query).length > 0) { datosInvalidos(res, 'Los filtros van en el cuerpo de la petición'); return; }
    const parsed = buscarSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, 'Filtros inválidos'); return; }
    res.json(await buscarBolsas(parsed.data, undefined));
  });

  // POST / con `alcance: 'transito'` — alta (AC1-AC2).
  router.post('/', deTransito('body'), soloSinEnlace(), exigirFuncion('bolsas.transito.crear'), async (req: Request, res: Response) => {
    const parsed = crearSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await crearBolsaTransito(parsed.data, ctxDe(req));
      await audit(req, {
        action: 'create', resource: 'flito_bolsa', resourceId: bolsa.id,
        detail: `Bolsa de tránsito: ${bolsa.cobertura.length} parejas de cobertura`,
      });
      res.status(201).json(bolsa);
    } catch (e) { fallo(res, e); }
  });

  // GET /bolsa/:bolsaId — detalle de tránsito con las parejas autogestionadas (AC9).
  router.get('/bolsa/:bolsaId', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.ver'), async (_req: Request, res: Response) => {
    const bolsa = await bolsaDetalle(bolsaDe(res).id);
    if (!bolsa) { res.status(404).json({ error: 'La bolsa no existe' }); return; }
    res.json(bolsa);
  });

  // PATCH /bolsa/:bolsaId — nombre, secretarías y conceptos (AC2-AC3). No cambia el alcance.
  router.patch('/bolsa/:bolsaId', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.editar'), async (req: Request, res: Response) => {
    const parsed = editarSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await editarBolsaTransito(bolsaDe(res).id, parsed.data, ctxDe(req));
      await audit(req, {
        action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id,
        detail: `Bolsa de tránsito: ${bolsa.cobertura.length} parejas de cobertura`,
      });
      res.json(bolsa);
    } catch (e) { fallo(res, e); }
  });

  // POST /bolsa/:bolsaId/inactivar — (AC4). Libera la cobertura; conserva saldo e historial.
  router.post('/bolsa/:bolsaId/inactivar', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.inactivar'), async (req: Request, res: Response) => {
    const parsed = motivoSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await inactivarBolsa(bolsaDe(res).id, parsed.data.motivo, ctxDe(req));
      await audit(req, { action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id, detail: 'Bolsa de tránsito inactivada' });
      res.json(bolsa);
    } catch (e) { fallo(res, e); }
  });

  // POST /bolsa/:bolsaId/reactivar — (AC5). 409 `cobertura_ocupada` con las parejas tomadas.
  router.post('/bolsa/:bolsaId/reactivar', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.inactivar'), async (req: Request, res: Response) => {
    const parsed = motivoSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await reactivarBolsa(bolsaDe(res).id, parsed.data.motivo, ctxDe(req));
      await audit(req, { action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id, detail: 'Bolsa de tránsito reactivada' });
      res.json(bolsa);
    } catch (e) { fallo(res, e); }
  });

  // GET /bolsa/:bolsaId/movimientos — libro de la bolsa de tránsito (sustituye a `GET /transito/:bolsaId/movimientos`).
  router.get('/bolsa/:bolsaId/movimientos', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.ver_movimientos'), async (_req: Request, res: Response) => {
    res.json(await movimientosTransitoDe(bolsaDe(res).id));
  });

  // POST /bolsa/:bolsaId/recargas — carga de saldo con soporte opcional (sustituye a `POST /transito/:bolsaId/cargas`).
  // Mismo handler que la ruta antigua; inactiva → 409 antes de multer.
  router.post('/bolsa/:bolsaId/recargas', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.cargar'), activa, d.recibirSoporte, d.registrarCarga);

  // GET /bolsa/:bolsaId/cierres — cierres de la bolsa de tránsito (Q3, AC8).
  router.get('/bolsa/:bolsaId/cierres', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.cierres.ver'), async (_req: Request, res: Response) => {
    res.json(await cierresDeBolsa(bolsaDe(res).id));
  });

  // POST /bolsa/:bolsaId/cierres — cierra un mes cumplido (AC6). La bolsa inactiva también se cierra (Q7).
  router.post('/bolsa/:bolsaId/cierres', deTransito('fila'), soloSinEnlace(), exigirFuncion('bolsas.transito.cierre.crear'), async (req: Request, res: Response) => {
    const parsed = cierreSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, 'Indica el periodo a cerrar (AAAA-MM)'); return; }
    try {
      const cierre = await cerrarPeriodoDeBolsa(bolsaDe(res).id, parsed.data.periodo, parsed.data.observaciones ?? null, ctxDe(req));
      await audit(req, {
        action: 'create', resource: 'flito_bolsa_cierre', resourceId: cierre.id,
        detail: `Cierre de ${cierre.periodo} de la bolsa de tránsito: entradas ${cierre.totalEntradas}, salidas ${cierre.totalSalidas}, saldo final ${cierre.saldoFinal}`,
      });
      res.status(201).json(cierre);
    } catch (e) { fallo(res, e); }
  });

  return router;
}
