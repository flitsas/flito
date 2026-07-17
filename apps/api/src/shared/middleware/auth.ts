import { Request, Response, NextFunction } from 'express';
import { jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { getRedis } from '../redis.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { loggerFor } from '../logger.js';
import type { UserRole } from '@operaciones/shared-types';

const log = loggerFor('auth');

// Re-export para compatibilidad: módulos que importaban UserRole desde aquí siguen
// funcionando. La definición canónica vive en @operaciones/shared-types.
export type { UserRole };

export interface JwtPayload {
  sub: number;
  username: string;
  role: UserRole;
  // Páginas custom concedidas al usuario (además de los defaults del rol). Embebidas en el
  // JWT al login. Ausente en tokens viejos → requirePage cae a defaults del rol (degradación segura).
  allowedPages?: string[];
  // TRAM-MT-01: código DIVIPOLA del organismo asignado (rol transito).
  transitoCodigo?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const secret = new TextEncoder().encode(env.JWT_SECRET);

// JWT blacklist con Redis para persistencia entre restarts y sincronización entre instancias.
// Fallback in-memory si Redis no está disponible (dev sin Redis).
const memoryBlacklist = new Set<string>();
const TTL_SECONDS = 24 * 60 * 60; // alineado con expiración del JWT

function blacklistKey(token: string): string {
  // Usamos hash para no almacenar el token completo en Redis. Suficientemente único para revocación.
  return `jwt:blacklist:${token.slice(-32)}`;
}

export async function blacklistToken(token: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.set(blacklistKey(token), '1', 'EX', TTL_SECONDS);
      return;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Redis blacklist falló, usando memoria');
    }
  }
  memoryBlacklist.add(token);
  setTimeout(() => memoryBlacklist.delete(token), TTL_SECONDS * 1000);
}

export async function isBlacklisted(token: string): Promise<boolean> {
  const r = getRedis();
  if (r) {
    try {
      const v = await r.get(blacklistKey(token));
      if (v != null) return true;
    } catch {
      // si Redis cae, caemos al check en memoria
    }
  }
  return memoryBlacklist.has(token);
}

// Cache de session_invalidated_at por user_id. TTL 60s evita pegarle a BD por cada request.
const sessInvalMemCache = new Map<number, { value: number | null; expiresAt: number }>();
const SESS_INVAL_CACHE_TTL_MS = 60_000;
const SESS_INVAL_REDIS_TTL = 60;
const sessInvalRedisKey = (userId: number) => `auth:sess_inval:${userId}`;

// Flag para deshabilitar el check en tests sin mockear cada selectMock. Producción siempre on.
function sessionInvalCheckEnabled(): boolean {
  return process.env.AUTH_SKIP_SESSION_INVAL_CHECK !== '1';
}

async function getSessionInvalidatedMs(userId: number): Promise<number | null> {
  if (!sessionInvalCheckEnabled()) return null;
  const now = Date.now();
  const memHit = sessInvalMemCache.get(userId);
  if (memHit && memHit.expiresAt > now) return memHit.value;

  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(sessInvalRedisKey(userId));
      if (cached !== null) {
        const value = cached === '0' ? null : Number(cached);
        sessInvalMemCache.set(userId, { value, expiresAt: now + SESS_INVAL_CACHE_TTL_MS });
        return value;
      }
    } catch { /* Redis caído, leemos BD */ }
  }

  // Fail-soft: si la consulta falla, asumimos null (no invalidación) para no convertir
  // un hipotético outage de BD en cierre total del servicio.
  let value: number | null = null;
  try {
    const [row] = await db.select({ s: users.sessionInvalidatedAt }).from(users).where(eq(users.id, userId)).limit(1);
    value = row?.s ? row.s.getTime() : null;
  } catch (err) {
    log.warn({ err: (err as Error)?.message, userId }, 'session_invalidated_at fetch fail — fail-soft');
    return null;
  }
  sessInvalMemCache.set(userId, { value, expiresAt: now + SESS_INVAL_CACHE_TTL_MS });
  if (r) {
    try { await r.set(sessInvalRedisKey(userId), value === null ? '0' : String(value), 'EX', SESS_INVAL_REDIS_TTL); }
    catch { /* ignorar */ }
  }
  return value;
}

export function invalidateSessionCacheFor(userId: number): void {
  sessInvalMemCache.delete(userId);
  const r = getRedis();
  if (r) { r.del(sessInvalRedisKey(userId)).catch(() => undefined); }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

  const token = header.slice(7);

  if (await isBlacklisted(token)) {
    res.status(401).json({ error: 'Token revocado' });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, secret);
    const userId = Number(payload.sub);
    const iat = typeof payload.iat === 'number' ? payload.iat * 1000 : 0;
    const invalAt = await getSessionInvalidatedMs(userId);
    // Si el token fue emitido ANTES de que se invalidaran las sesiones del user, rechazar.
    // Tokens viejos (sin iat o con iat=0) siempre fallan si el user tiene marca de invalidación.
    if (invalAt !== null && iat <= invalAt) {
      res.status(401).json({ error: 'Sesión invalidada — vuelva a iniciar sesión' });
      return;
    }
    req.user = {
      sub: userId,
      username: payload.username as string,
      role: payload.role as UserRole,
      allowedPages: Array.isArray(payload.allowedPages)
        ? (payload.allowedPages as string[])
        : undefined,
      transitoCodigo: typeof payload.transitoCodigo === 'string' && payload.transitoCodigo.trim()
        ? payload.transitoCodigo.trim()
        : undefined,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Sin permisos' });
      return;
    }
    next();
  };
}
