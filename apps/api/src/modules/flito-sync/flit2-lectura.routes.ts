// FLITO sync — botón «Sincronizar FLIT 2» (HU #13091, Feature #13059). Se monta desde
// `flit2.routes.ts` (`router.use`), así que responde en `/api/flito/sync/flit2/sincronizar`.
//
//   POST /sincronizar  `sync.sync.lanzar` → 200 Flit2LecturaResultado (a los 60 s corta tras la página
//                        en curso y responde los totales parciales con `hasMore`, HU #13092 AC3)
//                      · 400 datos_invalidos (el cuerpo no admite claves: la fecha NO se elige)
//                      · 409 lectura_concurrente (otra corrida, del cron o de otro botón, tiene el
//                        candado: HU #13092 AC2) · 502 flit2_respuesta · 503 no_configurado /
//                        sin_acceso / rechazado / bloqueado / espera / no_responde · 429 limitador (6/min)
//
// Reutiliza el permiso del sync de FLIT 1 (0179, solo admin): no hace falta migración de siembra.
// Fichero aparte (como `flit2-probar.routes.ts`) porque el inventario de guardas exige un código por
// guarda en `flit2.routes.ts`. Ninguna respuesta lleva radicados, nombres ni documentos: solo totales.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { debeAuditarse, detalleAuditoria, leerConCandado, parcialDe } from './flit2-lectura.service.js';
import { Flit2Error } from './flit2.errors.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

/** 6 por minuto y usuario. Va después de la guarda: quien no la pasa no consume cuota. */
const lecturaLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flit2-lectura'),
  message: { error: 'Demasiadas sincronizaciones con FLIT 2, espere 1 minuto' },
  store: makeStore('rl:flit2-lectura:'),
});

/** Sin claves: ni `initialDate` ni ninguna otra. La lectura parte de su posición guardada (AC1). */
const cuerpoSchema = z.object({}).strict();

router.post('/sincronizar', exigirFuncion('sync.sync.lanzar'), lecturaLimiter, async (req: Request, res: Response) => {
  const parsed = cuerpoSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const faltantes = parsed.error.issues.map((i) => (i.code === 'unrecognized_keys'
      ? `Campo no admitido: ${i.keys.join(', ')}.`
      : i.message));
    res.status(400).json({ error: 'Datos inválidos', codigo: 'datos_invalidos', faltantes: [...new Set(faltantes)] });
    return;
  }

  try {
    const r = await leerConCandado('boton');
    // HU #13092 AC8: solo las corridas que trajeron ítems, y solo totales (ningún radicado ni dato del
    // trámite entra en `audit_logs`). Las vacías o fallidas quedan en la fila de lectura.
    if (debeAuditarse(r)) {
      await audit(req, { action: 'update', resource: 'flito_sincronizacion_flit2', detail: detalleAuditoria(r, 'boton') });
    }
    res.json(r);
  } catch (e) {
    if (e instanceof Flit2Error) {
      const parcial = parcialDe(e);
      res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(parcial ? { parcial } : {}) });
      return;
    }
    throw e;
  }
});

export default router;
