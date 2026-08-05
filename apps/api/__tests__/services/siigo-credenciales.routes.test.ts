// HU #11247 — endpoints de administración de credenciales de Siigo.
//
// Son las llaves con las que se factura ante la DIAN: quién puede tocarlas y qué sale por la
// respuesta importa tanto como el cifrado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth, proveedorAuth } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

const guardarCredencialMock = vi.fn();
const listarCredencialesMock = vi.fn();
const desactivarCredencialMock = vi.fn();
vi.mock('../../src/modules/siigo/credenciales.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/credenciales.service.js')>();
  return {
    ...actual,
    guardarCredencial: guardarCredencialMock,
    listarCredenciales: listarCredencialesMock,
    desactivarCredencial: desactivarCredencialMock,
  };
});

const BODY_VALIDO = {
  ambiente: 'pruebas' as const,
  username: 'usuario@flitsas.com',
  accessKey: 'clave-de-acceso-siigo',
  notas: 'credencial de pruebas',
};

let app: ReturnType<typeof import('../../src/app.js').createApp>;

beforeEach(async () => {
  guardarCredencialMock.mockReset();
  listarCredencialesMock.mockReset();
  desactivarCredencialMock.mockReset();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('autenticación y permisos', () => {
  it('GET sin token responde 401', async () => {
    const r = await request(app).get('/api/siigo/credenciales');
    expect(r.status).toBe(401);
  });

  it('GET con rol no-admin responde 403', async () => {
    const r = await request(app)
      .get('/api/siigo/credenciales')
      .set('Authorization', await proveedorAuth());
    expect(r.status).toBe(403);
  });

  it('POST con rol no-admin responde 403 y no llega al servicio', async () => {
    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await proveedorAuth())
      .send(BODY_VALIDO);
    expect(r.status).toBe(403);
    expect(guardarCredencialMock).not.toHaveBeenCalled();
  });

  it('DELETE sin token responde 401', async () => {
    const r = await request(app).delete('/api/siigo/credenciales/1');
    expect(r.status).toBe(401);
  });
});

describe('AC2 — el listado no expone el secreto', () => {
  it('GET devuelve la credencial con el access_key enmascarado', async () => {
    listarCredencialesMock.mockResolvedValue([{
      id: 1, ambiente: 'pruebas', username: 'usuario@flitsas.com',
      accessKey: '••••••••', activo: true, keyVersion: 1, notas: null,
      descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const r = await request(app)
      .get('/api/siigo/credenciales')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].accessKey).toBe('••••••••');
    expect(r.body.data[0]).not.toHaveProperty('accessKeyCipher');
    expect(r.body.data[0]).not.toHaveProperty('aadNonce');
  });

  it('GET informa si la llave maestra está configurada, para poder diagnosticar antes de fallar', async () => {
    listarCredencialesMock.mockResolvedValue([]);
    const r = await request(app)
      .get('/api/siigo/credenciales')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.llaveMaestraConfigurada).toBe(true); // setup.ts define SIIGO_ENC_KEY
  });
});

describe('validación de entrada', () => {
  it('rechaza un ambiente fuera del enum', async () => {
    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send({ ...BODY_VALIDO, ambiente: 'staging' });
    expect(r.status).toBe(400);
    expect(guardarCredencialMock).not.toHaveBeenCalled();
  });

  it('rechaza un access_key demasiado corto', async () => {
    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send({ ...BODY_VALIDO, accessKey: 'abc' });
    expect(r.status).toBe(400);
  });

  it('rechaza body vacío', async () => {
    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('acepta un body válido y delega con el userId del token', async () => {
    guardarCredencialMock.mockResolvedValue({
      id: 5, ambiente: 'pruebas', username: BODY_VALIDO.username,
      accessKey: '••••••••', activo: true, keyVersion: 1,
    });

    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send(BODY_VALIDO);

    expect(r.status).toBe(201);
    expect(r.body.id).toBe(5);
    expect(r.body.accessKey).toBe('••••••••');
    expect(guardarCredencialMock.mock.calls[0]![0]).toMatchObject({
      ambiente: 'pruebas', accessKey: BODY_VALIDO.accessKey, userId: 1,
    });
  });

  it('la respuesta de creación nunca trae el access_key real', async () => {
    guardarCredencialMock.mockResolvedValue({
      id: 5, ambiente: 'pruebas', username: BODY_VALIDO.username, accessKey: '••••••••', activo: true,
    });
    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send(BODY_VALIDO);
    expect(JSON.stringify(r.body)).not.toContain(BODY_VALIDO.accessKey);
  });
});

describe('AC4 — sin llave maestra la administración responde 503', () => {
  it('traduce el fallo de configuración a 503 y no a 500', async () => {
    const { SiigoEncKeyError } = await import('../../src/shared/utils/crypto.js');
    guardarCredencialMock.mockRejectedValue(
      new SiigoEncKeyError('SIIGO_ENC_KEY no está configurada: ...'),
    );

    const r = await request(app)
      .post('/api/siigo/credenciales')
      .set('Authorization', await adminAuth())
      .send(BODY_VALIDO);

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('llave_maestra');
    expect(r.body.error).toMatch(/SIIGO_ENC_KEY/);
  });
});

describe('desactivación', () => {
  it('rechaza un id no numérico', async () => {
    const r = await request(app)
      .delete('/api/siigo/credenciales/abc')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
    expect(desactivarCredencialMock).not.toHaveBeenCalled();
  });

  it('responde 404 si no existía', async () => {
    desactivarCredencialMock.mockResolvedValue(false);
    const r = await request(app)
      .delete('/api/siigo/credenciales/999')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('responde 200 y delega con el usuario que la desactiva', async () => {
    desactivarCredencialMock.mockResolvedValue(true);
    const r = await request(app)
      .delete('/api/siigo/credenciales/5')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(desactivarCredencialMock).toHaveBeenCalledWith(5, 1);
  });
});
