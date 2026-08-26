// HU #11281 — BUG-A y BUG-B: el cortacircuitos NO puede ser compartido por los seis catálogos.
//
// Este archivo es el único de la HU que corre con el CORTACIRCUITOS REAL, sin mockear, porque los
// dos defectos que reproduce son exactamente su comportamiento acumulativo: el umbral de cinco
// fallos y la ventana de un minuto. Con el doble reiniciable del otro archivo —que abre y cierra a
// voluntad— ninguno de los dos se manifestaría.
//
// Lo que QA demostró con el circuito compartido:
//
//   BUG-A · Con tres catálogos caídos y tres sanos, el circuito se abre en el fallo nº 5 (2+2+1) y
//           a los tres sanos no se les hace ni una petición. El cortacircuitos existe para dejar de
//           insistir en lo que está roto, no para tumbar lo que funciona.
//   BUG-B · Tras una caída total (12 fallos sobre la misma clave), el reintento manual del operador
//           queda rechazado durante 60 segundos aunque Siigo ya esté respondiendo.
//
// El estado del cortacircuitos es un `Map` de módulo sin `reset`. Por eso cada test hace
// `vi.resetModules()` y vuelve a importar el servicio: así arranca con los circuitos limpios y el
// resultado no depende de qué test corrió antes.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'real' as 'mock' | 'real',
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

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: vi.fn().mockResolvedValue(undefined),
}));

const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: transactionMock, execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

const RUTAS = {
  document_type: '/v1/document-types?type=FV',
  user: '/v1/users',
  payment_type: '/v1/payment-types?document_type=FV',
  tax: '/v1/taxes',
  account_group: '/v1/account-groups',
  cost_center: '/v1/cost-centers',
} as const;

const fetchMock = vi.fn();

function respuestaHttp(status: number, datos: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => datos };
}

const CAIDO = {
  Status: 503,
  Errors: [{ Code: 'service_unavailable', Message: 'Service unavailable', Params: [] }],
};

/** Rutas que responden 503 en este momento. Se muta entre sincronizaciones. */
let rutasCaidas = new Set<string>();

function rutaDe(url: string): string {
  return url.replace(envMock.SIIGO_BASE_URL, '');
}

function peticionesPorRuta(): Record<string, number> {
  const conteo: Record<string, number> = {};
  for (const call of fetchMock.mock.calls) {
    const r = rutaDe(call[0] as string);
    conteo[r] = (conteo[r] ?? 0) + 1;
  }
  return conteo;
}

/** El servicio, reimportado con los circuitos en blanco. */
async function servicioLimpio() {
  vi.resetModules();
  return import('../../src/modules/siigo/siigo.catalogos.service.js');
}

/** Transacción de mentira: aquí no se prueba la persistencia, sino a quién se llama. */
function txFalso() {
  return {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    delete: () => { throw new Error('siigo_catalogos no admite DELETE'); },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  obtenerTokenMock.mockReset();
  transactionMock.mockReset();
  rutasCaidas = new Set();

  obtenerTokenMock.mockResolvedValue('Bearer token-simulado');
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txFalso()));

  fetchMock.mockImplementation(async (url: string) => {
    const ruta = rutaDe(url);
    if (rutasCaidas.has(ruta)) return respuestaHttp(503, CAIDO);
    return respuestaHttp(200, []);
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('BUG-A — un catálogo caído no puede dejar sin intentar a los sanos', () => {
  it('con tres catálogos caídos, los tres sanos SÍ reciben su petición', async () => {
    const { sincronizarCatalogos } = await servicioLimpio();
    // Los tres primeros del orden de sincronización: con circuito compartido acumulan 2+2+1 = 5
    // fallos y abren el circuito antes de llegar a `tax`.
    rutasCaidas = new Set([RUTAS.document_type, RUTAS.user, RUTAS.payment_type]);

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    const conteo = peticionesPorRuta();
    // Lo que fallaba: cero peticiones a estas tres.
    expect(conteo[RUTAS.tax]).toBeGreaterThan(0);
    expect(conteo[RUTAS.account_group]).toBeGreaterThan(0);
    expect(conteo[RUTAS.cost_center]).toBeGreaterThan(0);

    const ok = r.catalogos.filter((c) => c.ok).map((c) => c.tipo).sort();
    expect(ok).toEqual(['account_group', 'cost_center', 'tax']);
    expect(r.parcial).toBe(true);
  });

  it('los fallos se imputan al circuito del catálogo caído, no al de los demás', async () => {
    const { sincronizarCatalogos } = await servicioLimpio();
    rutasCaidas = new Set([RUTAS.tax]);

    // Tres sincronizaciones seguidas: `tax` acumula 6 fallos y abre SU circuito…
    for (let i = 0; i < 3; i++) {
      await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });
    }
    const antes = peticionesPorRuta();

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });
    const despues = peticionesPorRuta();

    // …y a partir de ahí deja de gastar cuota, que es para lo que sirve el cortacircuitos.
    expect(despues[RUTAS.tax]).toBe(antes[RUTAS.tax]);
    expect(r.catalogos.find((c) => c.tipo === 'tax')!.ok).toBe(false);
    // Pero los otros cinco siguen consultándose con normalidad.
    expect(despues[RUTAS.user]).toBeGreaterThan(antes[RUTAS.user]!);
    expect(r.catalogos.filter((c) => c.ok)).toHaveLength(5);
  });

  it('el ambiente separa los circuitos: producción no hereda el castigo de pruebas', async () => {
    const { sincronizarCatalogos } = await servicioLimpio();
    rutasCaidas = new Set([RUTAS.tax]);

    for (let i = 0; i < 3; i++) {
      await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined });
    }
    const antes = peticionesPorRuta();

    // El mismo catálogo, la otra empresa de Siigo: es otro servicio y merece su propio veredicto.
    rutasCaidas = new Set();
    const r = await sincronizarCatalogos({
      ambiente: 'produccion', tipos: ['tax'], dormir: async () => undefined,
    });

    expect(peticionesPorRuta()[RUTAS.tax]).toBeGreaterThan(antes[RUTAS.tax]!);
    expect(r.catalogos[0]!.ok).toBe(true);
  });
});

describe('BUG-B — el reintento del operador no puede quedar muerto tras una caída total', () => {
  it('si Siigo vuelve, la sincronización inmediata siguiente funciona', async () => {
    const { sincronizarCatalogos } = await servicioLimpio();
    rutasCaidas = new Set(Object.values(RUTAS));

    const caida = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });
    expect(caida.ok).toBe(false);
    expect(caida.parcial).toBe(false);
    const trasLaCaida = fetchMock.mock.calls.length;

    // Siigo se recupera y el operador vuelve a pulsar el botón, sin esperar el minuto de la ventana
    // de reapertura. Con el circuito compartido esta llamada no salía a la red.
    rutasCaidas = new Set();
    const reintento = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    expect(fetchMock.mock.calls.length).toBe(trasLaCaida + 6);
    expect(reintento.ok).toBe(true);
    expect(reintento.catalogos.every((c) => c.ok)).toBe(true);
  });

  it('un éxito limpia el contador del catálogo: un hipo aislado no acerca la apertura', async () => {
    const { sincronizarCatalogos } = await servicioLimpio();

    // Fallo, éxito, fallo, éxito… ocho fallos en total, pero nunca cinco seguidos.
    for (let i = 0; i < 4; i++) {
      rutasCaidas = new Set([RUTAS.tax]);
      await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined });
      rutasCaidas = new Set();
      const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined });
      expect(r.catalogos[0]!.ok, `la iteración ${i} debió recuperarse`).toBe(true);
    }
  });
});
