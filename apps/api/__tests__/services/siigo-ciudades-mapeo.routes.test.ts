// HU #11294 — rutas de la equivalencia de ciudad (AC1, AC6, AC7).
//
// La prueba que más importa: **confirmar es escritura sobre el cliente**, no una consulta. Fija el
// municipio que sale impreso en una factura ante la DIAN, así que va con el rol que edita clientes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const proponerMock = vi.fn();
const estadoMock = vi.fn();
const confirmarMock = vi.fn();
const obsoletasMock = vi.fn();
const propuestaMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.ciudades-mapeo.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js')>();
  return {
    ...actual,
    proponerEquivalencias: proponerMock,
    estadoMapeoCiudades: estadoMock,
    confirmarCiudad: confirmarMock,
    equivalenciasObsoletas: obsoletasMock,
    propuestaDeCliente: propuestaMock,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  estadoMock.mockResolvedValue({
    total: 100, conCodigo: 40, pendientes: 60, proponibles: 45, ambiguos: 5, sinEquivalencia: 10,
  });
  proponerMock.mockResolvedValue([{
    clienteId: 1, nombre: 'ACME', ciudadTexto: 'BOGOTA D.C.',
    propuesta: { textoOrigen: 'BOGOTA D.C.', certeza: 'exacta', candidatas: [{ cityCode: '11001' }] },
  }]);
  confirmarMock.mockResolvedValue({ clienteId: 1, cityCode: '11001', cityName: 'Bogotá' });
  obsoletasMock.mockResolvedValue([]);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/ciudades-mapeo.routes.js');
  app.use('/api/siigo/clientes-ciudades', router);
  return app;
}

const auth = async (role: string) => `Bearer ${await testToken({ sub: 7, role })}`;
const TERNA = { countryCode: 'Co', stateCode: '11', cityCode: '11001' };

describe('AC7 — confirmar es escritura, consultar no', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/clientes-ciudades/estado')).status).toBe(401);
  });

  for (const rol of ['admin', 'auditor', 'financiera']) {
    it(`${rol} consulta el informe`, async () => {
      const app = await buildApp();
      expect((await request(app).get('/api/siigo/clientes-ciudades/estado')
        .set('Authorization', await auth(rol))).status).toBe(200);
    });
  }

  for (const rol of ['auditor', 'financiera', 'conductor']) {
    it(`${rol} NO puede confirmar`, async () => {
      const app = await buildApp();
      const r = await request(app).post('/api/siigo/clientes-ciudades/1/confirmar')
        .set('Authorization', await auth(rol)).send(TERNA);
      expect(r.status).toBe(403);
      expect(confirmarMock).not.toHaveBeenCalled();
    });
  }

  it('admin confirma, y queda auditado con la ciudad', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/clientes-ciudades/1/confirmar')
      .set('Authorization', await auth('admin')).send(TERNA);
    expect(r.status).toBe(200);
    expect(confirmarMock).toHaveBeenCalledWith(expect.objectContaining({ clienteId: 1, usuarioId: 7 }));
    const detalle = auditMock.mock.calls.at(-1)?.[1].detail as string;
    expect(detalle).toMatch(/Bogotá/);
    expect(detalle).toMatch(/11001/);
  });
});

describe('AC6 — el avance es medible', () => {
  it('el estado desglosa los pendientes por qué se puede hacer con ellos', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/estado')
      .set('Authorization', await auth('admin'));
    expect(r.body).toMatchObject({
      total: 100, conCodigo: 40, pendientes: 60, proponibles: 45, ambiguos: 5, sinEquivalencia: 10,
    });
  });

  it('las propuestas vienen con su certeza', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/propuestas')
      .set('Authorization', await auth('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.data[0].propuesta.certeza).toBe('exacta');
  });
});

// La ficha fiscal (HU #11298) necesita la propuesta de SU cliente, no la de la cartera entera:
// pedir 4.000 propuestas para leer una es gasto puro y la ficha se abre por fila.
describe('propuesta de un cliente puntual', () => {
  it('devuelve la equivalencia de ese cliente', async () => {
    propuestaMock.mockResolvedValueOnce({
      textoOrigen: 'Medelin', certeza: 'aproximada',
      candidatas: [{ countryCode: 'Co', stateCode: '05', stateName: 'Antioquia', cityCode: '05001', cityName: 'Medellín' }],
    });
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/2/propuesta')
      .set('Authorization', await auth('financiera'));
    expect(r.status).toBe(200);
    expect(r.body.certeza).toBe('aproximada');
    expect(propuestaMock).toHaveBeenCalledWith(2, undefined);
  });

  it('un id inválido no llega al servicio', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/abc/propuesta')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(propuestaMock).not.toHaveBeenCalled();
  });

  it('un cliente que no existe → 404', async () => {
    const { SiigoCiudadMapeoError } = await import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js');
    propuestaMock.mockRejectedValueOnce(
      new SiigoCiudadMapeoError('cliente_no_encontrado', 'El cliente 999 no existe.'),
    );
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/999/propuesta')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
  });
});

describe('validación y errores', () => {
  it('una terna mal formada se rechaza sin llamar al servicio', async () => {
    const app = await buildApp();
    for (const cuerpo of [
      { ...TERNA, countryCode: 'COL' },
      { ...TERNA, stateCode: 'ANT' },
      { ...TERNA, cityCode: 'once mil uno' },
      { countryCode: 'Co' },
    ]) {
      const r = await request(app).post('/api/siigo/clientes-ciudades/1/confirmar')
        .set('Authorization', await auth('admin')).send(cuerpo);
      expect(r.status).toBe(400);
    }
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it('una ciudad que no está en el catálogo → 400 explicando cuál', async () => {
    const { SiigoCiudadMapeoError } = await import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js');
    confirmarMock.mockRejectedValueOnce(
      new SiigoCiudadMapeoError('candidata_invalida', 'La ciudad Co/11/99999 no está activa en el catálogo.'),
    );
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/clientes-ciudades/1/confirmar')
      .set('Authorization', await auth('admin')).send({ ...TERNA, cityCode: '99999' });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('candidata_invalida');
  });

  it('un cliente que no existe → 404', async () => {
    const { SiigoCiudadMapeoError } = await import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js');
    confirmarMock.mockRejectedValueOnce(
      new SiigoCiudadMapeoError('cliente_no_encontrado', 'El cliente 999 no existe.'),
    );
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/clientes-ciudades/999/confirmar')
      .set('Authorization', await auth('admin')).send(TERNA);
    expect(r.status).toBe(404);
  });

  it('el catálogo sin cargar → 409, no una lista vacía de propuestas', async () => {
    // Con el catálogo vacío TODO saldría «sin equivalencia»: un diagnóstico falso que llevaría a
    // corregir a mano una cartera que solo necesita cargar el catálogo.
    const { SiigoCiudadMapeoError } = await import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js');
    proponerMock.mockRejectedValueOnce(
      new SiigoCiudadMapeoError('catalogo_vacio', 'El catálogo de ubicaciones no tiene ciudades activas de Co.'),
    );
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes-ciudades/propuestas')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('catalogo_vacio');
  });
});
