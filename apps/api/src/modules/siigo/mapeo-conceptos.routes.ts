// Siigo API — mapeo de conceptos a productos (HU #11282). Montado en /api/siigo/mapeo-conceptos.
//
// AC8 — quién escribe:
//   · Editar el mapeo (producto, clasificación, impuestos, unidad, terceros): SOLO `admin`.
//   · Marcar la confirmación de contabilidad: `admin` y `financiera`. Es una firma contable, y
//     Finanzas es quien la da; por eso tiene endpoint propio en vez de ser un campo más del PATCH.
//   · Los demás roles pueden LEER (auditoría necesita ver la parametrización que respalda una
//     factura) pero no escriben nada.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`, y no hay forma de que un `return` temprano se
// salte la comprobación.
//
// Archivo propio de esta HU. La HU #11281 (catálogos) trae su propio router de parametrización de
// Siigo; unificarlos es trabajo del merge, no de aquí.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CLASIFICACIONES_TRIBUTARIAS, CONCEPTOS_FACTURABLES, CODIGO_PRODUCTO_SIIGO_RE,
} from '@operaciones/shared-types';
import rateLimit from 'express-rate-limit';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import {
  actualizarMapeo, confirmarMapeo, crearMapeoEspecifico, desactivarMapeoEspecifico,
  estadoMapeo, listarMapeo, obtenerMapeo, revalidarMapeo, SiigoMapeoError,
  type MapeoConcepto,
} from './mapeo-conceptos.service.js';
import { crearProductoDeConcepto } from './crear-producto.service.js';

const router = Router();
router.use(authMiddleware);

// Lectura: administración, auditoría y finanzas. Ver la parametrización que respalda una factura
// emitida es parte del trabajo de auditar, y no expone ningún secreto.
const LECTURA = requireRole('admin', 'auditor', 'financiera');
// Escritura del mapeo: solo administración (AC8).
const ESCRITURA = requireRole('admin');
// La confirmación contable la firma también Finanzas (AC8).
const CONFIRMACION = requireRole('admin', 'financiera');

const ambienteSchema = z.enum(['pruebas', 'produccion']);

/** Ambiente de la petición. Sin `?ambiente=`, el del entorno: nunca «todos». */
function ambienteDe(req: Request): SiigoAmbiente {
  const parsed = ambienteSchema.safeParse(req.query.ambiente);
  return parsed.success ? parsed.data : env.SIIGO_AMBIENTE;
}

const impuestoSchema = z.object({
  id: z.number().int().positive(),
  nombre: z.string().max(120).nullable().optional(),
  porcentaje: z.number().min(0).max(100).nullable().optional(),
});

const camposEditablesSchema = z.object({
  codigoProducto: z.string().regex(CODIGO_PRODUCTO_SIIGO_RE,
    'El código de producto de Siigo es alfanumérico, sin espacios y de máximo 30 caracteres').nullable().optional(),
  nombreProducto: z.string().max(200).nullable().optional(),
  clasificacionTributaria: z.enum(CLASIFICACIONES_TRIBUTARIAS).nullable().optional(),
  impuestos: z.array(impuestoSchema).max(20).optional(),
  unidadMedida: z.string().max(20).nullable().optional(),
  ingresoParaTerceros: z.boolean().optional(),
  facturaLineaPropia: z.boolean().optional(),
  lineaPropiaPendiente: z.boolean().optional(),
  notas: z.string().max(1000).nullable().optional(),
  activo: z.boolean().optional(),
});

const crearSchema = camposEditablesSchema.extend({
  ambiente: ambienteSchema.optional(),
  concepto: z.enum(CONCEPTOS_FACTURABLES),
  tipoTramite: z.string().trim().min(1).max(60),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Traduce el error de negocio del mapeo a un status. */
export function statusDeMapeoError(e: SiigoMapeoError): number {
  switch (e.codigo) {
    case 'no_existe': return 404;
    case 'duplicado': return 409;
    case 'no_editable': return 409;
    // El dato es sintácticamente válido pero no existe en Siigo (HU #11283, AC1-AC3). No es 400:
    // el cuerpo está bien formado; lo que falla es una comprobación contra un sistema externo.
    case 'validacion': return 422;
    // Siigo no respondió (AC6). 503 y no 4xx: el cliente no tiene nada que corregir, y reintentar
    // más tarde es exactamente la acción correcta. Confundirlo con un 422 mandaría a quien
    // parametriza a cambiar un código que probablemente estaba bien.
    case 'no_verificable': return 503;
    // Ya hay una revalidación corriendo para ese ambiente (HU #11283). Conflicto de estado, no
    // error del cliente: reintentar cuando termine es la acción correcta.
    case 'en_curso': return 409;
    default: return 400;
  }
}

/** `SiigoMapeoError` es de negocio; cualquier otra cosa sube al error handler de la app. */
function mapeoFallo(res: Response, e: unknown): void {
  if (e instanceof SiigoMapeoError) {
    res.status(statusDeMapeoError(e)).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

/**
 * Resumen de auditoría de una fila. Nombres de campo y banderas, nada de PII: el mapeo no contiene
 * datos de persona, pero el hábito de volcar la fila entera al `detail` es cómo se filtran.
 */
function resumen(m: MapeoConcepto): string {
  return `ambiente=${m.ambiente} concepto=${m.concepto} tipo=${m.tipoTramite ?? '(generico)'} `
    + `producto=${m.codigoProducto ?? '(sin)'} clasificacion=${m.clasificacionTributaria ?? '(sin)'} `
    + `impuestos=${m.impuestos.length} terceros=${m.ingresoParaTerceros} confirmado=${m.confirmadoContabilidad} `
    + `validacion=${m.validacionEstado}`;
}

// GET / — mapeo completo del ambiente.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ambiente = ambienteDe(req);
  const incluirInactivos = req.query.incluirInactivos === 'true';
  const data = await listarMapeo(ambiente, { incluirInactivos });
  res.json({ ambiente, data });
});

// GET /estado — cuánto falta para poder facturar en este ambiente.
router.get('/estado', LECTURA, async (req: Request, res: Response) => {
  res.json(await estadoMapeo(ambienteDe(req)));
});

/**
 * Freno propio de la revalidación (hallazgo Alta de la auditoría de esta HU).
 *
 * `apiLimiter` (500 cada 15 min) no sirve aquí: lo que hay que contener no son peticiones a FLITO
 * sino peticiones a SIIGO. Cada código distinto del mapeo gasta un cupo de los 100 por minuto que
 * Siigo concede POR EMPRESA, y esa cuota es la misma que usa la emisión de facturas. Peor aún, el
 * excedente ESPERA en vez de descartarse (`siigo.resiliencia.ts`), así que una revalidación grande
 * no falla: encola detrás de sí cualquier factura que llegue mientras dura.
 *
 * Sin este límite, un usuario autenticado que ni siquiera puede editar el mapeo podría frenar la
 * facturación ante la DIAN varios minutos sin tocar un solo dato. Mismo orden de magnitud que
 * `laft-sync` (2/hora), del que se copia el patrón.
 */
const revalidacionLimiter = rateLimit({
  windowMs: 3_600_000,
  max: 4,
  keyGenerator: userOrIpKey('siigo-reval'),
  message: { error: 'La revalidación contra Siigo está limitada a 4 por hora.' },
  // Con store en memoria el tope sería POR PROCESO y se reiniciaría en cada despliegue. Hoy da
  // igual —PM2 corre una instancia— pero el freno se degradaría en silencio al escalar.
  store: makeStore('rl:siigo-reval:'),
});

// POST /revalidar — vuelve a comprobar contra Siigo todo lo ya configurado (HU #11283, AC7).
//
// Va ANTES de las rutas `/:id` para que Express no lo capture como un identificador. Es POST y no
// GET porque escribe: deja el veredicto en cada fila, que es lo que permite que la pantalla señale
// los conceptos con novedad sin volver a lanzar la revalidación.
//
// Permiso: SOLO `admin`. Se consideró abrirlo a `financiera` —quien firma la confirmación contable
// tiene interés legítimo en revalidar— y se descartó: esta ruta ESCRIBE en `siigo_mapeo_conceptos`
// (estado de validación y `updated_by`), y el AC8 de la HU #11282 reserva la escritura del mapeo a
// `admin`. Ampliarlo requeriría una decisión escrita del Líder Técnico, no una elección de quien
// implementa; además dejaría a `financiera` figurando como último editor de la parametrización.
// El orden importa: la guarda de rol va ANTES del limitador. Lo que este freno protege es la cuota
// de Siigo, y una petición rechazada por rol no consume ni una llamada — cobrarle cupo dejaría que
// un rol sin permiso agotara el presupuesto de quien sí lo tiene.
router.post('/revalidar', ESCRITURA, revalidacionLimiter, async (req: Request, res: Response) => {
  const ambiente = ambienteDe(req);
  const usuarioId = req.user?.sub as number;

  try {
    const r = await revalidarMapeo(ambiente, usuarioId);
    await audit(req, {
      action: 'update', resource: 'siigo_mapeo_concepto', resourceId: `revalidacion:${ambiente}`,
      detail: `Revalidación contra Siigo · ambiente=${ambiente} revisados=${r.revisados} `
        + `conNovedad=${r.conNovedad.length} noVerificados=${r.noVerificados.length} `
        + `truncado=${r.truncado}`,
    });
    res.json(r);
  } catch (e) { mapeoFallo(res, e); }
});

// POST / — configuración específica por tipo de trámite (AC5). La genérica ya existe: se edita.
router.post('/', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const usuarioId = req.user?.sub as number;
  const { ambiente, ...resto } = parsed.data;

  try {
    const creado = await crearMapeoEspecifico(
      { ...resto, ambiente: ambiente ?? env.SIIGO_AMBIENTE }, usuarioId,
    );
    await audit(req, {
      action: 'create', resource: 'siigo_mapeo_concepto', resourceId: creado.id,
      detail: `Alta de configuración específica · ${resumen(creado)}`,
    });
    res.status(201).json(creado);
  } catch (e) { mapeoFallo(res, e); }
});

/**
 * Freno de la creación de productos (HU #11286).
 *
 * Cada intento gasta al menos dos peticiones de la cuota de Siigo —la búsqueda previa y la
 * creación— y esa cuota se comparte con la emisión de facturas. Además, a diferencia de una
 * consulta, esto ESCRIBE en el catálogo de la empresa: un bucle accidental dejaría productos
 * basura que no se pueden borrar, solo desactivar.
 *
 * Diez por hora y no treinta: la frecuencia esperada son seis —uno por concepto facturable— más
 * reintentos. El tope de una escritura irreversible se dimensiona por lo que hace falta, no por lo
 * que parece cómodo.
 */
const creacionProductoLimiter = rateLimit({
  windowMs: 3_600_000,
  max: 10,
  keyGenerator: userOrIpKey('siigo-crear-producto'),
  message: { error: 'La creación de productos en Siigo está limitada a 10 por hora.' },
  store: makeStore('rl:siigo-crear-producto:'),
});

const crearProductoSchema = z.object({
  // Opcional: si no viene, se propone el sugerido del concepto y se valida igual (AC1).
  codigo: z.string().regex(CODIGO_PRODUCTO_SIIGO_RE,
    'El código de producto de Siigo es alfanumérico, sin espacios y de máximo 30 caracteres').optional(),
  nombre: z.string().min(1).max(200).optional(),
  grupoInventarioCodigo: z.string().min(1).max(60),
});

// POST /:id/producto — crea en Siigo el producto que le falta al concepto y lo vincula (HU #11286).
//
// Escritura del mapeo: solo `admin`, igual que el resto de ediciones (AC8 de la HU #11282). Crear
// un producto en el catálogo de la empresa es más consecuente que editar una fila, no menos.
router.post('/:id/producto', ESCRITURA, creacionProductoLimiter, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = crearProductoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const usuarioId = req.user?.sub as number;

  try {
    const r = await crearProductoDeConcepto(req.params.id, parsed.data, usuarioId);
    await audit(req, {
      action: 'create', resource: 'siigo_producto', resourceId: r.codigo,
      detail: `${r.desenlace === 'creado' ? 'Producto creado en Siigo' : 'Producto existente vinculado'} `
        + `· ambiente=${r.ambiente} modo=${r.modo} codigo=${r.codigo} mapeo=${req.params.id}`,
    });
    res.status(r.desenlace === 'creado' ? 201 : 200).json(r);
  } catch (e) { mapeoFallo(res, e); }
});

// GET /:id — una fila concreta.
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    res.json(await obtenerMapeo(req.params.id));
  } catch (e) { mapeoFallo(res, e); }
});

// PATCH /:id — edita el mapeo. Puede tumbar la confirmación de contabilidad (AC4).
router.patch('/:id', ESCRITURA, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = camposEditablesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const usuarioId = req.user?.sub as number;

  try {
    const r = await actualizarMapeo(req.params.id, parsed.data, usuarioId);
    // AC8 — la auditoría lleva el valor ANTERIOR además del nuevo; sin él, un registro de cambio no
    // permite reconstruir qué se tocó.
    await audit(req, {
      action: 'update', resource: 'siigo_mapeo_concepto', resourceId: r.mapeo.id,
      detail: `Antes: ${resumen(r.anterior)} · Después: ${resumen(r.mapeo)}`
        + (r.confirmacionRevertidaPor.length > 0
          ? ` · Confirmación revertida por cambio en: ${r.confirmacionRevertidaPor.join(', ')}` : ''),
    });
    res.json(r.mapeo);
  } catch (e) { mapeoFallo(res, e); }
});

// POST /:id/confirmar — firma de contabilidad (AC4, AC8). También la aplica `financiera`.
router.post('/:id/confirmar', CONFIRMACION, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const usuarioId = req.user?.sub as number;

  try {
    const r = await confirmarMapeo(req.params.id, usuarioId);
    await audit(req, {
      action: 'update', resource: 'siigo_mapeo_concepto', resourceId: r.mapeo.id,
      detail: `Confirmación de contabilidad · Antes: confirmado=${r.anterior.confirmadoContabilidad} `
        + `· Después: ${resumen(r.mapeo)}`,
    });
    res.json(r.mapeo);
  } catch (e) { mapeoFallo(res, e); }
});

// DELETE /:id — desactiva una configuración específica. Las genéricas no se eliminan (AC1).
router.delete('/:id', ESCRITURA, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const usuarioId = req.user?.sub as number;

  try {
    const desactivado = await desactivarMapeoEspecifico(req.params.id, usuarioId);
    await audit(req, {
      action: 'delete', resource: 'siigo_mapeo_concepto', resourceId: desactivado.id,
      detail: `Desactivada (activo=false) · ${resumen(desactivado)}`,
    });
    res.json({ success: true, mapeo: desactivado });
  } catch (e) { mapeoFallo(res, e); }
});

export default router;
