import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '../redis.js';
import type { Request } from 'express';

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
function makeStore(prefix: string): Options['store'] | undefined {
  const r = getRedis();
  if (!r) return undefined;
  return new RedisStore({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => (r.call as any)(...args),
    prefix,
  });
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
