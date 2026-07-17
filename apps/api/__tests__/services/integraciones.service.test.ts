// TRAM-TRASPASO-F3 — proxies SIMIT/Fasecolda/MercadoLibre (mock upstream CEA).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';

vi.mock('https', () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock('../../src/services/circuitBreaker.js', () => ({
  withCircuitBreaker: (_name: string, fn: () => Promise<any>) => fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const httpsRequestMock = vi.mocked(https.request);

beforeEach(() => {
  httpsRequestMock.mockReset();
  (https as any).default = (https as any).default || {};
  (https as any).default.request = httpsRequestMock;
});

function mockResp(status: number, body: any) {
  httpsRequestMock.mockImplementationOnce((_opts: any, cb?: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = status; res.headers = {};
    setImmediate(() => {
      cb(res);
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    const req = new EventEmitter() as any;
    req.write = vi.fn(); req.end = vi.fn(); req.setTimeout = vi.fn(); req.destroy = vi.fn();
    return req;
  });
}
function mockErr(err: Error) {
  httpsRequestMock.mockImplementationOnce(() => {
    const req = new EventEmitter() as any;
    req.write = vi.fn(); req.end = vi.fn(); req.setTimeout = vi.fn(); req.destroy = vi.fn();
    setImmediate(() => req.emit('error', err));
    return req;
  });
}

describe('consultarSimit', () => {
  it('sin filtro → ok:false sin llamar CEA', async () => {
    const { consultarSimit } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await consultarSimit('');
    expect(r.ok).toBe(false);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('200 con comparendos → normaliza total + totalMonto + x-internal-key', async () => {
    mockResp(200, { ok: true, data: [
      { numero: '1', codigo: 'C29', monto: 500000, estado: 'pendiente' },
      { numero: '2', codigo: 'D04', monto: 300000, estado: 'pendiente' },
    ] });
    const { consultarSimit } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await consultarSimit('1040326572');
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.totalMonto).toBe(800000);
    const callArgs = httpsRequestMock.mock.calls[0][0] as any;
    expect(callArgs.headers['x-internal-key']).toBe('test-runt-internal-key-12345');
    expect(callArgs.path).toContain('simit/consulta-internal');
  });

  it('200 sin multas → ok:true total 0', async () => {
    mockResp(200, { ok: true, data: [] });
    const { consultarSimit } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await consultarSimit('123');
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.totalMonto).toBe(0);
  });

  it('CEA 500 → ok:false', async () => {
    mockResp(500, 'err');
    const { consultarSimit } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await consultarSimit('123');
    expect(r.ok).toBe(false);
  });

  it('error de red → ok:false con mensaje', async () => {
    mockErr(new Error('ECONNREFUSED'));
    const { consultarSimit } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await consultarSimit('123');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ECONNREFUSED|no disponible/);
  });
});

describe('buscarFasecolda', () => {
  it('sin marca/anio → ok:false sin red', async () => {
    const { buscarFasecolda } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await buscarFasecolda({ marca: '', anio: '' });
    expect(r.ok).toBe(false);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('200 → passthrough mejorMatch + query GET con params', async () => {
    mockResp(200, { ok: true, mejorMatch: { codigo: '08123456', valorCOP: 50000000 } });
    const { buscarFasecolda } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await buscarFasecolda({ marca: 'MAZDA', anio: '2020', linea: 'CX-30', cilindraje: '2000' });
    expect(r.ok).toBe(true);
    expect(r.mejorMatch.valorCOP).toBe(50000000);
    const callArgs = httpsRequestMock.mock.calls[0][0] as any;
    expect(callArgs.method).toBe('GET');
    expect(callArgs.path).toContain('fasecolda/buscar-internal');
    expect(callArgs.path).toContain('marca=MAZDA');
    expect(callArgs.path).toContain('cilindraje=2000');
  });

  it('CEA 500 → ok:false', async () => {
    mockResp(500, 'err');
    const { buscarFasecolda } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await buscarFasecolda({ marca: 'MAZDA', anio: '2020' });
    expect(r.ok).toBe(false);
  });
});

describe('precioMercadoLibre', () => {
  it('sin marca → ok:false sin red', async () => {
    const { precioMercadoLibre } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await precioMercadoLibre('');
    expect(r.ok).toBe(false);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('200 → passthrough precioPromedio', async () => {
    mockResp(200, { ok: true, precioPromedio: 48000000, precioMin: 40000000, precioMax: 60000000 });
    const { precioMercadoLibre } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await precioMercadoLibre('Mazda', 'CX-30', '2020');
    expect(r.ok).toBe(true);
    expect(r.precioPromedio).toBe(48000000);
    const callArgs = httpsRequestMock.mock.calls[0][0] as any;
    expect(callArgs.path).toContain('mercadolibre/precio-internal');
  });

  it('CEA 500 → ok:false', async () => {
    mockResp(500, 'err');
    const { precioMercadoLibre } = await import('../../src/modules/integraciones/integraciones.service.js');
    const r = await precioMercadoLibre('Mazda');
    expect(r.ok).toBe(false);
  });
});
