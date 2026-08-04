// HU #11248 — cliente HTTP de Siigo: cabeceras obligatorias, idempotencia y reintento ante 401.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const obtenerTokenMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.token.js')>();
  return { ...actual, obtenerToken: obtenerTokenMock };
});

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { siigoRequest, SiigoRequestError } = await import('../../src/modules/siigo/siigo.client.js');
const { SiigoAuthError } = await import('../../src/modules/siigo/siigo.token.js');

const fetchMock = vi.fn();

function respuesta(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Cabeceras de la llamada número `n` (0-indexada). */
function headersDe(n: number): Record<string, string> {
  return fetchMock.mock.calls[n]![1].headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock.mockReset();
  obtenerTokenMock.mockReset();
  obtenerTokenMock.mockResolvedValue('tok-vigente');
  envMock.SIIGO_PARTNER_ID = 'FlitoIntegracion';
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('AC4 — cabeceras obligatorias en toda petición', () => {
  it('un GET lleva Authorization y Partner-Id', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { results: [] }));

    await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });

    const h = headersDe(0);
    expect(h.Authorization).toBe('tok-vigente');
    expect(h['Partner-Id']).toBe('FlitoIntegracion');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.siigo.test/v1/invoices');
  });

  it('un POST con cuerpo declara Content-Type', async () => {
    fetchMock.mockResolvedValue(respuesta(201, { id: 'x' }));

    await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', cuerpo: { date: '2026-08-04' } });

    expect(headersDe(0)['Content-Type']).toBe('application/json');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ date: '2026-08-04' });
  });

  it('un GET sin cuerpo no manda Content-Type ni body', async () => {
    fetchMock.mockResolvedValue(respuesta(200));
    await siigoRequest({ metodo: 'GET', ruta: '/v1/users' });

    expect(headersDe(0)['Content-Type']).toBeUndefined();
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined();
  });

  it('sin Partner-Id válido no sale ninguna petición a la red', async () => {
    envMock.SIIGO_PARTNER_ID = 'con espacios';
    await expect(siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' }))
      .rejects.toThrow(/alfanuméricos/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devuelve status, ok y datos ya deserializados', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { total: 3 }));
    const r = await siigoRequest<{ total: number }>({ metodo: 'GET', ruta: '/v1/invoices' });
    expect(r).toEqual({ status: 200, ok: true, datos: { total: 3 } });
  });

  it('un cuerpo no deserializable no rompe la llamada', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 502, json: async () => { throw new Error('no es JSON'); },
    } as unknown as Response);

    const r = await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });
    expect(r.status).toBe(502);
    expect(r.ok).toBe(false);
    expect(r.datos).toBeNull();
  });
});

describe('AC5 — clave de idempotencia solo donde corresponde', () => {
  it('un POST con clave la envía en la cabecera', async () => {
    fetchMock.mockResolvedValue(respuesta(201));
    await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', cuerpo: {}, idempotencyKey: 'lote123' });
    expect(headersDe(0)['Idempotency-Key']).toBe('lote123');
  });

  it('un POST sin clave no manda la cabecera', async () => {
    fetchMock.mockResolvedValue(respuesta(201));
    await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', cuerpo: {} });
    expect(headersDe(0)['Idempotency-Key']).toBeUndefined();
  });

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'un %s con clave se rechaza antes de salir a la red', async (metodo) => {
      await expect(siigoRequest({ metodo, ruta: '/v1/invoices/1', idempotencyKey: 'abc' }))
        .rejects.toThrow(SiigoRequestError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rechaza una clave con caracteres especiales', async () => {
    await expect(siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', idempotencyKey: 'lote-123' }))
      .rejects.toThrow(/alfanumérica/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza una clave de más de 30 caracteres', async () => {
    await expect(siigoRequest({
      metodo: 'POST', ruta: '/v1/invoices', idempotencyKey: 'a'.repeat(31),
    })).rejects.toThrow(/30 caracteres/);
  });

  it('acepta una clave de exactamente 30 caracteres', async () => {
    fetchMock.mockResolvedValue(respuesta(201));
    await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', idempotencyKey: 'a'.repeat(30) });
    expect(headersDe(0)['Idempotency-Key']).toBe('a'.repeat(30));
  });
});

describe('AC6 — token rechazado', () => {
  it('ante un 401 renueva el token y reintenta una vez', async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta(401))
      .mockResolvedValueOnce(respuesta(200, { ok: true }));
    obtenerTokenMock
      .mockResolvedValueOnce('tok-viejo')
      .mockResolvedValueOnce('tok-renovado');

    const r = await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // El reintento va con el token nuevo, no con el rechazado.
    expect(headersDe(0).Authorization).toBe('tok-viejo');
    expect(headersDe(1).Authorization).toBe('tok-renovado');
    expect(obtenerTokenMock).toHaveBeenLastCalledWith('pruebas', { forzarRenovacion: true });
  });

  it('si el reintento vuelve a dar 401 falla y NO reintenta más', async () => {
    fetchMock.mockResolvedValue(respuesta(401));

    await expect(siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' }))
      .rejects.toThrow(SiigoAuthError);

    // Exactamente dos: el original y el único reintento. Un bucle acercaría el bloqueo de Siigo.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('otros errores NO disparan reintento: se devuelven tal cual para que los clasifique quien llame', async () => {
    fetchMock.mockResolvedValue(respuesta(400, { Errors: [{ Code: 'parameter_required' }] }));

    const r = await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', cuerpo: {} });

    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un 429 no se reintenta aquí: eso es responsabilidad del control de tasa', async () => {
    fetchMock.mockResolvedValue(respuesta(429));
    const r = await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });
    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ambiente', () => {
  it('usa el ambiente configurado cuando no se indica otro', async () => {
    fetchMock.mockResolvedValue(respuesta(200));
    await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });
    expect(obtenerTokenMock).toHaveBeenCalledWith('pruebas');
  });

  it('permite forzar el ambiente por petición', async () => {
    fetchMock.mockResolvedValue(respuesta(200));
    await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices', ambiente: 'produccion' });
    expect(obtenerTokenMock).toHaveBeenCalledWith('produccion');
  });
});
