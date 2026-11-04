// HU #14281: la telemetría no guarda tokens aunque el cliente los mande.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { normalizarRutaRum } from '@operaciones/shared-types';
import { PgDialect } from 'drizzle-orm/pg-core';
import { testToken } from '../helpers/auth.js';
import { chain } from '../helpers/db.js';

const valuesMock = vi.fn().mockResolvedValue(undefined);
const executeMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    insert: () => ({ values: valuesMock }),
    execute: executeMock,
    select: selectMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/rum/rum.routes.js');
  app.use('/api/rum', router);
  return app;
}

const reportar = async (route: unknown) => request(await buildApp()).post('/api/rum').send({ metric: 'LCP', value: 100, route });
const rutaGuardada = (i = 0) => (valuesMock.mock.calls[i]![0] as { route: string | null }).route;

beforeEach(() => {
  valuesMock.mockClear();
  executeMock.mockReset();
  selectMock.mockReset();
});

describe('AC2: POST /api/rum con token en la ruta', () => {
  it.each([
    ['/tramite/portal/TOKENSECRETO', '/tramite/portal/:token'],
    ['/m/TOKENSECRETO', '/m/:token'],
    ['/m/TOKENSECRETO/', '/m/:token'],
    ['/tramite/portal/TOKENSECRETO/firma', '/tramite/portal/:token'],
    ['//m//TOKENSECRETO', '/m/:token'],
    ['/M/TOKENSECRETO', '/m/:token'],
  ])('%s → 204 y se guarda %s', async (route, esperada) => {
    const r = await reportar(route);

    expect(r.status).toBe(204);
    expect(rutaGuardada()).toBe(esperada);
    expect(JSON.stringify(valuesMock.mock.calls[0]![0])).not.toContain('TOKENSECRETO');
  });

  it('un token más largo que el recorte de 200 tampoco deja rastro', async () => {
    await reportar(`/m/${'T'.repeat(500)}`);
    expect(rutaGuardada()).toBe('/m/:token');
  });
});

describe('AC3: dos tokens de la misma página', () => {
  it('se guardan con la misma ruta y el resumen agrupa por ruta', async () => {
    await reportar('/tramite/portal/TOKENUNO');
    await reportar('/tramite/portal/TOKENDOS');
    expect(rutaGuardada(0)).toBe(rutaGuardada(1));

    let sqlResumen = '';
    executeMock.mockImplementation(async (q: unknown) => {
      sqlResumen = new PgDialect().sqlToQuery(q as never).sql;
      return [{ metric: 'LCP', route: rutaGuardada(0), device: '(unknown)', samples: 2 }];
    });
    selectMock.mockImplementation(() => chain([{ total: 2 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await buildApp()).get('/api/rum/summary').set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(sqlResumen).toContain('GROUP BY 1, 2, 3');
    expect(r.body.groups).toHaveLength(1);
    expect(r.body.groups[0].route).toBe('/tramite/portal/:token');
  });
});

describe('AC4: ruta sin token', () => {
  it.each(['/', '/login', '/flito/soat', '/m', '/tramite/portal', '/mantenimiento/1', '/validar-identidad.html'])('%s se guarda igual', async (route) => {
    await reportar(route);
    expect(rutaGuardada()).toBe(route);
  });

  it('sin route sigue siendo null', async () => {
    await reportar(undefined);
    expect(rutaGuardada()).toBeNull();
  });
});

describe('normalizarRutaRum', () => {
  it('quita query y fragmento aunque el cliente los mande', () => {
    expect(normalizarRutaRum('/flito/soat?placa=ABC123#x')).toBe('/flito/soat');
  });

  it('lo que no es texto pasa tal cual', () => {
    expect(normalizarRutaRum(42)).toBe(42);
  });
});
