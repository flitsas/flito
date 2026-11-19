// HU #13947 (Feature #13939) — el desbloqueo excepcional de SOAT/impuesto de un cliente INACTIVO responde 409.
//
// El servicio (`flito-excepciones.test.ts`) prueba que el helper corta el alta dentro de la transacción; aquí se
// prueba solo la TRADUCCIÓN de la ruta: `ClienteNoOperableError` → 409 con el mensaje del AC, sin auditar.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/modules/flito-tramites/flito-tramites.alcance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/flito-tramites/flito-tramites.alcance.js')>();
  return { ...real, exigirTramitesPropios: vi.fn().mockResolvedValue(undefined) };
});
const desbloquearMock = vi.fn();
vi.mock('../../src/modules/flito-excepciones/flito-excepciones.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/flito-excepciones/flito-excepciones.service.js')>();
  return { ...real, desbloquear: desbloquearMock };
});

const { ClienteNoOperableError, mensajeClienteInactivo } = await import('../../src/modules/clients/cliente-operable.js');
const { ExcepcionError } = await import('../../src/modules/flito-excepciones/flito-excepciones.service.js');

const BASE = '/api/flito/tramites';
const TRAMITE = '11111111-1111-4111-8111-111111111111';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  app.use(BASE, router);
  return app;
}

async function token() {
  const t = `Bearer ${await testToken({ sub: 41, role: 'admin' })}`;
  await registrarUsuarioDePrueba(41, {
    rol: 'admin', tipoEnlace: 'ninguno', funcionesDelRol: ['tramites.autogestion.desbloquear'], excepciones: [],
  });
  return t;
}

const desbloqueo = async (concepto: string) => request(await buildApp())
  .post(`${BASE}/${TRAMITE}/desbloquear-autogestion`).set('Authorization', await token())
  .send({ concepto, motivo: 'lo pide el cliente por escrito' });

beforeEach(() => { desbloquearMock.mockReset(); auditMock.mockClear(); });

describe('POST /:id/desbloquear-autogestion — cliente inactivo (HU #13947)', () => {
  it('SOAT: ClienteNoOperableError → 409 con el mensaje del AC y sin auditar', async () => {
    desbloquearMock.mockRejectedValue(new ClienteNoOperableError(5, mensajeClienteInactivo('Transportes Andes', 'SOAT')));
    const r = await desbloqueo('soat');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'El cliente Transportes Andes está inactivo: no se pueden crear SOAT para él.' });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('impuesto: mismo 409 con «impuestos» en el mensaje', async () => {
    desbloquearMock.mockRejectedValue(new ClienteNoOperableError(5, mensajeClienteInactivo('Transportes Andes', 'impuestos')));
    const r = await desbloqueo('impuesto');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('El cliente Transportes Andes está inactivo: no se pueden crear impuestos para él.');
  });

  it('la traducción que ya existía no se movió: ExcepcionError conserva su estado', async () => {
    desbloquearMock.mockRejectedValue(new ExcepcionError(404, 'Trámite no encontrado'));
    const r = await desbloqueo('soat');
    expect(r.status).toBe(404);
  });
});
