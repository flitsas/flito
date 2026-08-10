// Siigo — corrección de una factura ya emitida (HU #11343). Montado en /api/siigo/correcciones.
//
// AC7 — quién entra. Registrar una corrección es afirmar que un documento ante la DIAN se tocó, así
// que escriben `admin` y `financiera`; `auditor` lee y no escribe, que es lo que significa auditar.
//
// **Por qué `requireRole` y no una página de permisos.** El modelo de páginas y grants de la
// operación de facturación lo define la HU #11342, que va en paralelo y todavía no está en esta
// rama. Inventar aquí una clave de permiso obligaría a las dos historias a acordarla por telepatía y
// dejaría la peor versión del error: dos fuentes de verdad sobre quién puede tocar una factura.
// Cuando #11342 aterrice, esta guarda se sustituye por la suya — y hasta entonces la ruta NO está
// abierta, que es lo que importa.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  SIIGO_CORRECCION_MOTIVO_MAX, SIIGO_CORRECCION_MOTIVO_MIN, SIIGO_CORRECCION_TIPOS,
} from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  consultarCorrecciones, correccionesDeTramites, registrarCorreccion, SiigoCorreccionError,
} from './correcciones.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
/** Registrar una corrección es una escritura sobre la historia fiscal: auditor queda fuera. */
const ESCRITURA = requireRole('admin', 'financiera');

const idSchema = z.string().uuid();

const cuerpoSchema = z.object({
  tipo: z.enum(SIIGO_CORRECCION_TIPOS),
  documentoSiigo: z.string().trim().min(1).max(100),
  // AC3 — obligatorio, y con fondo: es lo único que explicará después una corrección de tipo `otra`.
  motivo: z.string().trim().min(SIIGO_CORRECCION_MOTIVO_MIN).max(SIIGO_CORRECCION_MOTIVO_MAX),
  // Cuándo se hizo EN SIIGO. Opcional porque lo normal es registrarla el mismo día; el servicio
  // rechaza el futuro, que es el error que de verdad se comete.
  fechaCorreccion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Tope de la consulta en lote: la bandeja pagina, y una lista sin techo es un escaneo disfrazado. */
const MAX_TRAMITES = 200;

const tramitesSchema = z.object({
  ids: z.string().min(1).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
}).refine((v) => v.ids.length <= MAX_TRAMITES, `Máximo ${MAX_TRAMITES} trámites por consulta`)
  .refine((v) => v.ids.every((id) => idSchema.safeParse(id).success), 'Hay identificadores inválidos');

function statusDeError(e: SiigoCorreccionError): number {
  switch (e.codigo) {
    case 'no_existe': return 404;
    // El cuerpo es válido pero la factura no admite lo que se pide: es un conflicto con el estado
    // del recurso, no un error de sintaxis. Un 400 aquí haría pensar que se escribió mal.
    case 'no_corregible': return 409;
    case 'duplicada': return 409;
    default: return 400;
  }
}

function fallo(res: Response, e: unknown): void {
  if (e instanceof SiigoCorreccionError) {
    res.status(statusDeError(e)).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

// GET /factura/:facturaId — qué correcciones admite y cuáles ya se registraron (AC1, AC4).
router.get('/factura/:facturaId', LECTURA, async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.facturaId);
  if (!id.success) {
    res.status(400).json({ error: 'Identificador de factura inválido' });
    return;
  }
  try {
    res.json(await consultarCorrecciones(id.data));
  } catch (e) { fallo(res, e); }
});

// POST /factura/:facturaId — registra una corrección hecha por fuera de FLITO (AC2, AC3, AC6, AC7).
router.post('/factura/:facturaId', ESCRITURA, async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.facturaId);
  if (!id.success) {
    res.status(400).json({ error: 'Identificador de factura inválido' });
    return;
  }
  const parsed = cuerpoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const usuarioId = (req.user?.sub as number | undefined) ?? null;

  try {
    const c = await registrarCorreccion(id.data, parsed.data, usuarioId);
    // AC7 — toda corrección registrada queda atribuida. El detalle lleva el tipo y el documento,
    // que es lo mínimo para ir a comprobarla en Siigo sin abrir la tabla.
    await audit(req, {
      action: 'create', resource: 'siigo_factura_correcciones', resourceId: c.id,
      detail: `Corrección ${c.tipo} de la factura ${id.data} · documento ${c.documentoSiigo} · ${c.fechaCorreccion}`,
    });
    res.status(201).json(c);
  } catch (e) { fallo(res, e); }
});

// GET /tramites?ids=a,b,c — lo que consultan el reporte y la bandeja para no listar como pendiente
// un trámite que ya se corrigió (AC4).
router.get('/tramites', LECTURA, async (req: Request, res: Response) => {
  const parsed = tramitesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Consulta inválida', details: parsed.error.flatten() });
    return;
  }
  try {
    res.json({ data: await correccionesDeTramites(parsed.data.ids) });
  } catch (e) { fallo(res, e); }
});

export default router;
