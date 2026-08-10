// Siigo — freno por proporción de errores: fronteras HTTP (HU #11341, AC4 y AC6).
//
// Aquí no se vuelve a probar el cálculo —eso vive en siigo-freno.test.ts—. Se prueba quién entra,
// que reactivar quede auditado y, sobre todo, que la ventana y el umbral NO se puedan tocar desde
// la petición: admitir `?umbral=1` sería ofrecer un interruptor de apagado del freno a cualquiera
// que pueda leer el estado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken, type TestRole } from '../helpers/auth.js';
import type { EstadoFrenoSiigo } from '@operaciones/shared-types';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const auditMock = vi.fn();
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const estadoMock = vi.fn();
const reactivarMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.freno.service.js', () => ({
  estadoFreno: (...args: unknown[]) => estadoMock(...args),
  reactivarIntegracion: (...args: unknown[]) => reactivarMock(...args),
}));

function estado(over: Partial<EstadoFrenoSiigo> = {}): EstadoFrenoSiigo {
  return {
    ambiente: 'pruebas',
    modo: 'real',
    ventanaHoras: 24,
    umbral: 0.6,
    minimoOperaciones: 20,
    desde: '2026-08-09T12:00:00.000Z',
    hasta: '2026-08-10T12:00:00.000Z',
    total: 30,
    errores: 21,
    erroresDeDatos: 4,
    proporcion: 0.7,
    muestraSuficiente: true,
    superaUmbral: true,
    frenoActivo: true,
    frenada: true,
    frenadaDesde: '2026-08-10T09:15:00.000Z',
    ultimaReactivacion: null,
    motivo: 'La integración con Siigo está frenada.',
    ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/freno.routes.js');
  app.use('/api/siigo/freno', router);
  return app;
}

const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

const ROLES_SIN_LECTURA: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => {
  estadoMock.mockReset();
  reactivarMock.mockReset();
  auditMock.mockReset();
  estadoMock.mockImplementation(async (o: { ambiente: string }) => estado({ ambiente: o.ambiente }));
  reactivarMock.mockImplementation(async (o: { ambiente: string }) => estado({
    ambiente: o.ambiente, frenada: false, motivo: null, frenadaDesde: null,
  }));
});

describe('AC6 — el estado del freno es consultable', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/freno')).status).toBe(401);
  });

  it.each<TestRole>(['admin', 'auditor', 'financiera'])('%s consulta el estado → 200', async (role) => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/freno').set('Authorization', await auth(role));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      frenada: true, proporcion: 0.7, ventanaHoras: 24, umbral: 0.6,
      frenadaDesde: '2026-08-10T09:15:00.000Z',
    });
  });

  it.each(ROLES_SIN_LECTURA)('%s no consulta → 403 y no se mide nada', async (role) => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/freno').set('Authorization', await auth(role));

    expect(r.status).toBe(403);
    // La guarda va antes del handler: el rechazo no llega a consultar la bitácora.
    expect(estadoMock).not.toHaveBeenCalled();
  });

  it('consulta el ambiente pedido, no el del servidor', async () => {
    const app = await buildApp();
    await request(app).get('/api/siigo/freno?ambiente=produccion')
      .set('Authorization', await auth('admin'));

    expect(estadoMock.mock.calls[0]![0]).toMatchObject({ ambiente: 'produccion' });
  });

  it('un ambiente mal escrito se rechaza en vez de caer al del servidor', async () => {
    // Caer al ambiente por defecto mediría la salud de OTRA empresa de Siigo.
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/freno?ambiente=produccon')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
    expect(estadoMock).not.toHaveBeenCalled();
  });
});

describe('la ventana y el umbral no se pueden tocar desde la petición', () => {
  it('`?umbral=1&ventanaHoras=1` no llega al servicio', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/api/siigo/freno?umbral=1&ventanaHoras=1&minimoOperaciones=100000')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    const opciones = estadoMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opciones.umbral).toBeUndefined();
    expect(opciones.ventanaHoras).toBeUndefined();
    expect(opciones.minimoOperaciones).toBeUndefined();
  });

  it('tampoco por el cuerpo al reactivar', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/freno/reactivar')
      .set('Authorization', await auth('admin'))
      .send({ umbral: 1, ventanaHoras: 1 });

    const args = reactivarMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.umbral).toBeUndefined();
    expect(args.ventanaHoras).toBeUndefined();
  });
});

describe('AC4 — el freno se puede levantar a mano, y queda registrado', () => {
  it('admin reactiva → 200 con el estado recalculado', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/freno/reactivar')
      .set('Authorization', await auth('admin'))
      .send({ nota: 'Partner-Id corregido' });

    expect(r.status).toBe(200);
    expect(r.body.frenada).toBe(false);
    expect(reactivarMock.mock.calls[0]![0]).toMatchObject({
      usuarioId: 9, nota: 'Partner-Id corregido',
    });
  });

  it('queda auditado quién reactivó y contra qué medición', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/freno/reactivar')
      .set('Authorization', await auth('admin')).send({});

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      action: 'update', resource: 'siigo_freno', resourceId: 'pruebas',
    });
    expect(auditMock.mock.calls[0]![1].detail).toContain('reactivacion');
  });

  it.each<TestRole>(['auditor', 'financiera', ...ROLES_SIN_LECTURA])(
    '%s no puede reactivar → 403 y nada se escribe', async (role) => {
      const app = await buildApp();
      const r = await request(app).post('/api/siigo/freno/reactivar')
        .set('Authorization', await auth(role)).send({});

      expect(r.status).toBe(403);
      expect(reactivarMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it('sin token no se reactiva nada', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/freno/reactivar').send({});

    expect(r.status).toBe(401);
    expect(reactivarMock).not.toHaveBeenCalled();
  });

  it('una nota desmedida se rechaza: la bitácora es inalterable', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/freno/reactivar')
      .set('Authorization', await auth('admin'))
      .send({ nota: 'x'.repeat(500) });

    expect(r.status).toBe(400);
    expect(reactivarMock).not.toHaveBeenCalled();
  });

  it('sin cuerpo también reactiva: la nota es opcional', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/freno/reactivar')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
  });
});
