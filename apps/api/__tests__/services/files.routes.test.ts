// GET /api/files — la descarga firmada, con el foco puesto en las claves del formato VIEJO.
//
// El Bug #11694 volvió opacas las claves NUEVAS y decidió NO reescribir las existentes: la
// migración más la copia de objetos en MinIO no desharía lo que ya está escrito en los logs de
// nginx. La consecuencia es un contrato: aquí no se puede asumir que toda clave tenga el formato
// nuevo. Estos tests son lo que impide que esa suposición se cuele — es la regresión fácil.
//
// MinIO se sustituye por una clase mock, pero la firma HMAC es la REAL (`firmarDescargaEntidad`):
// lo que se ejerce es el camino entero enlace → verificación → stream.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'node:stream';

const bucketExistsMock = vi.fn();
const makeBucketMock = vi.fn();
const putObjectMock = vi.fn();
const getObjectMock = vi.fn();
const statObjectMock = vi.fn();
const removeObjectMock = vi.fn();

class MockClient {
  bucketExists = bucketExistsMock;
  makeBucket = makeBucketMock;
  putObject = putObjectMock;
  getObject = getObjectMock;
  statObject = statObjectMock;
  removeObject = removeObjectMock;
}

vi.mock('minio', () => ({ Client: MockClient }));

// Clave del formato LEGADO tal cual las escribió la versión anterior del helper:
// <prefix>/<entityId>/<timestamp>_<hash 12 hex>_<nombre saneado>.
const CLAVE_VIEJA = 'bolsas-transito/b1/cargas/1755000000000_a1b2c3d4e5f6_comprobante-ABC123.pdf';

beforeEach(() => {
  bucketExistsMock.mockReset().mockResolvedValue(true);
  makeBucketMock.mockReset();
  putObjectMock.mockReset().mockResolvedValue(undefined);
  getObjectMock.mockReset().mockResolvedValue(Readable.from([Buffer.from('%PDF-1.4 contenido')]));
  statObjectMock.mockReset();
  removeObjectMock.mockReset();
});

async function buildApp() {
  const app = express();
  const { default: router } = await import('../../src/modules/files/files.routes.js');
  app.use('/api/files', router);
  return app;
}

describe('GET /api/files — claves del formato VIEJO (Bug #11694, no regresión)', () => {
  it('el enlace firmado de una clave legada descarga el archivo (200 + contenido)', async () => {
    statObjectMock.mockResolvedValueOnce({ size: 18, metaData: { 'content-type': 'application/pdf' } });
    const { firmarDescargaEntidad } = await import('../../src/services/storage.js');
    const url = firmarDescargaEntidad(CLAVE_VIEJA, 300);

    const r = await request(await buildApp()).get(url);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    const cuerpo = Buffer.isBuffer(r.body) ? r.body.toString('utf-8') : String(r.text ?? '');
    expect(cuerpo).toContain('contenido');
    // Se pidió a MinIO la clave EXACTA, sin normalizarla ni recortarla por el camino.
    expect(getObjectMock).toHaveBeenCalledWith('operaciones-biometrics', CLAVE_VIEJA);
  });

  it('clave legada sin metadata en MinIO → content-type por la extensión de la clave', async () => {
    statObjectMock.mockResolvedValueOnce({ size: 18, metaData: {} });
    const { firmarDescargaEntidad } = await import('../../src/services/storage.js');
    const url = firmarDescargaEntidad(CLAVE_VIEJA, 300);

    const r = await request(await buildApp()).get(url);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
  });

  it('firma manipulada sobre una clave legada → 403 (la puerta sigue cerrada)', async () => {
    const { firmarDescargaEntidad } = await import('../../src/services/storage.js');
    const params = new URLSearchParams(firmarDescargaEntidad(CLAVE_VIEJA, 300).split('?')[1]);
    params.set('key', `${CLAVE_VIEJA}.otro`);

    const r = await request(await buildApp()).get(`/api/files?${params.toString()}`);

    expect(r.status).toBe(403);
    expect(getObjectMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/files — claves NUEVAS (opacas)', () => {
  it('la clave que produce hoy el helper se descarga por el mismo camino y no lleva el nombre', async () => {
    statObjectMock.mockResolvedValueOnce({ size: 18, metaData: { 'content-type': 'application/pdf' } });
    const { uploadEntityDocument, firmarDescargaEntidad } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument(
      'bolsas-transito/b1/cargas', 'b1', 'comprobante-ABC123.pdf', Buffer.from('x'), 'application/pdf',
    );
    const url = firmarDescargaEntidad(key, 300);

    // El AC del Bug: lo que viaja en la URL —y de ahí a los logs de nginx— no dice la placa.
    expect(url).not.toContain('ABC123');

    const r = await request(await buildApp()).get(url);

    expect(r.status).toBe(200);
    expect(getObjectMock).toHaveBeenCalledWith('operaciones-biometrics', key);
  });
});
