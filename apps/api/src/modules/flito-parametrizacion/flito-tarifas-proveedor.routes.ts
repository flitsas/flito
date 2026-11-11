// Épica #13763 (ADR-0041 §6) — `/api/flito/parametrizacion/tarifas-proveedores`: el costo que cada proveedor le cobra a FLIT.
// Montado en `app.ts` antes del router general y SIN `conAlcance`: `guardiaFrontera` da 403 a todo enlace distinto de
// `ninguno` aunque su rol tenga la función (R7, D9). Reutiliza las funciones de las tarifas al cliente (D8), sin funciones nuevas.
// Sin `logPiiAccess` (D10): no hay datos del titular; se proyecta id y nombre del proveedor (empresa), importes, fechas y el
// nombre del usuario interno. Nunca NIT ni datos de contacto.
//
// `audit()` en las tres mutaciones (fijar, cambiar, cerrar), tras el commit (D11): concepto, proveedor (id y nombre),
// valor anterior → nuevo e id de vigencia. Nunca NIT ni contacto.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CONCEPTOS_COSTO_PROVEEDOR, ETIQUETA_CONCEPTO_COSTO, MENSAJE_VALOR_COSTO_INVALIDO, TARIFA_VALOR_MAX, type VigenciaCostoProveedor,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { exigirFuncion, funcionesConcedidas } from '../../shared/middleware/exigir-funcion.js';
import {
  ProveedorNoActivoError, ServicioCostoNoPrestadoError, TarifaProveedorCambiadaError, TarifaProveedorProveedorNoEncontradoError,
  VigenciaCostoNoEncontradaError, cambiarOCerrarCosto, fijarCosto, historialCostosProveedor, listarProveedoresConCostos,
  vistaCostosProveedor, type CambiosCosto,
} from './flito-tarifas-proveedor.service.js';

const router = Router();
router.use(authMiddleware);

// Las guardas llevan el código literal (lo exige el lector de `inventario-guardas`); estas constantes son para `capacidades`.
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

const RECURSO_AUDIT = 'flito_tarifa_proveedor_vigencia';
const rotulo = (v: VigenciaCostoProveedor, proveedorNombre: string): string =>
  `${ETIQUETA_CONCEPTO_COSTO[v.concepto]} de ${proveedorNombre} (${v.proveedorId})`;

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

router.get('/', exigirFuncion('parametrizacion.tarifas.listar'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await listarProveedoresConCostos());
  } catch (e) { manejar(e, res, next); }
});

// `editar` exige las dos funciones de escritura porque la vista escribe por las dos rutas (POST fija, PATCH cambia/cierra).
router.get('/:proveedorId', exigirFuncion('parametrizacion.tarifas.listar'), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  try {
    const vista = await vistaCostosProveedor(proveedorId);
    const concedidas = await funcionesConcedidas(req, [FN_CREAR, FN_EDITAR, FN_HISTORIAL]);
    // Un proveedor inactivo o eliminado no se edita (RN-TP-05): la vista lo dice antes de que la escritura dé 409.
    const editable = vista.proveedor.activo && !vista.proveedor.eliminado;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...vista,
      capacidades: {
        editar: editable && concedidas.has(FN_CREAR) && concedidas.has(FN_EDITAR), verHistorial: concedidas.has(FN_HISTORIAL),
      },
    });
  } catch (e) { manejar(e, res, next); }
});

router.get('/:proveedorId/historial', exigirFuncion('parametrizacion.tarifas.historial'), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  const parsed = historialQuerySchema.safeParse(req.query);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await historialCostosProveedor(proveedorId, parsed.data.concepto));
  } catch (e) { manejar(e, res, next); }
});

router.post('/:proveedorId/vigencias', exigirFuncion('parametrizacion.tarifas.crear'), async (req: Request, res: Response, next: NextFunction) => {
  const proveedorId = uuidDe(req, res, 'proveedorId');
  if (proveedorId === null) return;
  const parsed = fijarSchema.safeParse(req.body);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    const { resultado: vigencia, proveedorNombre } = await fijarCosto({ proveedorId, ...parsed.data }, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: RECURSO_AUDIT, resourceId: vigencia.id,
      detail: `${rotulo(vigencia, proveedorNombre)} = ${vigencia.valor}, vigente desde ${vigencia.vigenteDesde}`,
    });
    res.status(201).json(vigencia);
  } catch (e) { manejar(e, res, next); }
});

router.patch('/vigencias/:vigenciaId', exigirFuncion('parametrizacion.tarifas.editar'), async (req: Request, res: Response, next: NextFunction) => {
  const vigenciaId = uuidDe(req, res, 'vigenciaId');
  if (vigenciaId === null) return;
  const parsed = parsearCambios(req.body);
  if (!parsed.success) { responderInvalido(res, parsed.error); return; }
  try {
    const { resultado: r, proveedorNombre } = await cambiarOCerrarCosto(vigenciaId, parsed.data, req.user?.sub ?? null);
    if (r.accion !== 'sin_cambio') {
      await audit(req, {
        action: 'update', resource: RECURSO_AUDIT, resourceId: r.vigencia.id,
        detail: r.accion === 'cerrada'
          ? `${rotulo(r.vigencia, proveedorNombre)} cerrada (dejar de cobrar); valor anterior ${r.valorAnterior} (vigencia ${r.vigencia.id})`
          : `${rotulo(r.vigencia, proveedorNombre)} de ${r.valorAnterior} a ${r.valorNuevo} (vigencia ${r.vigencia.id}, anterior ${vigenciaId})`,
      });
    }
    res.json(r);
  } catch (e) { manejar(e, res, next); }
});

export default router;
