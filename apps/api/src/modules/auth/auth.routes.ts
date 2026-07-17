import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { authMiddleware, blacklistToken } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { getEffectivePages } from '../../shared/permissions.js';
import { checkLockout, registerFailed, clearLockout } from './loginLockout.js';
import { isUserLaftBlocked } from '../laft/employees/auth-block.service.js';
import { laftAudit } from '../laft/audit.service.js';

const router = Router();
const secret = new TextEncoder().encode(env.JWT_SECRET);

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    return;
  }

  const { username, password } = parsed.data;

  // VUL-09: Chequeo de lockout distribuido (Redis-backed) antes de consultar BD.
  const lock = await checkLockout(username);
  if (lock.locked) {
    res.status(429).json({ error: `Cuenta bloqueada. Intente en ${lock.remainingMins} minutos.` });
    return;
  }

  // Username case-insensitive: 'edison' debe matchear 'Edison'/'EDISON'/etc.
  // Los conductores tipean en móvil y los usernames se crearon con mayúsculas mixtas.
  const [user] = await db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).limit(1);

  if (!user || !user.active) {
    await audit(req, { action: 'login_failed', resource: 'auth', detail: `Username: ${username.slice(0, 3)}*** - no encontrado o inactivo` });
    await registerFailed(username);
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    await audit(req, { action: 'login_failed', resource: 'auth', detail: `Username: ${username.slice(0, 3)}*** - contraseña incorrecta` });
    await registerFailed(username);
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  // VUL-LAFT: chequeo de bloqueo por match en lista restrictiva (Resolución UIAF 122/2021).
  // Hacemos esto DESPUÉS de validar password (no leak de existencia del bloqueo a anónimos)
  // pero ANTES de emitir token. Mensaje genérico — NO revelar el match al usuario final.
  const laftBlock = await isUserLaftBlocked(user.id);
  if (laftBlock.blocked) {
    await audit(req, { action: 'login_failed', resource: 'auth', resourceId: String(user.id), detail: 'login_blocked_laft' });
    await laftAudit(req, {
      action: 'login_blocked_laft',
      resource: 'risk_assessment',
      resourceId: user.id,
      after: { reason: laftBlock.reason ?? null, username: user.username },
    });
    // Bumpear session_invalidated_at para invalidar cualquier token preexistente del user.
    await db.update(users).set({ sessionInvalidatedAt: new Date() }).where(eq(users.id, user.id));
    res.status(403).json({ error: 'Acceso restringido. Contacte al área de cumplimiento.' });
    return;
  }

  // Login exitoso: limpiar intentos fallidos.
  await clearLockout(username);

  // allowedPages viaja en el JWT para que requirePage lo aplique server-side sin pegarle a BD
  // por request. Es seguro contra staleness: PATCH /users de role/allowedPages bumpea
  // sessionInvalidatedAt (ver users.routes.ts), forzando re-login con un token fresco.
  const token = await new SignJWT({
    sub: String(user.id),
    username: user.username,
    role: user.role,
    allowedPages: user.allowedPages ?? [],
    ...(user.transitoCodigo ? { transitoCodigo: user.transitoCodigo } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);

  await audit(req, { action: 'login', resource: 'auth', resourceId: String(user.id), detail: `Login exitoso: ${user.username}` });

  // Devolvemos allowedPages "efectivas" (rol defaults ∪ custom) igual que /me, para que el
  // frontend pinte la navegación correcta SIN esperar un reload que dispare /me.
  res.json({
    token,
    user: {
      id: user.id, name: user.name, username: user.username, role: user.role,
      allowedPages: getEffectivePages(user),
      transitoCodigo: user.transitoCodigo ?? null,
    },
  });
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const [user] = await db.select({
    id: users.id,
    username: users.username,
    name: users.name,
    role: users.role,
    allowedPages: users.allowedPages,
    transitoCodigo: users.transitoCodigo,
  }).from(users).where(eq(users.id, req.user!.sub)).limit(1);

  if (!user) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  // Devuelve allowedPages "efectivas" (rol defaults + custom) para que el frontend filtre UI directamente.
  res.json({ ...user, allowedPages: getEffectivePages(user) });
});

// VUL-07: Endpoint logout con revocación de token (Redis-backed con fallback in-memory).
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) await blacklistToken(token);
  res.json({ ok: true });
});

export default router;
