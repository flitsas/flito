// FLITO sync — interruptor por fuente de la sincronización FLIT (HU #13237, Feature #13236). Se monta
// desde `flito-sync.routes.ts` (`router.use`), así que responde en `/api/flito/sync/interruptores`.
//
//   PUT /interruptores/:fuente  `tramites.sincronizacion.configurar` → 200 InterruptorFuente · 400 datos_invalidos
//                               · 401 sin sesión · 403 sin la función
//   PUT /flit1/parametros-lectura  `tramites.sincronizacion.configurar` → 200 ParametrosLecturaFlit1
//                               · 400 datos_invalidos (con `campos`) · 401 · 403   (HU #13628)
//   GET /interruptores, GET /flit1/parametros-lectura y GET /flit1/estado-lectura: montados desde
//                               `flito-sync-interruptores-lectura.routes.ts`
//
// Fichero propio en la lista del inventario de guardas (`inventario-guardas.ts`), con DOS guardas de la
// misma función: los dos PUT. Los GET reutilizan el código en un fichero fuera de la lista (como
// `flit2-probar.routes.ts`).
// `flito-sync.routes.ts` conserva sus dos guardas. Nada de credenciales de FLIT 2 en la respuesta.
// Cada PUT se audita, también al mismo valor, con fuente y par anterior → nuevo, sin PII (AC10).
// Los parámetros de FLIT 1 (HU #13628) se auditan con los cuatro pares anterior → nuevo, sin PII (AC7);
// un 400 no llama al servicio ni escribe nada (AC3-AC5).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { mensajesDeTipo } from '../../shared/utils/zod-mensajes.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  detalleAuditoriaInterruptor, esFuenteSincronizacion, guardarInterruptor,
} from './flito-sync-interruptor.service.js';
import {
  LIMITES_PARAMETROS_LECTURA_FLIT1, type ParametrosLecturaFlit1Input,
} from '@operaciones/shared-types';
import {
  detalleAuditoriaParametrosFlit1, guardarParametrosLecturaFlit1, mensajeRango, problemasParametrosFlit1,
} from './flito-sync-flit1-parametros.service.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';
import lecturaRouter from './flito-sync-interruptores-lectura.routes.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

const FUENTE_INVALIDA = 'La fuente debe ser flit1 o flit2.';
const ENCENDIDO_INVALIDO = 'El campo encendido debe ser true o false.';

/** `.strict()`: una clave de más es un error de dedo, no un campo que se ignora en silencio. */
const interruptorSchema = z.object({
  encendido: z.boolean({ error: mensajesDeTipo({ requerido: ENCENDIDO_INVALIDO, tipo: ENCENDIDO_INVALIDO }) }),
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

type CampoParametro = keyof ParametrosLecturaFlit1Input;
const CAMPOS_PARAMETROS: readonly CampoParametro[] = ['frecuenciaMinutos', 'ventanaDias', 'ventanaNocturnaDias', 'arranque'];
const ARRANQUE_INVALIDO = 'arranque debe ser una fecha real con formato AAAA-MM-DD.';

const entero = (campo: keyof typeof LIMITES_PARAMETROS_LECTURA_FLIT1) => {
  const msg = mensajeRango(campo);
  const { min, max } = LIMITES_PARAMETROS_LECTURA_FLIT1[campo];
  return z.number({ error: mensajesDeTipo({ requerido: msg, tipo: msg }) }).int(msg).min(min, msg).max(max, msg);
};

/** HU #13628: los cuatro obligatorios; `arranque` no admite null (decisión del hilo, AC1 es solo lectura). */
const parametrosSchema = z.object({
  frecuenciaMinutos: entero('frecuenciaMinutos'),
  ventanaDias: entero('ventanaDias'),
  ventanaNocturnaDias: entero('ventanaNocturnaDias'),
  arranque: z.string({ error: mensajesDeTipo({ requerido: ARRANQUE_INVALIDO, tipo: ARRANQUE_INVALIDO }) }),
}).strict();

const orden = (c: string) => { const i = (CAMPOS_PARAMETROS as readonly string[]).indexOf(c); return i < 0 ? CAMPOS_PARAMETROS.length : i; };

/** 400 que además nombra los campos inválidos, en el orden fijo del contrato. Nunca repite lo recibido. */
function parametrosInvalidos(res: Response, problemas: { campo: string; mensaje: string }[]): void {
  const campos = [...new Set(problemas.map((p) => p.campo))].sort((a, b) => orden(a) - orden(b));
  res.status(400).json({
    error: 'Datos inválidos', codigo: 'datos_invalidos', campos, faltantes: [...new Set(problemas.map((p) => p.mensaje))],
  });
}

router.put('/flit1/parametros-lectura', exigirFuncion('tramites.sincronizacion.configurar'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = parametrosSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    parametrosInvalidos(res, parsed.error.issues.flatMap((i) => (i.code === 'unrecognized_keys'
      ? i.keys.map((k) => ({ campo: k, mensaje: `Campo no admitido: ${i.keys.join(', ')}.` }))
      : [{ campo: String(i.path[0] ?? 'body'), mensaje: i.message }])));
    return;
  }
  const problemas = problemasParametrosFlit1(parsed.data, hoyColombia());
  if (problemas.length > 0) { parametrosInvalidos(res, problemas); return; }

  try {
    const { anterior, actual } = await guardarParametrosLecturaFlit1(parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'update',
      resource: 'flito_sync_flit1_lectura',
      resourceId: 'flit1',
      detail: detalleAuditoriaParametrosFlit1(anterior, parsed.data),
    });
    res.json(actual);
  } catch (e) {
    next(e);
  }
});

// GET /interruptores y los GET de FLIT 1 — ver la cabecera de `flito-sync-interruptores-lectura.routes.ts`.
router.use(lecturaRouter);

export default router;
