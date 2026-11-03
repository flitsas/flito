// HU #14103 — Rutas de proveedores de logística: `/api/flito/parametrizacion/proveedores-logistica`.
// Reutiliza las funciones de gestión de proveedores (`parametrizacion.proveedores.*`); sin nuevas funciones de permiso.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { ProveedorLogisticaEnUsoError, eliminarProveedorLogistica, impactoProveedorLogistica } from './flito-proveedores-logistica-gestion.service.js';
import { ProveedorLogisticaAsignadoError } from './flito-logistica-proveedor-compania.service.js';
import {
  NIT_VALIDO, NitProveedorDuplicadoError, NombreProveedorLogisticaDuplicadoError, ProveedorLogisticaNoEncontradoError,
  actualizarProveedorLogistica, crearProveedorLogistica, listarProveedoresLogistica, normalizarNit, proveedorLogisticaDto,
} from './flito-proveedores-logistica.service.js';

const router = Router();
router.use(authMiddleware);

const texto = (max: number, etiqueta: string) =>
  z.string({ error: `${etiqueta} es obligatorio` }).trim().min(1, `${etiqueta} es obligatorio`).max(max, `${etiqueta} admite máximo ${max} caracteres`);
const nitSchema = z.string({ error: 'El NIT es obligatorio' }).transform(normalizarNit)
  .pipe(z.string().min(1, 'El NIT es obligatorio').regex(NIT_VALIDO, 'El NIT no es válido (solo dígitos y dígito de verificación opcional)'));
const opcional = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : (v === null || v === '' ? null : v)));

const crearSchema = z.object({
  nombre: texto(150, 'El nombre').pipe(z.string()),
  nit: nitSchema,
  contacto: opcional(150),
  telefono: opcional(30),
});
const editarSchema = z.object({
  nombre: texto(150, 'El nombre').optional(),
  nit: nitSchema.optional(),
  contacto: opcional(150),
  telefono: opcional(30),
});
// HU #14148: `activoEsperado` (concurrencia optimista del PATCH de SOAT) se ACEPTA y se IGNORA de forma explícita: la
// transición de inactivar ya es atómica (`FOR UPDATE`) y reactivar es idempotente. La web puede enviarlo sin romperse.
const estadoSchema = z.object({ activo: z.boolean(), activoEsperado: z.boolean().optional() });
const UUID = z.string().uuid();

/** 422 con el primer campo inválido o faltante. */
function responder422(res: Response, error: z.ZodError): void {
  const f = error.issues[0]!;
  res.status(422).json({ error: f.message, campo: String(f.path[0] ?? ''), details: error.flatten() });
}

router.get('/', exigirFuncion('parametrizacion.proveedores.listar'), async (_req: Request, res: Response) => {
  res.json((await listarProveedoresLogistica()).map(proveedorLogisticaDto));
});

router.post('/', exigirFuncion('parametrizacion.proveedores.crear'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  try {
    const creado = await crearProveedorLogistica(parsed.data);
    // Solo el nombre y el id al detalle: contacto y teléfono pueden ser de una persona.
    await audit(req, { action: 'create', resource: 'flito_proveedor_logistica', resourceId: creado.id, detail: `Proveedor de logística: ${creado.nombre}` });
    res.status(201).json(proveedorLogisticaDto(creado));
  } catch (e) { manejar(e, res, next); }
});

router.patch('/:id', exigirFuncion('parametrizacion.proveedores.editar'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = editarSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  const datos = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  if (Object.keys(datos).length === 0) { res.status(422).json({ error: 'No hay datos para actualizar', campo: '' }); return; }
  try {
    const act = await actualizarProveedorLogistica(req.params.id!, datos);
    await audit(req, { action: 'update', resource: 'flito_proveedor_logistica', resourceId: act.id, detail: `Proveedor de logística: ${act.nombre}` });
    res.json(proveedorLogisticaDto(act));
  } catch (e) { manejar(e, res, next); }
});

router.patch('/:id/estado', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = estadoSchema.safeParse(req.body);
  if (!parsed.success) { responder422(res, parsed.error); return; }
  try {
    const act = await actualizarProveedorLogistica(req.params.id!, { activo: parsed.data.activo });
    await audit(req, { action: 'update', resource: 'flito_proveedor_logistica', resourceId: act.id, detail: `Proveedor de logística ${act.activo ? 'activado' : 'desactivado'}: ${act.nombre}` });
    res.json(proveedorLogisticaDto(act));
  } catch (e) { manejar(e, res, next); }
});

// HU #14148 — impacto de una baja (inactivar o eliminar): cuántas compañías lo tienen y los 3 primeros nombres.
router.get('/:id/impacto', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  if (!UUID.safeParse(req.params.id).success) { res.status(400).json({ error: 'ID inválido' }); return; }
  try { res.json(await impactoProveedorLogistica(req.params.id!)); } catch (e) { manejar(e, res, next); }
});

// HU #14148 — eliminar: solo sin compañías asignadas (409). Exclusiva del Administrador (`…proveedores.eliminar`).
router.delete('/:id', exigirFuncion('parametrizacion.proveedores.eliminar'), async (req: Request, res: Response, next: NextFunction) => {
  if (!UUID.safeParse(req.params.id).success) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    const eliminado = await eliminarProveedorLogistica(req.params.id!);
    await audit(req, { action: 'delete', resource: 'flito_proveedor_logistica', resourceId: eliminado.id, detail: `Proveedor de logística eliminado: ${eliminado.nombre}` });
    res.json({ id: eliminado.id, eliminado: true });
  } catch (e) { manejar(e, res, next); }
});

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof NitProveedorDuplicadoError || e instanceof NombreProveedorLogisticaDuplicadoError) { res.status(409).json({ error: e.message }); return; }
  if (e instanceof ProveedorLogisticaAsignadoError) { res.status(409).json({ error: e.message, companias: e.companias }); return; }
  if (e instanceof ProveedorLogisticaEnUsoError) { res.status(409).json({ error: e.message }); return; }
  if (e instanceof ProveedorLogisticaNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
  next(e);
}

export default router;
