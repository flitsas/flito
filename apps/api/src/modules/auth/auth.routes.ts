import { Router, Request, Response } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoGestorOrganismos, permisosRoles, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { authMiddleware, blacklistToken } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { paginasEfectivasDeUsuario, resolverPermisos, type PermisosResueltos } from '../../shared/permisos-efectivos.js';
import { checkLockout, registerFailed, clearLockout } from './loginLockout.js';
import { isUserLaftBlocked } from '../laft/employees/auth-block.service.js';
import { laftAudit } from '../laft/audit.service.js';

/**
 * HU #12088: `transitoCodigo` del JWT/me = 1.er código ordenado de la puente
 * (`flito_gestor_organismos`). Compat con bandeja de trámites (un solo código).
 */
async function transitoCodigoDesdePuente(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ c: flitoGestorOrganismos.organismoCodigo })
    .from(flitoGestorOrganismos)
    .where(eq(flitoGestorOrganismos.userId, userId))
    .orderBy(asc(flitoGestorOrganismos.organismoCodigo))
    .limit(1);
  return row?.c ?? null;
}

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
  // HU #13255 (D1): `rolNombre` = `permisos_roles.nombre` en la MISMA consulta (LEFT JOIN, sin una
  // lectura de más por login); `null` si el rol no tiene fila en el catálogo.
  const [user] = await db.select({ ...getTableColumns(users), rolNombre: permisosRoles.nombre })
    .from(users)
    .leftJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(sql`lower(${users.username}) = lower(${username})`).limit(1);

  if (!user || !user.active || user.deletedAt) {
    await audit(req, { action: 'login_failed', resource: 'auth', detail: `Username: ${username.slice(0, 3)}*** - no encontrado, inactivo o de baja` });
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

  // Las páginas EFECTIVAS, como vista del resolutor único (HU #12082). Ya no viajan en el token:
  // cada petición resuelve contra la base (`resolverPermisos`, RN-A5). El sobre las lleva solo para
  // pintar el menú; la decisión la toma `exigirFuncion` en cada ruta.
  // HU #12088: el código del token sale de la puente, no de users.transito_codigo (obsoleta).
  const transitoCodigo = await transitoCodigoDesdePuente(user.id);
  // HU #13425: páginas, funciones e indicador del canal SOAT, de la misma foto que `/me`.
  const sobre = await sobreDePermisos(user.id, user.companiaId);

  const token = await new SignJWT({
    sub: String(user.id),
    username: user.username,
    role: user.role,
    ...(transitoCodigo ? { transitoCodigo } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);

  await audit(req, { action: 'login', resource: 'auth', resourceId: String(user.id), detail: `Login exitoso: ${user.username}` });

  // Devolvemos allowedPages "efectivas" (rol defaults ∪ custom) y `puedeSolicitarSoat`
  // igual que /me, para que el frontend pinte la navegación y el canal de SOAT
  // SIN esperar un reload que dispare /me (Bug #11937).
  // HU #13255: `email` (el del PROPIO usuario, solo en el cuerpo; nunca en URL ni en logs) y
  // `rolNombre`, con la misma forma que en `/me` para que los dos sobres no diverjan.
  res.json({
    token,
    user: {
      id: user.id, name: user.name, username: user.username, email: user.email ?? null, role: user.role,
      rolNombre: user.rolNombre ?? null,
      transitoCodigo,
      ...sobre,
    },
  });
});

/**
 * ¿Este usuario puede radicar una solicitud de SOAT sin trámite? (Feature #11912, HU #11914)
 *
 * **Es una CAPACIDAD DE INTERFAZ, no una frontera.** Sirve para que la pantalla no pinte un botón
 * que va a fallar y para la tarjeta del AC5; quien decide de verdad son los dos endpoints del canal,
 * que vuelven a leer el flag en cada petición y responden 403 — y así un `/me` viejo en una pestaña
 * abierta no concede nada.
 *
 * Se calcula en el servidor y no se deriva en la web de `role === 'cliente'`, porque el flag es de la
 * COMPAÑÍA y el navegador no la conoce. Viaja en `/me` y en el sobre de `POST /login` por lo mismo que
 * `allowedPages`: la SPA usa ese sobre hasta el reload, y un flag ausente pinta el canal apagado
 * (Bug #11937). `companiaId` no sale en ninguna de las dos respuestas.
 *
 * HU #13425: se decide por la FUNCIÓN `soat.solicitud.crear` del conjunto efectivo (la misma foto
 * que guarda los endpoints del canal), por el ENLACE `compania` del rol (HU #12875: el tipo
 * interno/externo se retiró; una regla por enlace) y por la compañía enlazada y su flag — nunca por el nombre del rol. Si falta algo, `false` sin consultar `clients`:
 * el JOIN solo lo paga quien puede radicar.
 */
async function puedeSolicitarSoat(p: PermisosResueltos, companiaId: number | null): Promise<boolean> {
  if (!p.ok || p.tipoEnlace !== 'compania' || !p.funciones.has('soat.solicitud.crear') || !companiaId) return false;
  const [compania] = await db.select({ sinTramite: clients.soatSinTramite })
    .from(clients).where(eq(clients.id, companiaId)).limit(1);
  return compania?.sinTramite === true;
}

/**
 * HU #13425 — Lo que la sesión sabe de los permisos del usuario, de UNA lectura del resolutor
 * (cacheado 60 s): páginas, funciones efectivas (códigos, ordenados) y el indicador del canal SOAT.
 * Con el resolutor en `ok:false` todo sale vacío/`false` (falla cerrado; el servidor decide igual).
 */
async function sobreDePermisos(userId: number, companiaId: number | null) {
  const p = await resolverPermisos(userId);
  const funciones: ReadonlySet<string> = p.ok ? p.funciones : new Set<string>();
  return {
    allowedPages: await paginasEfectivasDeUsuario(userId),
    funciones: [...funciones].sort(),
    puedeSolicitarSoat: await puedeSolicitarSoat(p, companiaId),
  };
}

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const [user] = await db.select({
    id: users.id,
    username: users.username,
    name: users.name,
    // HU #13255: `email` del propio usuario y `rolNombre` del catálogo (LEFT JOIN: misma consulta).
    email: users.email,
    role: users.role,
    rolNombre: permisosRoles.nombre,
    allowedPages: users.allowedPages,
    companiaId: users.companiaId,
  }).from(users)
    .leftJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(eq(users.id, req.user!.sub)).limit(1);

  if (!user) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  // `companiaId` se saca del objeto y NO se devuelve: la web no lo usa —el aislamiento lo aplica el
  // servidor en cada consulta— y publicarlo solo añadiría un identificador interno a una respuesta
  // que ya viaja a un tercero. Lo que sale es el booleano derivado.
  // HU #12088: `transitoCodigo` = 1.er código de la puente (no la columna obsoleta).
  const { companiaId, ...publico } = user;
  const transitoCodigo = await transitoCodigoDesdePuente(req.user!.sub);

  // Devuelve allowedPages "efectivas" para que el frontend filtre UI directamente. Desde la
  // HU #12082 salen del resolutor único (`resolverPermisos`, cacheado 60 s por usuario), el mismo
  // que decide en el servidor: el menú y el 403 no pueden divergir.
  res.json({
    ...publico,
    // Normalizados: un mock o una fila sin el dato no deben dejar la clave fuera del sobre.
    email: publico.email ?? null,
    rolNombre: publico.rolNombre ?? null,
    transitoCodigo,
    ...(await sobreDePermisos(req.user!.sub, companiaId)),
  });
});

// VUL-07: Endpoint logout con revocación de token (Redis-backed con fallback in-memory).
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) await blacklistToken(token);
  res.json({ ok: true });
});

export default router;
