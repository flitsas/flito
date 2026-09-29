// FLITO sync — rutas del acceso de FLITO a FLIT 2 (Feature #13057, HU #13061).
// Montado en `app.ts` como `/api/flito/sync/flit2`, ANTES de `/api/flito/sync`.
//
//   GET /acceso   `tramites.flit2.ver_acceso`      → Flit2AccesoMeta (200 también sin acceso)
//   PUT /acceso   `tramites.flit2.guardar_acceso`  → Flit2AccesoMeta · 400 · 409 · 503 llave_maestra
//
// Ninguna respuesta —tampoco las de error— lleva la contraseña ni un fragmento suyo. El `POST
// /acceso/probar` llega con la HU #13063.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { guardarAcceso, obtenerMetaAcceso } from './flit2-acceso.service.js';
import { Flit2Error } from './flit2.errors.js';

const router = Router();
router.use(authMiddleware);

/**
 * `PUT` del acceso: 10 por minuto y usuario (patrón del token SIMIT). Va después de las guardas:
 * quien no las pasa no consume cuota.
 */
const accesoLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flit2-acceso'),
  message: { error: 'Demasiadas actualizaciones del acceso a FLIT 2, espere 1 minuto' },
  store: makeStore('rl:flit2-acceso:'),
});

const FALTA_CLIENT_ID = 'Falta el usuario de servicio (clientId).';
const FALTA_SECRET = 'Falta la contraseña del usuario de servicio (clientSecret).';

/** `.strict()`: una clave de más es un error de dedo, no un campo que se ignora en silencio. */
const accesoSchema = z.object({
  clientId: z.string({ required_error: FALTA_CLIENT_ID, invalid_type_error: FALTA_CLIENT_ID })
    .trim()
    .min(1, FALTA_CLIENT_ID)
    .max(120, 'El usuario de servicio admite como máximo 120 caracteres.'),
  // Sin `.trim()`: la contraseña se guarda tal cual la entrega FLIT 2. Solo se rechaza la vacía o en blanco.
  clientSecret: z.string({ required_error: FALTA_SECRET, invalid_type_error: FALTA_SECRET })
    .max(512, 'La contraseña admite como máximo 512 caracteres.')
    .refine((v) => v.trim().length > 0, FALTA_SECRET),
}).strict();

/**
 * 400 con los MENSAJES de las reglas, nunca con lo recibido: `issues` de Zod no llevan el valor,
 * y se arma la lista a mano para que ningún `received` ni eco del cuerpo viaje en la respuesta.
 */
function datosInvalidos(res: Response, error: z.ZodError): void {
  const faltantes = error.issues.map((i) => (i.code === 'unrecognized_keys'
    ? `Campo no admitido: ${i.keys.join(', ')}.`
    : i.message));
  res.status(400).json({ error: 'Datos inválidos', codigo: 'datos_invalidos', faltantes: [...new Set(faltantes)] });
}

function fallo(res: Response, e: unknown): void {
  if (e instanceof Flit2Error) {
    res.status(e.status).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

router.get('/acceso', exigirFuncion('tramites.flit2.ver_acceso'), async (_req: Request, res: Response) => {
  res.json(await obtenerMetaAcceso());
});

router.put('/acceso', exigirFuncion('tramites.flit2.guardar_acceso'), accesoLimiter, async (req: Request, res: Response) => {
  const parsed = accesoSchema.safeParse(req.body ?? {});
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  try {
    const { id, meta } = await guardarAcceso(parsed.data.clientId, parsed.data.clientSecret, req.user?.sub ?? null);
    // Solo el usuario de servicio: la contraseña no entra en `audit_logs` ni recortada.
    await audit(req, {
      action: 'update',
      resource: 'flit2_acceso',
      resourceId: String(id),
      detail: `flit2.acceso.guardar: acceso a FLIT 2 guardado (clientId=${meta.clientId ?? '?'})`,
    });
    res.json(meta);
  } catch (e) { fallo(res, e); }
});

export default router;
