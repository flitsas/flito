// Siigo API — configuración global de emisión (HU #11284). Montado en /api/siigo/config-emision.
//
// AC7 — quién escribe: SOLO `admin`. Lectura para `admin`, `auditor` y `financiera`, por el mismo
// motivo que en el mapeo de conceptos: ver la parametrización que respalda una factura emitida es
// parte de auditar, y aquí no hay ningún secreto — son códigos de catálogo, no credenciales.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`.
//
// Archivo propio, como el de mapeo de conceptos. Unificar los tres routers de parametrización de
// Siigo (`parametrizacion`, `mapeo-conceptos`, `config-emision`) es deuda declarada del Feature.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ESTRATEGIAS_NUMERACION } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import {
  estadoConfigEmision, guardarConfigEmision, historialConfigEmision, obtenerConfigEmision,
  resumenConfig, SiigoConfigEmisionError,
} from './config-emision.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
/** AC7 — guardar la configuración de emisión es solo de administración. */
const ESCRITURA = requireRole('admin');

const ambienteSchema = z.enum(['pruebas', 'produccion']);
const consultaSchema = z.object({ ambiente: ambienteSchema.optional() });

/**
 * Ambiente de la petición. Sin `?ambiente=`, el del entorno: nunca «todos».
 *
 * Un valor mal escrito se RECHAZA, no se ignora. Descartarlo y caer al ambiente por defecto es
 * fallar abierto: un `?ambiente=prubas` en el `PUT`, escrito para tocar pruebas, reescribiría en
 * silencio la configuración del ambiente del despliegue — en producción, la parametrización con la
 * que se emiten documentos ante la DIAN. Es además lo que ya hace `parametrizacion.routes.ts`.
 */
function ambienteDe(req: Request): SiigoAmbiente {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new SiigoConfigEmisionError('datos',
      'El ambiente debe ser «pruebas» o «produccion».');
  }
  return parsed.data.ambiente ?? env.SIIGO_AMBIENTE;
}

/**
 * Cuerpo admitido. Los códigos son cadenas cortas porque son identificadores de catálogo; el
 * servicio comprueba que existan y estén activos, que es la validación que de verdad importa.
 *
 * `.nullable()` en los cuatro: borrar un valor es una operación legítima —dejar la configuración
 * incompleta a propósito mientras se decide— y distinta de no tocarlo.
 */
const cuerpoSchema = z.object({
  documentoTipoCodigo: z.string().min(1).max(60).nullable().optional(),
  vendedorCodigo: z.string().min(1).max(60).nullable().optional(),
  formaPagoCodigo: z.string().min(1).max(60).nullable().optional(),
  centroCostoCodigo: z.string().min(1).max(60).nullable().optional(),
  // AC4 — días, con cero por defecto. El tope replica el CHECK de la migración.
  plazoVencimientoDias: z.number().int().min(0).max(365).optional(),
  // AC5 — el enum tiene un solo valor a propósito; ampliarlo exige migración y decisión.
  estrategiaNumeracion: z.enum(ESTRATEGIAS_NUMERACION).optional(),
  notas: z.string().max(1000).nullable().optional(),
});

function statusDeError(e: SiigoConfigEmisionError): number {
  switch (e.codigo) {
    case 'no_existe': return 404;
    // El catálogo no está sincronizado: no es culpa del cuerpo de la petición, falta un paso previo
    // de la parametrización. 409 lo dice mejor que un 400.
    case 'catalogo': return 409;
    // Otro usuario guardó mientras editabas. Conflicto de concurrencia recuperable reintentando,
    // no un fallo del servidor: sin esta traducción sale un 500 genérico.
    case 'conflicto': return 409;
    default: return 400;
  }
}

/** `SiigoConfigEmisionError` es de negocio; cualquier otra cosa sube al error handler de la app. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof SiigoConfigEmisionError) {
    res.status(statusDeError(e)).json({ error: e.message, codigo: e.codigo, campo: e.campo });
    return;
  }
  throw e;
}

// GET / — configuración vigente del ambiente, con su diagnóstico campo a campo (AC2).
router.get('/', LECTURA, async (req: Request, res: Response) => {
  try {
    const ambiente = ambienteDe(req);
    const config = await obtenerConfigEmision(ambiente);
    // `null` explícito y 200: «nadie la ha configurado» es una respuesta legítima, no un 404.
    res.json({ ambiente, config });
  } catch (e) { fallo(res, e); }
});

// GET /estado — qué falta para poder emitir (AC6). Lo consume la compuerta de la HU #11285.
router.get('/estado', LECTURA, async (req: Request, res: Response) => {
  try {
    res.json(await estadoConfigEmision(ambienteDe(req)));
  } catch (e) { fallo(res, e); }
});

// GET /historial — con qué parametrización salió cada factura. Las configuraciones no se pisan.
router.get('/historial', LECTURA, async (req: Request, res: Response) => {
  try {
    const ambiente = ambienteDe(req);
    res.json({ ambiente, data: await historialConfigEmision(ambiente) });
  } catch (e) { fallo(res, e); }
});

// PUT / — guarda la configuración (AC1, AC7). Inserta una fila nueva y apaga la anterior.
router.put('/', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = cuerpoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const usuarioId = req.user?.sub as number;

  try {
    // Dentro del try: `ambienteDe` rechaza un ambiente mal escrito, y ese rechazo tiene que salir
    // como 400 por `fallo`, no escaparse del handler.
    const ambiente = ambienteDe(req);
    const anterior = await obtenerConfigEmision(ambiente);
    const config = await guardarConfigEmision(parsed.data, usuarioId, ambiente);
    // AC7 — la auditoría lleva el valor ANTERIOR además del nuevo; sin él, un registro de cambio no
    // permite reconstruir qué se tocó.
    await audit(req, {
      action: 'update', resource: 'siigo_config_emision', resourceId: config.id,
      detail: anterior === null
        ? `Alta de configuración de emisión · ${resumenConfig(config)}`
        : `Antes: ${resumenConfig(anterior)} · Después: ${resumenConfig(config)}`,
    });
    res.json(config);
  } catch (e) { fallo(res, e); }
});

export default router;
