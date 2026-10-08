// HU #13421 (ADR-0023) — PESV, Jornadas, Conductores y RUM piden permiso, no rol. Comportamiento HTTP
// de las guardas nuevas contra el motor real (`exigirFuncion` → `resolverPermisos`), con la lectura de
// filas sustituida por el double de `helpers/auth.ts` (`registrarUsuarioDePrueba`).
//
//   · AC2: ítem A habilitado y B no → 200 en la lectura de A; 403 en B, sin datos de B (ni consulta).
//   · AC1: ninguna ruta de pesv/ pide la página única `pesv`; tampoco por la guarda de router que antes
//     se filtraba desde /api/pesv (raci con solo `pagina.pesv_raci` entra).
//   · AC3: jornadas/, drivers/ y rum/ piden su permiso: un rol LLAMADO `admin` sin la función → 403;
//     con ella, la misma respuesta que hoy.
//   · AC4: escribir en un ítem exige «Administrar <ítem>» aunque se tenga la página.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => chain([]));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

/** Un usuario con EXACTAMENTE estas funciones en su rol (nombre de rol a elección). */
async function usuario(sub: number, rol: string, funciones: string[]): Promise<string> {
  await registrarUsuarioDePrueba(sub, { rol, tipoPrincipal: 'interno', tipoEnlace: 'ninguno', funcionesDelRol: funciones, excepciones: [] });
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const jwt = await new SignJWT({ username: `u${sub}`, role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h').sign(secret);
  return `Bearer ${jwt}`;
}

describe('AC2 — un ítem habilitado y otro no', () => {
  it('con solo `pagina.pesv_comite`: 200 en la lectura del comité y 403 en el plan, sin tocar la base para el plan', async () => {
    const auth = await usuario(9101, 'lider_pesv', ['pagina.pesv_comite']);
    const ok = await request(app).get('/api/pesv/comite').set('Authorization', auth);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: [] });

    selectMock.mockClear();
    const no = await request(app).get('/api/pesv/plan').set('Authorization', auth);
    expect(no.status).toBe(403);
    expect(no.body).toMatchObject({ funcion: 'pagina.pesv_plan' });
    expect(no.body).not.toHaveProperty('data');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('con solo `pagina.pesv_conductores`: entra a /api/drivers y no a /api/drivers/alcohol-tests', async () => {
    const auth = await usuario(9102, 'supervisor_flota', ['pagina.pesv_conductores']);
    expect((await request(app).get('/api/drivers/alcohol-tests').set('Authorization', auth)).body)
      .toMatchObject({ funcion: 'pagina.pesv_alcoholimetria' });
  });
});

describe('AC1 — ninguna ruta de pesv/ pide la página única', () => {
  it('quien tiene `pagina.pesv` y no `pagina.pesv_comite` NO entra al comité', async () => {
    const auth = await usuario(9103, 'conductor', ['pagina.pesv']);
    const r = await request(app).get('/api/pesv/comite').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'pagina.pesv_comite' });
  });

  it('raci ya no hereda `pagina.pesv` de la guarda de router de /api/pesv: con solo `pagina.pesv_raci` entra', async () => {
    const auth = await usuario(9104, 'compliance', ['pagina.pesv_raci']);
    const r = await request(app).get('/api/pesv/raci').set('Authorization', auth);
    expect(r.body).not.toMatchObject({ funcion: 'pagina.pesv' });
    expect(r.status).not.toBe(403);
  });
});

describe('AC3 — jornadas/, drivers/ y rum/ piden su permiso, no el nombre del rol', () => {
  it('un rol llamado `admin` sin `jornadas.control.administrar` → 403 en el listado de jornadas', async () => {
    const auth = await usuario(9105, 'admin', ['pagina.pesv_jornadas']);
    const r = await request(app).get('/api/jornadas').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'jornadas.control.administrar' });
  });

  it('con la función, la misma respuesta que hoy (200 con la página de datos)', async () => {
    const auth = await usuario(9106, 'cualquiera', ['pagina.pesv_jornadas', 'jornadas.control.administrar']);
    const r = await request(app).get('/api/jornadas').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], limit: 50, offset: 0 });
  });

  it('un rol llamado `admin` sin `drivers.conductores.administrar` → 403 al listar candidatos a conductor', async () => {
    const auth = await usuario(9107, 'admin', ['pagina.pesv_conductores']);
    const r = await request(app).get('/api/drivers/candidates/non-driver').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'drivers.conductores.administrar' });
  });

  it('rum: `admin` sin `rum.resumen.ver` → 403; el admin de partida (con la función) → 200', async () => {
    const sin = await usuario(9108, 'admin', []);
    const r = await request(app).get('/api/rum/summary').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'rum.resumen.ver' });
    const con = `Bearer ${await testToken({ role: 'admin', sub: 9109 })}`;
    selectMock.mockImplementation(() => chain([{ total: 0 }]));
    const ok = await request(app).get('/api/rum/summary').set('Authorization', con);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, totalRows: 0, groups: [] });
  });
});

describe('AC4 — escribir en un ítem exige «Administrar <ítem>»', () => {
  it('con la página del comité y sin `pesv.comite.administrar` → 403 al crear; con ella pasa la guarda (201)', async () => {
    const sin = await usuario(9110, 'lider_pesv', ['pagina.pesv_comite']);
    const r = await request(app).post('/api/pesv/comite').set('Authorization', sin)
      .send({ nombre: 'CSV', periodicidad: 'trimestral' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'pesv.comite.administrar' });
    expect(insertMock).not.toHaveBeenCalled();

    insertMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV' }]));
    const con = await usuario(9111, 'lider_pesv', ['pagina.pesv_comite', 'pesv.comite.administrar']);
    const ok = await request(app).post('/api/pesv/comite').set('Authorization', con)
      .send({ nombre: 'CSV', periodicidad: 'trimestral' });
    expect(ok.status).toBe(201);
  });

  it('la partida de `lider_pesv` (catálogo) lo deja crear el comité y NO borrar la política (solo admin hoy)', async () => {
    insertMock.mockReturnValueOnce(chain([{ id: 1, nombre: 'CSV' }]));
    const lider = `Bearer ${await testToken({ role: 'lider_pesv', sub: 9112 })}`;
    expect((await request(app).post('/api/pesv/comite').set('Authorization', lider)
      .send({ nombre: 'CSV', periodicidad: 'trimestral' })).status).toBe(201);
    const del = await request(app).delete('/api/pesv/policy/1').set('Authorization', lider);
    expect(del.status).toBe(403);
    expect(del.body).toMatchObject({ funcion: 'pesv.politica.administrar' });
  });
});
