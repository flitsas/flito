// FLITO sync — interruptor por fuente de la sincronización FLIT (HU #13237, Feature #13236). Se monta
// desde `flito-sync.routes.ts` (`router.use`), así que responde en `/api/flito/sync/interruptores`.
//
//   PUT /interruptores/:fuente  `tramites.sincronizacion.configurar` → 200 InterruptorFuente · 400 datos_invalidos
//                               · 401 sin sesión · 403 sin la función
//   GET /interruptores          montado desde `flito-sync-interruptores-lectura.routes.ts` (mismo código)
//
// Fichero propio en la lista del inventario de guardas (`inventario-guardas.ts`), con UNA guarda: la
// del PUT. El GET reutiliza el código en un fichero fuera de la lista (como `flit2-probar.routes.ts`).
// `flito-sync.routes.ts` conserva sus dos guardas. Nada de credenciales de FLIT 2 en la respuesta.
// Cada PUT se audita, también al mismo valor, con fuente y par anterior → nuevo, sin PII (AC10).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  detalleAuditoriaInterruptor, esFuenteSincronizacion, guardarInterruptor,
} from './flito-sync-interruptor.service.js';
import lecturaRouter from './flito-sync-interruptores-lectura.routes.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

const FUENTE_INVALIDA = 'La fuente debe ser flit1 o flit2.';
const ENCENDIDO_INVALIDO = 'El campo encendido debe ser true o false.';

/** `.strict()`: una clave de más es un error de dedo, no un campo que se ignora en silencio. */
const interruptorSchema = z.object({
  encendido: z.boolean({ required_error: ENCENDIDO_INVALIDO, invalid_type_error: ENCENDIDO_INVALIDO }),
}).strict();

/** 400 con los mensajes de las reglas, nunca con lo recibido (calco de `flit2.routes.ts`). */
function datosInvalidos(res: Response, faltantes: string[]): void {
  res.status(400).json({ error: 'Datos inválidos', codigo: 'datos_invalidos', faltantes: [...new Set(faltantes)] });
}

router.put('/interruptores/:fuente', exigirFuncion('tramites.sincronizacion.configurar'), async (req: Request, res: Response, next: NextFunction) => {
  const faltantes: string[] = [];
  const fuente = req.params.fuente;
  if (!esFuenteSincronizacion(fuente)) faltantes.push(FUENTE_INVALIDA);
  const parsed = interruptorSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      faltantes.push(i.code === 'unrecognized_keys' ? `Campo no admitido: ${i.keys.join(', ')}.` : i.message);
    }
  }
  if (!esFuenteSincronizacion(fuente) || !parsed.success) { datosInvalidos(res, faltantes); return; }

  try {
    const { anterior, actual } = await guardarInterruptor(fuente, parsed.data.encendido, req.user?.sub ?? null);
    await audit(req, {
      action: 'update',
      resource: 'flito_sync_interruptor',
      resourceId: fuente,
      detail: detalleAuditoriaInterruptor(fuente, anterior, parsed.data.encendido),
    });
    res.json(actual);
  } catch (e) {
    next(e);
  }
});

// GET /interruptores — ver la cabecera de `flito-sync-interruptores-lectura.routes.ts`.
router.use(lecturaRouter);

export default router;
