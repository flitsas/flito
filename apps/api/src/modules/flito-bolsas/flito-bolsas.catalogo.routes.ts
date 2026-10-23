// FLITO — catálogo de bolsas del modelo único (HTTP). HU #13900 (Feature #13886, ADR-0029).
//
// Sub-router montado por `flito-bolsas.routes.ts` ANTES de `/:companiaId` (si no, «buscar», «bolsa» y
// «compania» se leerían como un id de compañía).
//
// Ley 1581: los filtros (texto, NIT, nombre) viajan en el BODY de `POST /buscar`; en el path solo van ids
// opacos (uuid de la bolsa) o el id interno de la compañía. Ningún log ni auditoría lleva NIT ni nombre.
//
// Guardas: `exigirFuncion('<literal>')` por ruta, porque el lector de montajes (`inventario-guardas.ts`)
// lee el código del fuente y FALLA ante una guarda resuelta en tiempo de petición. Por eso no existe aún
// `exigirFuncionSegunAlcance`: la rama tránsito de estas rutas llega en la HU-G (#13907) y hoy responde 400.
// `bolsaPropia` es la frontera por enlace (ADR-0024) resuelta bolsa → compañía.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { companiaDeAlcance, esProyeccionCliente } from '../../shared/alcance-filas.js';
import {
  type BolsaDetalleDto, type BolsaResumenDto, CodigoErrorBolsa, CONCEPTOS_BOLSA_COMPANIA,
} from '@operaciones/shared-types';
import { BolsaError, MSG_BOLSA_INACTIVA } from './flito-bolsas.libro.js';
import {
  BolsaCompaniaExisteError, type BolsaGuarda, bolsaDetalle, bolsaParaGuarda, buscarBolsas, crearBolsaCompania,
  editarBolsa, estadoConAutogestion, inactivarBolsa, MSG_TRANSITO_PENDIENTE, reactivarBolsa,
} from './flito-bolsas.catalogo.service.js';

/** Handlers del canal Cliente (`/:companiaId/*`) que las rutas por bolsa reutilizan tal cual. */
export interface DelegadosCompania {
  companiaPropia: (modo: 'leer' | 'escribir') => RequestHandler;
  recibirSoporte: RequestHandler;
  verMovimientos: RequestHandler;
  registrarRecarga: RequestHandler;
  verCierres: RequestHandler;
  crearCierre: RequestHandler;
}

/**
 * Habeas Data (mismo criterio que HU #13426 en movimientos y cierres): la compañía (proyección cliente) no
 * recibe el nombre del empleado de FLIT que inactivó la bolsa NI el motivo que escribió (decisión de producto
 * 2026-10-23). Ambos salen `null`, el «vacío» del contrato; `inactivadaEn` y `activa` sí se muestran. El DTO
 * no lleva otro nombre de persona (`nombre`/`companiaNombre` son de la compañía). El resumen del listado no
 * trae esos campos: se proyecta igual y no se le añaden.
 */
export function proyectarParaCliente<T extends BolsaResumenDto | BolsaDetalleDto>(dto: T): T {
  if (!('inactivadaPorNombre' in dto) && !('motivoInactivacion' in dto)) return dto;
  return { ...dto, inactivadaPorNombre: null, motivoInactivacion: null };
}

/** Aplica `proyectarParaCliente` si el lector es la compañía; si es FLIT, el DTO va tal cual. */
async function proyectar<T extends BolsaResumenDto | BolsaDetalleDto>(req: Request, dto: T): Promise<T> {
  return esProyeccionCliente(await alcanceDe(req)) ? proyectarParaCliente(dto) : dto;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function datosInvalidos(res: Response, error: string): void {
  res.status(400).json({ error, codigo: CodigoErrorBolsa.DATOS_INVALIDOS });
}

/** BolsaError es de negocio (con `codigo` y, en el 409 de «ya existe», `{bolsaId, activa}`); lo demás sube. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof BolsaCompaniaExisteError) {
    res.status(e.estado).json({ error: e.message, codigo: e.codigo, ...e.datos });
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

/**
 * Frontera por enlace sobre `:bolsaId` (AC9): con enlace `compania`, solo SU bolsa. Lectura ajena o
 * inexistente → 404. Escritura con enlace → 403 sin distinguir ajena de inexistente (sin oráculo). Sin
 * enlace: 404 si no existe. Deja la bolsa en `res.locals.bolsa`. Va ANTES de multer.
 */
function bolsaPropia(modo: 'leer' | 'escribir') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const c = companiaDeAlcance(await alcanceDe(req));
    const id = String(req.params.bolsaId);
    const bolsa = UUID.test(id) ? await bolsaParaGuarda(id) : undefined;
    if (bolsa && (c === undefined || (bolsa.alcance === 'compania' && bolsa.companiaId === c))) {
      res.locals.bolsa = bolsa;
      next();
      return;
    }
    if (modo === 'escribir' && c !== undefined) res.status(403).json({ error: 'Sin permisos' });
    else res.status(404).json({ error: 'La bolsa no existe' });
  };
}

/**
 * Las rutas que delegan en el canal Cliente solo sirven a bolsas de COMPAÑÍA (tránsito: HU-G). Fija
 * `req.params.companiaId` para que el handler delegado resuelva la compañía como siempre. Con
 * `activa`, una bolsa inactiva se rechaza ANTES de recibir el archivo (AC10, sin soporte huérfano).
 */
function deCompania(opciones: { activa?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bolsa = bolsaDe(res);
    if (bolsa.alcance !== 'compania' || bolsa.companiaId === null) { datosInvalidos(res, MSG_TRANSITO_PENDIENTE); return; }
    if (opciones.activa && !bolsa.activa) {
      res.status(409).json({ error: MSG_BOLSA_INACTIVA, codigo: CodigoErrorBolsa.BOLSA_INACTIVA });
      return;
    }
    req.params.companiaId = String(bolsa.companiaId);
    next();
  };
}

const conceptosSchema = z.array(z.string().trim().min(1).max(30)).max(CONCEPTOS_BOLSA_COMPANIA.length * 2);

const crearCompaniaSchema = z.object({
  alcance: z.literal('compania'),
  companiaId: z.number().int().positive(),
  conceptos: conceptosSchema.min(1, 'Selecciona al menos un concepto'),
}).strict();

const editarCompaniaSchema = z.object({
  alcance: z.literal('compania').optional(),
  conceptos: conceptosSchema.min(1, 'Selecciona al menos un concepto'),
}).strict();

const motivoSchema = z.object({
  motivo: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(500),
}).strict();

const buscarSchema = z.object({
  alcance: z.enum(['compania', 'transito']).optional(),
  activa: z.boolean().optional(),
  texto: z.string().trim().max(120).optional(),
}).strict();

export function routerCatalogo(d: DelegadosCompania): Router {
  const router = Router();
  // Redundante con el del router padre, a propósito: la red `permisos.reconduccion-cierre` exige que todo
  // fichero de rutas en alcance lo declare, y así el sub-router no queda abierto si alguien lo monta en otra parte.
  router.use(authMiddleware);

  // POST /buscar — listado (AC7). Filtros SOLO en el body: una query string se rechaza, no se ignora.
  router.post('/buscar', exigirFuncion('bolsas.bolsa.listar'), async (req: Request, res: Response) => {
    if (Object.keys(req.query).length > 0) { datosInvalidos(res, 'Los filtros van en el cuerpo de la petición'); return; }
    const parsed = buscarSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, 'Filtros inválidos'); return; }
    const alcance = await alcanceDe(req);
    const bolsas = await buscarBolsas(parsed.data, companiaDeAlcance(alcance));
    res.json(esProyeccionCliente(alcance) ? bolsas.map(proyectarParaCliente) : bolsas);
  });

  // POST / — alta (AC1-AC3). Rama tránsito: HU-G (#13907) → 400 explícito.
  router.post('/', exigirFuncion('bolsas.bolsa.crear'), async (req: Request, res: Response) => {
    if (req.body?.alcance === 'transito') { datosInvalidos(res, MSG_TRANSITO_PENDIENTE); return; }
    const parsed = crearCompaniaSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    // Con enlace, solo la bolsa de SU compañía (AC9).
    const c = companiaDeAlcance(await alcanceDe(req));
    if (c !== undefined && c !== parsed.data.companiaId) { res.status(403).json({ error: 'Sin permisos' }); return; }
    try {
      const bolsa = await crearBolsaCompania(parsed.data, ctxDe(req));
      await audit(req, {
        action: 'create', resource: 'flito_bolsa', resourceId: bolsa.id,
        detail: `Bolsa de la compañía ${parsed.data.companiaId}: ${bolsa.conceptos.join(', ')}`,
      });
      res.status(201).json(await proyectar(req, bolsa));
    } catch (e) { fallo(res, e); }
  });

  // GET /compania/:companiaId/estado — contrato (d) con #13407 (AC8): sin bolsa → 200, no 404. AC11: más
  // `conceptosAutogestionados` de la compañía, para el aviso del formulario de alta.
  router.get('/compania/:companiaId/estado', exigirFuncion('bolsas.bolsa.ver'), d.companiaPropia('leer'), async (req: Request, res: Response) => {
    const id = Number(req.params.companiaId);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Compañía inválida' }); return; }
    res.json(await estadoConAutogestion(id));
  });

  // GET /bolsa/:bolsaId — detalle (AC9: la de otra compañía → 404).
  router.get('/bolsa/:bolsaId', exigirFuncion('bolsas.bolsa.ver'), bolsaPropia('leer'), async (req: Request, res: Response) => {
    const bolsa = await bolsaDetalle(bolsaDe(res).id);
    if (!bolsa) { res.status(404).json({ error: 'La bolsa no existe' }); return; }
    res.json(await proyectar(req, bolsa));
  });

  // PATCH /bolsa/:bolsaId — conceptos (AC4). No cambia alcance ni compañía.
  router.patch('/bolsa/:bolsaId', exigirFuncion('bolsas.bolsa.editar'), bolsaPropia('escribir'), async (req: Request, res: Response) => {
    if (req.body?.alcance === 'transito' || bolsaDe(res).alcance !== 'compania') { datosInvalidos(res, MSG_TRANSITO_PENDIENTE); return; }
    const parsed = editarCompaniaSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await editarBolsa(bolsaDe(res).id, parsed.data, ctxDe(req));
      await audit(req, {
        action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id, detail: `Conceptos: ${bolsa.conceptos.join(', ')}`,
      });
      res.json(await proyectar(req, bolsa));
    } catch (e) { fallo(res, e); }
  });

  // POST /bolsa/:bolsaId/inactivar — (AC5). Conserva saldo y movimientos.
  router.post('/bolsa/:bolsaId/inactivar', exigirFuncion('bolsas.bolsa.inactivar'), bolsaPropia('escribir'), async (req: Request, res: Response) => {
    const parsed = motivoSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await inactivarBolsa(bolsaDe(res).id, parsed.data.motivo, ctxDe(req));
      await audit(req, { action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id, detail: 'Bolsa inactivada' });
      res.json(await proyectar(req, bolsa));
    } catch (e) { fallo(res, e); }
  });

  // POST /bolsa/:bolsaId/reactivar — (AC6).
  router.post('/bolsa/:bolsaId/reactivar', exigirFuncion('bolsas.bolsa.inactivar'), bolsaPropia('escribir'), async (req: Request, res: Response) => {
    const parsed = motivoSchema.safeParse(req.body ?? {});
    if (!parsed.success) { datosInvalidos(res, parsed.error.issues[0]?.message ?? 'Datos inválidos'); return; }
    try {
      const bolsa = await reactivarBolsa(bolsaDe(res).id, parsed.data.motivo, ctxDe(req));
      await audit(req, { action: 'update', resource: 'flito_bolsa', resourceId: bolsa.id, detail: 'Bolsa reactivada' });
      res.json(await proyectar(req, bolsa));
    } catch (e) { fallo(res, e); }
  });

  // Libro, recargas y cierres POR BOLSA: delegan en los handlers del canal Cliente (mismas funciones).
  router.get('/bolsa/:bolsaId/movimientos', exigirFuncion('bolsas.movimientos.ver'), bolsaPropia('leer'), deCompania(), d.verMovimientos);
  router.post('/bolsa/:bolsaId/recargas', exigirFuncion('bolsas.recarga.registrar'), bolsaPropia('escribir'), deCompania({ activa: true }), d.recibirSoporte, d.registrarRecarga);
  router.get('/bolsa/:bolsaId/cierres', exigirFuncion('bolsas.cierres.ver'), bolsaPropia('leer'), deCompania(), d.verCierres);
  router.post('/bolsa/:bolsaId/cierres', exigirFuncion('bolsas.cierre.crear'), bolsaPropia('escribir'), deCompania(), d.crearCierre);

  return router;
}
