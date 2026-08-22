import rateLimit, { Options, ipKeyGenerator, type RateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '../redis.js';
import type { Request, Response } from 'express';
import { loggerFor } from '../logger.js';
import { rateLimitBloqueadoTotal } from '../metrics.js';

// Helper: keyGenerator que prefiere userId si está autenticado, sino normaliza IP (IPv6 /64).
// Sin esta normalización, atacantes con IPv6 pueden bypassear los límites cambiando los bits bajos.
export function userOrIpKey(prefix: string) {
  return (req: Request): string => {
    const userId = (req as Request & { user?: { sub?: string } }).user?.sub;
    if (userId) return `${prefix}-${userId}`;
    return `${prefix}-${ipKeyGenerator(req.ip ?? '')}`;
  };
}

// Si Redis está disponible, usamos su store para rate limit distribuido entre instancias.
// Si no, fallback al store in-memory por defecto de express-rate-limit.
export function makeStore(prefix: string): Options['store'] | undefined {
  const r = getRedis();
  if (!r) return undefined;
  return new RedisStore({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => (r.call as any)(...args),
    prefix,
  });
}

const logFreno = loggerFor('rate-limit');

/**
 * Handler de 429 que además deja rastro: un `warn` con la llave y un punto en el contador.
 *
 * ── Por qué existe (HU #11299) ─────────────────────────────────────────────────────────────────
 *
 * La corrección de seguridad de esa HU puso los limitadores del módulo `siigo/` DELANTE de las
 * guardas de permiso, porque una denegación escribe en `siigo_operaciones` y esa tabla es
 * append-only: sin limitador por delante, un autenticado sin permiso podía inundar una bitácora que
 * nadie puede podar. El intercambio es el correcto, pero abrió un punto ciego: a partir del intento
 * 61, el mismo actor recibe 429 y ya NO deja la fila `permiso_denegado`. Y el 429 no era observable
 * por ningún lado —`metrics.ts` no expone estados HTTP y el handler por defecto de
 * `express-rate-limit` no escribe nada—, así que quien insistía se volvía invisible exactamente
 * cuando pasaba a ser interesante. Frenar a un atacante sin verlo es media defensa.
 *
 * Se cierra con los dos mecanismos que el repo ya tiene, cada uno con lo que sabe hacer:
 *
 *   · **El contador** (`rate_limit_bloqueado_total`, etiquetado por limitador) responde «¿cuánto?»
 *     y es lo que se grafica y lo que dispara una alerta. No lleva llave ni ruta: serían series sin
 *     techo de cardinalidad.
 *   · **El log** responde «¿quién?». La llave del limitador es `<prefijo>-<sub>` para un
 *     autenticado, y ese `sub` es el identificador interno del usuario en `users` — que es
 *     justamente lo que hace falta para cruzarlo con `audit_logs` y con la bitácora del módulo.
 *
 * **Nada de datos personales**, y no por costumbre: `logger` no redacta lo que no reconoce, y aquí
 * el 429 puede venir de una petición cuya query trae un documento o una placa. Por eso se escribe
 * la llave y NO el correo, y por eso la ruta va sin query string. Un log de frenos que copiara la
 * consulta sería una copia sin control de aquello que el resto de esta HU se ha dedicado a acotar.
 *
 * Responde igual que el handler por defecto —mismo estado y mismo cuerpo, tomados de `options`—
 * para que añadir el rastro no cambie ni una respuesta.
 */
export function frenoConRastro(limitador: string): Options['handler'] {
  return (req: Request, res: Response, _next, options) => {
    // `key`, `limit` y `used` los deja el propio middleware en `req.rateLimit`; el tipo no está
    // declarado en el `Request` de Express, de ahí el ensanchado local (igual que en `userOrIpKey`).
    const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
    rateLimitBloqueadoTotal.inc({ limitador });
    logFreno.warn({
      limitador,
      // La llave, no el usuario: lleva el `sub` y nunca el correo ni el nombre.
      llave: info?.key ?? null,
      metodo: req.method,
      // Sin query string: ahí es donde viajan el documento y la placa.
      ruta: (req.originalUrl || req.url || '').split('?')[0]!.slice(0, 300),
      limite: info?.limit ?? null,
      intentos: info?.used ?? null,
    }, 'Limitador activado: peticion rechazada con 429');
    if (!res.writableEnded) res.status(options.statusCode).send(options.message);
  };
}

// General API rate limit: 500 requests per 15 min per IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intente de nuevo mas tarde' },
  store: makeStore('rl:api:'),
});

// Auth endpoints: 10 attempts per 15 min per IP (brute force protection)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticacion, espere 15 minutos' },
  store: makeStore('rl:auth:'),
});

// GET /metrics: 120 requests / 15 min / IP (Bug #11599). La ruta vive FUERA de `/api`, así
// que `apiLimiter` nunca la cubrió; ahora que porta autenticación, la regla 18 de AGENTS.md
// pide freno propio. No es contención de costo —`metricsAuth` rechaza antes de llamar a
// `registry.metrics()`, no hay amplificación— sino techo a la fuerza bruta contra el token.
// 120/15min deja holgura al scrape legítimo de Prometheus (60 con el intervalo por defecto
// de 15s) incluso con dos scrapers apuntando a la misma instancia.
export const metricsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('metrics:'),
  message: { error: 'Demasiadas solicitudes' },
  store: makeStore('rl:metrics:'),
});

// QR público RNDC: 60 requests / 15 min / IP. Anti-enumeración del token.
export const qrPublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas, espere unos minutos' },
  store: makeStore('rl:qr:'),
});

// PESV upload evidencia: 50 uploads / 15 min / usuario (o IP si no auth).
// BELK B3 (sprint rediseño PHVA): contención contra cuenta comprometida que
// intente llenar bucket MinIO en minutos. 50/15min es generoso para uso normal
// del líder PESV (típicamente 24×N evidencias en sesiones de horas).
export const pesvUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('pesv-up:'),
  message: { error: 'Demasiadas evidencias subidas. Espere 15 minutos.' },
  store: makeStore('rl:pesv-up:'),
});
