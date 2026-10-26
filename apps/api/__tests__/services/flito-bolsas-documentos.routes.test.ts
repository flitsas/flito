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
// HU #13890: el worker del OCR se mockea aquí (tiene su propio test); solo importa CUÁNDO se lanza.
const lanzarOcrMock = vi.fn();
vi.mock('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.ocr.js', () => ({ lanzarOcr: lanzarOcrMock }));

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
    fechaManualPorNombre: null, retiradoEn: null, motivoRetiro: null, retiradorNombre: null, ...over,
  };
}

function postCarga(app: express.Express, auth: string, archivo: Buffer, filename: string, contentType: string, tipo = 'rut') {
  return request(app).post(`/api/flito/bolsas-documentos/companias/${COMPANIA}/tipos/${tipo}`)
    .set('Authorization', auth).attach('archivo', archivo, { filename, contentType });
}

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear(); piiMock.mockClear(); deleteMock.mockClear(); lanzarOcrMock.mockClear();
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

// ── HU #13890 — OCR después de responder, fecha manual (E4) y estado por compañía ──────────────────

const { hoyColombia } = await import('../../src/shared/utils/fecha-rango.js');
const HOY = hoyColombia();
function dias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('#13890 — el OCR se lanza después de responder, solo para Cámara/RUT/certificado', () => {
  it('RUT cargado → 201 en validando y se lanza el OCR con el buffer en claro', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto()]);
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'rut.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('validando');
    expect(lanzarOcrMock).toHaveBeenCalledTimes(1);
    expect(lanzarOcrMock.mock.calls[0]![0]).toBe(DOC_ID);
    expect((lanzarOcrMock.mock.calls[0]![1] as Buffer).equals(PDF_REAL)).toBe(true);
  });

  it('AC7 — la cédula cargada sale Válido y NUNCA se envía al OCR', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto({ tipo: 'cedula_representante', ocrEstado: 'no_aplica' })]);
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'cc.pdf', 'application/pdf', 'cedula_representante');
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('valido');
    expect(lanzarOcrMock).not.toHaveBeenCalled();
  });

  it('AC9 — el archivo se guarda aunque el OCR quede pendiente, y la respuesta NO es «Válido»', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto({ tipo: 'camara_comercio' })]);
    const app = await buildApp();
    const res = await postCarga(app, await token([CARGAR]), PDF_REAL, 'cc.pdf', 'application/pdf', 'camara_comercio');
    expect(res.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(res.body.estado).not.toBe('valido');
  });
});

const FECHA = `/api/flito/bolsas-documentos/documentos/${DOC_ID}/fecha-expedicion`;

/** Captura el `set` de cada UPDATE; el reclamo devuelve la fila (`returning`). */
function capturarUpdates(filas: unknown[] = [{ id: DOC_ID }]) {
  const sets: Array<Record<string, unknown>> = [];
  kdb.update.mockImplementation(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      const c: Record<string, unknown> = {};
      c.where = () => c; c.returning = () => c;
      c.then = (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej);
      return c;
    },
  }));
  return sets;
}

describe('AC5 — con cargar, la fecha digitada a mano aplica la regla de 30 días y deja quién y cuándo', () => {
  it('documento en «No se pudo validar» + fecha de hace 30 días → 200 Válido, origen manual, auditado', async () => {
    const fecha = dias(HOY, -30);
    const sets = capturarUpdates();
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'certificado_bancario', vigente: true }])
      .selectOnce(DOCS, [filaDto({
        tipo: 'certificado_bancario', ocrEstado: 'sin_fecha', fechaExpedicion: fecha, fechaOrigen: 'manual',
        fechaManualEn: new Date('2026-10-23T16:00:00Z'), fechaManualPorNombre: 'Ana Operaciones',
      })]);
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([CARGAR], 9)).send({ fecha });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      estado: 'valido', fechaExpedicion: fecha, fechaOrigen: 'manual', venceEl: HOY,
      fechaManual: { por: 'Ana Operaciones', en: '2026-10-23T16:00:00.000Z' },
    });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ fechaExpedicion: fecha, fechaOrigen: 'manual', fechaManualPor: 9 });
    expect(sets[0]!.fechaManualEn).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ action: 'update', resource: 'flito_bolsa_documento', resourceId: DOC_ID });
    expect(JSON.stringify(auditMock.mock.calls[0]![1])).not.toContain(fecha);
  });

  it('la regla se aplica igual: una fecha manual de hace 31 días sale vencida', async () => {
    const fecha = dias(HOY, -31);
    capturarUpdates();
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', vigente: true }])
      .selectOnce(DOCS, [filaDto({ ocrEstado: 'fallido', fechaExpedicion: fecha, fechaOrigen: 'manual', fechaManualEn: new Date() })]);
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([CARGAR])).send({ fecha });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('vencido');
  });

  it.each([
    ['futura', dias(HOY, 1)],
    ['inexistente en el calendario', '2026-02-31'],
    ['con otro formato', '23/10/2026'],
  ])('fecha %s → 400 sin escribir', async (_n, fecha) => {
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([CARGAR])).send({ fecha });
    expect(res.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('cédula o adicional → 422 (no llevan vigencia)', async () => {
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'cedula_representante', vigente: true }]);
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([CARGAR])).send({ fecha: HOY });
    expect(res.status).toBe(422);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('versión reemplazada → 409; documento inexistente → 404', async () => {
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', vigente: false }]).selectOnce(DOCS, []);
    const app = await buildApp();
    const auth = await token([CARGAR]);
    expect((await request(app).put(FECHA).set('Authorization', auth).send({ fecha: HOY })).status).toBe(409);
    expect((await request(app).put(FECHA).set('Authorization', auth).send({ fecha: HOY })).status).toBe(404);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('bolsa inactiva → 409 sin escribir', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', vigente: true }]);
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([CARGAR])).send({ fecha: HOY });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/inactiva/);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('AC6 — sin bolsas.documentos.cargar no se digita la fecha', () => {
  it('solo con ver → 403 y no se toca la base', async () => {
    const app = await buildApp();
    const res = await request(app).put(FECHA).set('Authorization', await token([VER])).send({ fecha: HOY });
    expect(res.status).toBe(403);
    expect(res.body.funcion).toBe(CARGAR);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('AC8 — estado por compañía con bolsas.documentos.ver', () => {
  it('trae los 5 documentos con estado, fecha de expedición y origen, sin datos de la cédula', async () => {
    kdb.when.select(DOCS, [
      filaDto({ id: DOC_ID, tipo: 'camara_comercio', fechaExpedicion: dias(HOY, -3), fechaOrigen: 'ocr', ocrEstado: 'leido' }),
      filaDto({ id: NONCE, tipo: 'rut', fechaExpedicion: dias(HOY, -40), fechaOrigen: 'manual', ocrEstado: 'sin_fecha', fechaManualEn: new Date() }),
      filaDto({ id: '33333333-3333-4333-8333-333333333333', tipo: 'cedula_representante', ocrEstado: 'no_aplica' }),
    ]);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', await token([VER]));
    expect(res.status).toBe(200);
    const docs = res.body.documentos as Array<{ tipo: string; estado: string; vigente: Record<string, unknown> | null }>;
    expect(docs.map((d) => d.tipo)).toEqual(['camara_comercio', 'rut', 'cedula_representante', 'certificado_bancario', 'adicional']);
    const por = (t: string) => docs.find((d) => d.tipo === t)!;
    expect(por('camara_comercio')).toMatchObject({ estado: 'valido', vigente: { fechaExpedicion: dias(HOY, -3), fechaOrigen: 'ocr' } });
    expect(por('rut')).toMatchObject({ estado: 'vencido', vigente: { fechaOrigen: 'manual' } });
    expect(por('certificado_bancario')).toMatchObject({ estado: 'pendiente', vigente: null });
    expect(res.body.completo).toBe(false);
    // Cédula: solo metadatos (estado, versión, quién cargó); nada del archivo ni del almacenamiento.
    const cc = por('cedula_representante');
    expect(cc.estado).toBe('valido');
    expect(cc.vigente).not.toHaveProperty('storageKey');
    expect(cc.vigente).not.toHaveProperty('contenido');
    expect(cc.vigente!.fechaExpedicion).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('sin ver → 403', async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}`).set('Authorization', await token([CARGAR]));
    expect(res.status).toBe(403);
  });
});

// HU #13893 (ADR-0028 §5 E6) — estado agregado del expediente por lote, para el chip del listado.
describe('#13893 — E6 POST /estado-lote', () => {
  const OTRA = 8;
  const SIN_DOCS = 9;
  const vig = (companiaId: number, tipo: string, over: Record<string, unknown> = {}) => ({
    companiaId, tipo, fechaExpedicion: null, ocrEstado: 'no_aplica', ...over,
  });
  const principalesValidos = (companiaId: number) => [
    vig(companiaId, 'camara_comercio', { fechaExpedicion: dias(HOY, -2), ocrEstado: 'leido' }),
    vig(companiaId, 'rut', { fechaExpedicion: dias(HOY, -30), ocrEstado: 'leido' }),
    vig(companiaId, 'cedula_representante'),
    vig(companiaId, 'certificado_bancario', { fechaExpedicion: dias(HOY, 0), ocrEstado: 'leido' }),
  ];
  const postLote = async (body: unknown, funciones = [VER]) => {
    const app = await buildApp();
    return request(app).post('/api/flito/bolsas-documentos/estado-lote')
      .set('Authorization', await token(funciones)).send(body as object);
  };

  it('AC5 — N compañías en el body → estado agregado por compañía, en el orden pedido, con UNA sola consulta', async () => {
    kdb.when.select(DOCS, [...principalesValidos(COMPANIA), vig(OTRA, 'rut', { fechaExpedicion: dias(HOY, -2), ocrEstado: 'leido' })]);
    kdb.select.mockClear();
    const res = await postLote({ companiaIds: [OTRA, COMPANIA, SIN_DOCS] });
    expect(res.status).toBe(200);
    expect(kdb.select).toHaveBeenCalledTimes(1);
    expect(res.body.estados.map((e: { companiaId: number }) => e.companiaId)).toEqual([OTRA, COMPANIA, SIN_DOCS]);
    expect(res.body.estados[1]).toEqual({
      companiaId: COMPANIA, completo: true,
      estados: { camara_comercio: 'valido', rut: 'valido', cedula_representante: 'valido', certificado_bancario: 'valido' },
    });
    expect(res.body.estados[0]).toMatchObject({ companiaId: OTRA, completo: false, estados: { rut: 'valido', camara_comercio: 'pendiente' } });
  });

  it('AC1/AC3 — los 4 principales válidos → completo aunque falte el adicional (el adicional no cuenta)', async () => {
    kdb.when.select(DOCS, principalesValidos(COMPANIA));
    const res = await postLote({ companiaIds: [COMPANIA] });
    expect(res.status).toBe(200);
    expect(res.body.estados[0].completo).toBe(true);
    expect(res.body.estados[0].estados).not.toHaveProperty('adicional');
  });

  it.each([
    ['falta uno', (f: ReturnType<typeof vig>[]) => f.filter((x) => x.tipo !== 'cedula_representante'), 'cedula_representante', 'pendiente'],
    ['vencido', (f: ReturnType<typeof vig>[]) => f.map((x) => x.tipo === 'rut' ? { ...x, fechaExpedicion: dias(HOY, -31) } : x), 'rut', 'vencido'],
    ['no se pudo validar', (f: ReturnType<typeof vig>[]) => f.map((x) => x.tipo === 'camara_comercio' ? { ...x, fechaExpedicion: null, ocrEstado: 'sin_fecha' } : x), 'camara_comercio', 'no_validado'],
    ['validando', (f: ReturnType<typeof vig>[]) => f.map((x) => x.tipo === 'certificado_bancario' ? { ...x, fechaExpedicion: null, ocrEstado: 'validando' } : x), 'certificado_bancario', 'validando'],
  ])('AC2 — %s → completo:false', async (_caso, mutar, tipo, estado) => {
    kdb.when.select(DOCS, mutar(principalesValidos(COMPANIA)));
    const res = await postLote({ companiaIds: [COMPANIA] });
    expect(res.status).toBe(200);
    expect(res.body.estados[0].completo).toBe(false);
    expect(res.body.estados[0].estados[tipo]).toBe(estado);
  });

  it('compañía sin documentos (o inexistente) → completo:false y los 4 en pendiente, sin 404', async () => {
    kdb.when.select(DOCS, []);
    const res = await postLote({ companiaIds: [SIN_DOCS] });
    expect(res.status).toBe(200);
    expect(res.body.estados).toEqual([{
      companiaId: SIN_DOCS, completo: false,
      estados: { camara_comercio: 'pendiente', rut: 'pendiente', cedula_representante: 'pendiente', certificado_bancario: 'pendiente' },
    }]);
  });

  it('AC7 — sin bolsas.documentos.ver → 403 sin consultar', async () => {
    kdb.select.mockClear();
    const res = await postLote({ companiaIds: [COMPANIA] }, [CARGAR]);
    expect(res.status).toBe(403);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it.each([
    ['más de 200', { companiaIds: Array.from({ length: 201 }, (_, i) => i + 1) }],
    ['vacío', { companiaIds: [] }],
    ['repetidos', { companiaIds: [COMPANIA, COMPANIA] }],
    ['no enteros o no positivos', { companiaIds: [0, 1.5] }],
    ['como texto', { companiaIds: ['7'] }],
    ['campo extra', { companiaIds: [COMPANIA], nit: '900123456' }],
  ])('body inválido (%s) → 400 sin consultar', async (_caso, body) => {
    kdb.select.mockClear();
    const res = await postLote(body);
    expect(res.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('justo 200 compañías → 200', async () => {
    kdb.when.select(DOCS, []);
    const res = await postLote({ companiaIds: Array.from({ length: 200 }, (_, i) => i + 1) });
    expect(res.status).toBe(200);
    expect(res.body.estados).toHaveLength(200);
  });

  it('un usuario con enlace de compañía recibe 403 aunque tenga la función', async () => {
    const app = await buildApp();
    const auth = `Bearer ${await testToken({ sub: 31, role: 'cliente', funciones: [VER] })}`;
    const res = await request(app).post('/api/flito/bolsas-documentos/estado-lote').set('Authorization', auth).send({ companiaIds: [COMPANIA] });
    expect(res.status).toBe(403);
  });
});

// ── HU #13964 — E7 POST /documentos/:documentoId/retirar ───────────────────────────────────────────

const RETIRAR = `/api/flito/bolsas-documentos/documentos/${DOC_ID}/retirar`;
const vigenteRut = (over: Record<string, unknown> = {}) =>
  ({ companiaId: COMPANIA, tipo: 'rut', version: 2, vigente: true, ...over });

describe('HU #13964 AC1/AC2 — retirar con bolsas.documentos.cargar', () => {
  it('200 con la fila del tipo ya pendiente; no toca el almacenamiento; audita tipo, versión y compañía sin motivo', async () => {
    const MOTIVO = 'La cédula de Juan Pérez estaba vencida';
    const sets = capturarUpdates();
    kdb.when.selectOnce(DOCS, [vigenteRut()]);
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR], 9)).send({ motivo: `  ${MOTIVO}  ` });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tipo: 'rut', estado: 'pendiente', opcional: false, vigente: null, tieneHistorial: true });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ vigente: false, retiradoPor: 9, motivoRetiro: MOTIVO }); // trim
    expect(uploadMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
    expect(piiMock).not.toHaveBeenCalled();

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(entrada).toEqual({
      action: 'update', resource: 'flito_bolsa_documento', resourceId: DOC_ID,
      detail: `Retiro del documento rut v2 de la compañía ${COMPANIA}`,
    });
    expect(JSON.stringify(entrada)).not.toContain('Juan');
    expect(JSON.stringify(entrada)).not.toMatch(/\.(pdf|png|jpg)/);
  });

  it('el historial (E2) devuelve retiro: { en, por: { nombre }, motivo } en la retirada', async () => {
    const en = new Date('2026-10-25T14:00:00Z');
    kdb.when.select(DOCS, [
      filaDto({ vigente: false, reemplazadoEn: en, retiradoEn: en, motivoRetiro: 'Equivocado', retiradorNombre: 'Ana Operaciones' }),
    ]);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/companias/${COMPANIA}/tipos/rut/historial`)
      .set('Authorization', await token([VER]));
    expect(res.status).toBe(200);
    expect(res.body.versiones[0].retiro).toEqual({ en: '2026-10-25T14:00:00.000Z', por: { nombre: 'Ana Operaciones' }, motivo: 'Equivocado' });
  });
});

describe('HU #13964 AC8 — motivo', () => {
  it.each([
    ['más de 300 caracteres', { motivo: 'x'.repeat(301) }],
    ['una clave extra', { motivo: 'ok', borrarArchivo: true }],
    ['un motivo que no es texto', { motivo: 42 }],
  ])('%s → 400 motivo_invalido sin escribir', async (_n, body) => {
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR])).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'El motivo admite hasta 300 caracteres.', codigo: 'motivo_invalido' });
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('exactamente 300 caracteres se acepta', async () => {
    const sets = capturarUpdates();
    kdb.when.selectOnce(DOCS, [vigenteRut()]);
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR])).send({ motivo: 'x'.repeat(300) });
    expect(res.status).toBe(200);
    expect((sets[0]!.motivoRetiro as string).length).toBe(300);
  });

  it.each([
    ['sin body', undefined],
    ['body vacío', {}],
    ['motivo en blanco (trim → NULL)', { motivo: '   ' }],
  ])('%s → se retira igual con motivo NULL', async (_n, body) => {
    const sets = capturarUpdates();
    kdb.when.selectOnce(DOCS, [vigenteRut()]);
    const app = await buildApp();
    const r = request(app).post(RETIRAR).set('Authorization', await token([CARGAR]));
    const res = body === undefined ? await r : await r.send(body);
    expect(res.status).toBe(200);
    expect(sets[0]!.motivoRetiro).toBeNull();
  });
});

describe('HU #13964 AC5/AC7 — rechazos de negocio con codigo', () => {
  it('AC5: bolsa inactiva → 409 bolsa_inactiva sin escribir', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    kdb.when.selectOnce(DOCS, [vigenteRut()]);
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR])).send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'La bolsa de la compañía está inactiva: reactívala para retirar documentos.', codigo: 'bolsa_inactiva',
    });
    expect(kdb.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC7: versión ya no vigente → 409 no_vigente sin escribir', async () => {
    kdb.when.selectOnce(DOCS, [vigenteRut({ vigente: false })]);
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR])).send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Esta versión ya no es la vigente: actualiza para ver el expediente.', codigo: 'no_vigente' });
    expect(kdb.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC7: carrera — si el UPDATE de retiro afecta 0 filas → 409 no_vigente, sin auditar (la condición vigente = true del WHERE la comprueba el test de servicio)', async () => {
    capturarUpdates([]);
    kdb.when.selectOnce(DOCS, [vigenteRut()]);
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([CARGAR])).send({});
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('no_vigente');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('documento inexistente → 404 sin codigo; id no uuid → 400', async () => {
    kdb.when.selectOnce(DOCS, []);
    const app = await buildApp();
    const auth = await token([CARGAR]);
    const r404 = await request(app).post(RETIRAR).set('Authorization', auth).send({});
    expect(r404.status).toBe(404);
    expect(r404.body).toEqual({ error: 'El documento no existe.' });
    const r400 = await request(app).post('/api/flito/bolsas-documentos/documentos/no-es-uuid/retirar').set('Authorization', auth).send({});
    expect(r400.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('HU #13964 AC6 — sin bolsas.documentos.cargar no se retira', () => {
  it('solo con ver → 403 y no se toca la base', async () => {
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', await token([VER])).send({});
    expect(res.status).toBe(403);
    expect(res.body.funcion).toBe(CARGAR);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('un usuario con enlace de compañía → 403 aunque tenga la función', async () => {
    const auth = `Bearer ${await testToken({ sub: 31, role: 'cliente', funciones: [CARGAR] })}`;
    const app = await buildApp();
    const res = await request(app).post(RETIRAR).set('Authorization', auth).send({});
    expect(res.status).toBe(403);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('HU #13964 AC9 — la versión retirada se sigue descargando', () => {
  it('la descarga de una cédula retirada responde el archivo y registra logPiiAccess como hoy', async () => {
    const contenido = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 0x20)]);
    prepararDescarga('cedula_representante', contenido);
    const app = await buildApp();
    const res = await request(app).get(`/api/flito/bolsas-documentos/documentos/${DOC_ID}/archivo`)
      .set('Authorization', await token([VER], 77));
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, contenido)).toBe(0);
    expect(piiMock).toHaveBeenCalledTimes(1);
  });
});
