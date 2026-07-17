// TRAM-INNOV-EXP-PDF — expediente certificado PDF.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock, updateMock, auditMock, storageMocks } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(),
  auditMock: vi.fn().mockResolvedValue(undefined),
  storageMocks: { getEntityDocumentStream: vi.fn() },
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => storageMocks);

import { Readable } from 'node:stream';
import {
  computeExpedienteIntegrityHash,
  buildExpedientePdf,
  loadOrganismoLogoBytes,
  resolveExpedienteHeader,
  maskVin,
} from '../../src/modules/tramites/expediente-pdf.js';

// PNG mínimo (firma + IHDR de 1×1) embebible por pdf-lib.
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f8d0000000049454e44ae426082',
  'hex',
);
const ORG_MED = { codigo: '05001', nombre: 'Secretaría de Movilidad de Medellín', ciudad: 'Medellín', alias: 'Tránsito Medellín' };

const META_BASE = {
  tramiteId: 42,
  estado: 'borrador',
  placa: 'ABC123',
  vinMasked: '***********7890',
  tipologia: 'traspaso_standard',
  eventos: [
    { tipo: 'creado', createdAt: '2026-06-01T10:00:00.000Z', docHash: null },
    { tipo: 'documento_subido', createdAt: '2026-06-01T11:00:00.000Z', docHash: 'a'.repeat(64) },
  ],
};

describe('expediente-pdf · puro', () => {
  it('maskVin enmascara todo menos ultimos 4', () => {
    expect(maskVin('MAZ123TEST456789')).toBe('************6789');
    expect(maskVin(null)).toBeNull();
  });

  it('computeExpedienteIntegrityHash es determinístico (64 hex)', () => {
    const h = computeExpedienteIntegrityHash(META_BASE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExpedienteIntegrityHash(META_BASE)).toBe(h);
  });

  it('buildExpedientePdf devuelve buffer PDF valido (>1KB)', async () => {
    const buf = await buildExpedientePdf({
      ...META_BASE,
      tipologiaNombre: 'Traspaso estandar',
      verifyUrl: 'https://operaciones.flitsas.com/tramite/verificar?t=abc123token',
      verifyExpires: '2026-06-15T10:00:00.000Z',
    });
    expect(buf.length).toBeGreaterThan(1024);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset(); auditMock.mockResolvedValue(undefined);
  storageMocks.getEntityDocumentStream.mockReset();
});

// TRAM-MT-02 Fase 3 — branding por organismo + carga de logo.
describe('expediente-pdf · Fase 3 branding', () => {
  const baseFull = {
    ...META_BASE,
    tipologiaNombre: 'Traspaso estandar',
    verifyUrl: 'https://operaciones.flitsas.com/tramite/verificar?t=abc123token',
    verifyExpires: '2026-06-15T10:00:00.000Z',
  };
  // El stream de contenido del PDF va FlateDecode-comprimido (no greppable);
  // la lógica de cabecera se verifica en su función pura `resolveExpedienteHeader`.
  it('header sin organismo → título FLIT (regresión)', () => {
    const h = resolveExpedienteHeader(null);
    expect(h.titulo).toContain('FLIT');
    expect(h.titulo).toContain('Expediente certificado');
    expect(h.subtitulo).toBeNull();
  });

  it('header con alias → alias + "Expediente preparado"', () => {
    const h = resolveExpedienteHeader(ORG_MED);
    expect(h.titulo).toBe('Tránsito Medellín');
    expect(h.subtitulo).toContain('Expediente preparado');
    expect(h.subtitulo).toContain('Medellín');
  });

  it('header con organismo sin alias → nombre catálogo + código', () => {
    const h = resolveExpedienteHeader({ ...ORG_MED, alias: null });
    expect(h.titulo).toBe(ORG_MED.nombre);
    expect(h.subtitulo).toContain('codigo 05001');
  });

  it('buildExpedientePdf con organismo → PDF válido', async () => {
    const buf = await buildExpedientePdf({ ...baseFull, organismo: ORG_MED });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1024);
  });

  it('logo corrupto → PDF se genera igual (sin 500)', async () => {
    const buf = await buildExpedientePdf({ ...baseFull, organismo: ORG_MED, logoPng: Buffer.from('no-soy-imagen') });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('logo PNG válido → PDF embebe sin error', async () => {
    const buf = await buildExpedientePdf({ ...baseFull, organismo: ORG_MED, logoPng: PNG_1x1 });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1024);
  });
});

describe('loadOrganismoLogoBytes', () => {
  it('storage key con PNG → devuelve bytes', async () => {
    storageMocks.getEntityDocumentStream.mockResolvedValue(Readable.from(PNG_1x1));
    const buf = await loadOrganismoLogoBytes({ storageKey: 'transito/organismos/05001/logo/x.png' });
    expect(buf).not.toBeNull();
    expect(buf!.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('storage key con bytes no-imagen → null', async () => {
    storageMocks.getEntityDocumentStream.mockResolvedValue(Readable.from(Buffer.from('texto')));
    const buf = await loadOrganismoLogoBytes({ storageKey: 'k' });
    expect(buf).toBeNull();
  });

  it('storage falla y sin url → null (silencioso)', async () => {
    storageMocks.getEntityDocumentStream.mockRejectedValue(new Error('minio down'));
    const buf = await loadOrganismoLogoBytes({ storageKey: 'k' });
    expect(buf).toBeNull();
  });

  it('url externa no-https → null (no fetch)', async () => {
    const buf = await loadOrganismoLogoBytes({ externalUrl: 'http://inseguro.example/logo.png' });
    expect(buf).toBeNull();
  });

  it('sin key ni url → null', async () => {
    expect(await loadOrganismoLogoBytes({})).toBeNull();
  });
});

async function buildTramitesApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('GET /api/tramites/:id/expediente.pdf', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/0/expediente.pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('sin eventos → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 5, estado: 'borrador', placa: 'X', vin: 'VIN1234567890123', tipologiaCodigo: 'traspaso_standard',
    }]));
    selectMock.mockReturnValueOnce(chain([])); // archivos
    selectMock.mockReturnValueOnce(chain([])); // timeline
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/5/expediente.pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/eventos/i);
  });

  it('con tramite + eventos → 200 application/pdf', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 9, estado: 'enviado_transito', placa: 'MI0042', vin: '9BWZZZ377VT004251', tipologiaCodigo: 'traspaso_standard',
    }]));
    selectMock.mockReturnValueOnce(chain([])); // archivos
    selectMock.mockReturnValueOnce(chain([
      { id: 1, tipo: 'creado', actorRole: 'admin', payload: {}, docHash: null, createdAt: new Date('2026-06-01') },
    ]));
    selectMock.mockReturnValueOnce(chain([{
      id: 9, verifyToken: 'validtoken123456789012345678', verifyTokenExpires: new Date(Date.now() + 86400000),
    }]));
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve([]) }); // emitEvento
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/9/expediente.pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.body.length).toBeGreaterThan(1024);
    expect(r.headers['content-disposition']).toMatch(/expediente-9-/);
  });

  it('con organismo asignado → 200 y audit con organismoCodigo', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 11, estado: 'enviado_transito', placa: 'MI0011', vin: '9BWZZZ377VT004251',
      tipologiaCodigo: 'traspaso_standard', organismoCodigo: '05001', vehiculo: null,
    }]));
    selectMock.mockReturnValueOnce(chain([])); // archivos
    selectMock.mockReturnValueOnce(chain([
      { id: 1, tipo: 'creado', actorRole: 'admin', payload: {}, docHash: null, createdAt: new Date('2026-06-01') },
    ])); // timeline
    selectMock.mockReturnValueOnce(chain([{
      id: 11, verifyToken: 'validtoken123456789012345678', verifyTokenExpires: new Date(Date.now() + 86400000),
    }])); // resolveVerifyUrl
    selectMock.mockReturnValueOnce(chain([{
      codigo: '05001', alias: 'Tránsito Medellín', logoUrl: null, logoStorageKey: null, activo: true, updatedAt: new Date(),
    }])); // getOrganismoConfig row
    selectMock.mockReturnValueOnce(chain([{ c: 1 }])); // getOrganismoConfig count
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve([]) }); // emitEvento
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).get('/api/tramites/11/expediente.pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ detail: expect.stringContaining('05001') }),
    );
  });
});
