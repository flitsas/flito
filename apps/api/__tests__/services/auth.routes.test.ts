import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba, conCadena, operacionesDePartida } from '../helpers/auth.js';
import { expandir } from '../../src/modules/permisos/arbol/expansion.js';
import { decodeJwt } from 'jose';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { verify: argonVerifyMock },
  verify: argonVerifyMock,
}));

const checkLockoutMock = vi.fn();
const registerFailedMock = vi.fn().mockResolvedValue(undefined);
const clearLockoutMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/auth/loginLockout.js', () => ({
  checkLockout: checkLockoutMock,
  registerFailed: registerFailedMock,
  clearLockout: clearLockoutMock,
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// Silenciar redis para evitar warnings de "connect ECONNREFUSED 127.0.0.1:6379".
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const blacklistTokenMock = vi.fn().mockResolvedValue(undefined);
const isTokenBlacklistedMock = vi.fn().mockResolvedValue(false);
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return {
    ...actual,
    blacklistToken: blacklistTokenMock,
    isTokenBlacklisted: isTokenBlacklistedMock,
  };
});

beforeEach(async () => {
  selectMock.mockReset();
  argonVerifyMock.mockReset();
  checkLockoutMock.mockReset();
  registerFailedMock.mockClear();
  clearLockoutMock.mockClear();
  auditMock.mockClear();
  blacklistTokenMock.mockClear();
  isTokenBlacklistedMock.mockReset().mockResolvedValue(false);
  // Default: no lockout
  checkLockoutMock.mockResolvedValue({ locked: false });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/auth/auth.routes.js');
  app.use('/api/auth', router);
  return app;
}

describe('POST /api/auth/login — validación zod', () => {
  it('body sin username → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ password: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/usuario.*contraseña/i);
  });

  it('body sin password → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'x' });
    expect(r.status).toBe(400);
  });

  it('username string vacío → 400 (zod min 1)', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: '', password: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/auth/login — lockout', () => {
  it('cuenta bloqueada (locked=true) → 429 con remainingMins', async () => {
    checkLockoutMock.mockResolvedValueOnce({ locked: true, remainingMins: 12 });
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'p' });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/12 minutos/);
    // No tocó BD
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — usuario no existe / inactive', () => {
  it('user no existe → 401 + audit + registerFailed', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin usuario
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'JuanPerez', password: 'p' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Credenciales inválidas');
    expect(registerFailedMock).toHaveBeenCalledWith('JuanPerez');
    expect(clearLockoutMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalled();
    // El detail enmascara username (3 chars + '***')
    const auditArgs = auditMock.mock.calls[0][1];
    expect(auditArgs.action).toBe('login_failed');
    expect(auditArgs.detail).toContain('Jua***');
    expect(auditArgs.detail).not.toContain('JuanPerez');
  });

  it('user inactive (active=false) → 401 + registerFailed', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, username: 'u', passwordHash: 'h', active: false, role: 'admin', name: 'X', allowedPages: null,
    }]));
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'p' });
    expect(r.status).toBe(401);
    expect(argonVerifyMock).not.toHaveBeenCalled(); // ni siquiera verifica password
    expect(registerFailedMock).toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — password incorrecto', () => {
  it('argon2.verify=false → 401 + registerFailed + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 7, username: 'u', passwordHash: 'h', active: true, role: 'admin', name: 'X', allowedPages: null,
    }]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'mala' });
    expect(r.status).toBe(401);
    expect(registerFailedMock).toHaveBeenCalled();
    expect(clearLockoutMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0][1].action).toBe('login_failed');
  });
});

describe('POST /api/auth/login — éxito', () => {
  it('argon2.verify=true → 200 + token JWT + clearLockout + audit', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 42, username: 'admin', passwordHash: 'h', active: true, role: 'admin', name: 'Admin User', allowedPages: null,
      }]))
      // HU #12088: tras login exitoso, `transitoCodigoDesdePuente` lee `flito_gestor_organismos`.
      .mockReturnValueOnce(chain([]));
    // HU #12082: `allowedPages` es una vista del resolutor único. Aquí el resolutor lee del registro
    // del helper (no de `selectMock`): el reparto del rol trae `pagina.dashboard` justo para comprobar
    // que el sobre lleva el SLUG y no el código de la función.
    await registrarUsuarioDePrueba(42, { rol: 'admin', tipoEnlace: 'ninguno', funcionesDelRol: ['pagina.dashboard'], excepciones: [] });
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'OK' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.token.split('.').length).toBe(3); // JWT structure
    expect(r.body.user).toMatchObject({
      id: 42, name: 'Admin User', username: 'admin', role: 'admin',
    });
    // F-3: login ahora devuelve allowedPages efectivas (admin → todas las páginas).
    expect(Array.isArray(r.body.user.allowedPages)).toBe(true);
    expect(r.body.user.allowedPages).toContain('dashboard');
    // Bug #11937: el sobre de login trae el flag (false para admin) sin JOIN extra a clients.
    expect(Object.keys(r.body.user)).toContain('puedeSolicitarSoat');
    expect(r.body.user.puedeSolicitarSoat).toBe(false);
    expect(r.body.user.companiaId).toBeUndefined();
    // Dos: usuario + puente. El reparto lo sirve el resolutor; `clients` no ocurre para admin.
    expect(selectMock).toHaveBeenCalledTimes(2);
    // TC #12261 (AC3, retirada heredada 2): el JWT emitido YA NO lleva `allowedPages` ni ningún claim
    // de permisos. Del token, el servidor solo usa `sub` y `role`.
    const claims = decodeJwt(r.body.token);
    expect(claims).not.toHaveProperty('allowedPages');
    expect(claims).not.toHaveProperty('funciones');
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'role', 'sub', 'username']);
    expect(clearLockoutMock).toHaveBeenCalledWith('admin');
    expect(registerFailedMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0][1].action).toBe('login');
    expect(auditMock.mock.calls[0][1].resourceId).toBe('42');
  });

  it('NO devuelve passwordHash en respuesta (PII protection)', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 1, username: 'a', passwordHash: 'SECRET-HASH', active: true, role: 'admin', name: 'A', allowedPages: null,
      }]))
      .mockReturnValueOnce(chain([])); // puente #12088
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'a', password: 'p' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-HASH');
    expect(r.body.user).not.toHaveProperty('passwordHash');
  });
});

const CLIENTE_LOGIN = {
  id: 5, username: 'u@empresa.co', passwordHash: 'h', active: true,
  role: 'cliente', name: 'Cliente', allowedPages: null, transitoCodigo: null, companiaId: 7,
};

describe('POST /api/auth/login — `puedeSolicitarSoat` (Bug #11937)', () => {
  it('cliente cuya compañía tiene el flag ENCENDIDO → true y la clave viene', async () => {
    await registrarUsuarioDePrueba(5, { rol: 'cliente', tipoEnlace: 'compania', allowedPages: [], funcionesDelRol: ['pagina.flito_soat', 'soat.solicitud.crear'], excepciones: [] });
    selectMock
      .mockReturnValueOnce(chain([CLIENTE_LOGIN]))
      .mockReturnValueOnce(chain([{ active: true }])) // HU #13945: su compañía está activa
      .mockReturnValueOnce(chain([])) // puente #12088
      .mockReturnValueOnce(chain([{ id: 7 }]));
    argonVerifyMock.mockResolvedValueOnce(true);
    const r = await request(await buildApp()).post('/api/auth/login')
      .send({ username: 'u@empresa.co', password: 'OK' });

    expect(r.status).toBe(200);
    expect(Object.keys(r.body.user)).toContain('puedeSolicitarSoat');
    expect(r.body.user.puedeSolicitarSoat).toBe(true);
    expect(r.body.user.companiaId).toBeUndefined();
    expect(selectMock).toHaveBeenCalledTimes(4); // usuario + compañía activa (HU #13945) + puente + clients
  });

  it('compañía SIN proveedor (HU #13967) → false, y no es «no vino el campo»', async () => {
    await registrarUsuarioDePrueba(5, { rol: 'cliente', tipoEnlace: 'compania', allowedPages: [], funcionesDelRol: ['pagina.flito_soat', 'soat.solicitud.crear'], excepciones: [] });
    selectMock
      .mockReturnValueOnce(chain([CLIENTE_LOGIN]))
      .mockReturnValueOnce(chain([{ active: true }])) // HU #13945: su compañía está activa
      .mockReturnValueOnce(chain([])) // puente #12088
      .mockReturnValueOnce(chain([]));
    argonVerifyMock.mockResolvedValueOnce(true);
    const r = await request(await buildApp()).post('/api/auth/login')
      .send({ username: 'u@empresa.co', password: 'OK' });

    expect(r.status).toBe(200);
    expect(Object.keys(r.body.user)).toContain('puedeSolicitarSoat');
    expect(r.body.user.puedeSolicitarSoat).toBe(false);
    expect(r.body.user.companiaId).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me');
    expect(r.status).toBe(401);
  });

  it('token válido + user existe → 200 con allowedPages efectivas', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 1, username: 'admin', name: 'A', role: 'admin', allowedPages: null,
      }]))
      .mockReturnValueOnce(chain([])) // puente #12088 → transitoCodigo null
      // HU #12873 AC8: `admin` tiene «Solicitar SOAT sin trámite» → `/me` mira si alguna compañía tiene el
      // canal (#12874, admin sin enlace). Ninguna → `puedeSolicitarSoat: false`.
      .mockReturnValueOnce(chain([]));
    // HU #12082: las páginas las sirve el resolutor (el registro del helper); `allowedPages` del helper
    // es `users.allowed_pages`, y el admin no tiene fila de defaults, así que sale exactamente esto.
    const token = await testToken({ sub: 1, role: 'admin', allowedPages: ['dashboard'] });
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
    expect(Array.isArray(r.body.allowedPages)).toBe(true);
    // Lo que viaja son SLUGS, resueltos por el mismo resolutor que decide en el servidor.
    // HU #12873 (P-10): la Compuerta la abre «Entregar trámites», que el admin tiene de partida.
    // HU #13428 (P-11): el Tablero FLITO lo abre «Ver el tablero» de General, que el admin tiene de partida.
    // HU #13429: el admin de prueba tiene su partida ENTERA (páginas y `menu.*`, como tras la 0239), así que viajan
    // todas sus páginas efectivas; entre ellas, las dos que abren sus acciones y no son ítem.
    const esperado = [...expandir(conCadena([...operacionesDePartida('admin'), 'pagina.dashboard']))]
      .filter((c) => c.startsWith('pagina.')).map((c) => c.slice('pagina.'.length)).sort();
    expect([...r.body.allowedPages].sort()).toEqual(esperado);
    for (const s of ['dashboard', 'flito_tablero', 'flito_compuerta']) expect(r.body.allowedPages).toContain(s);
    expect(r.body.puedeSolicitarSoat).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(3); // usuario + puente + compañías con el canal (AC8)
  });

  it('token válido pero user no existe en BD → 404', async () => {
    selectMock.mockReturnValueOnce(chain([])); // user borrado tras emitir token
    const token = await testToken({ sub: 999, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });
});

describe('POST /api/auth/logout', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/logout');
    expect(r.status).toBe(401);
  });

  it('token válido → 200 + blacklistToken llamado con el token', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(blacklistTokenMock).toHaveBeenCalledWith(token);
  });
});

// HU #13945 (AC3) — Compañía inactiva: 403 con el motivo SOLO con la contraseña correcta; con una mala, el 401 genérico.
describe('POST /api/auth/login — compañía inactiva (HU #13945)', () => {
  const usuarioDeCompania = { id: 51, username: 'operador', passwordHash: 'h', active: true, role: 'cliente', name: 'Op', allowedPages: null, companiaId: 5 };

  it('contraseña correcta y compañía inactiva → 403 con el motivo, auditado sin PII y sin contar como intento fallido', async () => {
    selectMock
      .mockReturnValueOnce(chain([usuarioDeCompania]))
      .mockReturnValueOnce(chain([{ active: false }])); // clients.active de su compañía
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'operador', password: 'OK' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Tu compañía está inactiva en FLITO. Comunícate con el administrador.');
    expect(r.body.token).toBeUndefined();
    expect(registerFailedMock).not.toHaveBeenCalled();
    expect(clearLockoutMock).not.toHaveBeenCalled();
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'login_failed', resource: 'auth', resourceId: '51', detail: 'compañía inactiva' });
    expect(JSON.stringify(entrada)).not.toContain('operador');
  });

  it('contraseña incorrecta con la compañía inactiva → 401 «Credenciales inválidas» (no revela nada) y no consulta la compañía', async () => {
    selectMock.mockReturnValueOnce(chain([usuarioDeCompania]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'operador', password: 'mala' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Credenciales inválidas');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('AC5: usuario inactivo por su cuenta con la compañía activa → sigue el 401 de siempre', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...usuarioDeCompania, active: false }]));
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'operador', password: 'OK' });
    expect(r.status).toBe(401);
    expect(argonVerifyMock).not.toHaveBeenCalled();
  });
});

// HU #13958 (AC3/AC4) — Proveedor SOAT inactivo o eliminado: 403 con el motivo SOLO con la contraseña correcta.
describe('POST /api/auth/login — proveedor SOAT inactivo (HU #13958)', () => {
  const PROV = '11111111-1111-4111-8111-111111111111';
  const gestor = { id: 61, username: 'gestorsoat', passwordHash: 'h', active: true, role: 'gestor_soat', name: 'G', allowedPages: null, companiaId: null, flitoProveedorSoatId: PROV };

  it('AC3: contraseña correcta y proveedor inactivo → 403 con el motivo, auditado sin PII y sin contar como intento fallido', async () => {
    selectMock
      .mockReturnValueOnce(chain([gestor]))
      .mockReturnValueOnce(chain([{ activo: false, deletedAt: null }])); // flito_proveedores_soat de su proveedor
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'gestorsoat', password: 'OK' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Tu proveedor está inactivo en FLITO. Comunícate con el administrador.');
    expect(r.body.token).toBeUndefined();
    expect(registerFailedMock).not.toHaveBeenCalled();
    expect(clearLockoutMock).not.toHaveBeenCalled();
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'login_failed', resource: 'auth', resourceId: '61', detail: 'proveedor SOAT inactivo' });
    expect(JSON.stringify(entrada)).not.toContain('gestorsoat');
  });

  it('AC3: proveedor eliminado (activo pero con deleted_at) → el mismo 403', async () => {
    selectMock
      .mockReturnValueOnce(chain([gestor]))
      .mockReturnValueOnce(chain([{ activo: true, deletedAt: new Date() }]));
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'gestorsoat', password: 'OK' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Tu proveedor está inactivo en FLITO. Comunícate con el administrador.');
  });

  it('contraseña incorrecta con el proveedor inactivo → 401 genérico y no consulta el proveedor', async () => {
    selectMock.mockReturnValueOnce(chain([gestor]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'gestorsoat', password: 'mala' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Credenciales inválidas');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('AC4: usuario inactivo por su cuenta → sigue el 401 de siempre, aunque el proveedor esté activo', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...gestor, active: false }]));
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'gestorsoat', password: 'OK' });
    expect(r.status).toBe(401);
    expect(argonVerifyMock).not.toHaveBeenCalled();
  });
});
