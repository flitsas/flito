// Épica #13763 (ADR-0041 §6) — `/api/flito/parametrizacion/tarifas-proveedores`: el costo que cada proveedor le cobra a FLIT.
// Montado en `app.ts` antes del router general y SIN `conAlcance`: `guardiaFrontera` da 403 a todo enlace distinto de
// `ninguno` aunque su rol tenga la función (R7, D9). Reutiliza las funciones de las tarifas al cliente (D8), sin funciones nuevas.
// Sin `logPiiAccess` (D10): no hay datos del titular; se proyecta id y nombre del proveedor (empresa), importes, fechas y el
// nombre del usuario interno. Nunca NIT ni datos de contacto.
//
// Bloque CONTRATO: rutas, Zod y traducción de errores fijados. El bloque BACKEND completa `audit()` en las tres mutaciones.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { CONCEPTOS_COSTO_PROVEEDOR, MENSAJE_VALOR_COSTO_INVALIDO, TARIFA_VALOR_MAX } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, funcionesConcedidas } from '../../shared/middleware/exigir-funcion.js';
import {
  ProveedorNoActivoError, ServicioCostoNoPrestadoError, TarifaProveedorCambiadaError, TarifaProveedorProveedorNoEncontradoError,
  VigenciaCostoNoEncontradaError, cambiarOCerrarCosto, fijarCosto, historialCostosProveedor, listarProveedoresConCostos,
  vistaCostosProveedor, type CambiosCosto,
} from './flito-tarifas-proveedor.service.js';

const router = Router();
router.use(authMiddleware);

const FN_LISTAR = 'parametrizacion.tarifas.listar';
const FN_HISTORIAL = 'parametrizacion.tarifas.historial';
const FN_CREAR = 'parametrizacion.tarifas.crear';
const FN_EDITAR = 'parametrizacion.tarifas.editar';

// R3: vacío, null, texto o negativo responden el mensaje literal. El máximo y los decimales llevan el suyo.
const valorCostoSchema = z.number({ error: MENSAJE_VALOR_COSTO_INVALIDO })
  .nonnegative(MENSAJE_VALOR_COSTO_INVALIDO)
  .max(TARIFA_VALOR_MAX, 'Supera el máximo admitido (12 enteros y 2 decimales)')
  .refine((n) => Math.round(n * 100) / 100 === n, 'Admite a lo sumo dos decimales');
const conceptoSchema = z.enum(CONCEPTOS_COSTO_PROVEEDOR);
const fijarSchema = z.object({ concepto: conceptoSchema, valor: valorCostoSchema }).strict();
const cambiarValorSchema = z.object({ valor: valorCostoSchema }).strict();
const cerrarSchema = z.object({ cerrar: z.literal(true) }).strict();
const historialQuerySchema = z.object({ concepto: conceptoSchema.optional() }).strict();
const UUID = z.string().uuid();

/** El UUID del parámetro, o responde 400. */
function uuidDe(req: Request, res: Response, param: string): string | null {
  const v = req.params[param];
  if (UUID.safeParse(v).success) return v!;
  res.status(400).json({ error: `Datos inválidos: ${param} debe ser un identificador válido`, code: 'DATOS_INVALIDOS' });
  return null;
}

/** 400: el valor responde el literal de R3 con `campo: 'valor'`; lo demás, «Datos inválidos: …». */
function responderInvalido(res: Response, e: z.ZodError): void {
  const delValor = e.issues.find((i) => i.path[0] === 'valor');
  if (delValor?.message === MENSAJE_VALOR_COSTO_INVALIDO) {
    res.status(400).json({ error: MENSAJE_VALOR_COSTO_INVALIDO, campo: 'valor', code: 'VALOR_INVALIDO' });
    return;
  }
  const detalle = e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ');
  res.status(400).json({ error: `Datos inválidos: ${detalle}`, code: 'DATOS_INVALIDOS', ...(delValor ? { campo: 'valor' } : {}) });
}

/** `{ valor }` o `{ cerrar: true }`, exactamente uno: se elige el esquema por la llave para que el 400 sea legible. */
function parsearCambios(body: unknown): { success: true; data: CambiosCosto } | { success: false; error: z.ZodError } {
  const esCierre = typeof body === 'object' && body !== null && 'cerrar' in body;
  return esCierre ? cerrarSchema.safeParse(body) : cambiarValorSchema.safeParse(body);
}

function manejar(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof TarifaProveedorProveedorNoEncontradoError || e instanceof VigenciaCostoNoEncontradaError) {
    res.status(404).json({ error: e.message, code: e.code }); return;
  }
  if (e instanceof TarifaProveedorCambiadaError || e instanceof ProveedorNoActivoError) {
    res.status(409).json({ error: e.message, code: e.code }); return;
  }
  if (e instanceof ServicioCostoNoPrestadoError) { res.status(422).json({ error: e.message, code: e.code }); return; }
  next(e);
}

router.get('/', exigirFuncion(FN_LISTAR), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await listarProveedoresConCostos());
  } catch (e) { manejar(e, res, next); }
});

// `editar` exige las dos funciones de escritura porque la vista escribe por las dos rutas (POST fija, PATCH cambia/cierra).
router.get('/:proveedorId', exigirFuncion(FN_LISTAR), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  try {
    const vista = await vistaCostosProveedor(proveedorId);
    const concedidas = await funcionesConcedidas(req, [FN_CREAR, FN_EDITAR, FN_HISTORIAL]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...vista,
      capacidades: { editar: concedidas.has(FN_CREAR) && concedidas.has(FN_EDITAR), verHistorial: concedidas.has(FN_HISTORIAL) },
    });
  } catch (e) { manejar(e, res, next); }
});

router.get('/:proveedorId/historial', exigirFuncion(FN_HISTORIAL), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  const parsed = historialQuerySchema.safeParse(req.query);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await historialCostosProveedor(proveedorId, parsed.data.concepto));
  } catch (e) { manejar(e, res, next); }
});

router.post('/:proveedorId/vigencias', exigirFuncion(FN_CREAR), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  const parsed = fijarSchema.safeParse(req.body);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    const vigencia = await fijarCosto({ proveedorId, ...parsed.data }, req.user?.sub ?? null);
    res.status(201).json(vigencia);
  } catch (e) { manejar(e, res, next); }
});

router.patch('/vigencias/:vigenciaId', exigirFuncion(FN_EDITAR), async (req: Request, res: Response, next: NextFunction) => {
  const vigenciaId = uuidDe(req, res, 'vigenciaId');
  if (vigenciaId === null) return;
  const parsed = parsearCambios(req.body);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    res.json(await cambiarOCerrarCosto(vigenciaId, parsed.data, req.user?.sub ?? null));
  } catch (e) { manejar(e, res, next); }
});

export default router;
