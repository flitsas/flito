// Siigo — estado de la compuerta: fronteras HTTP (HU #11285, AC5 y AC6).
//
// Un solo endpoint de consulta. Lo que se prueba aquí es quién entra y que la evaluación ocurra en
// el servidor: la lógica del veredicto vive en siigo-compuerta.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken, type TestRole } from '../helpers/auth.js';
import type { EstadoCompuerta } from '@operaciones/shared-types';

/** El servicio se mockea: aquí importa la frontera HTTP, no el cálculo. */
const estadoMock = vi.fn<(ambiente: string) => Promise<EstadoCompuerta>>();
vi.mock('../../src/modules/siigo/siigo.compuerta.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.compuerta.service.js')>();
  return { ...real, estadoCompuerta: (a: string) => estadoMock(a) };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

function estado(over: Partial<EstadoCompuerta> = {}): EstadoCompuerta {
  return {
    ambiente: 'pruebas',
    modo: 'real',
    compuertaActiva: true,
    emisionRealHabilitada: false,
    motivos: [{ tipo: 'concepto_sin_confirmar', detalle: 'Falta confirmar: soat.', conceptos: ['soat'] }],
    conceptosEvaluados: ['soat'],
    ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/compuerta.routes.js');
  app.use('/api/siigo/compuerta', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

const ROLES_SIN_LECTURA: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => {
  estadoMock.mockReset();
  estadoMock.mockImplementation(async (ambiente: string) => estado({ ambiente }));
});

describe('AC5 — el estado de la compuerta es consultable', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/compuerta')).status).toBe(401);
  });

  it.each<TestRole>(['admin', 'auditor', 'financiera'])('%s consulta el estado → 200', async (role) => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/compuerta')
      .set('Authorization', await auth(role));

    expect(r.status).toBe(200);
    expect(r.body.emisionRealHabilitada).toBe(false);
    expect(r.body.motivos).toHaveLength(1);
  });

  it.each(ROLES_SIN_LECTURA)('%s no consulta → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/compuerta')
      .set('Authorization', await auth(role));
    expect(r.status).toBe(403);
  });

  it('la respuesta distingue el modo simulado', async () => {
    estadoMock.mockResolvedValue(estado({
      modo: 'mock', compuertaActiva: false, emisionRealHabilitada: true,
    }));
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/compuerta')
      .set('Authorization', await auth('admin'));

    expect(r.body.modo).toBe('mock');
    expect(r.body.compuertaActiva).toBe(false);
  });
});

describe('AC7 — la consulta es por ambiente y el ambiente se valida', () => {
  it('evalúa el ambiente pedido, no el del servidor', async () => {
    const app = await buildApp();
    await request(app).get('/api/siigo/compuerta?ambiente=produccion')
      .set('Authorization', await auth('admin'));

    expect(estadoMock).toHaveBeenCalledWith('produccion');
  });

  it('un ambiente mal escrito se rechaza en vez de caer al del servidor', async () => {
    // Caer al ambiente por defecto respondería «se puede emitir» sobre otra parametrización.
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/compuerta?ambiente=prubas')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
    expect(estadoMock).not.toHaveBeenCalled();
  });

  it('sin `?ambiente=` usa el del entorno', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/compuerta')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(['pruebas', 'produccion']).toContain(estadoMock.mock.calls[0]![0]);
  });
});
