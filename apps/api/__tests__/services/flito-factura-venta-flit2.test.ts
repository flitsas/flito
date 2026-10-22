// Bug #13230 — `GET /api/flito/impuestos/:id/factura-venta` con un trámite de FLIT 2.
//
// Antes del fix la ruta pedía SIEMPRE la URL al adaptador de FLIT 1 con el adjuntoId de FLIT 2 → 404
// «no está disponible». Ahora un trámite `fuente = 'flit2'` va por la MISMA vía que la extracción
// (HU #13095): puerto de FLIT 2, allowlist `FLIT2_ADJUNTOS_HOSTS`, sin `Authorization`,
// `redirect: 'error'`. FLIT 1 sigue con `getFlitAdapter().obtenerUrlFactura`. Ningún host real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const entorno = vi.hoisted(() => ({ hosts: ['almacen.ejemplo.test'] as string[] }));
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_ADJUNTOS_HOSTS') return entorno.hosts;
        return target[prop as string];
      },
    }),
  };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const selectMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const obtenerUrlFactura = vi.hoisted(() => vi.fn());
const obtenerUrlAdjunto = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({
  getFlitAdapter: () => ({ obtenerUrlFactura, obtenerTramites: vi.fn(), marcarEntregado: vi.fn() }),
}));
vi.mock('../../src/modules/flito-sync/flit2-sync.adapter.js', () => ({ getFlit2SyncAdapter: () => ({ obtenerUrlAdjunto }) }));

const { default: impuestosRoutes } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');

const app = express();
app.use(express.json());
app.use('/api/flito/impuestos', impuestosRoutes);

const ID2 = '0192b7c4-5e6a-7d10-9f21-000000000001';
const ADJ = '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f';
const FIRMADA = 'https://almacen.ejemplo.test/f/factura.pdf?X-Amz-Signature=secreta-13230';
const SECRETOS = /secreta-13230|almacen\.ejemplo|X-Amz|FV-777/;
const PDF = '%PDF-1.7 factura flit2';
const adjunto = (url = FIRMADA) => ({ url, contentType: 'application/pdf', nombreArchivo: 'FV-777.pdf', expiraEn: '2026-10-01T15:10:00Z' });

/** buscarConAcceso (1.ª lectura) + trámite con la factura (2.ª). `fuente`/`idFlit2` explícitos: el `chain` no filtra columnas. */
function mockAcceso(tramite: { fuente: string | null; idFlit2: string | null; facturaVentaFlitId?: string }) {
  selectMock
    .mockReturnValueOnce(chain([{ imp: { id: 'i1', tramiteId: 't1', organismoCodigo: '05001', estado: 'pendiente' }, dentroDeFrontera: true }]))
    .mockReturnValueOnce(chain([{
      facturaVentaFlitId: tramite.facturaVentaFlitId ?? ADJ, idFlit: null,
      fuente: tramite.fuente, idFlit2: tramite.idFlit2,
      placa: 'asd123', organismoAlias: 'Medellín', organismoCodigo: '05001',
    }]));
}

const fetchMock = vi.fn();
const todoElLog = () => JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls));
const peticion = (token: string) => request(app).get('/api/flito/impuestos/i1/factura-venta')
  .set('Authorization', `Bearer ${token}`);
const pedir = async () => peticion(await testToken({ role: 'admin' }));
/** Igual que `pedir`, pero con el cuerpo binario como Buffer (supertest no parsea `application/pdf`). */
const pedirBytes = async () => {
  const token = await testToken({ role: 'admin' });
  return peticion(token).buffer(true).parse((r, cb) => {
    const partes: Buffer[] = [];
    r.on('data', (d: Buffer) => partes.push(d));
    r.on('end', () => cb(null, Buffer.concat(partes)));
  });
};

beforeEach(() => {
  selectMock.mockReset(); obtenerUrlFactura.mockReset(); obtenerUrlAdjunto.mockReset(); fetchMock.mockReset();
  Object.values(logMock).forEach((m) => m.mockReset());
  entorno.hosts = ['almacen.ejemplo.test'];
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Bug #13230 — factura de venta de un trámite de FLIT 2', () => {
  it('FLIT 2 → 200 con los bytes del PDF, `PLACA.pdf`, y la URL pedida al puerto de FLIT 2 (no a FLIT 1)', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(adjunto());
    fetchMock.mockResolvedValue(new Response(PDF, { status: 200, headers: { 'content-type': 'binary/octet-stream' } }));

    const res = await pedirBytes();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="ASD123.pdf"');
    expect(Buffer.from(res.body as Buffer).toString()).toBe(PDF);
    expect(obtenerUrlAdjunto).toHaveBeenCalledWith(ID2, ADJ);
    expect(obtenerUrlFactura).not.toHaveBeenCalled();
    // Misma vía que la extracción: sin Authorization y sin seguir redirecciones.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FIRMADA);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('la lectura del trámite PIDE `fuente` e `idFlit2` (el mock no filtra columnas: se asierta el select)', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(adjunto());
    fetchMock.mockResolvedValue(new Response(PDF, { status: 200 }));

    await pedir();

    const columnas = Object.keys(selectMock.mock.calls[1]?.[0] ?? {});
    expect(columnas).toEqual(expect.arrayContaining(['facturaVentaFlitId', 'fuente', 'idFlit2']));
  });

  it('host fuera de FLIT2_ADJUNTOS_HOSTS → 502 con el copy de siempre; no se descarga; ni la URL ni el error crudo salen', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(adjunto('https://otro-host.ejemplo.invalid/f.pdf?X-Amz-Signature=secreta-13230'));

    const res = await pedir();

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'No se pudo descargar la factura de venta desde FLIT' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(SECRETOS);
    expect(todoElLog()).not.toMatch(SECRETOS);
    expect(todoElLog()).toContain('host');
  });

  it('URL http (no https) → 502 y no se descarga', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(adjunto('http://almacen.ejemplo.test/f/factura.pdf?X-Amz-Signature=secreta-13230'));

    const res = await pedir();

    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trámite FLIT 2 sin `idFlit2` → 404 «no está disponible», sin llamar a ningún adaptador', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: null });

    const res = await pedir();

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'La factura de venta no está disponible en FLIT' });
    expect(obtenerUrlAdjunto).not.toHaveBeenCalled();
    expect(obtenerUrlFactura).not.toHaveBeenCalled();
  });

  it('404 del puerto de FLIT 2 (adjunto null) → 404 «no está disponible»', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(null);

    const res = await pedir();

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'La factura de venta no está disponible en FLIT' });
  });

  it('descarga fallida dos veces → 502; pide UNA URL nueva y no más', async () => {
    mockAcceso({ fuente: 'flit2', idFlit2: ID2 });
    obtenerUrlAdjunto.mockResolvedValue(adjunto());
    fetchMock.mockResolvedValue(new Response('x', { status: 500 }));

    const res = await pedir();

    expect(res.status).toBe(502);
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(2);
    expect(todoElLog()).not.toMatch(SECRETOS);
  });
});

describe('Bug #13230 — FLIT 1 sigue igual', () => {
  it('trámite FLIT 1 → URL de getFlitAdapter, descarga con fetch(url) y nunca el puerto de FLIT 2', async () => {
    mockAcceso({ fuente: 'flit', idFlit2: null, facturaVentaFlitId: 'fac-123' });
    obtenerUrlFactura.mockResolvedValue('https://flit-bucket.s3/fac-123?sig=abc');
    fetchMock.mockResolvedValue({
      ok: true, headers: new Headers({ 'content-type': 'binary/octet-stream' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('%PDF-1.4 fake').buffer),
    });

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline; filename="ASD123.pdf"');
    expect(obtenerUrlFactura).toHaveBeenCalledWith('fac-123');
    expect(fetchMock).toHaveBeenCalledWith('https://flit-bucket.s3/fac-123?sig=abc');
    expect(obtenerUrlAdjunto).not.toHaveBeenCalled();
  });
});
