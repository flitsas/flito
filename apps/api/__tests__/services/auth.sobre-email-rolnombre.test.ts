// HU #13255 (Feature #13254) — AC8 + decisión D1: los dos sobres de sesión (`POST /api/auth/login`
// → `user` y `GET /api/auth/me`) llevan `rolNombre` (`permisos_roles.nombre` de su rol, `null` sin
// fila) y coinciden en él (Bug #11937: la SPA usa el sobre del login hasta el primer reload).
// `companiaId` sigue fuera de los dos.
//
// HU #13431 (Feature #13416): `GET /api/auth/me` YA NO lleva `email` —ni lo pide al SELECT—. Perfil lo
// lee de `GET /api/auth/perfil` (guarda `perfil.datos.ver`, HU #13428); `/me` corre en cada carga de
// pantalla y no debe arrastrar un dato personal de más. Tampoco el sobre del login (`user`): la SPA lo
// guardaba en la sesión sin usarlo. El SELECT del login sigue siendo la fila completa (necesita el hash
// y el estado), así que ahí se aserta la RESPUESTA, no la proyección.
//
// Por qué se mira el SELECT y no solo la respuesta: el `chain` de los helpers devuelve la fila
// ENTERA aunque la proyección pidiera menos («El mock `chain` inventa columnas»). Un aserto sobre la
// respuesta pasaría en verde sin el cambio de producción. Por eso se captura la proyección de cada
// `select` y se aserta qué pide (`rolNombre` en los dos; `email` no lo pide `/me`), y que el `rolNombre` sale del LEFT JOIN con
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

/**
 * Login + /me del mismo usuario. Consultas del login: usuario → compañía activa (HU #13945, `companiaInactiva`:
 * el usuario tiene `companiaId`) → puente → clients (cliente con compañía). /me: usuario → puente → clients.
 */
async function ambosSobres(fila: Record<string, unknown>) {
  await registrarUsuarioDePrueba(42, { rol: 'cliente', tipoEnlace: 'compania', funcionesDelRol: ['pagina.flito_soat', 'soat.solicitud.crear'], excepciones: [] });
  argonVerifyMock.mockResolvedValueOnce(true);
  selectMock
    .mockImplementationOnce(espia([fila]))
    .mockImplementationOnce(espia([{ active: true }]))
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

describe('AC8 + D1 — `rolNombre` en los dos sobres de sesión; `email` en ninguno (HU #13431)', () => {
  it('ni login ni /me traen el email (ni la clave) y sí el resto del sobre; el nombre del rol COINCIDE', async () => {
    const { login, me } = await ambosSobres(FILA);
    expect(login.status).toBe(200);
    expect(me.status).toBe(200);
    // HU #13431: ni el valor ni la clave (un `email: null` seguiría siendo un dato de más en el contrato).
    for (const sobre of [login.body.user, me.body]) {
      expect(Object.keys(sobre)).not.toContain('email');
      expect(sobre).toMatchObject({ id: 42, username: 'ana', name: 'Ana Pérez', role: 'cliente', rolNombre: 'Cliente corporativo' });
      expect(Object.keys(sobre)).toEqual(expect.arrayContaining(['allowedPages', 'transitoCodigo']));
    }
    // En ningún rincón del cuerpo (tampoco junto al token).
    expect(JSON.stringify(login.body)).not.toContain(EMAIL);
    expect(JSON.stringify(me.body)).not.toContain(EMAIL);
    expect(typeof login.body.token).toBe('string');
    expect(login.body.user.rolNombre).toBe('Cliente corporativo');
    expect(me.body.rolNombre).toBe('Cliente corporativo');
    expect(login.body.user.rolNombre).toBe(me.body.rolNombre);
  });

  it('las dos consultas PIDEN `rolNombre` por LEFT JOIN a `permisos_roles` (sin consulta de más); /me no pide `email`', async () => {
    const { consultasLogin, consultasMe } = await ambosSobres(FILA);
    // Login: la proyección es `{...columnas de users, rolNombre}`; /me: la proyección explícita.
    const [pLogin] = [proyecciones[0]!];
    const pMe = proyecciones[consultasLogin]!;
    for (const p of [pLogin, pMe]) expect(Object.keys(p)).toContain('rolNombre');
    // HU #13431: /me ni siquiera lo lee de la base (el mock `chain` lo inventaría en la respuesta).
    expect(Object.keys(pMe)).not.toContain('email');
    expect(joins[0]).toEqual(['permisos_roles']);
    expect(joins[consultasLogin]).toEqual(['permisos_roles']);
    // usuario + puente + clients, en los dos: el JOIN no añadió una lectura. El login suma la de compañía activa
    // (HU #13945, AC3): un usuario con `companiaId` no entra si su compañía está inactiva.
    expect(consultasLogin).toBe(4);
    expect(consultasMe).toBe(3);
  });

  it('sin fila de rol en el catálogo ni correo → `rolNombre` SALE y vale null (no desaparece); `email` sigue fuera de los dos', async () => {
    const { login, me } = await ambosSobres({ ...FILA, email: null, rolNombre: undefined });
    for (const sobre of [login.body.user, me.body]) {
      expect(Object.keys(sobre)).toContain('rolNombre');
      expect(Object.keys(sobre)).not.toContain('email');
    }
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
