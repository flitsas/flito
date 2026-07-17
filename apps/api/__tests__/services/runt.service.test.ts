import { describe, it, expect, vi, beforeEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';

// Mock https.request to capture calls and return controlled responses.
vi.mock('https', () => {
  return { default: { request: vi.fn() }, request: vi.fn() };
});

// Bypass circuit breaker → just call the function (preserves rejects)
vi.mock('../../src/services/circuitBreaker.js', () => ({
  withCircuitBreaker: (_name: string, fn: () => Promise<any>) => fn(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const httpsRequestMock = vi.mocked(https.request);

beforeEach(() => {
  httpsRequestMock.mockReset();
  // Re-mock default.request too in case the service uses default import
  (https as any).default = (https as any).default || {};
  (https as any).default.request = httpsRequestMock;
});

function mockHttpsResponse(status: number, body: any) {
  httpsRequestMock.mockImplementationOnce((opts: any, cb?: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = status;
    res.headers = {};
    setImmediate(() => {
      cb(res);
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    return req;
  });
}

function mockHttpsError(err: Error) {
  httpsRequestMock.mockImplementationOnce(() => {
    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    setImmediate(() => req.emit('error', err));
    return req;
  });
}

describe('consultarVehiculoRunt', () => {
  it('sin placa ni vin → throw', async () => {
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    await expect(consultarVehiculoRunt(undefined, undefined)).rejects.toThrow(/Placa o VIN/);
  });

  it('placa sin documento → throw', async () => {
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    await expect(consultarVehiculoRunt('ABC123', undefined)).rejects.toThrow(/Documento/);
  });

  it('placa + documento → llama CEA y retorna data', async () => {
    mockHttpsResponse(200, { ok: true, data: { placa: 'ABC123' } });
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarVehiculoRunt('abc-123', undefined, '1040326572', 'CC');
    expect(r.ok).toBe(true);
    expect(httpsRequestMock).toHaveBeenCalled();
    const callArgs = httpsRequestMock.mock.calls[0][0] as any;
    expect(callArgs.headers['x-internal-key']).toBe('test-runt-internal-key-12345');
  });

  it('vin solo (sin documento) → llama CEA con vin sanitizado', async () => {
    mockHttpsResponse(200, { ok: true });
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarVehiculoRunt(undefined, 'wXy12-34');
    expect(r.ok).toBe(true);
  });

  it('CEA responde 500 → ok:false', async () => {
    mockHttpsResponse(500, 'error html');
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarVehiculoRunt('ABC123', undefined, '123456');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Error comunicando/);
  });

  it('CEA error de red → ok:false con mensaje', async () => {
    mockHttpsError(new Error('ECONNREFUSED'));
    const { consultarVehiculoRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarVehiculoRunt('ABC123', undefined, '123456');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ECONNREFUSED|no disponible/);
  });
});

describe('consultarPersonaRunt', () => {
  it('sin documento → throw', async () => {
    const { consultarPersonaRunt } = await import('../../src/modules/runt/runt.service.js');
    await expect(consultarPersonaRunt('')).rejects.toThrow(/Documento/);
  });

  it('documento → llama CEA persona', async () => {
    mockHttpsResponse(200, { ok: true, data: { nombres: 'Juan' } });
    const { consultarPersonaRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarPersonaRunt('1040326572', 'CC');
    expect(r.ok).toBe(true);
  });

  it('CEA responde string (no JSON) → ok:false', async () => {
    mockHttpsResponse(200, 'plain text');
    const { consultarPersonaRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarPersonaRunt('1040326572');
    expect(r.ok).toBe(false);
  });

  it('error red → ok:false', async () => {
    mockHttpsError(new Error('timeout'));
    const { consultarPersonaRunt } = await import('../../src/modules/runt/runt.service.js');
    const r = await consultarPersonaRunt('1040326572');
    expect(r.ok).toBe(false);
  });
});
