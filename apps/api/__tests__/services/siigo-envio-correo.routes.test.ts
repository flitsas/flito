// HU #11334 — envío y reenvío de la factura por correo: fronteras HTTP.
//
// Lo que se prueba aquí es QUIÉN entra y QUÉ se rechaza antes de llegar al servicio. La lógica del
// envío vive en `siigo-envio-correo.test.ts`, que la interroga sin HTTP.
//
// La matriz de roles se recorre entera a propósito: una guarda mal puesta solo se nota probando el
// rol que NO debería pasar. El matiz de esta historia es que `auditor` LEE el historial de envíos y
// no reenvía — auditar es mirar, y reenviar le manda un documento fiscal a alguien.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const bitacoraMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: bitacoraMock,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const siigoRequestOrThrowMock = vi.fn().mockResolvedValue({ mail: { send: true } });
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const FACTURA_ID = '11111111-2222-3333-4444-555555555555';

function facturaConCliente(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA_ID, ambiente: 'pruebas', siigoInvoiceId: 'inv-1', numero: 'FV-100',
    estado: 'emitida', clienteEmail: 'pagos@cliente.test', clienteContactEmail: null,
    ...over,
  };
}

function actaDevuelta(over: Record<string, unknown> = {}) {
  return {
    id: 'acta-1', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'enviado',
    destinatarios: [{ correo: 'pagos@cliente.test', origen: 'compania' }],
    destinatariosPurgadosEn: null, codigo: null, motivo: null, solicitadoPor: 9,
    createdAt: new Date('2026-08-10T12:00:00Z'), ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/envio-correo.routes.js');
  app.use('/api/siigo/envios', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

/** Ni admin ni financiera: ninguno reenvía. `auditor` incluido, y ese es el matiz. */
const ROLES_SIN_ESCRITURA: TestRole[] = [
  'auditor', 'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  bitacoraMock.mockClear();
  siigoRequestOrThrowMock.mockClear();
});

describe('Ninguna ruta de envíos es pública', () => {
  it.each([
    ['get', `/api/siigo/envios/factura/${FACTURA_ID}`],
    ['post', `/api/siigo/envios/factura/${FACTURA_ID}`],
  ])('%s %s sin token → 401', async (verbo, ruta) => {
    const app = await buildApp();
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo]!(ruta);
    expect(r.status).toBe(401);
  });
});

describe('Quién puede reenviar', () => {
  it.each(ROLES_SIN_ESCRITURA)('%s no reenvía → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth(role))
      .send({});

    expect(r.status).toBe(403);
    // Y sobre todo: la guarda para ANTES de la red. Un 403 que ya gastó una petición de la cuota
    // compartida con la emisión no protege de nada.
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'financiera'] as TestRole[])('%s sí reenvía → 200', async (role) => {
    kdb.when.select('siigo_facturas', [facturaConCliente()]);
    kdb.when.insert('siigo_factura_envios', () => [actaDevuelta()]);

    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth(role))
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.resultado).toBe('enviado');
  });

  it('auditor SÍ lee el historial: auditar es mirar', async () => {
    kdb.when.select('siigo_factura_envios', []);
    const app = await buildApp();
    const r = await request(app)
      .get(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(r.body.veces).toBe(0);
  });
});

describe('Lo que la ruta rechaza antes de tocar el servicio', () => {
  it('un identificador que no es UUID → 400, sin consultar nada', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/api/siigo/envios/factura/no-es-un-uuid')
      .set('Authorization', await auth('admin'))
      .send({});

    expect(r.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('seis destinatarios → 400 y ninguna petición a Siigo', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ destinatarios: Array.from({ length: 6 }, (_, i) => `d${i}@x.test`) });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('5');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('una dirección que no tiene forma de correo → 400', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ destinatarios: ['esto-no-es-un-correo'] });

    expect(r.status).toBe(400);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

describe('Lo que la ruta responde cuando el servicio dice que no', () => {
  it('una factura que aún no existe en Siigo → 409 con su código', async () => {
    kdb.when.select('siigo_facturas', [facturaConCliente({ estado: 'en_proceso', siigoInvoiceId: null })]);

    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({});

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('factura_no_emitida');
  });

  it('una factura inexistente → 404', async () => {
    kdb.when.select('siigo_facturas', []);

    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({});

    expect(r.status).toBe(404);
  });

  it('un envío no realizado responde 200, no 5xx: el registro SÍ ocurrió', async () => {
    kdb.when.select('siigo_facturas', [facturaConCliente({ clienteEmail: null })]);
    kdb.when.insert('siigo_factura_envios', () => [actaDevuelta({
      resultado: 'no_realizado', destinatarios: [], codigo: 'cliente_sin_correo',
      motivo: 'El cliente no tiene un correo registrado en su ficha.',
    })]);

    const app = await buildApp();
    const r = await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({});

    // Un 5xx haría creer que no quedó rastro, que es lo contrario de lo que la historia garantiza.
    expect(r.status).toBe(200);
    expect(r.body.resultado).toBe('no_realizado');
  });
});

describe('La auditoría no duplica las direcciones', () => {
  it('anota cuántos destinatarios, no cuáles', async () => {
    kdb.when.select('siigo_facturas', [facturaConCliente()]);
    kdb.when.insert('siigo_factura_envios', () => [actaDevuelta()]);

    const app = await buildApp();
    await request(app)
      .post(`/api/siigo/envios/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({});

    // El acta es el único registro autorizado a guardar direcciones, porque es el único que la
    // purga por derecho de supresión puede vaciar. Copiarlas al log de auditoría abriría un
    // duplicado que nadie limpiaría.
    const anotado = JSON.stringify(auditMock.mock.calls[0]?.[1] ?? {});
    expect(anotado).not.toContain('pagos@cliente.test');
    expect(anotado).toContain('1 destinatario');
  });
});
