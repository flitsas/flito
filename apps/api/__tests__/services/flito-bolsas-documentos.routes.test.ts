// HU #13889 (ADR-0028 §5) — fronteras HTTP de /api/flito/bolsas-documentos: MIME real y tamaño (AC3),
// permisos de carga y de descarga (AC5, AC6), la auditoría PII de la cédula (AC7) y los rechazos por
// bolsa (AC8). Drizzle, almacenamiento, auditoría y el puerto S0 están mockeados; el olfateo de MIME
// (`file-type`) y el cifrado son los reales: los adjuntos llevan bytes que de verdad son PDF o PNG.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const KEY = 'flito-bolsas-documentos/7/1700000000000_x.bin';
const uploadMock = vi.fn();
const deleteMock = vi.fn().mockResolvedValue(true);
const streamMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  deleteEntityDocument: deleteMock,
  getEntityDocumentStream: streamMock,
}));
const estadoBolsaMock = vi.fn();
vi.mock('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.bolsa-compania.js', () => ({
  estadoBolsaDeCompania: estadoBolsaMock,
}));

const { encryptPiiBuffer } = await import('../../src/shared/utils/crypto.js');
const { conAlcance } = await import('../../src/shared/middleware/frontera-enlace.js');

const COMPANIA = 7;
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = '22222222-2222-4222-8222-222222222222';
const DOCS = 'flito_bolsas_documentos';
const VER = 'bolsas.documentos.ver';
const CARGAR = 'bolsas.documentos.cargar';

const PDF_REAL = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
/** PNG 1x1 completo (firma + IHDR + IDAT + IEND): `file-type` necesita la IHDR. */
const PNG_REAL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** Cabecera MZ/PE de un ejecutable de Windows. */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(58, 0), Buffer.from([0x40, 0, 0, 0]), Buffer.from('PE\0\0'), Buffer.alloc(256, 0)]);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.routes.js');
  app.use('/api/flito/bolsas-documentos', conAlcance('bolsas', router));
  return app;
}

const token = async (funciones: string[], sub = 9) =>
  `Bearer ${await testToken({ sub, username: 'ana@flit.io', role: 'financiera', funciones })}`;

function filaDto(over: Record<string, unknown> = {}) {
  return {
    id: DOC_ID, tipo: 'rut', version: 1, vigente: true, mime: 'application/pdf', tamanoBytes: PDF_REAL.length,
    storageKey: KEY, fechaExpedicion: null, fechaOrigen: null, fechaManualEn: null, ocrEstado: 'validando',
    cargadoEn: new Date('2026-10-23T15:00:00Z'), reemplazadoEn: null, cargadoPorNombre: 'Ana Operaciones',
    fechaManualPorNombre: null, ...over,
  };
}

function postCarga(app: express.Express, auth: string, archivo: Buffer, filename: string, contentType: string, tipo = 'rut') {
  return request(app).post(`/api/flito/bolsas-documentos/companias/${COMPANIA}/tipos/${tipo}`)
    .set('Authorization', auth).attach('archivo', archivo, { filename, contentType });
}

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear(); piiMock.mockClear(); deleteMock.mockClear();
  uploadMock.mockReset().mockResolvedValue(KEY);
  streamMock.mockReset();
  estadoBolsaMock.mockReset().mockResolvedValue({ existe: true, activa: true });
  kdb.when.select('clients', [{ id: COMPANIA }]);
});

describe('AC1 — carga por HTTP', () => {
  it('201 con la versión vigente, su autor y su fecha; audita sin nombre de archivo', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto()]);
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'RUT Juan Perez.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: DOC_ID, tipo: 'rut', version: 1, cargadoPor: 'Ana Operaciones', cargadoEn: '2026-10-23T15:00:00.000Z' });
    expect(JSON.stringify(res.body)).not.toContain('Juan');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auditMock.mock.calls[0]![1])).not.toContain('Juan');
  });
});

describe('AC3 — archivo inválido → 400 con mensaje claro, sin guardar nada', () => {
  it('un .pdf que en realidad es un ejecutable', async () => {
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), EXE, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF, JPG o PNG/);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('un PNG de 16 MB', async () => {
    const app = await buildApp();
    const grande = Buffer.concat([PNG_REAL, Buffer.alloc(16 * 1024 * 1024, 0)]);
    const res = await postCarga(app, await token([CARGAR]), grande, 'rut.png', 'image/png');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El archivo supera el máximo de 15 MB.');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('un tipo declarado fuera de la lista (text/html)', async () => {
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), Buffer.from('<html></html>'), 'rut.html', 'text/html');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El archivo debe ser un PDF, JPG o PNG.');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('un PNG real declarado como PDF', async () => {
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PNG_REAL, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('un tipo de documento que no existe', async () => {
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'x.pdf', 'application/pdf', 'pasaporte');
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — cargar exige bolsas.documentos.cargar', () => {
  it('sin la función → 403 y no se toca el almacenamiento', async () => {
    const app = await buildApp();
    const res = await postCarga(app, await token([VER]), PDF_REAL, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(403);
    expect(res.body.funcion).toBe(CARGAR);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

/** Fila de `filaDeArchivo` con el blob cifrado de verdad para `contenido`. */
function prepararDescarga(tipo: string, contenido: Buffer) {
  const b = encryptPiiBuffer(contenido, { table: DOCS, column: 'archivo', empresaNit: DOC_ID, aadNonce: NONCE });
  kdb.when.select(DOCS, [{
    companiaId: COMPANIA, tipo, version: 3, mime: 'application/pdf', storageKey: KEY,
    iv: b.iv, tag: b.authTag, keyVersion: b.keyVersion, aadNonce: NONCE,
  }]);
  streamMock.mockResolvedValue(Readable.from([b.cipher]));
}

describe('AC6 — descarga', () => {
  it('con bolsas.documentos.ver → el archivo descifrado, como adjunto y sin caché', async () => {
    prepararDescarga('rut', PDF_REAL);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/documentos/${DOC_ID}/archivo`)
      .set('Authorization', await token([VER])).buffer(true).parse((r, cb) => {
        const partes: Buffer[] = []; r.on('data', (c: Buffer) => partes.push(c)); r.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(PDF_REAL)).toBe(true);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="rut-v3.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('sin bolsas.documentos.ver → 403 sin leer el archivo', async () => {
    prepararDescarga('rut', PDF_REAL);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/documentos/${DOC_ID}/archivo`)
      .set('Authorization', await token([]));
    expect(res.status).toBe(403);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('sin bolsas.documentos.ver tampoco se lee el expediente → 403', async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', await token([]));
    expect(res.status).toBe(403);
  });

  it('con bolsas.documentos.ver el expediente responde 200 con los 5 tipos', async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', await token([VER]));
    expect(res.status).toBe(200);
    expect(res.body.documentos).toHaveLength(5);
  });

  it('documento purgado o inexistente → 404', async () => {
    kdb.when.select(DOCS, []);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/documentos/${DOC_ID}/archivo`).set('Authorization', await token([VER]));
    expect(res.status).toBe(404);
  });
});

describe('AC7 — descarga de la cédula', () => {
  it('registra logPiiAccess (usuario, compañía, fecha) y ningún registro lleva el número ni el contenido', async () => {
    const CEDULA = '1020304050';
    const contenido = Buffer.concat([Buffer.from(`%PDF-1.4\n% CC ${CEDULA}\n`), Buffer.alloc(32, 0x20)]);
    prepararDescarga('cedula_representante', contenido);
    const logSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/documentos/${DOC_ID}/archivo`)
      .set('Authorization', await token([VER], 77));
    expect(res.status).toBe(200);
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [req, opts] = piiMock.mock.calls[0]!;
    // Usuario: `logPiiAccess` lo toma de `req.user` (la fecha la pone la base al insertar).
    expect((req as { user?: { sub: number } }).user?.sub).toBe(77);
    expect(opts).toEqual({
      resourceTipo: 'flito_bolsa_documento', resourceId: COMPANIA, accion: 'read',
      camposAccedidos: ['cedula_representante.archivo'], motivo: `descarga documento ${DOC_ID}`,
    });
    const registrado = JSON.stringify([opts, auditMock.mock.calls, ...logSpies.map((s) => s.mock.calls)]);
    expect(registrado).not.toContain(CEDULA);
    expect(registrado).not.toContain('%PDF');
    logSpies.forEach((s) => s.mockRestore());
  });
});

describe('AC8 — rechazos por bolsa', () => {
  it('compañía sin bolsa de compañía (o solo con bolsa de tránsito) → 404 con mensaje', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: false, activa: false });
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no tiene bolsa de compañía/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('bolsa inactiva → 409', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/inactiva/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('la lectura del expediente NO exige bolsa activa', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', await token([VER]));
    expect(res.status).toBe(200);
    expect(estadoBolsaMock).not.toHaveBeenCalled();
  });
});

describe('frontera — solo personal FLIT', () => {
  it('un usuario con enlace de compañía recibe 403 aunque tenga la función', async () => {
    const auth = `Bearer ${await testToken({ sub: 31, role: 'cliente', funciones: [VER] })}`;
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', auth);
    expect(res.status).toBe(403);
  });
});
