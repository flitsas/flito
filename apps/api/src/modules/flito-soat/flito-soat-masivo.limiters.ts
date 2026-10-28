// HU #14131 (Feature #14013) — limitadores PROPIOS de la carga masiva. NO se encadena `soatClienteLimiter`
// (20/15 min): el sondeo del avance lo agotaría. Prefijos de llave y de store distintos entre sí y de los
// demás limitadores (dos con el mismo prefijo compartirían contador).

import rateLimit from 'express-rate-limit';
import { frenoConRastro, makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';

/** Alta del lote: 5 por 15 min y usuario (cada alta puede traer 200 filas que consultan al RUNT). */
export const soatMasivoAltaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-masivo-alta:'),
  handler: frenoConRastro('soat-masivo-alta'),
  message: { error: 'Demasiadas cargas masivas. Espera unos minutos e intenta de nuevo.' },
  store: makeStore('rl:soat-masivo-alta:'),
});

/** Lecturas (plantilla y avance, que se sondea cada 2–3 s): 90 por minuto y usuario. */
export const soatMasivoLecturaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-masivo-lectura:'),
  handler: frenoConRastro('soat-masivo-lectura'),
  message: { error: 'Demasiadas consultas. Espera un momento e intenta de nuevo.' },
  store: makeStore('rl:soat-masivo-lectura:'),
});

/** Descarga de rechazadas (PII): 10 por 15 min y usuario. */
export const soatMasivoDescargaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('soat-masivo-descarga:'),
  handler: frenoConRastro('soat-masivo-descarga'),
  message: { error: 'Demasiadas descargas. Espera unos minutos e intenta de nuevo.' },
  store: makeStore('rl:soat-masivo-descarga:'),
});
