// HU #14280 (AC6, AC7, AC8): el log del API no copia lo que viene en la URL. Con Express real y nada
// simulado salvo el logger: las trampas (`baseUrl` vacío tras `next(err)`, 413 sin `req.route`) solo
// existen con el router de verdad.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';

const warnMock = vi.fn();
const errorMock = vi.fn();
vi.mock('../../src/shared/logger.js', () => {
  const falso = {
    warn: (...a: unknown[]) => warnMock(...a),
    error: (...a: unknown[]) => errorMock(...a),
    info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: () => falso,
  };
  return { logger: falso, loggerFor: () => falso };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
const { frenoConRastro } = await import('../../src/shared/middleware/rateLimiter.js');

const TOKEN_16 = 'k3Jx9QpLm2Zt7VbN';
const CUERPO_500 = { error: 'Error interno del servidor' };

function appConErrores() {
  const app = express();
  app.use('/api/validacion-identidad/completar', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '5mb' }));
  const router = Router();
  router.get('/historial/:placa', () => { throw new Error('Placa ABC123 sin historial'); });
  router.get('/cuentas/:filename', () => { throw new Error('No se pudo abrir WGY123 en disco'); });
  router.get('/portal/:token/firma', (req: Request) => { throw new Error(`token ${req.params.token} vencido`); });
  router.get('/buscar', () => { throw new Error('Failed query: params: VALORBUSCADO'); });
  router.post('/eco', (_req: Request, res: Response) => { res.json({ ok: true }); });
  app.use('/api/modulo', router);
  app.use(errorHandler);
  return app;
}

const escrito = () => JSON.stringify([...errorMock.mock.calls, ...warnMock.mock.calls]);

beforeEach(() => {
  warnMock.mockClear();
  errorMock.mockClear();
});

describe('AC6: 413 antes de llegar a la ruta', () => {
  it('no escribe un token de 16 caracteres y la respuesta no cambia', async () => {
    const r = await request(appConErrores())
      .post(`/api/validacion-identidad/completar/${TOKEN_16}`)
      .send({ foto: 'x'.repeat(16 * 1024 * 1024) });

    expect(r.status).toBe(413);
    expect(r.body).toEqual({
      ok: false,
      message: 'Las fotos superan el tamaño permitido. Reduce la resolución o acércate más al documento.',
    });
    expect(escrito()).not.toContain(TOKEN_16);
    expect(warnMock.mock.calls[0]![0]).toEqual({ method: 'POST', path: '/api/validacion-identidad/*' });
  });
});

describe('AC7: 500 de una ruta con dato en el path', () => {
  it('el mensaje cita el valor en otra capitalización: ni err, ni stack, ni path lo conservan', async () => {
    const r = await request(appConErrores()).get('/api/modulo/historial/abc123');

    expect(r.status).toBe(500);
    expect(r.body).toEqual(CUERPO_500);
    expect(escrito().toUpperCase()).not.toContain('ABC123');
    const campos = errorMock.mock.calls[0]![0] as { err: string; path: string; stack: string };
    expect(campos.path).toBe('/api/modulo/historial/:placa');
    // Lo que sirve para diagnosticar sigue ahí.
    expect(campos.err).toBe('Placa * sin historial');
    expect(campos.stack).toContain('logs-sin-dato-url.test');
  });

  it('`<placa>.pdf`: el mensaje trae solo la placa y tampoco queda', async () => {
    const r = await request(appConErrores()).get('/api/modulo/cuentas/WGY123.pdf');

    expect(r.status).toBe(500);
    expect(escrito()).not.toContain('WGY123');
    expect((errorMock.mock.calls[0]![0] as { path: string }).path).toBe('/api/modulo/cuentas/:filename');
  });

  it('token de 16 caracteres, codificado o no', async () => {
    await request(appConErrores()).get(`/api/modulo/portal/${TOKEN_16}/firma`);

    expect(escrito()).not.toContain(TOKEN_16);
    expect((errorMock.mock.calls[0]![0] as { path: string }).path).toBe('/api/modulo/portal/:token/firma');
  });

  it('un valor de la query citado en el mensaje tampoco queda', async () => {
    const r = await request(appConErrores()).get('/api/modulo/buscar?buscar=VALORBUSCADO');

    expect(r.status).toBe(500);
    expect(escrito()).not.toContain('VALORBUSCADO');
  });

  it('JSON roto: el mensaje del parser citaría el cuerpo; se conserva el 500 de hoy', async () => {
    const r = await request(appConErrores())
      .post('/api/modulo/eco')
      .set('Content-Type', 'application/json')
      .send('1036640908x');

    expect(r.status).toBe(500);
    expect(r.body).toEqual(CUERPO_500);
    expect(escrito()).not.toContain('1036640908');
    expect((errorMock.mock.calls[0]![0] as { err: string }).err).toBe('cuerpo JSON inválido');
  });

  it('un id corto no borra los números de línea del stack', async () => {
    const app = express();
    app.get('/api/x/:id', () => { throw new Error('fallo'); });
    app.use(errorHandler);

    await request(app).get('/api/x/12');

    expect((errorMock.mock.calls[0]![0] as { stack: string }).stack).toMatch(/:\d+:\d+/);
  });
});

describe('AC8: frenoConRastro', () => {
  function limitador(nombre: string) {
    return rateLimit({
      windowMs: 60_000, max: 1, keyGenerator: () => nombre,
      message: { error: 'freno' }, handler: frenoConRastro(nombre),
    });
  }

  it('limitador de ruta: escribe la plantilla', async () => {
    const app = express();
    const router = Router();
    router.get('/qr/:token', limitador('freno-ruta'), (_req: Request, res: Response) => { res.json({ ok: true }); });
    app.use('/api/drivers/checklists', router);

    await request(app).get(`/api/drivers/checklists/qr/${TOKEN_16}`);
    const r = await request(app).get(`/api/drivers/checklists/qr/${TOKEN_16}`);

    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'freno' });
    expect(escrito()).not.toContain(TOKEN_16);
    expect(warnMock.mock.calls[0]![0]).toMatchObject({ ruta: '/api/drivers/checklists/qr/:token' });
  });

  it('limitador de router, sin plantilla: `<placa>.pdf` y token de 16 no quedan', async () => {
    const app = express();
    app.use('/api/public/drive', limitador('freno-router'));
    app.get('/api/public/drive/cuentas-archivo/:dir/:token/:filename', (_req: Request, res: Response) => { res.json({ ok: true }); });
    const url = `/api/public/drive/cuentas-archivo/lote/${TOKEN_16}/WGY123.pdf`;

    await request(app).get(url);
    const r = await request(app).get(url);

    expect(r.status).toBe(429);
    expect(escrito()).not.toContain(TOKEN_16);
    expect(escrito()).not.toContain('WGY123');
    expect(warnMock.mock.calls[0]![0]).toMatchObject({ ruta: '/api/public/*' });
  });
});
