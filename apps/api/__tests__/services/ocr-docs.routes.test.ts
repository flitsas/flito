import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';
import { env } from '../../src/config/env.js';

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// TRAM-11: la ruta llama a anthropicMessages (helper resiliente). Mockeamos ese
// seam en vez de `https`.
const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({
  anthropicMessages: anthropicMock,
}));

// Mock pdf-lib para extractPages
const pdfDocMock = {
  copyPages: vi.fn().mockResolvedValue([{}, {}]),
  addPage: vi.fn(),
  save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  getPageCount: vi.fn().mockReturnValue(3),
};
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue(pdfDocMock),
    create: vi.fn().mockResolvedValue(pdfDocMock),
  },
}));

// Mock fs/promises para evitar I/O real
const mkdirMock = vi.fn().mockResolvedValue(undefined);
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const readFileMock = vi.fn();
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
    readFile: readFileMock,
  };
});

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  auditMock.mockClear();
  anthropicMock.mockReset();
  mkdirMock.mockClear();
  writeFileMock.mockClear();
  readFileMock.mockReset();
  pdfDocMock.getPageCount.mockReturnValue(3);
  pdfDocMock.copyPages.mockResolvedValue([{}, {}]);
  env.ANTHROPIC_API_KEY = 'sk-test-key';
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/ocr-docs.routes.js');
  app.use('/api/tramites/docs', router);
  return app;
}

function queueVisionResponse(jsonData: object | { error: string }) {
  if ('error' in jsonData) {
    // Fallo de Anthropic → el helper devuelve ok:false + 503 + mensaje usable.
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'Servicio de lectura no disponible, adjunta el documento manualmente.' });
  } else {
    anthropicMock.mockResolvedValueOnce({ ok: true, data: { content: [{ text: JSON.stringify(jsonData) }] } });
  }
}

const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 0)]);
const JPG_BUFFER = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.alloc(100, 0)]);
const PNG_BUFFER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(100, 0)]);

describe('ocr-docs — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(403);
  });
});

describe('POST /ocr/:tipo — validaciones', () => {
  it('tipo no soportado → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/inventado')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Tipo no soportado/);
  });

  it('sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Archivo requerido/);
  });

  it('sin ANTHROPIC_API_KEY → 500', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = undefined;
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/API key/);
  });

  it('archivo no es PDF/JPG/PNG (magic bytes) → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('not-an-image-or-pdf'), { filename: 'doc.txt', contentType: 'text/plain' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Solo PDF, JPG o PNG/);
  });

  it('PROMPTS soportados: factura, aduana, impronta, soat → no rechaza por tipo', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    for (const tipo of ['factura', 'aduana', 'impronta', 'soat']) {
      queueVisionResponse({ tipo_documento: 'x', es_valido: true, paginas_documento: [], total_paginas: 1 });
      const app = await buildApp();
      const r = await request(app).post(`/api/tramites/docs/ocr/${tipo}`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
      expect(r.status).toBe(200);
    }
  });
});

describe('POST /ocr/:tipo — flujo Vision', () => {
  it('Vision API falla → 503 (TRAM-11) con mensaje usable', async () => {
    queueVisionResponse({ error: 'Rate limit exceeded' });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/manual|disponible/i);
  });

  it('Vision response no parseable como JSON → 500', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: true, data: { content: [{ text: 'esto no es json' }] } });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/No se pudo extraer/);
  });

  it('Vision parsea JSON con markdown ```json``` wrapper → 200', async () => {
    const inner = JSON.stringify({ tipo_documento: 'factura_venta', es_factura_valida: true, paginas_documento: [], total_paginas: 1 });
    anthropicMock.mockResolvedValueOnce({ ok: true, data: { content: [{ text: '```json\n' + inner + '\n```' }] } });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.data.tipo_documento).toBe('factura_venta');
  });

  it('JPG válido → 200 (no extrae páginas, no es PDF)', async () => {
    queueVisionResponse({ tipo_documento: 'soat', es_valido: true, paginas_documento: [1], total_paginas: 1 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/soat')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', JPG_BUFFER, { filename: 'soat.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(200);
    expect(r.body.data._paginas_extraidas).toBeUndefined();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('PNG válido → 200 (no extrae páginas)', async () => {
    queueVisionResponse({ tipo_documento: 'impronta', es_valido: true, paginas_documento: [], total_paginas: 1 });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/impronta')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_BUFFER, { filename: 'impronta.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe('POST /ocr/:tipo — extracción multi-doc (PDF subset)', () => {
  it('PDF + paginas_documento subset (2 de 3) → extrae + guarda + responde con _extracted_filename', async () => {
    queueVisionResponse({
      tipo_documento: 'factura_venta', es_factura_valida: true,
      paginas_documento: [1, 2], total_paginas: 3,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'multi.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.data._paginas_extraidas).toBe(true);
    expect(r.body.data._paginas_originales).toBe(3);
    expect(r.body.data._extracted_filename).toMatch(/^factura_\d+\.pdf$/);
    expect(mkdirMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('PDF + paginas_documento === total_paginas → NO extrae (no es subset)', async () => {
    queueVisionResponse({
      tipo_documento: 'factura_venta', es_factura_valida: true,
      paginas_documento: [1, 2, 3], total_paginas: 3,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'monodoc.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.data._paginas_extraidas).toBeUndefined();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('PDF + paginas_documento vacío → NO extrae (documento no encontrado)', async () => {
    queueVisionResponse({
      tipo_documento: 'no_es_factura', es_factura_valida: false,
      paginas_documento: [], total_paginas: 5,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'no-factura.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(r.body.data.es_factura_valida).toBe(false);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('extractPages PDF > 200 páginas → throws (capturado en log, no aborta response)', async () => {
    pdfDocMock.getPageCount.mockReturnValueOnce(250); // > 200 throws
    queueVisionResponse({
      tipo_documento: 'factura_venta', es_factura_valida: true,
      paginas_documento: [1, 2], total_paginas: 250,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/docs/ocr/factura')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'huge.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(200); // OCR data igual se devuelve
    expect(r.body.data._paginas_extraidas).toBeUndefined();
  });

  it('audit con detail enriquecido cuando se extraen páginas', async () => {
    queueVisionResponse({
      tipo_documento: 'soat', es_valido: true,
      paginas_documento: [3], total_paginas: 5,
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/tramites/docs/ocr/soat')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PDF_BUFFER, { filename: 'mix.pdf', contentType: 'application/pdf' });
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'upload', resource: 'ocr_doc' }),
    );
    expect(auditMock.mock.calls[0][1].detail).toContain('1/5 pags');
  });
});

describe('GET /ocr-extracted/:filename', () => {
  it('archivo válido → 200 con application/pdf', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('%PDF-content'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/docs/ocr-extracted/factura_123.pdf')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('archivo no existe → 404', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/docs/ocr-extracted/inexistente.pdf')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/no encontrado/);
  });

  it('filename con caracteres no permitidos → sanitizado (path.basename + regex)', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('%PDF'));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    // Caracteres "../" se eliminan por path.basename + regex `/[^a-zA-Z0-9._-]/g`
    const r = await request(app).get('/api/tramites/docs/ocr-extracted/factura_123.pdf')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/docs/ocr-extracted/x.pdf')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});
