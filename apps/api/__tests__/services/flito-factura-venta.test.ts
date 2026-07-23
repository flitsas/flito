// FLITO — factura de venta desde FLIT (Fase 8 P1.2). La factura ya no se carga a mano ni se analiza con
// OCR: viene de FLIT. Se verifica ver/descargar (redirect a la URL prefirmada) y el zip. drizzle + el
// adaptador FLIT mockeados.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const obtenerUrlFacturaMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({ getFlitAdapter: () => ({ obtenerUrlFactura: obtenerUrlFacturaMock, obtenerTramites: vi.fn(), marcarEntregado: vi.fn() }) }));

const { default: impuestosRoutes } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');

const app = express();
app.use(express.json());
app.use('/api/flito/impuestos', impuestosRoutes);

// buscarConAcceso: 1) impuesto+autogestion, 2) trámite con la factura de FLIT.
function mockAcceso(facturaVentaFlitId: string | null) {
  selectMock
    .mockReturnValueOnce(chain([{ imp: { id: 'i1', tramiteId: 't1', organismoCodigo: '05001', estado: 'pendiente' }, autogestion: false }]))
    .mockReturnValueOnce(chain([{ facturaVentaFlitId }]));
}

beforeEach(() => { selectMock.mockReset(); obtenerUrlFacturaMock.mockReset(); });

describe('GET /:id/factura-venta — ver/descargar (redirect a S3 prefirmado)', () => {
  it('con factura válida → 302 a la URL prefirmada', async () => {
    mockAcceso('fac-123');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123.pdf?sig=abc');
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://flit-bucket.s3/fac-123.pdf?sig=abc');
  });

  it('trámite sin factura de venta en FLIT → 404', async () => {
    mockAcceso(null);
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(obtenerUrlFacturaMock).not.toHaveBeenCalled();
  });

  it('factura no disponible en FLIT (presigned null) → 404', async () => {
    mockAcceso('fac-123');
    obtenerUrlFacturaMock.mockResolvedValue(null);
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('auditor NO puede (solo operaciones/gestor)', async () => {
    const auditor = await testToken({ role: 'auditor' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${auditor}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /facturas-venta/zip — descarga varias en un zip', () => {
  it('body inválido (ids vacío) → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post('/api/flito/impuestos/facturas-venta/zip').set('Authorization', `Bearer ${token}`).send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it('operaciones: responde un zip (application/zip)', async () => {
    mockAcceso('fac-1');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1.pdf');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new TextEncoder().encode('%PDF fake').buffer) }));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post('/api/flito/impuestos/facturas-venta/zip').set('Authorization', `Bearer ${token}`)
      .send({ ids: ['00000000-0000-0000-0000-000000000001'] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    vi.unstubAllGlobals();
  });
});
