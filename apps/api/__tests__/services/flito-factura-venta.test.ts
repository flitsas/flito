// FLITO — factura de venta desde FLIT (Fase 8 P1.2). La factura ya no se carga a mano ni se analiza con
// OCR: viene de FLIT. Se verifica ver/descargar (la API sirve el fichero) y el zip. drizzle + el
// adaptador FLIT mockeados.
//
// Lo que más se vigila aquí es el NOMBRE y el TIPO con el que sale el archivo: la API dejó de
// redirigir a S3 justo porque desde allí se descargaba como octet-stream y sin extensión.

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

// buscarConAcceso: 1) impuesto+autogestion, 2) trámite con la factura de FLIT y su id de FLIT.
function mockAcceso(facturaVentaFlitId: string | null, idFlit = 'FLIT-2001') {
  selectMock
    .mockReturnValueOnce(chain([{ imp: { id: 'i1', tramiteId: 't1', organismoCodigo: '05001', estado: 'pendiente' }, dentroDeFrontera: true }]))
    .mockReturnValueOnce(chain([{ facturaVentaFlitId, idFlit }]));
}

/** Respuesta de S3 tal como llega de verdad: sin tipo útil y con el cuerpo del PDF. */
function mockS3(cuerpo = '%PDF-1.4 fake') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'binary/octet-stream' }),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(cuerpo).buffer),
  }));
}

beforeEach(() => { selectMock.mockReset(); obtenerUrlFacturaMock.mockReset(); vi.unstubAllGlobals(); });

describe('GET /:id/factura-venta — la sirve la API, en PDF y con nombre', () => {
  it('con factura válida → 200 application/pdf, aunque S3 la rotule como octet-stream', async () => {
    mockAcceso('fac-123');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123?sig=abc');
    mockS3();
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  // Es el fallo que se venía a corregir: sin nombre con extensión, el navegador guarda el id de S3
  // a secas y el archivo no abre con doble clic.
  it('el nombre de descarga lleva el id del trámite y termina en .pdf', async () => {
    mockAcceso('fac-123', 'FLIT-9876');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123?sig=abc');
    mockS3();
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.headers['content-disposition']).toBe('inline; filename="factura-venta-FLIT-9876.pdf"');
  });

  // Si lo que hay guardado NO es un PDF, se dice la verdad en vez de rotularlo como tal: un `.pdf`
  // que ningún visor abre es peor que un nombre correcto.
  it('una imagen se sirve como imagen, no disfrazada de PDF', async () => {
    mockAcceso('fac-123');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'binary/octet-stream' }),
      arrayBuffer: () => Promise.resolve(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer),
    }));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition']).toContain('.jpg"');
  });

  it('FLIT responde mal la descarga → 502 (y no un fichero vacío con nombre de PDF)', async () => {
    mockAcceso('fac-123');
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers(), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
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
    mockS3();
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post('/api/flito/impuestos/facturas-venta/zip').set('Authorization', `Bearer ${token}`)
      .send({ ids: ['00000000-0000-0000-0000-000000000001'] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    vi.unstubAllGlobals();
  });
});
