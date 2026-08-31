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

// buscarConAcceso: 1) impuesto+autogestion, 2) trámite con la factura de FLIT.
//
// La segunda fila trae PLACA y ORGANISMO desde la HU #11910: el nombre de descarga dejó de ser
// `factura-venta-<idFlit>.pdf` y pasó a ser `PLACA-ORGANISMO.<ext>` (AC5), el mismo con el que la
// factura aparece dentro del ZIP. `idFlit` se sigue leyendo y ya no decide el nombre.
function mockAcceso(
  facturaVentaFlitId: string | null,
  idFlit = 'FLIT-2001',
  vehiculo: { placa?: string | null; organismoAlias?: string | null; organismoCodigo?: string | null } = {},
) {
  selectMock
    .mockReturnValueOnce(chain([{ imp: { id: 'i1', tramiteId: 't1', organismoCodigo: '05001', estado: 'pendiente' }, dentroDeFrontera: true }]))
    .mockReturnValueOnce(chain([{
      facturaVentaFlitId, idFlit,
      placa: vehiculo.placa === undefined ? 'ASD123' : vehiculo.placa,
      organismoAlias: vehiculo.organismoAlias === undefined ? 'Medellín' : vehiculo.organismoAlias,
      organismoCodigo: vehiculo.organismoCodigo === undefined ? '05001' : vehiculo.organismoCodigo,
    }]));
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

  // El fallo original que se vino a corregir sigue cubierto —sin extensión el navegador guarda el id
  // de S3 a secas y el archivo no abre con doble clic—, pero el nombre ES OTRO desde la HU #11910:
  // `PLACA-ORGANISMO.<ext>` (AC5), el mismo con el que la factura aparece dentro del ZIP. Con dos
  // convenciones, quien baja un ZIP y luego una factura suelta no puede emparejarlas en su carpeta.
  it('el nombre de descarga es `PLACA-ORGANISMO.pdf`, en mayúsculas y sin tildes', async () => {
    mockAcceso('fac-123', 'FLIT-9876', { placa: 'asd123', organismoAlias: 'Medellín' });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-123?sig=abc');
    mockS3();
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/impuestos/i1/factura-venta').set('Authorization', `Bearer ${token}`);
    expect(res.headers['content-disposition']).toBe('inline; filename="ASD123-MEDELLIN.pdf"');
    // Y el id de FLIT ya no viaja en la cabecera: era el único texto libre del origen que llegaba a
    // una cabecera HTTP.
    expect(res.headers['content-disposition']).not.toContain('FLIT-9876');
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

/**
 * `POST /facturas-venta/zip` — RETIRADA en la HU #11910.
 *
 * Lo que hacía lo hace ahora `POST /soportes/zip` (`flito-soportes-zip.test.ts`), y la vieja no se
 * conserva «por si acaso»: exportaba facturas con datos personales SIN cuota, SIN rastro en
 * `pii_access_log` y con un `catch {}` mudo que hacía desaparecer documentos sin dejar constancia.
 * Además escribía las cabeceras y hacía `pipe` antes del bucle, así que una selección sin soportes
 * producía un ZIP válido y vacío de 22 bytes.
 *
 * El aserto se queda AQUÍ y no solo en la suite nueva: este archivo es el que cubría el endpoint, y
 * un test de retirada que viva únicamente en el archivo del sustituto no se lee cuando alguien viene
 * a preguntarse qué pasó con el original.
 */
describe('POST /facturas-venta/zip — retirada (HU #11910)', () => {
  it('la ruta ya NO existe: 404, no un zip', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post('/api/flito/impuestos/facturas-venta/zip')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['00000000-0000-0000-0000-000000000001'] });
    expect(res.status).toBe(404);
    expect(String(res.headers['content-type'] ?? '')).not.toContain('application/zip');
  });
});
