// HU #11281 — sincronización y caché de los catálogos de Siigo (Feature #11239).
//
// Un test por criterio de aceptación. Lo que se prueba aquí no es «que se guarden filas», sino las
// cuatro propiedades que hacen que esta caché sea confiable:
//
//   · que la sincronización se autolimite antes de que Siigo tenga que bloquearnos,
//   · que la parametrización lea de local y no vuelva a salir a la red,
//   · que nada se borre nunca —una parametrización antigua tiene que seguir siendo explicable—,
//   · y que un catálogo caído no arrastre a los otros cinco.
//
// El cliente HTTP, el limitador de tasa y el traductor de errores van SIN mockear: lo que se mockea
// es `fetch` y la base. Así el test recorre el mismo camino que producción, incluidas las cabeceras
// y la traducción del error de Siigo.
//
// El cortacircuitos sí se sustituye por una versión con estado reiniciable: su lógica propia ya está
// cubierta en `siigo-resiliencia.test.ts` (HU #11249), y su estado global —que no expone reset—
// filtraría entre tests de este archivo y haría fallar al siguiente por culpa del anterior.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import { paramsDe } from '../helpers/espia-drizzle.js';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'real' as 'mock' | 'real',
  SIIGO_MOCK_ERROR_RATE: 0,
  SIIGO_MOCK_TIMEOUT_RATE: 0,
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

const registrarOperacionMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: registrarOperacionMock,
}));

// Cortacircuitos reiniciable. Registra por qué clave pasó cada operación — que es justo lo que AC2
// exige comprobar— y permite forzarlo abierto sin depender de acumular cinco fallos reales.
//
// El rechazo usa la clase REAL `CircuitoAbiertoError`: lo que se prueba abajo es que el servicio la
// traduce a un mensaje operativo, y con un `Error` genérico de mentira el test pasaría sin ejercer
// esa traducción. El comportamiento acumulativo del cortacircuitos de verdad —umbral, ventana de
// reapertura y aislamiento entre claves— se ejerce sin mock en
// `siigo-catalogos-cortacircuitos.test.ts`.
const cbClaves: string[] = [];
let cbAbierto = false;
vi.mock('../../src/services/circuitBreaker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/circuitBreaker.js')>();
  return {
    ...actual,
    withCircuitBreaker: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      cbClaves.push(name);
      if (cbAbierto) throw new actual.CircuitoAbiertoError(name);
      return fn();
    },
  };
});

const selectMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: transactionMock, execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

const {
  sincronizarCatalogos, leerCatalogo, resumenCatalogos, claveResiliencia, claveCortacircuitos,
  rutaDeCatalogo,
} = await import('../../src/modules/siigo/siigo.catalogos.service.js');
const { reiniciarLimitador, peticionesEnVentana, MAX_PETICIONES_POR_VENTANA } =
  await import('../../src/modules/siigo/siigo.resiliencia.js');
const { CATALOGOS_SIMULADOS } = await import('../../src/modules/siigo/siigo.mock.js');

// ── Respuestas de Siigo por ruta (modo real) ────────────────────────────────

const CATALOGOS_REALES: Record<string, unknown[]> = {
  '/v1/document-types?type=FV': [
    {
      id: 24446, code: '1', name: 'Factura de venta', description: 'Factura electrónica',
      type: 'FV', active: true, cost_center: true, cost_center_mandatory: true,
      automatic_number: true, consecutive: 3, decimals: true, electronic_type: 'ElectronicInvoice',
    },
  ],
  '/v1/users': [
    {
      id: 35071, username: 'ventas@ejemplo.test', first_name: 'Ana', last_name: 'Ramírez',
      email: 'ventas@ejemplo.test', active: true, identification: '1000000001',
    },
    {
      id: 35072, username: 'baja@ejemplo.test', first_name: 'Diana', last_name: 'Osorio',
      email: 'baja@ejemplo.test', active: false, identification: '1000000002',
    },
  ],
  '/v1/payment-types?document_type=FV': [
    { id: 5636, name: 'Contado', type: 'Cartera', active: true, due_date: false },
    { id: 5637, name: 'Crédito 30 días', type: 'Cartera', active: true, due_date: true },
  ],
  '/v1/taxes': [
    { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true },
  ],
  '/v1/account-groups': [
    { id: 1253, name: 'Servicios de trámites', active: true },
  ],
  '/v1/cost-centers': [
    { id: 25732, code: '13-1', name: 'Principal', active: true },
  ],
};

const TODAS_LAS_RUTAS = Object.keys(CATALOGOS_REALES);

const fetchMock = vi.fn();

/** Respuesta con la interfaz mínima que consume el cliente HTTP. */
function respuestaHttp(status: number, datos: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => datos };
}

/** Fallos inyectados por ruta, para el aislamiento de AC5. */
let fallosPorRuta: Record<string, { status: number; datos: unknown }> = {};

function rutaDe(url: string): string {
  return url.replace(envMock.SIIGO_BASE_URL, '');
}

// ── Espías de escritura ─────────────────────────────────────────────────────

interface Upsert { valores: Record<string, unknown>[] }
let upserts: Upsert[] = [];
let inactivacionesSet: Record<string, unknown>[] = [];
/** Filas que el UPDATE de inactivación devuelve; controla el conteo `inactivados`. */
let filasInactivadas: unknown[] = [];
let huboDelete = false;
/** Valores enlazados de los `where`, que es donde vive el filtro por ambiente. */
let filtrosInactivacion: string[] = [];
let filtrosSelect: string[] = [];

function txFalso() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>[]) => {
        upserts.push({ valores: v });
        return { onConflictDoUpdate: () => Promise.resolve([]) };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        inactivacionesSet.push(s);
        return {
          // El `where` no se descarta: es lo único que dice a qué ambiente alcanza la baja masiva.
          where: (cond: unknown) => {
            filtrosInactivacion.push(...paramsDe(cond));
            return { returning: () => Promise.resolve(filasInactivadas) };
          },
        };
      },
    }),
    // La tabla no se borra NUNCA (AC4). Si el servicio lo intentara, el test lo delata.
    delete: () => { huboDelete = true; throw new Error('siigo_catalogos no admite DELETE'); },
  };
}

/** `chain()` que además registra los valores enlazados del `where`. */
function chainEspia(filas: unknown[]) {
  const c = chain(filas) as unknown as Record<string, unknown>;
  const original = c.where as (v: unknown) => unknown;
  c.where = (cond: unknown) => { filtrosSelect.push(...paramsDe(cond)); return original(cond); };
  return c;
}

function filtrosDeInactivacion(): string[] { return filtrosInactivacion; }
function filtrosDeSelect(): string[] { return filtrosSelect; }

/** Todas las filas escritas para un catálogo. */
function filasDe(tipo: string): Record<string, unknown>[] {
  return upserts.flatMap((u) => u.valores).filter((v) => v.tipo === tipo);
}

beforeEach(() => {
  fetchMock.mockReset();
  obtenerTokenMock.mockReset();
  registrarOperacionMock.mockReset();
  selectMock.mockReset();
  transactionMock.mockReset();
  reiniciarLimitador();

  cbClaves.length = 0;
  cbAbierto = false;
  upserts = [];
  inactivacionesSet = [];
  filasInactivadas = [];
  huboDelete = false;
  filtrosInactivacion = [];
  filtrosSelect = [];
  fallosPorRuta = {};

  envMock.SIIGO_MODE = 'real';
  envMock.SIIGO_PARTNER_ID = 'FlitoIntegracion';

  obtenerTokenMock.mockResolvedValue('Bearer token-simulado');
  registrarOperacionMock.mockResolvedValue(undefined);
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txFalso()));

  fetchMock.mockImplementation(async (url: string) => {
    const ruta = rutaDe(url);
    const fallo = fallosPorRuta[ruta];
    if (fallo) return respuestaHttp(fallo.status, fallo.datos);
    return respuestaHttp(200, CATALOGOS_REALES[ruta] ?? []);
  });
  vi.stubGlobal('fetch', fetchMock);
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC1 — sincronización completa', () => {
  it('consulta los seis catálogos, cada uno en su ruta documentada', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    const rutas = fetchMock.mock.calls.map((c) => rutaDe(c[0] as string));
    expect(rutas).toHaveLength(6);
    expect(rutas).toEqual(expect.arrayContaining(TODAS_LAS_RUTAS));
  });

  it('los seis tipos tienen ruta declarada, incluido el centro de costo', () => {
    expect(rutaDeCatalogo('document_type')).toBe('/v1/document-types?type=FV');
    expect(rutaDeCatalogo('user')).toBe('/v1/users');
    expect(rutaDeCatalogo('payment_type')).toBe('/v1/payment-types?document_type=FV');
    expect(rutaDeCatalogo('tax')).toBe('/v1/taxes');
    expect(rutaDeCatalogo('account_group')).toBe('/v1/account-groups');
    expect(rutaDeCatalogo('cost_center')).toBe('/v1/cost-centers');
  });

  it('guarda identificador, nombre, estado activo y fecha de sincronización', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    const [impuesto] = filasDe('tax');
    expect(impuesto).toMatchObject({
      tipo: 'tax', codigo: '13156', nombre: 'IVA 19%', activo: true,
    });
    expect(impuesto!.sincronizadoEn).toBeInstanceOf(Date);
  });

  it('el resultado indica cuántos elementos se trajeron por catálogo', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(r.ok).toBe(true);
    expect(r.parcial).toBe(false);
    const porTipo = Object.fromEntries(r.catalogos.map((c) => [c.tipo, c.total]));
    expect(porTipo).toEqual({
      document_type: 1, user: 2, payment_type: 2, tax: 1, account_group: 1, cost_center: 1,
    });
  });

  it('cada llamada queda registrada en la bitácora de operaciones', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas', usuarioId: 7 });

    const registros = registrarOperacionMock.mock.calls.map((c) => c[0]);
    expect(registros).toHaveLength(6);
    expect(registros[0]).toMatchObject({
      operacion: 'sync_catalogo', entidadTipo: 'catalogo', resultado: 'ok',
      ambiente: 'pruebas', modo: 'real', statusHttp: 200, createdBy: 7,
    });
    expect(registros.map((r) => r.entidadId).sort()).toEqual([
      'account_group', 'cost_center', 'document_type', 'payment_type', 'tax', 'user',
    ]);
  });

  it('normaliza los atributos propios de cada catálogo', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(filasDe('document_type')[0]!.atributos).toMatchObject({
      centroCostoObligatorio: true, manejaCentroCosto: true, tipoElectronico: 'ElectronicInvoice',
    });
    const credito = filasDe('payment_type').find((f) => f.codigo === '5637');
    expect(credito!.atributos).toMatchObject({ manejaVencimiento: true });
    expect(filasDe('tax')[0]!.atributos).toMatchObject({ tipo: 'IVA', porcentaje: 19 });
    expect(filasDe('cost_center')[0]!.atributos).toMatchObject({ code: '13-1' });
  });

  it('del catálogo de vendedores no persiste cédula ni correo (Ley 1581)', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    const vendedores = filasDe('user');
    expect(vendedores[0]).toMatchObject({ codigo: '35071', nombre: 'Ana Ramírez' });
    const serializado = JSON.stringify(vendedores);
    expect(serializado).not.toContain('1000000001');
    expect(serializado).not.toContain('ventas@ejemplo.test');
  });

  it('permite sincronizar un subconjunto sin gastar cuota en los demás', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rutaDe(fetchMock.mock.calls[0]![0] as string)).toBe('/v1/taxes');
    expect(r.catalogos.map((c) => c.tipo)).toEqual(['tax']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bordes de la normalización. Baratos de cubrir y caros de descubrir en producción: los tres
// terminan en una fila que la parametrización no puede usar o en un catálogo entero perdido.
describe('bordes de la respuesta de Siigo', () => {
  it('un elemento sin `id` se descarta en vez de guardarse con código vacío', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (rutaDe(url) === '/v1/taxes') {
        return respuestaHttp(200, [
          { name: 'Impuesto sin identificador', type: 'IVA', percentage: 19, active: true },
          { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true },
        ]);
      }
      return respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? []);
    });

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    // Una fila sin código no se puede referenciar desde una parametrización: no sirve para nada.
    expect(r.catalogos[0]!.total).toBe(1);
    expect(filasDe('tax').map((f) => f.codigo)).toEqual(['13156']);
    // Y descartarla no invalida el resto del catálogo.
    expect(r.catalogos[0]!.ok).toBe(true);
  });

  it('un elemento cuyo `id` es solo espacios también se descarta', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/taxes'
        ? respuestaHttp(200, [{ id: '   ', name: 'Vacío', active: true }])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.total).toBe(0);
    expect(filasDe('tax')).toEqual([]);
  });

  it('un código repetido en la respuesta no rompe el INSERT: gana la última aparición', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/taxes'
        ? respuestaHttp(200, [
          { id: 13156, name: 'IVA 19% (antiguo)', type: 'IVA', percentage: 19, active: true },
          { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true },
        ])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    // El índice único rechazaría el INSERT entero si el duplicado llegara a la sentencia: un
    // catálogo perdido por un duplicado de Siigo sería un fallo nuestro.
    expect(r.catalogos[0]!.total).toBe(1);
    const filas = filasDe('tax');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ codigo: '13156', nombre: 'IVA 19%' });
  });

  it('un id numérico y el mismo id en texto son el mismo elemento, no dos', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      rutaDe(url) === '/v1/taxes'
        ? respuestaHttp(200, [
          { id: 13156, name: 'IVA numérico', active: true },
          { id: '13156', name: 'IVA texto', active: true },
        ])
        : respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? [])
    ));

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.total).toBe(1);
    expect(filasDe('tax')[0]).toMatchObject({ codigo: '13156', nombre: 'IVA texto' });
  });

  it('los elementos se devuelven ordenados por nombre, no por el orden de Siigo', async () => {
    // La base ordena (`ORDER BY nombre ASC`, cubierto en siigo-catalogos-sql.test.ts). Aquí se
    // comprueba que la lectura RESPETA ese orden en vez de reordenar por su cuenta al filtrar.
    selectMock.mockReturnValue(chain([
      { codigo: '3', nombre: 'Anticipo', descripcion: null, activo: true, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
      { codigo: '1', nombre: 'Contado', descripcion: null, activo: false, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
      { codigo: '2', nombre: 'Crédito 30 días', descripcion: null, activo: true, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
    ]));

    const r = await leerCatalogo('payment_type', { incluirInactivos: true });

    expect(r.elementos.map((e) => e.nombre)).toEqual(['Anticipo', 'Contado', 'Crédito 30 días']);
  });

  it('descartar los inactivos no altera el orden de los que quedan', async () => {
    selectMock.mockReturnValue(chain([
      { codigo: '3', nombre: 'Anticipo', descripcion: null, activo: true, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
      { codigo: '1', nombre: 'Contado', descripcion: null, activo: false, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
      { codigo: '2', nombre: 'Crédito 30 días', descripcion: null, activo: true, atributos: null, sincronizadoEn: new Date('2026-08-05T10:00:00.000Z') },
    ]));

    const r = await leerCatalogo('payment_type');

    expect(r.elementos.map((e) => e.nombre)).toEqual(['Anticipo', 'Crédito 30 días']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC2 — la sincronización se autolimita', () => {
  it('las seis peticiones pasan por el control de tasa bajo UNA sola clave', async () => {
    const ahora = () => 1_000_000;
    await sincronizarCatalogos({ ambiente: 'pruebas', ahora });

    // Una clave por catálogo permitiría 600 peticiones por minuto creyendo que respeta 100.
    expect(peticionesEnVentana(claveResiliencia('pruebas'), ahora)).toBe(6);
    expect(peticionesEnVentana(claveResiliencia('produccion'), ahora)).toBe(0);
  });

  it('todas las peticiones pasan por el cortacircuitos, cada catálogo por el SUYO', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(cbClaves).toHaveLength(6);
    // BUG-A/BUG-B: seis circuitos distintos, no uno compartido. El limitador sigue con clave única
    // (test anterior) porque la cuota es de la empresa; la salud es de cada endpoint.
    expect(new Set(cbClaves)).toEqual(new Set([
      'siigo:catalogos:pruebas:document_type',
      'siigo:catalogos:pruebas:user',
      'siigo:catalogos:pruebas:payment_type',
      'siigo:catalogos:pruebas:tax',
      'siigo:catalogos:pruebas:account_group',
      'siigo:catalogos:pruebas:cost_center',
    ]));
  });

  it('el circuito de un catálogo lleva su ambiente: pruebas y producción no se comparten', () => {
    expect(claveCortacircuitos('pruebas', 'tax')).toBe('siigo:catalogos:pruebas:tax');
    expect(claveCortacircuitos('produccion', 'tax')).toBe('siigo:catalogos:produccion:tax');
    // …mientras que la cuota sí es del ambiente entero.
    expect(claveResiliencia('produccion')).toBe('catalogos:produccion');
  });

  it('un uso repetido no agota la cuota de 100 por minuto: el excedente espera', async () => {
    let reloj = 1_000_000;
    const dormir = vi.fn(async (ms: number) => { reloj += ms; });
    const ahora = () => reloj;

    // 17 sincronizaciones × 6 catálogos = 102 peticiones, dos por encima del tope de la ventana.
    for (let i = 0; i < 17; i++) {
      await sincronizarCatalogos({ ambiente: 'pruebas', dormir, ahora });
    }

    // Nada se descartó: las 102 salieron. Una petición que se cae de la cola es una sincronización
    // silenciosamente incompleta.
    expect(fetchMock).toHaveBeenCalledTimes(102);
    // Y el excedente esperó a que se liberara cupo en vez de saltarse el límite.
    expect(dormir).toHaveBeenCalled();
    expect(Math.max(...dormir.mock.calls.map((c) => c[0]))).toBeGreaterThan(50_000);
    expect(peticionesEnVentana(claveResiliencia('pruebas'), ahora))
      .toBeLessThanOrEqual(MAX_PETICIONES_POR_VENTANA);
  });

  it('con el cortacircuitos abierto el catálogo falla, pero no lanza', async () => {
    cbAbierto = true;

    const r = await sincronizarCatalogos({
      ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined,
    });

    expect(r.ok).toBe(false);
    expect(r.catalogos[0]!.error?.codigo).toBe('servicio_no_disponible');
    // El cortacircuitos existe para NO llamar: si hubiera salido a la red, no serviría de nada.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el circuito abierto se explica sin filtrar la clave interna del cortacircuitos', async () => {
    cbAbierto = true;

    const r = await sincronizarCatalogos({
      ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined,
    });

    const mensaje = r.catalogos[0]!.error!.mensaje;
    // Lo que llegaba antes: «…Servicio siigo:catalogos:pruebas temporalmente no disponible».
    expect(mensaje).not.toMatch(/siigo:catalogos/);
    expect(mensaje).not.toMatch(/Servicio siigo/);
    // Y lo que tiene que llegar: qué pasó, qué hacer y que los demás siguen sanos.
    expect(mensaje).toMatch(/fallos seguidos/);
    expect(mensaje).toMatch(/intentarlo/);
    // Tampoco por la bitácora, que la lee el mismo operador.
    const registrado = registrarOperacionMock.mock.calls.map((c) => c[0].mensaje).join(' ');
    expect(registrado).not.toMatch(/siigo:catalogos/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC3 — lectura desde la copia local', () => {
  const FECHA = new Date('2026-08-05T10:00:00.000Z');

  function filaLocal(over: Record<string, unknown> = {}) {
    return {
      codigo: '5636', nombre: 'Contado', descripcion: null, activo: true,
      atributos: { manejaVencimiento: false }, sincronizadoEn: FECHA, ...over,
    };
  }

  it('obtiene los elementos sin llamar a Siigo', async () => {
    selectMock.mockReturnValue(chain([filaLocal()]));

    const r = await leerCatalogo('payment_type');

    expect(r.elementos).toHaveLength(1);
    expect(r.elementos[0]).toMatchObject({ codigo: '5636', nombre: 'Contado', activo: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(obtenerTokenMock).not.toHaveBeenCalled();
  });

  it('la respuesta indica cuándo fue la última sincronización de ese catálogo', async () => {
    selectMock.mockReturnValue(chain([
      filaLocal({ sincronizadoEn: new Date('2026-08-01T00:00:00.000Z') }),
      filaLocal({ codigo: '5637', nombre: 'Crédito', sincronizadoEn: FECHA }),
    ]));

    const r = await leerCatalogo('payment_type');

    expect(r.sincronizadoEn).toBe(FECHA.toISOString());
    expect(r.etiqueta).toBe('Formas de pago');
  });

  it('un catálogo nunca sincronizado responde vacío y sin fecha, no un error', async () => {
    selectMock.mockReturnValue(chain([]));

    const r = await leerCatalogo('cost_center');

    expect(r.elementos).toEqual([]);
    expect(r.sincronizadoEn).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el resumen lista los seis catálogos aunque nunca se hayan traído', async () => {
    selectMock.mockReturnValue(chain([
      { tipo: 'tax', total: 4, activos: 3, sincronizadoEn: FECHA },
    ]));

    const r = await resumenCatalogos();

    expect(r).toHaveLength(6);
    expect(r.find((c) => c.tipo === 'tax')).toMatchObject({
      total: 4, activos: 3, sincronizadoEn: FECHA.toISOString(), etiqueta: 'Impuestos',
    });
    expect(r.find((c) => c.tipo === 'user')).toMatchObject({
      total: 0, activos: 0, sincronizadoEn: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC4 — los elementos no se borran, se inactivan', () => {
  it('la sincronización nunca ejecuta un DELETE sobre el catálogo', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });
    expect(huboDelete).toBe(false);
  });

  it('lo que deja de venir se marca inactivo, conservando la fila', async () => {
    // El UPDATE de inactivación devuelve dos filas: dos elementos dejaron de venir.
    filasInactivadas = [{ id: 10 }, { id: 11 }];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.inactivados).toBe(2);
    expect(inactivacionesSet).toHaveLength(1);
    expect(inactivacionesSet[0]).toMatchObject({ activo: false });
    expect(inactivacionesSet[0]!.inactivadoEn).toBeDefined();
  });

  it('un elemento que viene marcado inactivo se guarda inactivo y con su fecha', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['user'] });

    const baja = filasDe('user').find((f) => f.codigo === '35072');
    expect(baja).toMatchObject({ activo: false });
    expect(baja!.inactivadoEn).toBeInstanceOf(Date);
    // El activo no arrastra fecha de inactivación.
    const alta = filasDe('user').find((f) => f.codigo === '35071');
    expect(alta).toMatchObject({ activo: true, inactivadoEn: null });
  });

  it('una respuesta vacía inactiva, pero tampoco borra', async () => {
    fallosPorRuta = {};
    fetchMock.mockImplementation(async () => respuestaHttp(200, []));
    filasInactivadas = [{ id: 1 }, { id: 2 }, { id: 3 }];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.total).toBe(0);
    expect(r.catalogos[0]!.inactivados).toBe(3);
    expect(huboDelete).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-C (Alto) — una sincronización que vacía los catálogos no puede reportarse como un éxito
// cualquiera. La inactivación es correcta y se mantiene: es lo que AC4 pide y es reversible. Lo que
// faltaba es que se anuncie, porque el caso indistinguible desde aquí —Siigo devolviendo listas
// vacías por un problema suyo— deja al operador con una pantalla verde y la parametrización
// desierta.
describe('BUG-C — el vaciado masivo se señala', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () => respuestaHttp(200, []));
  });

  it('un catálogo poblado que vuelve vacío queda marcado, aunque la sincronización sea exitosa', async () => {
    filasInactivadas = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    const tax = r.catalogos[0]!;
    expect(tax.ok).toBe(true);
    expect(tax.total).toBe(0);
    expect(tax.inactivados).toBe(4);
    expect(tax.vaciadoMasivo).toBe(true);
    // La inactivación NO se revierte: esconderla taparía una baja masiva legítima.
    expect(inactivacionesSet).toHaveLength(1);
  });

  it('el veredicto global lo refleja para que la pantalla pueda destacarlo', async () => {
    filasInactivadas = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas' });

    // Antes: ok=true, parcial=false, error=null y 24 elementos inactivados sin una sola señal.
    expect(r.ok).toBe(true);
    expect(r.parcial).toBe(false);
    expect(r.vaciadoMasivo).toBe(true);
    expect(r.catalogos.filter((c) => c.vaciadoMasivo)).toHaveLength(6);
  });

  it('un catálogo que ya estaba vacío no marca nada: no se perdió nada', async () => {
    filasInactivadas = [];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.vaciadoMasivo).toBe(false);
    expect(r.vaciadoMasivo).toBe(false);
  });

  it('una sincronización normal con bajas sueltas no es un vaciado', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      respuestaHttp(200, CATALOGOS_REALES[rutaDe(url)] ?? []));
    filasInactivadas = [{ id: 1 }];

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    expect(r.catalogos[0]!.inactivados).toBe(1);
    expect(r.catalogos[0]!.vaciadoMasivo).toBe(false);
    expect(r.vaciadoMasivo).toBe(false);
  });

  it('la bitácora lo dice con todas las letras, no solo con un contador', async () => {
    filasInactivadas = [{ id: 1 }, { id: 2 }];

    await sincronizarCatalogos({ ambiente: 'pruebas', tipos: ['tax'] });

    const registro = registrarOperacionMock.mock.calls[0]![0];
    expect(registro.resultado).toBe('ok');
    expect(registro.mensaje).toMatch(/VACÍO/);
    expect(registro.responseBody).toMatchObject({ total: 0, inactivados: 2, vaciadoMasivo: true });
  });

  it('un catálogo que falló no cuenta como vaciado: no se sabe qué hay al otro lado', async () => {
    fetchMock.mockImplementation(async () => respuestaHttp(503, {
      Status: 503, Errors: [{ Code: 'service_unavailable', Message: 'x', Params: [] }],
    }));

    const r = await sincronizarCatalogos({
      ambiente: 'pruebas', tipos: ['tax'], dormir: async () => undefined,
    });

    expect(r.catalogos[0]!.ok).toBe(false);
    expect(r.catalogos[0]!.vaciadoMasivo).toBe(false);
    expect(r.vaciadoMasivo).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// La copia local es POR AMBIENTE. `pruebas` y `produccion` son empresas distintas de Siigo, con
// identificadores distintos: sin este aislamiento, sincronizar producción pisa los códigos que
// coincidan e inactiva el resto del catálogo de pruebas «porque no vino».
describe('aislamiento por ambiente', () => {
  it('cada fila se escribe con el ambiente que se sincronizó', async () => {
    await sincronizarCatalogos({ ambiente: 'produccion' });

    const escritas = upserts.flatMap((u) => u.valores);
    expect(escritas.length).toBeGreaterThan(0);
    expect(escritas.every((f) => f.ambiente === 'produccion')).toBe(true);
  });

  it('sincronizar producción no toca las filas de pruebas', async () => {
    await sincronizarCatalogos({ ambiente: 'produccion', tipos: ['tax'] });

    // El upsert lleva ambiente…
    expect(filasDe('tax').every((f) => f.ambiente === 'produccion')).toBe(true);
    // …y la inactivación de «lo que no vino» está acotada al mismo ambiente.
    expect(filtrosDeInactivacion()).toContain('produccion');
  });

  it('el ambiente viaja en el resultado y en la bitácora', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'produccion', tipos: ['tax'] });

    expect(r.ambiente).toBe('produccion');
    expect(registrarOperacionMock.mock.calls[0]![0]).toMatchObject({ ambiente: 'produccion' });
  });

  it('la lectura filtra por ambiente y lo devuelve', async () => {
    selectMock.mockReturnValue(chainEspia([]));

    const r = await leerCatalogo('tax', { ambiente: 'produccion' });

    expect(r.ambiente).toBe('produccion');
    expect(filtrosDeSelect()).toContain('produccion');
  });

  it('sin ambiente explícito se lee el configurado en el servidor, no una mezcla', async () => {
    selectMock.mockReturnValue(chainEspia([]));

    const r = await leerCatalogo('tax');

    expect(r.ambiente).toBe('pruebas');
    expect(filtrosDeSelect()).toContain('pruebas');
  });

  it('el resumen también se calcula por ambiente', async () => {
    selectMock.mockReturnValue(chainEspia([]));

    const r = await resumenCatalogos({ ambiente: 'produccion' });

    expect(r.every((c) => c.ambiente === 'produccion')).toBe(true);
    expect(filtrosDeSelect()).toContain('produccion');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC4 (continuación) — los inactivos siguen consultables', () => {
  it('los inactivos siguen siendo consultables para explicar una parametrización antigua', async () => {
    const fila = {
      codigo: '25735', nombre: 'Sede cerrada', descripcion: '13-9', activo: false,
      atributos: null, sincronizadoEn: new Date('2026-07-01T00:00:00.000Z'),
    };
    selectMock.mockReturnValue(chain([fila]));

    const soloActivos = await leerCatalogo('cost_center');
    expect(soloActivos.elementos).toEqual([]);
    // Pero la fecha del catálogo se conserva: el catálogo SÍ se sincronizó.
    expect(soloActivos.sincronizadoEn).toBe(fila.sincronizadoEn.toISOString());

    selectMock.mockReturnValue(chain([fila]));
    const conInactivos = await leerCatalogo('cost_center', { incluirInactivos: true });
    expect(conInactivos.elementos).toHaveLength(1);
    expect(conInactivos.elementos[0]).toMatchObject({ codigo: '25735', activo: false });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC5 — un catálogo caído no arrastra a los demás', () => {
  const FALLO_IMPUESTOS = {
    status: 503,
    datos: {
      Status: 503,
      Errors: [{ Code: 'service_unavailable', Message: 'Service unavailable', Params: [] }],
    },
  };

  it('los catálogos que respondieron quedan actualizados', async () => {
    fallosPorRuta = { '/v1/taxes': FALLO_IMPUESTOS };

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    const ok = r.catalogos.filter((c) => c.ok).map((c) => c.tipo).sort();
    expect(ok).toEqual(['account_group', 'cost_center', 'document_type', 'payment_type', 'user']);
    expect(r.parcial).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('el que falló no escribe nada: conserva íntegra su copia anterior', async () => {
    fallosPorRuta = { '/v1/taxes': FALLO_IMPUESTOS };

    await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    expect(filasDe('tax')).toEqual([]);
    expect(filasDe('user').length).toBeGreaterThan(0);
  });

  it('el resultado señala cuál falló y con qué causa traducida', async () => {
    fallosPorRuta = { '/v1/taxes': FALLO_IMPUESTOS };

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    const impuestos = r.catalogos.find((c) => c.tipo === 'tax')!;
    expect(impuestos.ok).toBe(false);
    expect(impuestos.total).toBe(0);
    expect(impuestos.error).toEqual({
      codigo: 'service_unavailable',
      // Texto operativo del traductor, no el mensaje crudo en inglés de Siigo.
      mensaje: 'Siigo no está disponible en este momento. Se puede reintentar.',
    });
    expect(impuestos.etiqueta).toBe('Impuestos');
  });

  it('el fallo queda en la bitácora con su código y sin tumbar el registro de los demás', async () => {
    fallosPorRuta = { '/v1/taxes': FALLO_IMPUESTOS };

    await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    const registros = registrarOperacionMock.mock.calls.map((c) => c[0]);
    expect(registros).toHaveLength(6);
    const impuestos = registros.find((r) => r.entidadId === 'tax')!;
    expect(impuestos).toMatchObject({
      operacion: 'sync_catalogo', resultado: 'error_tecnico',
      codigo: 'service_unavailable', statusHttp: 503,
    });
  });

  it('una respuesta con forma inesperada falla solo ese catálogo', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const ruta = rutaDe(url);
      if (ruta === '/v1/account-groups') return respuestaHttp(200, { mensaje: 'no es una lista' });
      return respuestaHttp(200, CATALOGOS_REALES[ruta] ?? []);
    });

    const r = await sincronizarCatalogos({ ambiente: 'pruebas', dormir: async () => undefined });

    const grupos = r.catalogos.find((c) => c.tipo === 'account_group')!;
    expect(grupos.ok).toBe(false);
    expect(grupos.error?.codigo).toBe('respuesta_inesperada');
    expect(r.catalogos.filter((c) => c.ok)).toHaveLength(5);
  });

  it('sin Partner-Id no sale ninguna petición: los seis fallan por la misma causa', async () => {
    envMock.SIIGO_PARTNER_ID = '';

    const r = await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.parcial).toBe(false);
    expect(r.catalogos.every((c) => c.error?.codigo === 'sin_configuracion')).toBe(true);
    expect(r.catalogos[0]!.error?.mensaje).toMatch(/SIIGO_PARTNER_ID/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AC6 — el modo simulado devuelve catálogos utilizables', () => {
  beforeEach(() => { envMock.SIIGO_MODE = 'mock'; });

  it('los seis catálogos traen elementos, no listas vacías', async () => {
    const r = await sincronizarCatalogos({ ambiente: 'pruebas' });

    expect(r.ok).toBe(true);
    for (const c of r.catalogos) {
      expect(c.total, `el catálogo ${c.tipo} vino vacío`).toBeGreaterThan(0);
    }
    // Modo simulado: ni token ni red.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alcanzan para configurar la parametrización completa', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    // Un comprobante FV electrónico con el que emitir.
    const comprobantes = filasDe('document_type');
    expect(comprobantes.some((c) => c.activo
      && (c.atributos as Record<string, unknown>).tipoElectronico === 'ElectronicInvoice')).toBe(true);
    // Un comprobante que exige centro de costo, para poder validar esa regla sin ambiente real.
    expect(comprobantes.some((c) =>
      (c.atributos as Record<string, unknown>).centroCostoObligatorio === true)).toBe(true);
    // Un vendedor activo al que asignar la factura.
    expect(filasDe('user').some((u) => u.activo)).toBe(true);
    // Contado y crédito con vencimiento: las dos ramas de la validación de formas de pago.
    const pagos = filasDe('payment_type');
    expect(pagos.some((p) => (p.atributos as Record<string, unknown>).manejaVencimiento === false)).toBe(true);
    expect(pagos.some((p) => (p.atributos as Record<string, unknown>).manejaVencimiento === true)).toBe(true);
    // IVA con tarifa, grupo de inventario y centro de costo.
    expect(filasDe('tax').some((t) => (t.atributos as Record<string, unknown>).porcentaje === 19)).toBe(true);
    expect(filasDe('account_group').some((g) => g.activo)).toBe(true);
    expect(filasDe('cost_center').some((c) => c.activo)).toBe(true);
  });

  it('cada catálogo simulado trae al menos un elemento inactivo', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    for (const tipo of ['document_type', 'user', 'payment_type', 'tax', 'account_group', 'cost_center']) {
      expect(filasDe(tipo).some((f) => f.activo === false), `${tipo} no trae inactivos`).toBe(true);
    }
  });

  it('el simulador honra el filtro ?type=FV de los tipos de comprobante', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    const fv = respuestaSimulada('GET', '/v1/document-types?type=FV').datos as unknown[];
    const fc = respuestaSimulada('GET', '/v1/document-types?type=FC').datos as unknown[];

    expect(fv.length).toBe(CATALOGOS_SIMULADOS['document-types']!.length);
    expect(fc).toEqual([]);
  });

  it('el simulador no expone datos de personas reales', async () => {
    await sincronizarCatalogos({ ambiente: 'pruebas' });

    // Los correos de las fixtures son del dominio reservado `.test` (RFC 2606) y la cédula ficticia
    // no llega nunca a la base, igual que en modo real.
    const serializado = JSON.stringify(filasDe('user'));
    expect(serializado).not.toContain('@ejemplo.test');
    expect(serializado).not.toMatch(/10000000\d/);
  });
});
