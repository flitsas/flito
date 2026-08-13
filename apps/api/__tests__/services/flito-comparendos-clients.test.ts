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
//   3. En `real`, la petición sale bien formada —método, URL, cabeceras, cuerpo— y con el techo de
//      tiempo del módulo, no con el de la librería (ADR-0001 §7).
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
const { consultarComparendosMunicipales } =
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
    httpsJsonMock.mockResolvedValue({ status: 200, data: { data: [{ numeroComparendo: 'A-1' }] } });
  });

  it('POST a /v2/co/simit/consultar con documentType=NIT y documentNumber en el cuerpo', async () => {
    const r = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const [metodo, url, cuerpo] = httpsJsonMock.mock.calls[0];
    expect(metodo).toBe('POST');
    expect(url).toBe('https://verifik.test/v2/co/simit/consultar');
    expect(cuerpo).toEqual({ documentType: 'NIT', documentNumber: NIT });
    expect(r.httpStatus).toBe(200);
    expect(r.modo).toBe('real');
    expect(r.items).toEqual([{ numeroComparendo: 'A-1' }]);
  });

  it('manda el Bearer con el token inyectado', async () => {
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    const cabeceras = httpsJsonMock.mock.calls[0][3] as Record<string, string>;
    expect(cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
    // Y el token inyectado se usa tal cual: no se vuelve a pedir a la base una vez por NIT.
    expect(obtenerTokenSimitMock).not.toHaveBeenCalled();
  });

  it('si no se le inyecta, lo pide al servicio del token (nunca a una variable suelta)', async () => {
    await consultarComparendosSimit(NIT);

    expect(obtenerTokenSimitMock).toHaveBeenCalledTimes(1);
    const cabeceras = httpsJsonMock.mock.calls[0][3] as Record<string, string>;
    expect(cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('la barra final de la base URL no duplica la barra de la ruta', async () => {
    modoReal('https://verifik.test/');

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(httpsJsonMock.mock.calls[0][1]).toBe('https://verifik.test/v2/co/simit/consultar');
  });

  it('respeta el prefijo de ruta de la base URL (hay ambientes detrás de un gateway)', async () => {
    modoReal('https://gateway.test/verifik');

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(httpsJsonMock.mock.calls[0][1]).toBe('https://gateway.test/verifik/v2/co/simit/consultar');
  });

  it('el NIT no viaja en la query string: no se siembra en los logs de acceso de los proxys', async () => {
    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(String(httpsJsonMock.mock.calls[0][1])).not.toContain(NIT);
  });
});

// ─────────────────────────────── AC2 · UTS en modo real ─────────────────────────────────────────

describe('UTS municipal en modo real: la query que sale', () => {
  beforeEach(() => {
    modoReal();
    httpsGetJsonMock.mockResolvedValue({ status: 200, data: { infracciones: [{ numero: 'M-1' }] } });
  });

  it('GET a ConsultarInfraccion con fuente y nit', async () => {
    const r = await consultarComparendosMunicipales(NIT, 'BELLO');

    const [url] = httpsGetJsonMock.mock.calls[0];
    expect(url).toBe(`https://uts.test/ConsultarInfraccion?fuente=BELLO&nit=${NIT}`);
    expect(r.items).toEqual([{ numero: 'M-1' }]);
    expect(r.fuente).toBe('BELLO');
    // Ni una llamada al SIMIT de traspaso: son otro dominio (ADR-0001 §4).
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
});

// ─────────────────────────────── AC3 · Errores de transporte ────────────────────────────────────

describe('errores tipados de las fuentes', () => {
  beforeEach(() => modoReal());

  it('HTTP no-OK de Verifik → fuente_http con el status del proveedor', async () => {
    httpsJsonMock.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) })).rejects.toMatchObject({
      codigo: 'fuente_http',
      httpStatus: 401,   // el del proveedor
      status: 502,       // con el que respondería nuestra API
      origen: 'simit',
      fuente: 'simit',
    });
  });

  it('el 401 sugiere revisar el token, sin enseñarlo', async () => {
    httpsJsonMock.mockResolvedValue({ status: 401, data: {} });

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

  it('Verifik colgado → el techo de tiempo del módulo corta igual, aunque el helper no lo soporte', async () => {
    // `httpsJson` tiene 90 s fijos dentro y no acepta timeout: por eso el adapter corre su propia
    // carrera. Sin ella, una corrida del sync moriría en el nginx antes que en el cliente.
    entorno.COMPARENDOS_HTTP_TIMEOUT_MS = 25;
    httpsJsonMock.mockImplementation(() => new Promise(() => { /* nunca resuelve */ }));

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
    httpsJsonMock.mockRejectedValue(roto);

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    expect(fallo).toMatchObject({ codigo: 'fuente_red', httpStatus: null, status: 502 });
    expect(fallo.message).toContain('ECONNREFUSED');
    expect(fallo.message).not.toContain(TOKEN);
    expect(fallo.message).not.toMatch(/authorization/i);
  });

  it('2xx con un cuerpo sin lista reconocible → error, NUNCA lista vacía', async () => {
    httpsJsonMock.mockResolvedValue({ status: 200, data: { mensaje: 'sin resultados', meta: {} } });

    const fallo = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch((e) => e);

    // Devolver `[]` aquí le diría al sync que este NIT no debe nada e inactivaría su histórico
    // entero por un cambio de contrato del proveedor. El step falla y se ve.
    expect(fallo).toMatchObject({ codigo: 'fuente_respuesta_ilegible', httpStatus: 200 });
    // La pista describe la FORMA (nombres de clave), no el contenido.
    expect(fallo.message).toContain('mensaje, meta');
  });

  it('una lista vacía de verdad sí pasa: el proveedor contestó lo que se le preguntó', async () => {
    httpsJsonMock.mockResolvedValue({ status: 200, data: { data: [] } });

    const r = await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(r.items).toEqual([]);
    expect(r.httpStatus).toBe(200);
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
});

// ─────────────────────────────── El token no se filtra ──────────────────────────────────────────

describe('el token no aparece en ningún log ni mensaje', () => {
  beforeEach(() => modoReal());

  it('camino feliz: se registran códigos y conteos, no la petición', async () => {
    httpsJsonMock.mockResolvedValue({ status: 200, data: { data: [{ numeroComparendo: 'A-1' }] } });

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(logueado()).not.toContain(TOKEN);
    expect(logueado()).not.toMatch(/authorization/i);
    expect(registros.length).toBeGreaterThan(0);
  });

  it('camino de error: tampoco al fallar, que es cuando se suele volcar todo', async () => {
    httpsJsonMock.mockRejectedValue(Object.assign(new Error(`boom Bearer ${TOKEN}`), { code: 'ECONNRESET' }));

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) }).catch(() => undefined);

    expect(logueado()).not.toContain(TOKEN);
    expect(logueado()).not.toMatch(/bearer/i);
    // Y sí queda constancia del fallo: no filtrar no puede significar no registrar nada.
    expect(logueado()).toContain('fuente_red');
  });

  it('el NIT se registra enmascarado (Ley 1581), nunca en claro', async () => {
    httpsJsonMock.mockResolvedValue({ status: 200, data: { data: [] } });

    await consultarComparendosSimit(NIT, { token: new Redacted(TOKEN) });

    expect(logueado()).not.toContain(NIT);
    // `maskDocument`: primeros 2 y últimos 3 caracteres, el resto tapado.
    expect(logueado()).toContain('90****456');
  });

  it('el token envuelto se redacta solo si alguien lo serializa por descuido', async () => {
    const envuelto = new Redacted(TOKEN);

    // La red de seguridad de `Redacted`: incluso pasándolo entero a un log, sale `[REDACTED]`.
    expect(JSON.stringify({ token: envuelto })).toBe('{"token":"[REDACTED]"}');
    expect(String(envuelto)).toBe('[REDACTED]');
  });
});
