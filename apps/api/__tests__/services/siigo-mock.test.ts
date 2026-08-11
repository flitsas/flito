// HU #11252 — modo simulado de Siigo (Feature #11239).
//
// El valor de esta HU no es «que haya un mock», sino que el simulador se comporte lo bastante como
// Siigo para que el resto del código no note la diferencia, y que el modo real NUNCA se degrade a
// simulado en silencio.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'mock' as 'mock' | 'real',
  SIIGO_MOCK_ERROR_RATE: 0,
  SIIGO_MOCK_TIMEOUT_RATE: 0,
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const obtenerCredencialActivaMock = vi.fn();
vi.mock('../../src/modules/siigo/credenciales.service.js', () => ({
  obtenerCredencialActiva: obtenerCredencialActivaMock,
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { siigoRequest } = await import('../../src/modules/siigo/siigo.client.js');
const { obtenerToken, invalidarTodos } = await import('../../src/modules/siigo/siigo.token.js');
const {
  respuestaSimulada, modoSiigo, enModoMock, reiniciarConsecutivoSimulado,
  SiigoMockTimeout, TOKEN_SIMULADO,
} = await import('../../src/modules/siigo/siigo.mock.js');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  obtenerCredencialActivaMock.mockReset();
  invalidarTodos();
  reiniciarConsecutivoSimulado();
  envMock.SIIGO_MODE = 'mock';
  envMock.SIIGO_MOCK_ERROR_RATE = 0;
  envMock.SIIGO_MOCK_TIMEOUT_RATE = 0;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('AC1 — en modo simulado no sale tráfico', () => {
  it('una petición no toca la red', async () => {
    const r = await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('la autenticación tampoco toca la red ni la base de datos', async () => {
    const token = await obtenerToken('pruebas');

    expect(token).toBe(TOKEN_SIMULADO);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(obtenerCredencialActivaMock).not.toHaveBeenCalled();
  });

  it('el token simulado se cachea igual que uno real', async () => {
    const a = await obtenerToken('pruebas');
    const b = await obtenerToken('pruebas');
    expect(a).toBe(b);
  });

  it('el token simulado se distingue a simple vista de uno real', () => {
    expect(TOKEN_SIMULADO).toMatch(/mock/i);
  });

  it('crear una factura devuelve una respuesta simulada sin red', async () => {
    const r = await siigoRequest({ metodo: 'POST', ruta: '/v1/invoices', cuerpo: facturaValida() });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.status).toBe(201);
    expect((r.datos as { id: string }).id).toMatch(/^mock-invoice-/);
  });
});

// HU #11326 — el simulador dejó de devolver una factura FIJA. Antes respondía siempre el mismo
// objeto —total cero, cliente inventado, sin observaciones—, así que estos tests pasaban con una
// petición sin cuerpo, que Siigo rechazaría con `parameter_required`. Ahora exige los obligatorios
// documentados y calcula el total de las líneas: un simulador más permisivo que el ambiente real
// deja pasar en desarrollo justo lo que revienta en producción.
function facturaValida(over: Record<string, unknown> = {}) {
  return {
    document: { id: 24446 },
    date: '2026-08-04',
    customer: { identification: '900123456', branch_office: 0 },
    seller: 629,
    items: [{ code: 'P-1', quantity: 1, price: 1000 }],
    payments: [{ id: 5636, value: 1000 }],
    ...over,
  };
}

describe('AC2 — el simulador respeta el contrato', () => {
  it('la factura simulada trae los campos documentados', () => {
    const r = respuestaSimulada('POST', '/v1/invoices', { cuerpo: facturaValida() });
    const d = r.datos as Record<string, unknown>;

    // Los mismos campos que devuelve InvoiceOutDian según la documentación.
    for (const campo of ['id', 'number', 'name', 'date', 'customer', 'total', 'balance', 'items', 'payments', 'public_url', 'metadata']) {
      expect(d).toHaveProperty(campo);
    }
    expect(d.name).toMatch(/^FV-\d+-\d+$/);
  });

  it('dos facturas simuladas no comparten consecutivo', () => {
    const a = respuestaSimulada('POST', '/v1/invoices', { cuerpo: facturaValida() }).datos as { number: number };
    const b = respuestaSimulada('POST', '/v1/invoices', { cuerpo: facturaValida() }).datos as { number: number };
    expect(b.number).toBe(a.number + 1);
  });

  it('los listados traen la forma paginada documentada', () => {
    const d = respuestaSimulada('GET', '/v1/invoices').datos as Record<string, unknown>;
    expect(d).toHaveProperty('pagination');
    expect(d).toHaveProperty('results');
    expect((d.pagination as Record<string, unknown>).page_size).toBe(25);
  });

  it('los catálogos devuelven un arreglo', () => {
    expect(Array.isArray(respuestaSimulada('GET', '/v1/document-types?type=FV').datos)).toBe(true);
    expect(Array.isArray(respuestaSimulada('GET', '/v1/payment-types').datos)).toBe(true);
  });

  // HU #11297 — el simulador dejó de devolver un tercero fijo. Antes respondía siempre el mismo
  // objeto, así que este test pasaba con una petición SIN cuerpo, que Siigo rechazaría. Ahora hace
  // eco de lo enviado y exige los obligatorios: un simulador más permisivo que el ambiente real
  // deja pasar en desarrollo justo lo que revienta en producción.
  it('crear un tercero devuelve la forma de CustomerOut', () => {
    const d = respuestaSimulada('POST', '/v1/customers', {
      cuerpo: { identification: '900123456', branch_office: 0, name: ['Empresa simulada'] },
    }).datos as Record<string, unknown>;
    expect(d).toHaveProperty('id');
    expect(d).toHaveProperty('identification');
    expect(Array.isArray(d.name)).toBe(true); // en Siigo `name` es un arreglo
  });

  it('crear un tercero SIN los obligatorios se rechaza, como haría Siigo', () => {
    const r = respuestaSimulada('POST', '/v1/customers');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('una ruta no contemplada devuelve éxito vacío, no un 404 inventado', () => {
    const r = respuestaSimulada('GET', '/v1/algo-que-no-existe');
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  // HU #11335 — el archivo del PDF y el XML.
  it('el PDF y el XML de una factura traen contenido de verdad, no un listado vacío', () => {
    // Antes de esta HU estas dos rutas caían en el listado genérico de `/v1/invoices` y respondían
    // `results: []`. Con eso el archivo no se podía ensayar: no había caso feliz que probar.
    for (const [documento, firma] of [['pdf', '%PDF'], ['xml', '<?xml']] as const) {
      const d = respuestaSimulada('GET', `/v1/invoices/inv-1/${documento}`).datos as { base64: string };
      expect(typeof d.base64).toBe('string');
      expect(Buffer.from(d.base64, 'base64').toString('utf8').startsWith(firma)).toBe(true);
    }
  });

  it('el listado de facturas sigue siendo un listado: la ruta del documento no se lo come', () => {
    const d = respuestaSimulada('GET', '/v1/invoices').datos as Record<string, unknown>;
    expect(d).toHaveProperty('results');
  });
});

describe('AC3 — se pueden ensayar los fallos', () => {
  it('con tasa de error 1 siempre devuelve un error con la estructura real de Siigo', () => {
    const r = respuestaSimulada('POST', '/v1/invoices', { tasaError: 1, aleatorio: () => 0 });

    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    const d = r.datos as { Status: number; Errors: Array<{ Code: string }> };
    expect(d.Status).toBe(429);
    expect(d.Errors[0]!.Code).toBe('requests_limit');
  });

  it('el error simulado lo entiende el traductor real y sale reintentable', async () => {
    const { traducirErrorSiigo } = await import('../../src/modules/siigo/siigo.errors.js');
    const r = respuestaSimulada('POST', '/v1/invoices', { tasaError: 1, aleatorio: () => 0 });

    const e = traducirErrorSiigo(r.status, r.datos);
    expect(e.code).toBe('requests_limit');
    expect(e.reintentable).toBe(true);
  });

  it('con tasa de timeout 1 lanza el fallo de espera agotada', () => {
    expect(() => respuestaSimulada('GET', '/v1/invoices', { tasaTimeout: 1, aleatorio: () => 0 }))
      .toThrow(SiigoMockTimeout);
  });

  it('con tasa 0 nunca falla', () => {
    for (let i = 0; i < 20; i++) {
      expect(respuestaSimulada('GET', '/v1/invoices', { tasaError: 0, tasaTimeout: 0 }).ok).toBe(true);
    }
  });

  it('las tasas se leen del entorno cuando no se pasan explícitas', () => {
    envMock.SIIGO_MOCK_ERROR_RATE = 1;
    const r = respuestaSimulada('POST', '/v1/invoices', { aleatorio: () => 0 });
    expect(r.ok).toBe(false);
  });

  it('el timeout tiene prioridad sobre el error: se evalúa primero', () => {
    expect(() => respuestaSimulada('GET', '/v1/invoices', {
      tasaError: 1, tasaTimeout: 1, aleatorio: () => 0,
    })).toThrow(SiigoMockTimeout);
  });
});

describe('AC4 — modo real sin credenciales', () => {
  it('falla con el error de credenciales y NO devuelve una respuesta simulada', async () => {
    envMock.SIIGO_MODE = 'real';
    obtenerCredencialActivaMock.mockRejectedValue(
      new Error('No hay credenciales de Siigo activas para el ambiente "pruebas"'),
    );

    // Lo esencial de AC4: falla, y lo que devuelve NO es el token simulado.
    const resultado = await obtenerToken('pruebas').catch((e: Error) => e);

    expect(resultado).toBeInstanceOf(Error);
    expect((resultado as Error).message).toMatch(/No hay credenciales/);
    expect(resultado).not.toBe(TOKEN_SIMULADO);
  });

  it('en modo real una petición sí intenta salir a la red', async () => {
    envMock.SIIGO_MODE = 'real';
    const { Redacted } = await import('../../src/shared/utils/crypto.js');
    obtenerCredencialActivaMock.mockResolvedValue({
      id: 1, ambiente: 'pruebas', username: 'u', accessKey: new Redacted('k'),
    });
    fetchMock.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ access_token: 'tok-real' }),
    } as Response);

    await siigoRequest({ metodo: 'GET', ruta: '/v1/invoices' });

    // Al menos la autenticación salió a la red: no se simuló nada.
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('AC5 — el modo queda registrado', () => {
  it('el modo se resuelve en un único punto y es consultable', () => {
    envMock.SIIGO_MODE = 'mock';
    expect(modoSiigo()).toBe('mock');
    expect(enModoMock()).toBe(true);

    envMock.SIIGO_MODE = 'real';
    expect(modoSiigo()).toBe('real');
    expect(enModoMock()).toBe(false);
  });

  it('la bitácora acepta el modo para distinguir prueba de operación productiva', async () => {
    // La columna `modo` de siigo_operaciones existe desde la HU #11251; aquí se comprueba que el
    // valor que hay que escribir sale de un único sitio.
    envMock.SIIGO_MODE = 'mock';
    expect(modoSiigo()).toBe('mock');
  });
});
