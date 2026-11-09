// HU #14332, #14333, #14334 y #14335 (Feature #14324, ADR-0039 §7.1) — `/api/flito/parametrizacion/proveedores`.
// Montado en `app.ts` antes del router general y SIN `conAlcance`: nace cerrado a todo enlace. Es la única vía de escritura de
// proveedores. De `proveedores-soat` y `proveedores-logistica` solo quedan lecturas, hasta F5.
//
// Frente a §7.1: `PATCH /:id` también recibe `servicios` (datos y servicios en una sola transacción) y por eso no hay
// `POST /:id/servicios/:servicio`. `DELETE` se conserva: HU #14333 AC8 pide 422 para el segundo de dos retiros simultáneos,
// y con `versionEsperada` recibiría el aviso de edición simultánea.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { SERVICIOS_PROVEEDOR, MENSAJE_SIN_SERVICIO, MENSAJE_PROVEEDOR_EDITADO_POR_OTRO, type ProveedorGeneralesBody, type ProveedorSoatBody, type ServicioProveedor } from '@operaciones/shared-types';
import { authMiddleware, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { invalidarPermisosDe } from '../../shared/permisos-efectivos.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';
import { ProveedorLogisticaAsignadoError } from './flito-logistica-proveedor-compania.service.js';
import { historialProveedor } from './flito-proveedores-auditoria.js';
import { editarProveedor } from './flito-proveedores-edicion.service.js';
import { ProveedorNoEliminableError, eliminarProveedor } from './flito-proveedores-eliminar.service.js';
import { EstadoProveedorCambiadoError, cambiarEstadoProveedor, impactoProveedor } from './flito-proveedores-estado.service.js';
import { NIT_VALIDO, normalizarNit } from './flito-proveedores-logistica.service.js';
import { ServicioNoPrestadoError, ServicioNoQuitableError, quitarServicio } from './flito-proveedores-servicios.service.js';
import {
  DatosSoatInvalidosError, GeneralesIncompletosError, ProveedorDuplicadoError, ProveedorEditadoPorOtroError, ProveedorNoEncontradoError,
  ProveedorSinServicioError, crearProveedor, detalleProveedor, existeProveedor, listarProveedores, proveedoresAsignablesAUsuario,
  selectorProveedores,
} from './flito-proveedores.service.js';

const router = Router();
router.use(authMiddleware);

const texto = (max: number) => z.string().trim().min(1).max(max);
const generalesSchema = z.object({
  nombre: texto(150),
  nit: z.string().transform(normalizarNit).pipe(z.string().regex(NIT_VALIDO)),
  telefono: texto(30),
  correo: z.string().trim().max(150).email(),
  direccion: texto(300),
  ciudad: texto(100),
  contacto: texto(150),
}).strict();

// Todos opcionales, al crear, al agregar y al editar. La cadena vacía limpia la estrategia y `null` limpia los otros dos.
const soatSchema = z.object({
  estrategia: z.string().trim().max(40).optional(),
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
}).strict();

const serviciosSchema = z.array(z.enum(SERVICIOS_PROVEEDOR));
const servicioParam = z.enum(SERVICIOS_PROVEEDOR);
const versionSchema = z.number().int().positive();

// `.strict()`: datos de SOAT fuera de `soat` se rechazan (R7), y `activo` no se acepta al crear: todo proveedor nace activo.
const crearSchema = z.object({ generales: z.unknown().optional(), servicios: z.unknown().optional(), soat: z.unknown().optional() }).strict();
const editarSchema = z.object({
  versionEsperada: versionSchema, generales: z.unknown().optional(), servicios: z.unknown().optional(), soat: z.unknown().optional(),
}).strict();
const estadoSchema = z.object({ activo: z.boolean(), versionEsperada: versionSchema }).strict();
const listaSchema = z.object({ servicio: servicioParam.optional(), activo: z.enum(['true', 'false']).optional() });
const selectorSchema = z.object({ servicio: servicioParam });
const UUID = z.string().uuid();

const CAMPOS_PII_DETALLE = ['nit', 'telefono', 'correo', 'direccion', 'contacto'];

/** El identificador de la ruta, o responde 400. */
function idDe(req: Request, res: Response): string | null {
  if (UUID.safeParse(req.params.id).success) return req.params.id!;
  res.status(400).json({ error: 'ID inválido' });
  return null;
}

function responderGeneralesInvalidos(res: Response, error: z.ZodError): void {
  const campos = [...new Set(error.issues.map((i) => String(i.path[0] ?? '')).filter((c) => c !== ''))];
  res.status(422).json({ error: `Complete los datos generales del proveedor: ${campos.join(', ') || 'datos no admitidos'}`, campos });
}

function responderDatosInvalidos(res: Response, mensaje: string): void {
  res.status(422).json({ error: mensaje });
}

const MENSAJE_SOAT_INVALIDO = 'Los datos de SOAT no son válidos: estrategia, umbral de OCR entre 0 y 1 y ANS en horas.';

/** Parsea `servicios`; responde 422 con el mensaje de la épica si faltan. `null` = ya respondió. */
function serviciosDe(valor: unknown, res: Response): ServicioProveedor[] | null {
  if (valor === undefined || (Array.isArray(valor) && valor.length === 0)) {
    responderDatosInvalidos(res, MENSAJE_SIN_SERVICIO);
    return null;
  }
  const parsed = serviciosSchema.safeParse(valor);
  if (!parsed.success) { responderDatosInvalidos(res, 'Servicio no reconocido.'); return null; }
  return parsed.data;
}

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof ProveedorNoEncontradoError || e instanceof ServicioNoPrestadoError) { res.status(404).json({ error: e.message }); return; }
  if (e instanceof ProveedorSinServicioError || e instanceof DatosSoatInvalidosError) { res.status(422).json({ error: e.message }); return; }
  if (e instanceof GeneralesIncompletosError) { res.status(422).json({ error: e.message, campos: e.campos }); return; }
  if (e instanceof ProveedorEditadoPorOtroError) { res.status(409).json({ error: MENSAJE_PROVEEDOR_EDITADO_POR_OTRO, code: e.code }); return; }
  if (e instanceof ProveedorDuplicadoError) { res.status(409).json({ error: e.message, campo: e.campo }); return; }
  if (e instanceof ServicioNoQuitableError) { res.status(409).json({ error: e.message, servicio: e.servicio, bloqueos: e.bloqueos }); return; }
  if (e instanceof ProveedorLogisticaAsignadoError) { res.status(409).json({ error: e.message, companias: e.companias }); return; }
  if (e instanceof ProveedorNoEliminableError || e instanceof EstadoProveedorCambiadoError) { res.status(409).json({ error: e.message }); return; }
  if (e instanceof BloqueoAdministracionError) { res.status(409).json({ error: e.message, funcion: e.funcion }); return; }
  next(e);
}

/** AC4 de #14335: el detalle de `audit()` solo lleva identificador y nombre. */
const detalleAudit = (p: { id: string; nombre: string }) => `Proveedor ${p.nombre} (${p.id})`;

/** Tras el commit: la siguiente petición de cada usuario relee su sesión y sus permisos. */
function invalidarUsuarios(ids: readonly number[]): void {
  for (const id of ids) { invalidateSessionCacheFor(id); invalidarPermisosDe(id); }
}

router.get('/', exigirFuncion('parametrizacion.proveedores.listar'), async (req: Request, res: Response) => {
  const parsed = listaSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtro no válido' }); return; }
  const { servicio, activo } = parsed.data;
  res.json(await listarProveedores({ ...(servicio ? { servicio } : {}), ...(activo ? { activo: activo === 'true' } : {}) }));
});

router.get('/selector', exigirFuncion('parametrizacion.proveedores.listar'), async (req: Request, res: Response) => {
  const parsed = selectorSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Indique un servicio válido' }); return; }
  res.json(await selectorProveedores(parsed.data.servicio));
});

router.get('/asignables-usuario', exigirFuncion('parametrizacion.proveedores.listar'), async (_req: Request, res: Response) => {
  res.json(await proveedoresAsignablesAUsuario());
});

router.get('/:id', exigirFuncion('parametrizacion.proveedores.listar'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  try {
    const detalle = await detalleProveedor(id);
    res.setHeader('Cache-Control', 'no-store');
    await logPiiAccess(req, { resourceTipo: 'flito_proveedor', accion: 'read', camposAccedidos: CAMPOS_PII_DETALLE, motivo: `Detalle del proveedor ${id}` });
    res.json(detalle);
  } catch (e) { manejar(e, res, next); }
});

router.post('/', exigirFuncion('parametrizacion.proveedores.crear'), async (req: Request, res: Response, next: NextFunction) => {
  const cuerpo = crearSchema.safeParse(req.body);
  if (!cuerpo.success) { responderDatosInvalidos(res, 'La petición trae datos no admitidos.'); return; }
  const servicios = serviciosDe(cuerpo.data.servicios, res);
  if (servicios === null) return;
  const generales = generalesSchema.safeParse(cuerpo.data.generales ?? {});
  if (!generales.success) { responderGeneralesInvalidos(res, generales.error); return; }
  let soat: ProveedorSoatBody | undefined;
  if (cuerpo.data.soat !== undefined) {
    const parsed = soatSchema.safeParse(cuerpo.data.soat);
    if (!parsed.success) { responderDatosInvalidos(res, MENSAJE_SOAT_INVALIDO); return; }
    soat = parsed.data;
  }
  try {
    const creado = await crearProveedor({ generales: generales.data, servicios, ...(soat ? { soat } : {}) }, actorDeRequest(req));
    await audit(req, { action: 'create', resource: 'flito_proveedor', resourceId: creado.id, detail: detalleAudit(creado) });
    res.status(201).json(creado);
  } catch (e) { manejar(e, res, next); }
});

router.patch('/:id', exigirFuncion('parametrizacion.proveedores.editar'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  const cuerpo = editarSchema.safeParse(req.body);
  if (!cuerpo.success) { responderDatosInvalidos(res, 'Indique la versión del proveedor que está editando y solo datos admitidos.'); return; }
  const { versionEsperada } = cuerpo.data;
  let generales: ProveedorGeneralesBody | undefined;
  if (cuerpo.data.generales !== undefined) {
    const parsed = generalesSchema.safeParse(cuerpo.data.generales);
    if (!parsed.success) { responderGeneralesInvalidos(res, parsed.error); return; }
    generales = parsed.data;
  }
  let servicios: ServicioProveedor[] | undefined;
  if (cuerpo.data.servicios !== undefined) {
    const parsed = serviciosDe(cuerpo.data.servicios, res);
    if (parsed === null) return;
    servicios = parsed;
  }
  let soat: ProveedorSoatBody | undefined;
  if (cuerpo.data.soat !== undefined) {
    const parsed = soatSchema.safeParse(cuerpo.data.soat);
    if (!parsed.success) { responderDatosInvalidos(res, MENSAJE_SOAT_INVALIDO); return; }
    soat = parsed.data;
  }
  try {
    const act = await editarProveedor(id, {
      versionEsperada, ...(generales ? { generales } : {}), ...(servicios ? { servicios } : {}), ...(soat ? { soat } : {}),
    }, actorDeRequest(req));
    await audit(req, { action: 'update', resource: 'flito_proveedor', resourceId: act.id, detail: detalleAudit(act) });
    res.json(act);
  } catch (e) { manejar(e, res, next); }
});

router.delete('/:id/servicios/:servicio', exigirFuncion('parametrizacion.proveedores.editar'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  const servicio = servicioParam.safeParse(req.params.servicio);
  if (!servicio.success) { res.status(400).json({ error: 'Servicio no reconocido' }); return; }
  try {
    const act = await quitarServicio(id, servicio.data, actorDeRequest(req));
    await audit(req, { action: 'update', resource: 'flito_proveedor', resourceId: act.id, detail: detalleAudit(act) });
    res.json(act);
  } catch (e) { manejar(e, res, next); }
});

router.get('/:id/impacto', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  try { res.json(await impactoProveedor(id)); } catch (e) { manejar(e, res, next); }
});

router.patch('/:id/estado', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  const cuerpo = estadoSchema.safeParse(req.body);
  if (!cuerpo.success) { responderDatosInvalidos(res, 'Indique el estado y la versión del proveedor que está editando.'); return; }
  try {
    const { item, usuariosInvalidados } = await cambiarEstadoProveedor(id, cuerpo.data, actorDeRequest(req));
    invalidarUsuarios(usuariosInvalidados);
    await audit(req, { action: 'update', resource: 'flito_proveedor', resourceId: item.id, detail: detalleAudit(item) });
    res.json(item);
  } catch (e) { manejar(e, res, next); }
});

router.delete('/:id', exigirFuncion('parametrizacion.proveedores.eliminar'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  try {
    const eliminado = await eliminarProveedor(id, actorDeRequest(req));
    invalidarUsuarios(eliminado.usuariosDesactivados);
    await audit(req, { action: 'delete', resource: 'flito_proveedor', resourceId: eliminado.id, detail: detalleAudit(eliminado) });
    res.json({ id: eliminado.id, eliminado: true });
  } catch (e) { manejar(e, res, next); }
});

router.get('/:id/historial', exigirFuncion('parametrizacion.proveedores.historial'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idDe(req, res);
  if (id === null) return;
  try {
    if (!(await existeProveedor(id))) throw new ProveedorNoEncontradoError();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await historialProveedor(id));
  } catch (e) { manejar(e, res, next); }
});

export default router;
