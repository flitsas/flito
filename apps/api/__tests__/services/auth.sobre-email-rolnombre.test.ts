// HU #13255 (Feature #13254) — AC8 + decisión D1: los dos sobres de sesión (`POST /api/auth/login`
// → `user` y `GET /api/auth/me`) llevan `email` del PROPIO usuario y `rolNombre`
// (`permisos_roles.nombre` de su rol, `null` sin fila), y coinciden entre sí (Bug #11937: la SPA usa
// el sobre del login hasta el primer reload). `companiaId` sigue fuera de los dos.
//
// Por qué se mira el SELECT y no solo la respuesta: el `chain` de los helpers devuelve la fila
// ENTERA aunque la proyección pidiera menos («El mock `chain` inventa columnas»). Un aserto sobre la
// respuesta pasaría en verde sin el cambio de producción. Por eso se captura la proyección de cada
// `select` y se aserta que pide `email` y `rolNombre`, y que el `rolNombre` sale del LEFT JOIN con
// `permisos_roles` (no de una consulta de más: el conteo de `select` no cambia).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({ default: { verify: argonVerifyMock }, verify: argonVerifyMock }));
vi.mock('../../src/modules/auth/loginLockout.js', () => ({
  checkLockout: vi.fn().mockResolvedValue({ locked: false }),
  registerFailed: vi.fn().mockResolvedValue(undefined),
  clearLockout: vi.fn().mockResolvedValue(undefined),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const EMAIL = 'ana.perez@empresa.co';
const FILA = {
  id: 42, username: 'ana', name: 'Ana Pérez', email: EMAIL, passwordHash: 'h', active: true, deletedAt: null,
  role: 'cliente', rolNombre: 'Cliente corporativo', allowedPages: null, companiaId: 7,
};

/** Proyecciones y joins que pidió cada `select`, en orden. */
let proyecciones: Array<Record<string, unknown> | undefined> = [];
let joins: string[][] = [];

/** `chain` que además anota la proyección y las tablas del LEFT JOIN de esa consulta. */
function espia(filas: unknown[]) {
  return (proyeccion?: Record<string, unknown>) => {
    proyecciones.push(proyeccion);
    const misJoins: string[] = [];
    joins.push(misJoins);
    // Proyecta de verdad: lo que no está en la proyección no sale (el `chain` pelado lo inventaría).
    const proyectadas = proyeccion
      ? filas.map((f) => Object.fromEntries(Object.keys(proyeccion).map((k) => [k, (f as Record<string, unknown>)[k]])))
      : filas;
    const c = chain(proyectadas) as unknown as Record<string, unknown>;
    const orig = c.leftJoin as (...a: unknown[]) => unknown;
    c.leftJoin = (t: unknown, ...rest: unknown[]) => { misJoins.push(getTableName(t as never)); return orig(t, ...rest); };
    return c;
  };
}

beforeEach(() => {
  selectMock.mockReset();
  argonVerifyMock.mockReset();
  auditMock.mockClear();
  proyecciones = [];
  joins = [];
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/auth/auth.routes.js');
  app.use('/api/auth', router);
  return app;
}

/** Login + /me del mismo usuario. Consultas: usuario → puente → clients (cliente con compañía). */
async function ambosSobres(fila: Record<string, unknown>) {
  await registrarUsuarioDePrueba(42, { rol: 'cliente', tipoEnlace: 'compania', funcionesDelRol: ['pagina.flito_soat', 'soat.solicitud.crear'], excepciones: [] });
  argonVerifyMock.mockResolvedValueOnce(true);
  selectMock
    .mockImplementationOnce(espia([fila]))
    .mockImplementationOnce(espia([]))
    .mockImplementationOnce(espia([{ sinTramite: false }]));
  const app = await buildApp();
  const login = await request(app).post('/api/auth/login').send({ username: 'ana', password: 'OK' });
  const consultasLogin = selectMock.mock.calls.length;
  selectMock
    .mockImplementationOnce(espia([fila]))
    .mockImplementationOnce(espia([]))
    .mockImplementationOnce(espia([{ sinTramite: false }]));
  const token = await testToken({ sub: 42, username: 'ana', role: 'cliente' });
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  return { login, me, consultasLogin, consultasMe: selectMock.mock.calls.length - consultasLogin };
}

describe('AC8 + D1 — `email` y `rolNombre` en los dos sobres de sesión', () => {
  it('login y /me devuelven el email del propio usuario y el nombre del rol, y COINCIDEN', async () => {
    const { login, me } = await ambosSobres(FILA);
    expect(login.status).toBe(200);
    expect(me.status).toBe(200);
    expect(login.body.user.email).toBe(EMAIL);
    expect(me.body.email).toBe(EMAIL);
    expect(login.body.user.rolNombre).toBe('Cliente corporativo');
    expect(me.body.rolNombre).toBe('Cliente corporativo');
    expect(login.body.user.email).toBe(me.body.email);
    expect(login.body.user.rolNombre).toBe(me.body.rolNombre);
  });

  it('las dos consultas del usuario PIDEN `email` y `rolNombre`, este por LEFT JOIN a `permisos_roles` (sin consulta de más)', async () => {
    const { consultasLogin, consultasMe } = await ambosSobres(FILA);
    // Login: la proyección es `{...columnas de users, rolNombre}`; /me: la proyección explícita.
    const [pLogin] = [proyecciones[0]!];
    const pMe = proyecciones[consultasLogin]!;
    for (const p of [pLogin, pMe]) {
      expect(Object.keys(p)).toContain('email');
      expect(Object.keys(p)).toContain('rolNombre');
    }
    expect(joins[0]).toEqual(['permisos_roles']);
    expect(joins[consultasLogin]).toEqual(['permisos_roles']);
    // usuario + puente + clients, en los dos: el JOIN no añadió una lectura.
    expect(consultasLogin).toBe(3);
    expect(consultasMe).toBe(3);
  });

  it('sin fila de rol en el catálogo ni correo → las dos claves SALEN y valen null (no desaparecen)', async () => {
    const { login, me } = await ambosSobres({ ...FILA, email: null, rolNombre: undefined });
    expect(Object.keys(login.body.user)).toEqual(expect.arrayContaining(['email', 'rolNombre']));
    expect(Object.keys(me.body)).toEqual(expect.arrayContaining(['email', 'rolNombre']));
    expect(login.body.user.email).toBeNull();
    expect(me.body.email).toBeNull();
    expect(login.body.user.rolNombre).toBeNull();
    expect(me.body.rolNombre).toBeNull();
  });

  it('`companiaId` y `passwordHash` siguen fuera de los dos sobres', async () => {
    const { login, me } = await ambosSobres(FILA);
    expect(login.body.user.companiaId).toBeUndefined();
    expect(me.body.companiaId).toBeUndefined();
    expect(JSON.stringify(login.body)).not.toContain('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
  });

  it('el correo NO viaja al audit del login (no a los logs)', async () => {
    await ambosSobres(FILA);
    expect(auditMock).toHaveBeenCalled();
    for (const [, entrada] of auditMock.mock.calls) expect(JSON.stringify(entrada)).not.toContain(EMAIL);
  });
});
