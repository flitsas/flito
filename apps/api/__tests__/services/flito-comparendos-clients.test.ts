// FLITO comparendos — adapters de Verifik SIMIT y UTS municipal (HU #11499, Feature #11492 17a).
//
// Lo que se demuestra aquí, por orden de importancia:
//
//   1. **El token no se escapa.** No aparece en el mensaje de ningún error, ni en ninguna línea de
//      log, ni siquiera cuando el fallo viene de la capa de red y trae texto arbitrario dentro. La
//      credencial de prueba es una cadena única y se busca literalmente en TODO lo que los adapters
//      producen.
//   2. `mock` no toca la red y no exige ni base URL ni token (AC1/AC2). `setup.ts` no define las
//      dos variables de host a propósito: si el modo simulado las necesitara, estos tests fallarían.
//   3. En `real`, la petición sale bien formada —método, URL, parámetros y cabeceras— y con el
//      techo de tiempo del módulo, no con el de la librería (ADR-0001 §7). Las DOS fuentes son GET:
//      Verifik recibe `documentType`/`documentNumber` como parámetros de BÚSQUEDA (contrato del
//      proveedor, corregido el 2026-08-18) y el UTS recibe `fuente`/`nit` en su ruta completa
//      `/infraction/api/Infraccion/ConsultarInfraccionFuente`.
//   4. Timeout, HTTP no-OK, red caída y cuerpo ilegible salen como errores TIPADOS con `codigo` y
//      `httpStatus`, que son las dos columnas que el `sync_run_step` de la HU #11500 va a escribir.
//
// `integraciones/http.js` está mockeado entero: es la frontera con la red y mockearla es lo que
// hace que estos tests no dependan de nadie. El servicio del token también, para poder inyectar un
// valor conocido y para no arrastrar `db/client` a un archivo que no consulta la base.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Redacted } from '../../src/shared/utils/crypto.js';

// Cadena con una pinta imposible de confundir: cualquier aparición suya en un log o en un mensaje
// de error es, por construcción, una filtración de la credencial.
const TOKEN = 'TOKEN-SIMIT-QUE-NO-DEBE-APARECER-JAMAS-9f3a1c';
const NIT = '900123456';

const httpsJsonMock = vi.fn();
const httpsGetJsonMock = vi.fn();
vi.mock('../../src/modules/integraciones/http.js', () => ({
  httpsJson: (...args: unknown[]) => httpsJsonMock(...args),
  httpsGetJson: (...args: unknown[]) => httpsGetJsonMock(...args),
  httpsFormPost: vi.fn(),
}));

const obtenerTokenSimitMock = vi.fn(async () => new Redacted(TOKEN));
vi.mock('../../src/modules/flito-comparendos/flito-comparendos.token.service.js', () => ({
  obtenerTokenSimit: () => obtenerTokenSimitMock(),
}));

/** Todo lo que los adapters registran, tal cual, para poder buscarle el token dentro. */
const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({
  logger: loggerFalso,
  loggerFor: () => loggerFalso,
}));

const { consultarComparendosSimit } =
  await import('../../src/modules/flito-comparendos/clients/verifik-simit.client.js');
const { consultarComparendosMunicipales, reiniciarAvisoTextoPlano } =
  await import('../../src/modules/flito-comparendos/clients/uts-municipal.client.js');
const { env } = await import('../../src/config/env.js');

// `env` es una foto validada en el import, pero es un objeto normal: mutarlo es la forma en que el
// resto de la suite (ver `flito-comparendos-token.test.ts`) ejerce otros valores de entorno.
type EnvMutable = {
  COMPARENDOS_SIMIT_MODE: 'mock' | 'real';
  VERIFIK_SIMIT_BASE_URL?: string;
  UTS_MUNICIPAL_BASE_URL?: string;
  COMPARENDOS_HTTP_TIMEOUT_MS: number;
};
const entorno = env as unknown as EnvMutable;
const original = { ...entorno };

/** Pone el módulo en modo real con hosts de prueba. Devuelve los que quedaron puestos. */
function modoReal(verifik = 'https://verifik.test', uts = 'https://uts.test'): void {
  entorno.COMPARENDOS_SIMIT_MODE = 'real';
  entorno.VERIFIK_SIMIT_BASE_URL = verifik;
  entorno.UTS_MUNICIPAL_BASE_URL = uts;
}

/** Texto de todo lo logueado, para las aserciones de «esto no aparece en ningún sitio». */
const logueado = () => JSON.stringify(registros);

beforeEach(() => {
  httpsJsonMock.mockReset();
  httpsGetJsonMock.mockReset();
  obtenerTokenSimitMock.mockClear();
  obtenerTokenSimitMock.mockImplementation(async () => new Redacted(TOKEN));
  registros.length = 0;
  Object.assign(entorno, original);
});

afterEach(() => {
  Object.assign(entorno, original);
});

// ─────────────────────────────── AC1/AC2 · Modo mock ────────────────────────────────────────────

describe('modo mock: no hay red, no hay credenciales', () => {
  it('Verifik devuelve una lista tipada sin llamar a la red', async () => {
    const r = await consultarComparendosSimit(NIT);

    expect(r.modo).toBe('mock');
    expect(r.origen).toBe('simit');
    expect(r.fuente).toBe('simit');
    // `null` y no 200: en mock no hubo petición que responder, y fingir un código haría que el
    // `sync_run_step` de una corrida simulada fuera indistinguible del de una real.
    expect(r.httpStatus).toBeNull();
    expect(r.items).toHaveLength(2);
    expect(r.items[0].numeroComparendo).toBe(`MOCK-SIMIT-${NIT}-0001`);
    expect(httpsJsonMock).not.toHaveBeenCalled();
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('el mock de Verifik no exige token: un entorno sin credenciales puede ejercer el módulo', async () => {
    await consultarComparendosSimit(NIT);

    expect(obtenerTokenSimitMock).not.toHaveBeenCalled();
  });

  it('el mock no exige base URL (setup.ts no define ninguna de las dos)', async () => {
    // Si los adapters pidieran host en mock, esto reventaría: la comprobación es real, no retórica.
    expect(entorno.VERIFIK_SIMIT_BASE_URL).toBeUndefined();
    expect(entorno.UTS_MUNICIPAL_BASE_URL).toBeUndefined();

    await expect(consultarComparendosSimit(NIT)).resolves.toBeDefined();
    await expect(consultarComparendosMunicipales(NIT, 'BELLO')).resolves.toBeDefined();
  });

  it('el UTS devuelve un payload municipal marcado con el municipio consultado', async () => {
    const r = await consultarComparendosMunicipales(NIT, 'BELLO');

    expect(r.modo).toBe('mock');
    expect(r.origen).toBe('municipal');
    expect(r.fuente).toBe('BELLO');
    expect(r.items).toHaveLength(2);
    expect(r.items[1].numero).toBe(`MOCK-BELLO-${NIT}-0003`);
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('los dos mocks comparten un número de comparendo, con el hueco que el merge debe rellenar', async () => {
    const simit = await consultarComparendosSimit(NIT);
    const municipal = await consultarComparendosMunicipales(NIT, 'BELLO');

    // El caso que la HU #11500 tiene que resolver: mismo comparendo visto por las dos fuentes
    // (CF-07) y un campo que solo trae el municipal (CF-08). Sin este solape, el merge no tendría
    // nada que hacer en modo mock y la simulación no serviría para probarlo.
    const compartido = `MOCK-COMPARTIDO-${NIT}-0002`;
    expect(simit.items[1].numeroComparendo).toBe(compartido);
    expect(simit.items[1].descripcionInfraccion).toBeUndefined();
    expect(municipal.items[0].numero).toBe(compartido);
    expect(municipal.items[0].descripcion).toBeTruthy();
  });

  it('el mock es determinista: dos llamadas iguales devuelven exactamente lo mismo', async () => {
    const a = await consultarComparendosSimit(NIT);
    const b = await consultarComparendosSimit(NIT);

    expect(b.items).toEqual(a.items);
  });
});

// ─────────────────────────────── AC1 · Verifik en modo real ─────────────────────────────────────

describe('Verifik en modo real: la petición que sale', () => {
  beforeEach(() => {
    modoReal();
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [{ numeroComparendo: 'A-1' }] } });
  });

  it('GET a /v2/co/simit/consultar con documentType y documentNumber como parámetros', async () => {
    const r = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    // GET y con los dos valores en la QUERY: es el contrato de Verifik. La versión anterior de
    // este módulo mandaba un POST con los dos en el cuerpo, que el proveedor no lee.
    const url = new URL(String(httpsGetJsonMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://verifik.test/v2/co/simit/consultar');
    expect(url.searchParams.get('documentType')).toBe('NIT');
    expect(url.searchParams.get('documentNumber')).toBe(NIT);
    // Y nada de cuerpo: `httpsGetJson` no lo admite, así que no hay dónde esconderlo.
    expect(httpsJsonMock).not.toHaveBeenCalled();
    expect(r.httpStatus).toBe(200);
    expect(r.modo).toBe('real');
    expect(r.items).toEqual([{ numeroComparendo: 'A-1' }]);
  });

  it('manda el Bearer con el token inyectado', async () => {
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const cabeceras = httpsGetJsonMock.mock.calls[0][1] as Record<string, string>;
    expect(cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
    // Y el token inyectado se usa tal cual: no se vuelve a pedir a la base una vez por NIT.
    expect(obtenerTokenSimitMock).not.toHaveBeenCalled();
  });

  it('si no se le inyecta, lo pide al servicio del token (nunca a una variable suelta)', async () => {
    await consultarComparendosSimit(NIT);

    expect(obtenerTokenSimitMock).toHaveBeenCalledTimes(1);
    const cabeceras = httpsGetJsonMock.mock.calls[0][1] as Record<string, string>;
    expect(cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('pide que no se cachee: la clave de caché de esta petición lleva el NIT dentro', async () => {
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const cabeceras = httpsGetJsonMock.mock.calls[0][1] as Record<string, string>;
    expect(cabeceras['Cache-Control']).toBe('no-store');
  });

  it('usa el timeout del módulo y no el de la librería', async () => {
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const [, , timeoutMs] = httpsGetJsonMock.mock.calls[0];
    expect(timeoutMs).toBe(entorno.COMPARENDOS_HTTP_TIMEOUT_MS);
    expect(timeoutMs).toBe(8000);
  });

  it('la barra final de la base URL no duplica la barra de la ruta', async () => {
    modoReal('https://verifik.test/');

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const url = new URL(String(httpsGetJsonMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://verifik.test/v2/co/simit/consultar');
  });

  it('respeta el prefijo de ruta de la base URL (hay ambientes detrás de un gateway)', async () => {
    modoReal('https://gateway.test/verifik');

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const url = new URL(String(httpsGetJsonMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://gateway.test/verifik/v2/co/simit/consultar');
  });

  it('el NIT sale codificado como parámetro y no interpolado a mano', async () => {
    // El NIT en la URL es una imposición del contrato de Verifik, en una llamada saliente (lo que
    // aplica ahí es la Ley 1581, no AGENTS.md §14, que regula nuestras superficies). Lo que sí
    // controlamos es que salga por `URLSearchParams`: un valor con `&` o `?` dentro no puede
    // convertirse en otro parámetro de la petición.
    await consultarComparendosSimit('900123456&documentType=CC', { token: new Redacted(TOKEN) });

    const url = new URL(String(httpsGetJsonMock.mock.calls[0][0]));
    expect(url.searchParams.getAll('documentType')).toEqual(['NIT']);
    expect(url.searchParams.get('documentNumber')).toBe('900123456&documentType=CC');
  });
});

// ─────────────────────────────── AC2 · UTS en modo real ─────────────────────────────────────────

describe('UTS municipal en modo real: la query que sale', () => {
  beforeEach(() => {
    modoReal();
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [{ numero: 'M-1' }] } });
  });

  it('GET a la ruta COMPLETA del contrato UTS, con fuente y nit', async () => {
    const r = await consultarComparendosMunicipales(NIT, 'BELLO');

    // Ruta completa `/infraction/api/Infraccion/ConsultarInfraccionFuente` (corrección del
    // 2026-08-18): con la ruta corta `/ConsultarInfraccion` el proveedor devuelve 404.
    const [url] = httpsGetJsonMock.mock.calls[0];
    expect(url).toBe(
      `https://uts.test/infraction/api/Infraccion/ConsultarInfraccionFuente?fuente=BELLO&nit=${NIT}`,
    );
    expect(r.items).toEqual([{ numero: 'M-1' }]);
    expect(r.fuente).toBe('BELLO');
    // Una sola petición y a este host: el UTS no se mezcla con Verifik ni con el SIMIT de
    // traspaso, que son otro dominio (ADR-0001 §4).
    expect(httpsGetJsonMock).toHaveBeenCalledTimes(1);
    expect(httpsJsonMock).not.toHaveBeenCalled();
  });

  it('usa el timeout del módulo y no el de la librería', async () => {
    await consultarComparendosMunicipales(NIT, 'BELLO');

    // 8000 y no 15000: con el default, la matriz NIT × municipios se pasa del corte del nginx.
    const [, , timeoutMs] = httpsGetJsonMock.mock.calls[0];
    expect(timeoutMs).toBe(entorno.COMPARENDOS_HTTP_TIMEOUT_MS);
    expect(timeoutMs).toBe(8000);
  });

  it('un municipio de varias palabras se codifica y se decodifica igual', async () => {
    const municipio = 'SANTA ROSA DE OSOS';

    await consultarComparendosMunicipales(NIT, municipio);

    const url = String(httpsGetJsonMock.mock.calls[0][0]);
    // El espacio sale como `+` (x-www-form-urlencoded), nunca crudo: una URL con espacios dentro es
    // una petición mal formada esperando a que un proxy la corte por donde no debe.
    expect(url).toContain('fuente=SANTA+ROSA+DE+OSOS');
    expect(url).not.toContain('SANTA ROSA');
    expect(new URL(url).searchParams.get('fuente')).toBe(municipio);
    expect(new URL(url).searchParams.get('nit')).toBe(NIT);
  });

  it('un código de fuente con metacaracteres no puede inyectar otro parámetro', async () => {
    // El Zod de la HU #11497 no deja guardar esto por el API; codificar aquí cubre lo que entre por
    // un seed, una migración o un script — la otra mitad de la misma defensa.
    await consultarComparendosMunicipales(NIT, 'BELLO&nit=000000000');

    const url = new URL(String(httpsGetJsonMock.mock.calls[0][0]));
    expect(url.searchParams.getAll('nit')).toEqual([NIT]);
    expect(url.searchParams.get('fuente')).toBe('BELLO&nit=000000000');
  });

  it('no manda el token del módulo a un tercero que no lo pide', async () => {
    await consultarComparendosMunicipales(NIT, 'BELLO');

    const cabeceras = (httpsGetJsonMock.mock.calls[0][1] ?? {}) as Record<string, string>;
    expect(cabeceras.Authorization).toBeUndefined();
    expect(JSON.stringify(cabeceras)).not.toContain(TOKEN);
    expect(obtenerTokenSimitMock).not.toHaveBeenCalled();
  });

  it('pide que no se cachee, y aquí es la ÚNICA protección: esta llamada no va autenticada', async () => {
    // La RFC 9111 ya restringe el caché compartido de respuestas a peticiones con `Authorization`.
    // El UTS no lleva ninguna, así que sin este encabezado nada le impide a un proxy intermedio
    // guardar una respuesta cuya clave de caché es una URL con el NIT dentro.
    await consultarComparendosMunicipales(NIT, 'BELLO');

    const cabeceras = httpsGetJsonMock.mock.calls[0][1] as Record<string, string>;
    expect(cabeceras['Cache-Control']).toBe('no-store');
    expect(cabeceras.Authorization).toBeUndefined();
  });
});

// ─────────────────────────────── AC3 · Errores de transporte ────────────────────────────────────

describe('errores tipados de las fuentes', () => {
  beforeEach(() => modoReal());

  it('HTTP no-OK de Verifik → fuente_http con el status del proveedor', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) })).rejects.toMatchObject({
      codigo: 'fuente_http',
      httpStatus: 401,   // el del proveedor
      status: 502,       // con el que respondería nuestra API
      origen: 'simit',
      fuente: 'simit',
    });
  });

  it('el 401 sugiere revisar el token, sin enseñarlo', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 401, data: {} });

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(fallo.message).toMatch(/token SIMIT/i);
    expect(fallo.message).not.toContain(TOKEN);
  });

  it('HTTP no-OK del UTS → fuente_http con el municipio en `fuente`', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 503, data: 'Service Unavailable' });

    await expect(consultarComparendosMunicipales(NIT, 'ITAGUI')).rejects.toMatchObject({
      codigo: 'fuente_http', httpStatus: 503, origen: 'municipal', fuente: 'ITAGUI',
    });
  });

  it('timeout del UTS → fuente_timeout, distinguible de un error del proveedor', async () => {
    // Lo que rechaza `httpsGetJson` cuando corta el socket: un Error('Timeout') pelado, sin `code`.
    httpsGetJsonMock.mockRejectedValue(new Error('Timeout'));

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    // `httpStatus` null y no 0: no hubo respuesta, y el sync necesita esa diferencia — un timeout
    // NO autoriza a inactivar los comparendos del NIT (ADR-0001 §5).
    expect(fallo).toMatchObject({ codigo: 'fuente_timeout', httpStatus: null, status: 504 });
    expect(fallo.message).toContain('8000 ms');
  });

  it('Verifik colgado → el techo ABSOLUTO del módulo corta, no solo el de inactividad del socket', async () => {
    // El `timeoutMs` de `httpsGetJson` es de INACTIVIDAD: un proveedor que gotee no lo dispara
    // nunca. Sin la carrera, una corrida del sync moriría en el nginx antes que en el cliente.
    entorno.COMPARENDOS_HTTP_TIMEOUT_MS = 25;
    httpsGetJsonMock.mockImplementation(() => new Promise(() => { /* nunca resuelve */ }));

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(fallo).toMatchObject({ codigo: 'fuente_timeout', origen: 'simit', httpStatus: null });
    expect(fallo.message).toContain('25 ms');
  });

  it('red caída → fuente_red con el code de Node y SIN el mensaje original', async () => {
    // El mensaje original lleva el token dentro a propósito: es el peor caso realista —una librería
    // que vuelca la petición en el error— y el adapter no debe reenviarlo.
    const roto = Object.assign(new Error(`connect ECONNREFUSED 10.0.0.1:443 Authorization: Bearer ${TOKEN}`), {
      code: 'ECONNREFUSED',
    });
    httpsGetJsonMock.mockRejectedValue(roto);

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(fallo).toMatchObject({ codigo: 'fuente_red', httpStatus: null, status: 502 });
    expect(fallo.message).toContain('ECONNREFUSED');
    expect(fallo.message).not.toContain(TOKEN);
    expect(fallo.message).not.toMatch(/authorization/i);
  });

  it('2xx con un cuerpo sin lista reconocible → error, NUNCA lista vacía', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { mensaje: 'sin resultados', meta: {} } });

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    // Devolver `[]` aquí le diría al sync que este NIT no debe nada e inactivaría su histórico
    // entero por un cambio de contrato del proveedor. El step falla y se ve.
    expect(fallo).toMatchObject({ codigo: 'fuente_respuesta_ilegible', httpStatus: 200 });
    // La pista describe la FORMA (nombres de clave), no el contenido.
    expect(fallo.message).toContain('mensaje, meta');
  });

  it('una lista vacía de verdad sí pasa: el proveedor contestó lo que se le preguntó', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [] } });

    const r = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(r.items).toEqual([]);
    expect(r.httpStatus).toBe(200);
  });

  // ── La forma REAL de las dos respuestas (capturadas el 2026-08-20) ─────────────────────────────
  //
  // Estas dos son la regresión crítica del módulo, no un caso más: en las dos fuentes la lista viva
  // convive con OTRA lista vacía dentro del mismo cuerpo. Quedarse con la vacía —o no encontrar
  // ninguna— devuelve cero comparendos para el NIT, y cero comparendos inactiva su histórico
  // entero. Un fallo aquí no se ve como un error: se ve como «este NIT ya no debe nada».

  it('SIMIT: `data.comparendos` vacío y `data.multas` con 5 → devuelve 5, nunca 0', async () => {
    const multas = Array.from({ length: 5 }, (_, i) => ({
      numeroComparendo: `7649700000005592081${i}`,
      comparendo: true,
      placa: 'LEW657',
      fechaComparendo: '11/05/2026 14:20:00',
      infracciones: [{ codigoInfraccion: 'D02', valorInfraccion: '1266222' }],
      valorPagar: '1308422',
    }));
    // La raíz REAL de Verifik: `data` es un OBJETO, no un array — el barrido genérico de claves lo
    // encontraba, veía que no era array y devolvía `fuente_respuesta_ilegible` (502).
    httpsGetJsonMock.mockResolvedValue({
      status: 200,
      data: { data: { comparendos: [], multas, cursos: [], totalMultas: 5 }, signature: 'x', id: 'y' },
    });

    const r = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(r.items).toHaveLength(5);
    expect(r.items[0]).toMatchObject({ numeroComparendo: '76497000000055920810' });
  });

  it('UTS: `informacionComparendoAdicional` vacío y ANTES que `informacionComparendo` → devuelve 1', async () => {
    modoReal();
    httpsGetJsonMock.mockResolvedValue({
      status: 200,
      data: {
        idTipoIdentificacion: 3,
        criterio: NIT,
        response: null,
        consultaMultaOComparendoOutDTO: {
          estado: { codigoEstado: 1, descripcion: 'EXITOSO' },
          informacionComparendoAdicional: [],
          informacionComparendo: [{ numeroComparendo: 'D05001000000054652201', placa: 'PYT159' }],
          informacionMulta: [],
          tarifasComparendos: [],
        },
      },
    });

    const r = await consultarComparendosMunicipales(NIT, 'BELLO');

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ numeroComparendo: 'D05001000000054652201' });
  });

  it('UTS con `codigoEstado` distinto de 1 → error de fuente, NUNCA lista vacía', async () => {
    modoReal();
    httpsGetJsonMock.mockResolvedValue({
      status: 200,
      data: {
        criterio: NIT,
        consultaMultaOComparendoOutDTO: {
          estado: { codigoEstado: 4, descripcion: 'SIN INFORMACION' },
          informacionComparendo: [],
        },
      },
    });

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(fallo).toMatchObject({ codigo: 'fuente_respuesta_ilegible', httpStatus: 200 });
    expect(fallo.message).toContain('4');
    expect(fallo.message).toContain('SIN INFORMACION');
    // El `criterio` de la raíz ES el NIT: la pista viaja a `sync_steps.mensaje`, que se conserva.
    expect(fallo.message).not.toContain(NIT);
  });

  it('un cuerpo de texto plano no acaba en el mensaje del error', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: '<html>placa ABC123 cédula 1036640908</html>' });

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(fallo.codigo).toBe('fuente_respuesta_ilegible');
    expect(fallo.message).toContain('texto plano de');
    expect(fallo.message).not.toContain('1036640908');
    expect(fallo.message).not.toContain('ABC123');
  });

  it('un mapa indexado por placa o cédula tampoco filtra: las CLAVES también son datos', async () => {
    // El caso que rompe la premisa de «las claves son contrato»: si el proveedor contesta un mapa,
    // el identificador ES la clave. Y esta pista no se queda en un log — viaja al cuerpo de la
    // respuesta HTTP y a la columna `mensaje` de sync_steps, que se conserva.
    httpsGetJsonMock.mockResolvedValue({
      status: 200,
      data: { ABC123: { valor: 1 }, '1036640908': { valor: 2 }, total: 2 },
    });

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(fallo.codigo).toBe('fuente_respuesta_ilegible');
    expect(fallo.message).not.toContain('ABC123');
    expect(fallo.message).not.toContain('1036640908');
    // Lo que sí se conserva es el valor diagnóstico: cuántas claves y cuáles parecen de contrato.
    expect(fallo.message).toContain('total');
    expect(fallo.message).toContain('?');
  });

  it('una lista cuyos elementos no son objetos es ilegible, NO una lista vacía', async () => {
    // Filtrar a secas reintroduciría por la puerta de atrás el `[]` silencioso que todo el módulo
    // evita — y con él la inactivación en falso del histórico entero del NIT.
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [null, 'texto', 42] } });

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(fallo.codigo).toBe('fuente_respuesta_ilegible');
    expect(fallo.message).toContain('no son objetos');
  });

  it('el UTS también tiene techo de tiempo ABSOLUTO, no solo el de inactividad de socket', async () => {
    // El `timeoutMs` de httpsGetJson es un timeout de INACTIVIDAD: un proveedor que gotee un byte
    // cada 7 s no lo dispara nunca. Sin la carrera, el camino con el helper «bueno» estaba menos
    // protegido que el del POST, y el presupuesto de tiempo del sync (ADR-0001 §7) dependía de eso.
    httpsGetJsonMock.mockImplementation(() => new Promise(() => {}));

    const fallo = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(fallo).toMatchObject({ codigo: 'fuente_timeout', httpStatus: null, status: 504 });
  });

  it('falta la base URL y el modo es real → fuente_no_configurada, sin salir a la red', async () => {
    entorno.COMPARENDOS_SIMIT_MODE = 'real';
    entorno.VERIFIK_SIMIT_BASE_URL = undefined;
    entorno.UTS_MUNICIPAL_BASE_URL = undefined;

    const simit = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);
    const uts = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    // 503 y con el nombre de la variable dentro: es un fallo de provisión, no un bug, y así se
    // arregla leyendo el mensaje. Nunca una URL con `undefined` disfrazada de error de DNS.
    expect(simit).toMatchObject({ codigo: 'fuente_no_configurada', status: 503 });
    expect(simit.message).toContain('VERIFIK_SIMIT_BASE_URL');
    expect(uts.message).toContain('UTS_MUNICIPAL_BASE_URL');
    expect(httpsJsonMock).not.toHaveBeenCalled();
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('una base `http://` se RECHAZA en Verifik: en texto plano el Bearer se regala', async () => {
    // Verifik sigue siendo https-only y no debe dejar de serlo: su petición lleva el token del
    // módulo en la cabecera. La excepción de texto plano del 2026-08-20 es SOLO del UTS.
    modoReal('http://verifik.test', 'https://uts.test');

    const simit = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(simit).toMatchObject({ codigo: 'fuente_no_configurada', status: 503, httpStatus: null });
    expect(simit.message).toContain('VERIFIK_SIMIT_BASE_URL');
    expect(simit.message).toContain('http');
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('una base `http://` SÍ la acepta el UTS, y la petición sale por http de verdad', async () => {
    // Decisión de David (2026-08-20): el proveedor del UTS no publica HTTPS y sin esto la fuente
    // no es consultable. Lo que no puede pasar es que se acepte la base y la petición salga
    // igualmente contra el 443 —el NIT remitido en silencio a un endpoint que nadie revisó—, así
    // que el adapter tiene que pedirle la MISMA excepción al transporte.
    modoReal('https://verifik.test', 'http://uts-inventado.test');
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [{ numero: 'M-1' }] } });

    const r = await consultarComparendosMunicipales(NIT, 'BELLO');

    expect(r.items).toEqual([{ numero: 'M-1' }]);
    const [url, , , opciones] = httpsGetJsonMock.mock.calls[0];
    expect(url).toContain('http://uts-inventado.test/infraction/api/Infraccion/');
    expect(opciones).toMatchObject({ permitirTextoPlano: true });
  });

  it('el UTS sobre http avisa en el log de que el NIT viaja sin cifrar, sin enseñar URL ni NIT', async () => {
    reiniciarAvisoTextoPlano();
    modoReal('https://verifik.test', 'http://uts-inventado.test');
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [] } });

    await consultarComparendosMunicipales(NIT, 'BELLO');

    const texto = logueado();
    expect(texto).toContain('sin cifrar');
    // El aviso no puede ser la puerta por la que salgan el host ni el NIT.
    expect(texto).not.toContain('uts-inventado.test');
    expect(texto).not.toContain(NIT);
  });

  it('sobre https el UTS no pide texto plano ni avisa de nada', async () => {
    reiniciarAvisoTextoPlano();
    modoReal('https://verifik.test', 'https://uts.test');
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [] } });

    await consultarComparendosMunicipales(NIT, 'BELLO');

    const [, , , opciones] = httpsGetJsonMock.mock.calls[0];
    expect(opciones).toMatchObject({ permitirTextoPlano: false });
    expect(logueado()).not.toContain('sin cifrar');
  });

  it('una base con query o fragmento se rechaza: es el único punto interpolado de la URL', async () => {
    // Los adapters concatenan `${base}${RUTA}?${params}`. Una base con `?` pegado partiría la query
    // en dos y mezclaría parámetros del despliegue con el `documentNumber` que ponemos nosotros.
    modoReal('https://verifik.test/?apiKey=x', 'https://uts.test/#frag');

    const simit = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);
    const uts = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(simit).toMatchObject({ codigo: 'fuente_no_configurada', status: 503 });
    expect(uts).toMatchObject({ codigo: 'fuente_no_configurada', status: 503 });
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('una base que no parsea da error de CONFIGURACIÓN, no un TypeError disfrazado de red', async () => {
    // Sin el try/catch alrededor de `new URL`, esto reventaría dentro del `try` del adapter y
    // saldría como `fuente_red`: el diagnóstico exactamente equivocado (no falló la red, falló la
    // provisión) y encima con el mensaje crudo de la librería.
    modoReal('verifik.test/v2', 'uts.test');

    const simit = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);
    const uts = await consultarComparendosMunicipales(NIT, 'BELLO').catch((e) => e);

    expect(simit).toMatchObject({ codigo: 'fuente_no_configurada', status: 503 });
    expect(simit.name).toBe('ComparendosFuenteNoConfiguradaError');
    expect(uts).toMatchObject({ codigo: 'fuente_no_configurada', status: 503 });
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });

  it('en mock una base `http://` no molesta: el entorno local no se rompe', async () => {
    // La validación vive DESPUÉS del cortocircuito de mock, a propósito: un clon recién hecho —o
    // con el host de texto plano que dio el proveedor puesto en el .env— sigue ejerciendo el
    // módulo entero sin tocar la red.
    entorno.COMPARENDOS_SIMIT_MODE = 'mock';
    entorno.VERIFIK_SIMIT_BASE_URL = 'http://verifik.test';
    entorno.UTS_MUNICIPAL_BASE_URL = 'http://ec2-cualquiera.compute-1.amazonaws.com';

    await expect(consultarComparendosSimit(NIT)).resolves.toMatchObject({ modo: 'mock' });
    await expect(consultarComparendosMunicipales(NIT, 'BELLO')).resolves.toMatchObject({ modo: 'mock' });
    expect(httpsGetJsonMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────── El token no se filtra ──────────────────────────────────────────

describe('el token no aparece en ningún log ni mensaje', () => {
  beforeEach(() => modoReal());

  it('camino feliz: se registran códigos y conteos, no la petición', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [{ numeroComparendo: 'A-1' }] } });

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(logueado()).not.toContain(TOKEN);
    expect(logueado()).not.toMatch(/authorization/i);
    expect(registros.length).toBeGreaterThan(0);
  });

  it('camino de error: tampoco al fallar, que es cuando se suele volcar todo', async () => {
    httpsGetJsonMock.mockRejectedValue(Object.assign(new Error(`boom Bearer ${TOKEN}`), { code: 'ECONNRESET' }));

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch(() => undefined);

    expect(logueado()).not.toContain(TOKEN);
    expect(logueado()).not.toMatch(/bearer/i);
    // Y sí queda constancia del fallo: no filtrar no puede significar no registrar nada.
    expect(logueado()).toContain('fuente_red');
  });

  it('el NIT se registra enmascarado (Ley 1581), nunca en claro', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [] } });

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(logueado()).not.toContain(NIT);
    // `maskDocument`: primeros 2 y últimos 3 caracteres, el resto tapado.
    expect(logueado()).toContain('90****456');
  });

  it('la URL con el NIT dentro no acaba en ningún log, ni en el camino feliz ni en el de error', async () => {
    // El contrato de Verifik obliga a poner el NIT en la query de una llamada SALIENTE (AGENTS.md
    // §14 gobierna nuestras superficies, no las de un tercero; lo que aplica ahí es la Ley 1581).
    // Lo que NO se puede admitir es que además lo escribamos nosotros en nuestros propios logs: ni
    // la URL entera, ni el nombre del parámetro con su valor al lado.
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { data: [] } });
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    httpsGetJsonMock.mockRejectedValue(
      // El peor caso realista: la librería vuelca la URL —NIT incluido— en el mensaje del error.
      Object.assign(new Error(`connect ECONNREFUSED https://verifik.test/v2/co/simit/consultar?documentNumber=${NIT}`),
        { code: 'ECONNREFUSED' }),
    );
    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(logueado()).not.toContain(NIT);
    expect(logueado()).not.toContain('documentNumber');
    expect(logueado()).not.toContain('/v2/co/simit/consultar');
    // Y tampoco en el mensaje del error, que se PERSISTE en `sync_steps.mensaje` (RN-20).
    expect(fallo.message).not.toContain(NIT);
    expect(fallo.message).not.toContain('documentNumber');
  });

  it('la URL del UTS con el NIT tampoco se registra', async () => {
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [] } });

    await consultarComparendosMunicipales(NIT, 'BELLO');

    expect(logueado()).not.toContain(NIT);
    expect(logueado()).not.toContain('ConsultarInfraccionFuente');
  });

  it('el token envuelto se redacta solo si alguien lo serializa por descuido', async () => {
    const envuelto = new Redacted(TOKEN);

    // La red de seguridad de `Redacted`: incluso pasándolo entero a un log, sale `[REDACTED]`.
    expect(JSON.stringify({ token: envuelto })).toBe('{"token":"[REDACTED]"}');
    expect(String(envuelto)).toBe('[REDACTED]');
  });
});
