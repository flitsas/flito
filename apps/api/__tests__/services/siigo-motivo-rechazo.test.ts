// Siigo — explicar por qué la DIAN rechazó una factura (HU #11333). Un bloque por criterio.
//
// La mayor parte de lo que hay que probar es PURO —normalizar lo que llega y componer el texto— y
// se interroga sin red ni base. El resto es orquestación: a quién se pregunta, a quién no, y qué
// queda escrito cuando la consulta falla.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SIIGO_MOTIVO_RECHAZO_PENDIENTE, esMotivoPendiente } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const aplicarEstadoDianMock = vi.fn().mockResolvedValue({
  cambio: true, cufeCompletado: false, cufeDiscrepante: false, registro: {},
});
vi.mock('../../src/modules/siigo/siigo.estado-dian.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.estado-dian.service.js')>();
  return { ...real, aplicarEstadoDian: (e: unknown) => aplicarEstadoDianMock(e) };
});

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const {
  MAX_MOTIVOS_ENUMERADOS, componerMotivo, normalizarErrores, resolverMotivoDeRechazo,
  resolverMotivosPendientes,
} = await import('../../src/modules/siigo/siigo.motivo-rechazo.service.js');

const FACTURA = {
  id: 'cccccccc-4444-4444-8444-cccccccccccc',
  ambiente: 'produccion',
  siigoInvoiceId: 'inv-88',
  numero: 'FV-1-88',
};

beforeEach(() => {
  kdb.reset();
  siigoRequestOrThrowMock.mockReset();
  aplicarEstadoDianMock.mockClear();
  registrarOperacionMock.mockClear();
});

describe('AC2 — el motivo se dice en el idioma de quien opera', () => {
  it('usa la traducción del catálogo que YA existe, no una inventada', () => {
    const texto = componerMotivo([{ codigo: 'invalid_dian_resolution', campos: [] }]);

    // El catálogo de `siigo.errors.ts` ya dice esto. Un segundo diccionario habría creado dos
    // verdades sobre el mismo código, y la copia sería la que se quedara desactualizada.
    expect(texto).toContain('resolución DIAN');
    expect(texto).not.toMatch(/invalid_dian_resolution/);
  });

  it('un código que NO está en el catálogo se dice con su código, no con una frase bonita', () => {
    const texto = componerMotivo([{ codigo: 'codigo_marciano', campos: [] }]);

    // El código es exactamente lo que alguien necesita para buscarlo. Inventar una frase que suene
    // bien y no diga nada sería peor que admitir que no lo conocemos.
    expect(texto).toContain('codigo_marciano');
  });

  it('el campo señalado por Siigo se conserva', () => {
    const texto = componerMotivo([{ codigo: 'invalid_identification', campos: ['customer.identification'] }]);
    expect(texto).toContain('customer.identification');
  });
});

describe('AC3 — varios errores se conservan todos', () => {
  it('enumera en vez de quedarse con el primero', () => {
    const texto = componerMotivo([
      { codigo: 'invalid_dian_resolution', campos: [] },
      { codigo: 'invalid_identification', campos: [] },
      { codigo: 'invalid_email', campos: [] },
    ]);

    // Un rechazo con tres causas y una sola mostrada hace que se corrija una, se reintente, y vuelva
    // a rechazarse por la segunda: tres viajes para lo que era uno.
    expect(texto).toContain('1.');
    expect(texto).toContain('2.');
    expect(texto).toContain('3.');
  });

  it('con un solo error no numera: «1.» sobre una sola causa es ruido', () => {
    const texto = componerMotivo([{ codigo: 'invalid_email', campos: [] }]);
    expect(texto).not.toMatch(/^1\./);
  });

  it('con muchos errores acota el texto pero DICE cuántos quedan fuera', () => {
    const muchos = Array.from({ length: MAX_MOTIVOS_ENUMERADOS + 3 },
      () => ({ codigo: 'invalid_email', campos: [] }));

    const texto = componerMotivo(muchos)!;

    // El texto va a una columna de una tabla inmutable: acotarlo es necesario. Silenciar los
    // sobrantes, no — quien lea tiene que saber que hay más.
    expect(texto).toContain('3 error(es) más');
  });

  it('sin errores no compone nada: null es «no hay», no una frase vacía', () => {
    expect(componerMotivo([])).toBeNull();
  });
});

describe('La forma de la respuesta no está documentada, así que se aceptan las que Siigo usa', () => {
  const uno = { Code: 'invalid_email', Params: ['customer.email'] };

  it('arreglo suelto', () => {
    expect(normalizarErrores([uno])).toEqual([{ codigo: 'invalid_email', campos: ['customer.email'] }]);
  });

  it('envuelto en `results`', () => {
    expect(normalizarErrores({ results: [uno] })).toHaveLength(1);
  });

  it('envuelto en `Errors`, que es lo que usa el resto de su API', () => {
    expect(normalizarErrores({ Errors: [uno] })).toHaveLength(1);
  });

  it('lo que no trae código NO se convierte en un error inventado', () => {
    expect(normalizarErrores({ results: [{ Message: 'algo pasó' }] })).toEqual([]);
    expect(normalizarErrores({ vete: 'a saber' })).toEqual([]);
    expect(normalizarErrores(null)).toEqual([]);
  });
});

describe('AC5 — si el motivo no está disponible, se dice', () => {
  it('un fallo de consulta deja el marcador de pendiente, no una explicación falsa', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const r = await resolverMotivoDeRechazo(FACTURA);

    expect(r.desenlace).toBe('pendiente');
    expect(esMotivoPendiente(r.motivo)).toBe(true);
  });

  it('«no se pudo consultar» y «rechazó sin decir por qué» son distintos', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce({ results: [] });

    const r = await resolverMotivoDeRechazo(FACTURA);

    // Sin esta diferencia, quien opera no sabe si esperar o ir a mirar a Siigo Nube.
    expect(r.desenlace).toBe('sin_errores');
    expect(esMotivoPendiente(r.motivo)).toBe(false);
    expect(r.motivo).toContain('no devolvió el detalle');
  });

  it('el fallo queda en la bitácora', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await resolverMotivoDeRechazo(FACTURA);

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      resultado: 'error_tecnico', entidadId: FACTURA.id,
    }));
  });

  it('no lanza: un rechazo sin explicar sigue siendo un rechazo que hay que registrar', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('boom'));
    await expect(resolverMotivoDeRechazo(FACTURA)).resolves.toBeDefined();
  });
});

describe('AC1 y AC4 — el motivo va junto al estado, y solo se pregunta por lo rechazado', () => {
  it('se registra por la puerta de ingesta, con estado rechazada', async () => {
    kdb.execute.mockResolvedValueOnce([{
      id: FACTURA.id, ambiente: 'produccion', siigo_invoice_id: 'inv-88', numero: 'FV-1-88',
    }]);
    siigoRequestOrThrowMock.mockResolvedValueOnce({
      results: [{ Code: 'invalid_dian_resolution' }],
    });

    const r = await resolverMotivosPendientes(5);

    expect(r).toMatchObject({ revisadas: 1, resueltos: 1 });
    expect(aplicarEstadoDianMock).toHaveBeenCalledWith(expect.objectContaining({
      facturaId: FACTURA.id, estado: 'rechazada',
    }));
    // El motivo va donde va el estado, no en una tabla aparte que alguien tendría que cruzar.
    const enviado = aplicarEstadoDianMock.mock.calls[0][0] as { motivo: string };
    expect(enviado.motivo).toContain('resolución DIAN');
  });

  it('la consulta solo trae rechazadas sin explicación, y lo hace en SQL', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    kdb.execute.mockResolvedValueOnce([]);

    await resolverMotivosPendientes(5);

    // AC4: no es que se salten dentro del bucle — es que no se traen, así que no gastan ni una
    // petición. Se compila la consulta real para afirmarlo sobre el SQL que de verdad se manda.
    const { sql: texto, params } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toContain("v.estado = 'rechazada'");
    expect(texto).toContain('v.motivo IS NULL');
    expect(params).toContain(SIIGO_MOTIVO_RECHAZO_PENDIENTE);
  });

  it('una factura sin errores que resolver no se vuelve a consultar en bucle', async () => {
    kdb.execute.mockResolvedValueOnce([]);

    const r = await resolverMotivosPendientes(5);

    expect(r.revisadas).toBe(0);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('si la ingesta falla, la factura cuenta como pendiente y el ciclo sigue', async () => {
    kdb.execute.mockResolvedValueOnce([
      { id: FACTURA.id, ambiente: 'produccion', siigo_invoice_id: 'inv-1', numero: 'A' },
      { id: FACTURA.id, ambiente: 'produccion', siigo_invoice_id: 'inv-2', numero: 'B' },
    ]);
    siigoRequestOrThrowMock.mockResolvedValue({ results: [{ Code: 'invalid_email' }] });
    aplicarEstadoDianMock
      .mockRejectedValueOnce(new Error('transacción abortada'))
      .mockResolvedValueOnce({ cambio: true, cufeCompletado: false, cufeDiscrepante: false, registro: {} });

    const r = await resolverMotivosPendientes(5);

    expect(r).toMatchObject({ revisadas: 2, pendientes: 1, resueltos: 1 });
  });
});

describe('AC6 — el motivo que se guarda está saneado y acotado', () => {
  it('no arrastra el volcado de una consulta de base de datos', () => {
    // Dos defensas en serie. La de fuera —el saneo del repo— reconoce SQL por el identificador
    // ENTRECOMILLADO, que es como lo compila drizzle. La de dentro, y la que actúa aquí, es el
    // filtro de FORMA de `campoLegible`: un volcado de consulta no tiene forma de nombre de campo,
    // así que se descarta entero en vez de recortarse. Mejor todavía que redactarlo.
    const texto = componerMotivo([
      { codigo: 'invalid_email', campos: [] },
      { codigo: 'x', campos: ['failed query: select "a" from "users"'] },
    ])!;
    expect(texto).not.toContain('failed query');
    expect(texto).not.toContain('from "users"');
  });

  it('un valor con pinta de secreto en los campos se redacta', () => {
    // Los `Params` vienen de fuera. `campoLegible` los pasa por el redactado que ya existe; pintarlos
    // a mano se saltaría esa defensa sin que nadie se enterara.
    const texto = componerMotivo([{ codigo: 'x', campos: ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def'] }])!;
    expect(texto).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('la longitud está acotada aunque Siigo devuelva una novela', () => {
    const largos = Array.from({ length: 3 }, () => ({ codigo: 'x', campos: ['A'.repeat(5000)] }));
    const texto = componerMotivo(largos)!;
    expect(texto.length).toBeLessThan(5000);
  });
});

describe('El simulador sabe representar los tres desenlaces', () => {
  it('un rechazo con varios errores, uno sin catalogar', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    const r = respuestaSimulada('GET', '/v1/invoices/inv-multi/stamp/errors');
    const errores = normalizarErrores(r.datos);

    // El caso de un solo error no ensaya el AC3, y sin un código desconocido no se ensaya qué pasa
    // cuando el catálogo no lo tiene.
    expect(errores.length).toBeGreaterThan(1);
    expect(componerMotivo(errores)).toContain('2.');
  });

  it('un rechazo sin detalle', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');
    const r = respuestaSimulada('GET', '/v1/invoices/inv-sindetalle/stamp/errors');
    expect(normalizarErrores(r.datos)).toEqual([]);
  });

  it('la ruta del detalle no se la traga la consulta de la factura', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    const r = respuestaSimulada('GET', '/v1/invoices/inv-1/stamp/errors');

    // `/v1/invoices/{id}` es prefijo de esta ruta: si el orden fuera el contrario, aquí llegaría un
    // `stamp` en vez de una lista de errores y el motivo nunca se resolvería en desarrollo.
    expect((r.datos as { stamp?: unknown }).stamp).toBeUndefined();
    expect(normalizarErrores(r.datos)).toHaveLength(1);
  });
});

describe('Correcciones de la auditoría — lista blanca de forma, no lista negra de contenido', () => {
  it('un DATO PERSONAL en los Params no llega al motivo', () => {
    // `Params` debería traer la RUTA del campo, pero eso no está documentado y el array lo llena el
    // proveedor: para `invalid_identification` es plausible que devuelva el VALOR rechazado. Ese
    // texto acaba en una columna append-only que no está en el flujo de olvido, así que un dato
    // personal que entre ahí no se puede rectificar ni suprimir nunca.
    for (const dato of ['1032456789', 'juan.perez@empresa.com', 'CC 1032456789', '3001234567']) {
      const texto = componerMotivo([{ codigo: 'invalid_identification', campos: [dato] }])!;
      expect(texto, `«${dato}» no debería aparecer`).not.toContain(dato);
    }
  });

  it('pero el NOMBRE del campo sí se conserva: es lo que sirve para corregir', () => {
    expect(componerMotivo([{ codigo: 'invalid_identification', campos: ['customer.identification'] }]))
      .toContain('customer.identification');
    expect(componerMotivo([{ codigo: 'x', campos: ['items[0].code'] }])).toContain('items[0].code');
  });

  it('un array desmedido de Params no construye un texto desmedido', () => {
    const muchos = Array.from({ length: 5000 }, (_, i) => `campo_${i}`);
    const texto = componerMotivo([{ codigo: 'x', campos: muchos }])!;

    // `join` sobre miles de cadenas construye el texto entero ANTES de que nadie lo recorte, así que
    // el tope tiene que ir sobre el NÚMERO de elementos, no sobre el resultado.
    expect(texto.length).toBeLessThan(500);
  });

  it('una respuesta con cientos de miles de errores no se recorre entera', () => {
    const enorme = Array.from({ length: 200_000 }, () => ({ Code: 'invalid_email' }));
    expect(normalizarErrores({ results: enorme }).length).toBeLessThanOrEqual(50);
  });

  it('un código heredado del prototipo NO se da por catalogado', () => {
    // `CATALOGO['constructor']` devuelve la función `Object` —truthy—, así que el código se daba por
    // conocido, su descripción era `undefined`, y la cadena literal «undefined» acababa escrita en
    // una columna que no se puede corregir. Además silenciaba la alarma de código sin catalogar.
    for (const codigo of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const texto = componerMotivo([{ codigo, campos: [] }])!;
      expect(texto, `«${codigo}» no debería producir texto roto`).not.toContain('undefined');
      expect(texto).toContain(codigo);
    }
  });

  it('el barrido tiene cadencia: una factura que nunca consigue su motivo no se consulta en bucle', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    kdb.execute.mockResolvedValueOnce([]);

    await resolverMotivosPendientes(5);

    // Es el mismo bicho que el sondeo de estado ya corrigió: sin ancla de último intento, una
    // factura con un identificador que Siigo ya no reconoce se reconsultaría en todos los barridos
    // para siempre, gastando la cuota que comparte con la emisión.
    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toContain('ultimo_intento');
    expect(texto).toContain('INTERVAL');
    // Y sin inanición: las que nunca se intentaron primero, después las que llevan más esperando.
    expect(texto).toContain('NULLS FIRST');
  });

  it('el presupuesto está acotado y un valor absurdo no revienta la consulta', async () => {
    kdb.execute.mockResolvedValue([]);

    await expect(resolverMotivosPendientes(NaN)).resolves.toMatchObject({ revisadas: 0 });
    await expect(resolverMotivosPendientes(-5)).resolves.toMatchObject({ revisadas: 0 });
    await expect(resolverMotivosPendientes(10_000)).resolves.toBeDefined();

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const ultima = kdb.execute.mock.calls[kdb.execute.mock.calls.length - 1][0];
    const { params } = new PgDialect().sqlToQuery(ultima);
    expect(params[params.length - 1]).toBeLessThanOrEqual(50);
  });
});
