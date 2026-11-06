// Feature #14097 (HU #14099 AC1-AC4) — clasificador de fotos y comportamiento de la ruta cuando un
// valor con formato cifrado no descifra. Antes del arreglo la ruta respondía 200 con el cifrado.
import 'express-async-errors';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => {
  const logs: unknown[][] = [];
  const rec = (...a: unknown[]) => { logs.push(a); };
  const logger: Record<string, unknown> = { trace: rec, debug: rec, info: rec, warn: rec, error: rec, fatal: rec };
  logger.child = () => logger;
  return { logs, logger, selectMock: vi.fn(), insertMock: vi.fn(), getPhotoMock: vi.fn() };
});

vi.mock('../../src/shared/logger.js', () => ({
  logger: m.logger,
  loggerFor: () => m.logger,
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: m.selectMock, insert: m.insertMock, update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/services/storage.js', () => ({
  uploadPhoto: vi.fn(),
  getPhoto: m.getPhotoMock,
  ensureBucket: vi.fn(),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() }, createTransport: vi.fn() }));
vi.mock('express-rate-limit', () => ({ default: () => (_q: unknown, _s: unknown, next: () => void) => next() }));

const { env } = await import('../../src/config/env.js');
const { encryptPiiText, PiiDecryptError } = await import('../../src/shared/utils/crypto.js');
const { piiDecryptFailuresTotal, piiLegacyPlaintextTotal, registry } = await import('../../src/shared/metrics.js');
const { clasificarFoto, resolverFotoBiometrica } = await import('../../src/modules/tramites/identidad.fotos.js');
const { default: router } = await import('../../src/modules/tramites/identidad.routes.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');

const OTRA_LLAVE = 'otra-llave-otra-llave-otra-llave-otra-1234';
const FOTO = 'data:image/jpeg;base64,U0VDUkVUT19CSU9NRVRSSUNP';
const BASE64_LARGO = 'QUJD'.repeat(40);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function cifrarViejo(plano: string, passphrase: string): string {
  const key = crypto.scryptSync(passphrase, 'kyverum-pii-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plano, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('base64')}`;
}

/** Cifra con la llave de otro ambiente, que es el escenario real de una llave mal desplegada. */
function cifrarNuevoConOtraLlave(plano: string, id: number, column = 'foto_rostro'): string {
  const envMutable = env as { PII_ENC_KEY: string };
  const original = envMutable.PII_ENC_KEY;
  envMutable.PII_ENC_KEY = OTRA_LLAVE;
  try {
    return encryptPiiText(plano, { table: 'tramites_validaciones', column, id });
  } finally {
    envMutable.PII_ENC_KEY = original;
  }
}

async function valorMetrica(counter: typeof piiDecryptFailuresTotal, column: string): Promise<number> {
  const { values } = await counter.get();
  return values.find((v) => v.labels.column === column && v.labels.table === 'tramites_validaciones')?.value ?? 0;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tramites/identidad', router);
  app.use(errorHandler);
  return app;
}

function filaValidacion(fotoRostro: string | null) {
  return {
    id: 41, tramiteId: 5, nombre: 'Persona Prueba', tipoDoc: 'CC', documento: '123', estado: 'aprobado', score: 90,
    fotoRostro, fotoCedulaFrontal: null, fotoCedulaReverso: null,
    detalle: {}, validadoAt: null, ipAddress: null, ciudadGeo: null, lat: null, lng: null,
    intentos: 1, enviadoAt: null, placa: 'ABC123', vehiculoInfo: null,
  };
}

beforeEach(() => {
  m.logs.length = 0;
  m.selectMock.mockReset();
  m.getPhotoMock.mockReset();
  m.insertMock.mockReset();
  m.insertMock.mockImplementation(() => ({ values: () => Promise.resolve(undefined) }));
});

describe('clasificarFoto — las 7 clases, primer acierto gana', () => {
  it.each([
    ['vacio', null],
    ['vacio', ''],
    ['storage_key', 'validaciones/5/rostro_abc.jpg'],
    ['nuevo', `v1:${'a'.repeat(24)}:${'b'.repeat(32)}:QUJD`],
    ['viejo', `${'A'.repeat(32)}:${'b'.repeat(32)}:QUJD`],
    ['data_uri', 'data:image/png;base64,QUJD'],
    ['base64_plano', BASE64_LARGO],
    ['desconocido', 'v1: hola'],
    ['desconocido', 'QUJD'],
    ['desconocido', 'data:text/plain;base64,QUJD'],
    ['desconocido', `v1:${'A'.repeat(24)}:${'b'.repeat(32)}:QUJD`],
  ])('%s ← %j', (clase, valor) => {
    expect(clasificarFoto(valor)).toBe(clase);
  });
});

describe('resolverFotoBiometrica', () => {
  const CTX = { column: 'foto_rostro', id: 9 } as const;

  it('vacío → null, sin métrica ni aviso', async () => {
    const antes = await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro');
    expect(await resolverFotoBiometrica('', CTX)).toBeNull();
    expect(await resolverFotoBiometrica(null, CTX)).toBeNull();
    expect(await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro')).toBe(antes);
    expect(m.logs).toEqual([]);
  });

  it('storage_key → getPhoto', async () => {
    m.getPhotoMock.mockResolvedValueOnce(FOTO);
    expect(await resolverFotoBiometrica('validaciones/5/rostro.jpg', CTX)).toBe(FOTO);
    expect(m.getPhotoMock).toHaveBeenCalledWith('validaciones/5/rostro.jpg');
  });

  it('nuevo → descifra con el AAD de la celda', async () => {
    const valor = encryptPiiText(FOTO, { table: 'tramites_validaciones', column: 'foto_rostro', id: 9 });
    expect(await resolverFotoBiometrica(valor, CTX)).toBe(FOTO);
  });

  it('viejo → descifra', async () => {
    expect(await resolverFotoBiometrica(cifrarViejo(FOTO, env.PII_ENC_KEY), CTX)).toBe(FOTO);
  });

  it.each([
    ['data_uri', FOTO],
    ['base64_plano', BASE64_LARGO],
    ['desconocido', 'v1: hola'],
  ])('%s → tal cual, con aviso sin el valor y métrica de legado (no de fallo)', async (clase, valor) => {
    const legadoAntes = await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro');
    const fallosAntes = await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro');

    expect(await resolverFotoBiometrica(valor, CTX)).toBe(valor);

    expect(await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro')).toBe(legadoAntes + 1);
    expect(await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro')).toBe(fallosAntes);
    expect(m.logs).toHaveLength(1);
    expect(m.logs[0][0]).toMatchObject({ table: 'tramites_validaciones', column: 'foto_rostro', clase });
    expect(JSON.stringify(m.logs)).not.toContain(valor);
  });

  it.each([
    ['nuevo', () => cifrarNuevoConOtraLlave(FOTO, 9)],
    ['viejo', () => cifrarViejo(FOTO, OTRA_LLAVE)],
  ])('%s con otra llave → PiiDecryptError y métrica de fallo, no de legado', async (_clase, valor) => {
    const legadoAntes = await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro');
    const fallosAntes = await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro');

    await expect(resolverFotoBiometrica(valor(), CTX)).rejects.toBeInstanceOf(PiiDecryptError);

    expect(await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro')).toBe(fallosAntes + 1);
    expect(await valorMetrica(piiLegacyPlaintextTotal, 'foto_rostro')).toBe(legadoAntes);
  });
});

describe('métricas expuestas', () => {
  it('ambas series existen en 0 o más para las tres columnas desde el arranque', async () => {
    const texto = await registry.metrics();
    for (const column of ['foto_rostro', 'foto_cedula_frontal', 'foto_cedula_reverso']) {
      expect(texto).toContain(`pii_decrypt_failures_total{table="tramites_validaciones",column="${column}"}`);
      expect(texto).toContain(`pii_legacy_plaintext_total{table="tramites_validaciones",column="${column}"}`);
    }
  });
});

describe.each([
  ['nuevo', () => cifrarNuevoConOtraLlave(FOTO, 41)],
  ['viejo', () => cifrarViejo(FOTO, OTRA_LLAVE)],
])('rutas con un valor %s de otra llave', (_clase, valor) => {
  async function compruebaFallo(r: request.Response, cifrado: string, fallosAntes: number) {
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Error interno del servidor' });
    expect(JSON.stringify(r.body)).not.toContain(cifrado);
    expect(await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro')).toBe(fallosAntes + 1);

    expect(m.logs.some(([ctx]) => {
      const c = ctx as Record<string, unknown>;
      return c?.requestId === REQUEST_ID && c.table === 'tramites_validaciones' && c.column === 'foto_rostro' && c.id === 41;
    })).toBe(true);

    const volcado = JSON.stringify(m.logs);
    expect(volcado).not.toContain(cifrado);
    expect(volcado).not.toContain('U0VDUkVUT19CSU9NRVRSSUNP');
  }

  it('GET /documentos → 500 genérico, métrica y log con requestId, tabla y columna; sin el valor', async () => {
    const cifrado = valor();
    m.selectMock.mockReturnValueOnce(chain([filaValidacion(cifrado)]));
    const fallosAntes = await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro');
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`).set('x-request-id', REQUEST_ID);

    await compruebaFallo(r, cifrado, fallosAntes);
  });

  it('POST /certificado → 500 genérico, sin concatenar el mensaje de la excepción', async () => {
    const cifrado = valor();
    m.selectMock.mockReturnValue(chain([filaValidacion(cifrado)]));
    const fallosAntes = await valorMetrica(piiDecryptFailuresTotal, 'foto_rostro');
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).post('/api/tramites/identidad/certificado/5')
      .set('Authorization', `Bearer ${token}`).set('x-request-id', REQUEST_ID).send({});

    await compruebaFallo(r, cifrado, fallosAntes);
  });
});

describe('GET /documentos con formatos legibles', () => {
  it('un valor nuevo de la llave vigente responde 200 con la foto', async () => {
    const valor = encryptPiiText(FOTO, { table: 'tramites_validaciones', column: 'foto_rostro', id: 41 });
    m.selectMock.mockReturnValueOnce(chain([filaValidacion(valor)]));
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(r.body.documentos[0].fotoRostro).toBe(FOTO);
  });

  it('un valor copiado de otra fila no se sirve: el AAD lo ata a su celda', async () => {
    const deOtraFila = encryptPiiText(FOTO, { table: 'tramites_validaciones', column: 'foto_rostro', id: 999 });
    m.selectMock.mockReturnValueOnce(chain([filaValidacion(deOtraFila)]));
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('U0VDUkVUT19CSU9NRVRSSUNP');
  });
});

// Feature #14284 (HU #14285 AC2 y AC3) — sin fila en `pii_access_log` no salen los datos, y lo
// responde `errorHandler`, igual que el fallo de descifrado.
describe('fallo cerrado de pii_access_log', () => {
  const VALOR_DEL_INSERT = 'detalle-interno-del-insert';

  beforeEach(() => {
    m.insertMock.mockImplementation(() => ({ values: () => Promise.reject(new Error(VALOR_DEL_INSERT)) }));
  });

  it('GET /documentos → 500 genérico, sin fotos ni nombre', async () => {
    m.selectMock.mockReturnValueOnce(chain([filaValidacion(FOTO)]));
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).get('/api/tramites/identidad/documentos/5')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Error interno del servidor' });
    expect(r.text).not.toContain('Persona Prueba');
    expect(r.text).not.toContain('U0VDUkVUT19CSU9NRVRSSUNP');
    expect(JSON.stringify(m.logs)).toContain('fallo escribiendo pii_access_log');
  });

  it('POST /certificado → 500 genérico, sin PDF ni el mensaje concatenado', async () => {
    m.selectMock.mockReturnValue(chain([filaValidacion(null)]));
    const token = await testToken({ sub: 1, role: 'admin' });

    const r = await request(buildApp()).post('/api/tramites/identidad/certificado/5')
      .set('Authorization', `Bearer ${token}`).send({});

    expect(r.status).toBe(500);
    expect(r.headers['content-type']).not.toContain('application/pdf');
    expect(r.body).toEqual({ error: 'Error interno del servidor' });
    expect(r.text).not.toContain('Error generando certificado');
    expect(r.text).not.toContain(VALOR_DEL_INSERT);
  });
});
