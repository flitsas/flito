import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { env } from '../../src/config/env.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// nodemailer mock
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

// storage mock
const uploadPhotoMock = vi.fn();
const getPhotoMock = vi.fn();
const ensureBucketMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/storage.js', () => ({
  uploadPhoto: uploadPhotoMock,
  getPhoto: getPhotoMock,
  ensureBucket: ensureBucketMock,
}));

// TRAM-11: las rutas llaman a anthropicMessages (helper resiliente). Mockeamos
// ese seam en vez de `https`.
const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({
  anthropicMessages: anthropicMock,
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  auditMock.mockClear();
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  uploadPhotoMock.mockReset();
  getPhotoMock.mockReset();
  ensureBucketMock.mockClear().mockResolvedValue(undefined);
  anthropicMock.mockReset();

  // Setear process.env (no env directo) — vi.resetModules() reparseará env.ts y debe leer
  // process.env actualizado. Mutar el env importado solo no funciona tras resetModules.
  process.env.SMTP_HOST = 'smtp.test.com';
  process.env.SMTP_USER = 'test@kyverum.com';
  process.env.SMTP_PASS = 'pass';
  process.env.SMTP_FROM_NAME = 'FLIT';
  process.env.PUBLIC_URL = 'https://operaciones.kyverum.com';
  process.env.PII_ENC_KEY = 'test-pii-enc-key-test-pii-enc-key-1234'; // ≥ 32 chars (zod min)
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  vi.resetModules();
});

async function buildApp() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const { default: router } = await import('../../src/modules/tramites/identidad.routes.js');
  app.use('/api/tramites/identidad', router);
  return app;
}

function queueVisionResponse(jsonData: object | { error: string }) {
  if ('error' in jsonData) {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'Servicio de IA no disponible, intenta de nuevo.' });
  } else {
    anthropicMock.mockResolvedValueOnce({ ok: true, data: { content: [{ text: JSON.stringify(jsonData) }] } });
  }
}

describe('identidad — auth en endpoints admin', () => {
  it('POST /iniciar sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar').send({ tramiteId: 1 });
    expect(r.status).toBe(401);
  });

  it('POST /iniciar proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    expect(r.status).toBe(403);
  });

  it('GET /estado/:id sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/estado/1');
    expect(r.status).toBe(401);
  });

  it('GET /documentos/:id sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/documentos/1');
    expect(r.status).toBe(401);
  });
});

describe('POST /iniciar — envío email validación', () => {
  it('sin tramiteId → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });

  it('tramite no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 999 });
    expect(r.status).toBe(404);
  });

  it('comprador sin email → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, comprador: { nombre: 'X' } }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/email válido/);
  });

  it('email formato inválido → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, comprador: { nombre: 'Juan', email: 'no-arroba' },
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    expect(r.status).toBe(400);
  });

  it('SMTP no configurado → fallback enlace manual (200, default TRAMITES_EMAIL_FALLBACK=true)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, comprador: { nombre: 'Juan', email: 'juan@x.com', documento: '123', tipoDoc: 'CC' },
      placa: 'ABC123', vehiculo: { marca: 'TOYOTA' },
    }]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });
    delete process.env.SMTP_HOST;
    vi.resetModules();
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    // El token+enlace ya están creados → no se bloquea el trámite; se devuelve el enlace.
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.fallback).toBe(true);
    expect(r.body.emailEnviado).toBe(false);
    expect(r.body.motivo).toMatch(/SMTP no configurado/);
    expect(r.body.link).toContain('/validar-identidad.html?t=');
  });

  it('éxito: invalida tokens previos + insert + sendMail + audit con email enmascarado', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, comprador: { nombre: 'Juan Pérez', email: 'juan@x.com', documento: '123', tipoDoc: 'CC' },
      placa: 'ABC123', vehiculo: { marca: 'TOYOTA', linea: 'COROLLA', modelo: 2020 },
    }]));
    let updateValues: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (v: any) => { updateValues = v; return { where: () => Promise.resolve(undefined) }; },
    })).mockImplementationOnce(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    let insertValues: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { insertValues = v; return Promise.resolve(undefined); },
    });
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-001' });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 5 });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.email).toBe('juan@x.com');
    expect(updateValues.estado).toBe('rechazado'); // invalida previos
    expect(insertValues.estado).toBe('enviado');
    expect(insertValues.token).toMatch(/^[a-f0-9]{64}$/); // crypto.randomBytes(32).hex
    expect(insertValues.placa).toBe('ABC123');
    expect(insertValues.vehiculoInfo).toBe('TOYOTA COROLLA 2020');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('juan@x.com');
    expect(sendMailMock.mock.calls[0][0].subject).toContain('ABC123');
    // Audit con email enmascarado vía regex `^(.).*(.@.+)$`: juan@x.com → j***n@x.com
    expect(auditMock.mock.calls[0][1].detail).toMatch(/j\*\*\*n@x\.com/);
  });

  it('sendMail falla → fallback enlace manual (200) con motivo del error SMTP', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, comprador: { nombre: 'Juan', email: 'juan@x.com', documento: '123' },
      placa: 'ABC', vehiculo: {},
    }]));
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValue({ values: () => Promise.resolve(undefined) });
    sendMailMock.mockRejectedValueOnce(new Error('SMTP rejected'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.fallback).toBe(true);
    expect(r.body.emailEnviado).toBe(false);
    expect(r.body.motivo).toContain('SMTP rejected');
    expect(r.body.link).toContain('/validar-identidad.html?t=');
  });

  it('sendMail falla con TRAMITES_EMAIL_FALLBACK=false → 500 (modo estricto)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, comprador: { nombre: 'Juan', email: 'juan@x.com', documento: '123' },
      placa: 'ABC', vehiculo: {},
    }]));
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValue({ values: () => Promise.resolve(undefined) });
    sendMailMock.mockRejectedValueOnce(new Error('SMTP rejected'));
    process.env.TRAMITES_EMAIL_FALLBACK = 'false';
    vi.resetModules();
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 1 });
    delete process.env.TRAMITES_EMAIL_FALLBACK;
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('SMTP rejected');
  });
});

describe('GET /info/:token — público', () => {
  it('token no existe → ok=false enlace inválido', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/info/abc123');
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/inválido/);
  });

  it('token expirado → estado=expirado', async () => {
    selectMock.mockReturnValueOnce(chain([{
      token: 'x', expiraAt: new Date(Date.now() - 86400_000).toISOString(),
      estado: 'enviado', nombre: 'Juan', tipoDoc: 'CC', documento: '123',
      placa: 'ABC123', vehiculoInfo: 'TOYOTA',
    }]));
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/info/x');
    expect(r.body.ok).toBe(false);
    expect(r.body.estado).toBe('expirado');
  });

  it('token ya aprobado → estado=aprobado', async () => {
    selectMock.mockReturnValueOnce(chain([{
      token: 'x', expiraAt: new Date(Date.now() + 86400_000).toISOString(),
      estado: 'aprobado', nombre: 'Juan',
    }]));
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/info/x');
    expect(r.body.ok).toBe(false);
    expect(r.body.estado).toBe('aprobado');
  });

  it('token válido → ok=true con datos del trámite', async () => {
    selectMock.mockReturnValueOnce(chain([{
      token: 'x', expiraAt: new Date(Date.now() + 86400_000).toISOString(),
      estado: 'enviado', nombre: 'Juan', tipoDoc: 'CC',
      documento: '123', placa: 'ABC123', vehiculoInfo: 'TOYOTA',
    }]));
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/info/x');
    expect(r.body.ok).toBe(true);
    expect(r.body.nombre).toBe('Juan');
    expect(r.body.placa).toBe('ABC123');
  });
});

describe('POST /completar/:token — flujo biométrico', () => {
  function stubRecoveryEmpty() {
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
  }
  function stubAtomicUpdateOk(record: any) {
    stubRecoveryEmpty();
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([record]) }) }),
    }));
  }
  function stubAtomicUpdateEmpty() {
    stubRecoveryEmpty();
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
  }

  it('token no existe → 400', async () => {
    stubAtomicUpdateEmpty();
    selectMock.mockReturnValueOnce(chain([])); // verifica causa: no existe
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/notoken')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Token inválido/);
  });

  it('ya aprobado → ok=true (idempotente)', async () => {
    stubAtomicUpdateEmpty();
    selectMock.mockReturnValueOnce(chain([{ estado: 'aprobado', intentos: 1, expiraAt: new Date(Date.now() + 86400_000).toISOString() }]));
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.body.ok).toBe(true);
    expect(r.body.aprobado).toBe(true);
  });

  it('intentos >= 5 → 429', async () => {
    stubAtomicUpdateEmpty();
    selectMock.mockReturnValueOnce(chain([{ estado: 'enviado', intentos: 5, expiraAt: new Date(Date.now() + 86400_000).toISOString() }]));
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/Máximo de intentos/);
  });

  it('expirado → 400', async () => {
    stubAtomicUpdateEmpty();
    selectMock.mockReturnValueOnce(chain([{ estado: 'enviado', intentos: 1, expiraAt: new Date(Date.now() - 86400_000).toISOString() }]));
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Enlace expirado/);
  });

  it('en_proceso activo (no stale) → 409 con mensaje de espera', async () => {
    stubAtomicUpdateEmpty();
    selectMock.mockReturnValueOnce(chain([{
      estado: 'en_proceso', intentos: 1,
      expiraAt: new Date(Date.now() + 86400_000).toISOString(),
    }]));
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/validación en curso/i);
  });

  it('stale en_proceso recuperado → permite continuar (recovery + atomic OK)', async () => {
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 15 }]) }) }),
    }));
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, tramiteId: 5, documento: '123' }]) }) }),
    }));
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    process.env.ANTHROPIC_API_KEY = '';
    vi.resetModules();
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(500);
    expect(updateMock).toHaveBeenCalled();
  });

  it('atomic OK pero sin las 3 fotos → 400 + revertir estado=enviado', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    let revertCalled = false;
    updateMock.mockImplementationOnce(() => ({
      set: (v: any) => { if (v.estado === 'enviado') revertCalled = true; return { where: () => Promise.resolve(undefined) }; },
    }));
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x' }); // faltan 2
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/3 fotos son requeridas/);
    expect(revertCalled).toBe(true);
  });

  it('foto > 5MB (base64 > 7MB) → 400 + revertir', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    const huge = 'A'.repeat(8 * 1024 * 1024); // 8MB
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: huge, fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/máximo 5MB/);
  });

  it('sin ANTHROPIC_API_KEY → 500 + revertir', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    // String vacío → !env.ANTHROPIC_API_KEY === true. NO usar delete porque dotenv.config
    // restaura desde .env tras vi.resetModules.
    process.env.ANTHROPIC_API_KEY = '';
    vi.resetModules();
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/API key no configurada/);
  });

  it('Vision API falla → 503 + revertir intentos -1 (TRAM-11)', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    let revertValues: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (v: any) => { revertValues = v; return { where: () => Promise.resolve(undefined) }; },
    }));
    queueVisionResponse({ error: 'Rate limit' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/disponible|intenta/i);
    expect(revertValues.estado).toBe('enviado');
  });

  it('biometría rechazada (documento no coincide) → 200 ok=true aprobado=false con motivo', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123456789' });
    updateMock.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    queueVisionResponse({
      resultado_general: { aprobado: true, score_total: 90 },
      documento_ocr: { numero: '999', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
      liveness: { rostro_visible: true, es_persona_real: true },
      comparacion_facial: { score: 85 },
    });
    uploadPhotoMock.mockResolvedValue('validaciones/5/foto.jpg');

    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
    expect(r.body.ok).toBe(true);
    expect(r.body.aprobado).toBe(false);
    expect(r.body.motivo).toMatch(/no coincide con el registrado/);
  });

  it('biometría aprobada → 200 ok=true aprobado=true + uploadPhoto x3 + ensureBucket', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    updateMock.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    queueVisionResponse({
      resultado_general: { aprobado: true, score_total: 95 },
      documento_ocr: { numero: '123', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
      liveness: { rostro_visible: true, es_persona_real: true },
      comparacion_facial: { score: 90 },
    });
    uploadPhotoMock.mockResolvedValue('validaciones/5/foto.jpg');

    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'r', fotoCedula: 'f', fotoCedulaReverso: 'rev' });
    expect(r.body.aprobado).toBe(true);
    expect(r.body.score).toBe(95);
    expect(ensureBucketMock).toHaveBeenCalled();
    expect(uploadPhotoMock).toHaveBeenCalledTimes(3);
  });

  it('S3 falla durante uploadPhoto → 503 + revertir intentos', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    let revertValues: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (v: any) => { revertValues = v; return { where: () => Promise.resolve(undefined) }; },
    }));
    queueVisionResponse({
      resultado_general: { aprobado: true, score_total: 95 },
      documento_ocr: { numero: '123', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
      liveness: { rostro_visible: true, es_persona_real: true },
      comparacion_facial: { score: 90 },
    });
    uploadPhotoMock.mockRejectedValueOnce(new Error('MinIO down'));

    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'r', fotoCedula: 'f', fotoCedulaReverso: 'rev' });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/Almacenamiento.*no disponible/);
    expect(revertValues.estado).toBe('enviado');
  });

  it('liveness rostro_visible=false → rechazado por liveness', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    updateMock.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    queueVisionResponse({
      resultado_general: { aprobado: true, score_total: 90 },
      documento_ocr: { numero: '123', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
      liveness: { rostro_visible: false, es_persona_real: true },
      comparacion_facial: { score: 90 },
    });
    uploadPhotoMock.mockResolvedValue('k');
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'r', fotoCedula: 'f', fotoCedulaReverso: 'rev' });
    expect(r.body.aprobado).toBe(false);
    expect(r.body.motivo).toMatch(/rostro no es completamente visible/i);
  });

  it('comparación facial < 60 → rechazado', async () => {
    stubAtomicUpdateOk({ id: 1, tramiteId: 5, documento: '123' });
    updateMock.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    queueVisionResponse({
      resultado_general: { aprobado: true, score_total: 90 },
      documento_ocr: { numero: '123', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
      liveness: { rostro_visible: true, es_persona_real: true },
      comparacion_facial: { score: 45 },
    });
    uploadPhotoMock.mockResolvedValue('k');
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/completar/x')
      .send({ fotoRostro: 'r', fotoCedula: 'f', fotoCedulaReverso: 'rev' });
    expect(r.body.aprobado).toBe(false);
    expect(r.body.motivo).toMatch(/coincidencia facial es insuficiente/i);
  });
});

describe('GET /estado/:tramiteId', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/estado/abc')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('id válido → 200 con validaciones', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, nombre: 'Juan', estado: 'aprobado', score: 95, intentos: 1 },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/estado/5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.validaciones).toHaveLength(1);
  });
});

describe('GET /documentos/:tramiteId — fotos resueltas (S3 vs legacy)', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/documentos/abc')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('foto en S3 (key validaciones/...) → llama getPhoto', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, nombre: 'X', tipoDoc: 'CC', documento: '123', estado: 'aprobado', score: 90,
      fotoRostro: 'validaciones/5/rostro_abc.jpg',
      fotoCedulaFrontal: null, fotoCedulaReverso: null,
      detalle: {}, validadoAt: null, ipAddress: null, ciudadGeo: null, lat: null, lng: null,
      intentos: 1, enviadoAt: null,
    }]));
    getPhotoMock.mockResolvedValueOnce('data:image/jpeg;base64,abc');
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.documentos[0].fotoRostro).toBe('data:image/jpeg;base64,abc');
    expect(getPhotoMock).toHaveBeenCalledWith('validaciones/5/rostro_abc.jpg');
  });

  it('getPhoto throws → null en respuesta (no rompe)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, nombre: 'X', tipoDoc: 'CC', documento: '123', estado: 'aprobado', score: 90,
      fotoRostro: 'validaciones/5/rostro.jpg',
      fotoCedulaFrontal: null, fotoCedulaReverso: null,
      detalle: {}, validadoAt: null, ipAddress: null, ciudadGeo: null, lat: null, lng: null,
      intentos: 1, enviadoAt: null,
    }]));
    getPhotoMock.mockRejectedValueOnce(new Error('S3 404'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.documentos[0].fotoRostro).toBeNull();
  });

  it('foto null → null sin llamar getPhoto', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, nombre: 'X', tipoDoc: 'CC', documento: '123', estado: 'aprobado', score: 90,
      fotoRostro: null, fotoCedulaFrontal: null, fotoCedulaReverso: null,
      detalle: {}, validadoAt: null, ipAddress: null, ciudadGeo: null, lat: null, lng: null,
      intentos: 0, enviadoAt: null,
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.documentos[0].fotoRostro).toBeNull();
    expect(getPhotoMock).not.toHaveBeenCalled();
  });
});

describe('GET /sse — Server-Sent Events', () => {
  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/identidad/sse')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('POST /iniciar-partes — reenvío selectivo traspaso', () => {
  it('vendedor aprobado + comprador rechazado → solo reenvía comprador', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 21,
        placa: 'IWL38D',
        vehiculo: {
          marca: 'MAZDA',
          _vendedor: { nombre: 'Ven', documento: '111', email: 'v@x.co', tipoDoc: 'CC' },
        },
        comprador: { nombre: 'Com', documento: '222', email: 'c@x.co', tipoDoc: 'CC' },
      }]))
      .mockReturnValueOnce(chain([
        { id: 10, parte: 'vendedor', documento: '111', estado: 'aprobado' },
        { id: 11, parte: 'comprador', documento: '222', estado: 'rechazado' },
      ]));
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValue({ values: () => Promise.resolve(undefined) });
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-1' });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar-partes')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 21 });

    expect(r.status).toBe(200);
    expect(r.body.partes).toHaveLength(1);
    expect(r.body.partes[0].parte).toBe('comprador');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('c@x.co');
  });

  it('vehiculo corrupto (solo _stt) → recupera emails de validaciones previas y reenvía', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 27,
        placa: 'IWL38D',
        vehiculo: { _stt: { observaciones: 'x' } },
        comprador: {},
      }]))
      .mockReturnValueOnce(chain([
        { id: 10, parte: 'vendedor', documento: '111', email: 'v@x.co', estado: 'rechazado' },
        { id: 11, parte: 'comprador', documento: '222', email: 'c@x.co', estado: 'rechazado' },
      ]));
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValue({ values: () => Promise.resolve(undefined) });
    sendMailMock.mockResolvedValue({ messageId: 'm-1' });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar-partes')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 27 });

    expect(r.status).toBe(200);
    expect(r.body.partes).toHaveLength(2);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const destinos = sendMailMock.mock.calls.map((c: any[]) => c[0].to).sort();
    expect(destinos).toEqual(['c@x.co', 'v@x.co']);
  });

  it('vehiculo corrupto + mismo email recuperado en ambas partes → 400 duplicado (no "falta email")', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 27,
        placa: 'IWL38D',
        vehiculo: { _stt: { observaciones: 'x' } },
        comprador: {},
      }]))
      .mockReturnValueOnce(chain([
        { id: 10, parte: 'vendedor', documento: '111', email: 'andresmenez4@gmail.com', estado: 'rechazado' },
        { id: 11, parte: 'comprador', documento: '222', email: 'andresmenez4@gmail.com', estado: 'rechazado' },
      ]));

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar-partes')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 27 });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/mismo correo/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('ambas aprobadas o enlaces activos → 200 sin reenvío', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: 21,
        placa: 'IWL38D',
        vehiculo: { _vendedor: { nombre: 'Ven', documento: '111', email: 'v@x.co', tipoDoc: 'CC' } },
        comprador: { nombre: 'Com', documento: '222', email: 'c@x.co', tipoDoc: 'CC' },
      }]))
      .mockReturnValueOnce(chain([
        { id: 10, parte: 'vendedor', documento: '111', estado: 'aprobado' },
        { id: 11, parte: 'comprador', documento: '222', estado: 'enviado' },
      ]));

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/identidad/iniciar-partes')
      .set('Authorization', `Bearer ${token}`).send({ tramiteId: 21 });

    expect(r.status).toBe(200);
    expect(r.body.partes).toHaveLength(0);
    expect(r.body.message).toMatch(/pendientes de reenvío/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
