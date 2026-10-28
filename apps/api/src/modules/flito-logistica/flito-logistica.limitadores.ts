// FLITO Logística — frenos propios de los endpoints con firma y con PII (HU #14110, ADR-0030 §5).

import rateLimit from 'express-rate-limit';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';

/** Confirmar recogida: sube una imagen y escribe en cinco tablas. 60 / 15 min / usuario. */
export const recogidaConfirmarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey('log-recogida:'),
  message: { error: 'Demasiadas confirmaciones de recogida. Espera unos minutos.' },
  store: makeStore('rl:log-recogida:'),
});

/** Revelar la cédula de un firmante: PII; 20 / 15 min / usuario. */
export const revelarDocumentoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey('log-revelar-doc:'),
  message: { error: 'Demasiadas consultas de documento. Espera unos minutos.' },
  store: makeStore('rl:log-revelar-doc:'),
});
