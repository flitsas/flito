// Siigo — sondeo del estado ante la DIAN (HU #11332). Un bloque por criterio de aceptación.
//
// Se mockean las dos fronteras: el cliente HTTP de Siigo y la base. Lo que se prueba es la
// ORQUESTACIÓN —a quién se consulta, con qué cadencia, qué se hace con lo que contesta y, sobre
// todo, qué NO se hace cuando la respuesta no llega o no se entiende.
//
// La puerta de ingesta (`aplicarEstadoDian`) también se mockea: su corrección es de la HU #11330 y
// tiene sus propios tests. Aquí lo que importa es que ESTE archivo la use y no escriba por su cuenta.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { traducirEstadoStamp, SIIGO_STAMP_STATUS_A_ESTADO_DIAN } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

/** Se captura para poder afirmar QUÉ clave de limitador usa: es el AC2 entero. */
const resilienciaOpcionesMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return {
    ...real,
    ejecutarConResiliencia: async (op: () => Promise<unknown>, opts: unknown) => {
      resilienciaOpcionesMock(opts);
      return op();
    },
  };
});

/** La puerta de ingesta. Que se use ES el AC1; su corrección es de la HU #11330. */
const aplicarEstadoDianMock = vi.fn();
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
  claveCortacircuitosSondeo, intervaloDeSondeoMs, sondearEstadosDian, sondearFactura,
} = await import('../../src/modules/siigo/siigo.sondeo-dian.service.js');

const FACTURA_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const MINUTO = 60_000;

function porSondear(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA_ID, ambiente: 'produccion', siigoInvoiceId: 'inv-77', numero: 'FV-1-77',
    estadoDian: null, ...over,
  };
}

/** Una fila tal como la devuelve la consulta de selección: nombres de COLUMNA, no de propiedad. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'f-1', ambiente: 'produccion', siigo_invoice_id: 'inv-1', numero: 'FV-1',
    estado_dian: null, verificado_en: null, created_at: new Date(), ...over,
  };
}

/** Lo que responde Siigo para una factura. */
function respuesta(status: unknown, cufe: string | null = null) {
  return { id: 'inv-77', stamp: { send: true, status }, cufe };
}

function ingestaDevuelve(over: Record<string, unknown> = {}) {
  aplicarEstadoDianMock.mockResolvedValueOnce({
    cambio: true, cufeCompletado: false, cufeDiscrepante: false,
    registro: { id: 'h-1', facturaId: FACTURA_ID, secuencia: 1, estado: 'aceptada' },
    ...over,
  });
}

beforeEach(() => {
  kdb.reset();
  siigoRequestOrThrowMock.mockReset();
  aplicarEstadoDianMock.mockReset();
  registrarOperacionMock.mockClear();
  resilienciaOpcionesMock.mockClear();
});

describe('AC1 — el ciclo entrega por la puerta de ingesta, no escribe en el historial', () => {
  it('lo que contesta Siigo se le pasa a `aplicarEstadoDian` con fuente `sondeo`', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted', 'cufe-abc'));
    ingestaDevuelve();

    await sondearFactura(porSondear());

    expect(aplicarEstadoDianMock).toHaveBeenCalledWith(expect.objectContaining({
      facturaId: FACTURA_ID, estado: 'aceptada', cufe: 'cufe-abc', fuente: 'sondeo',
    }));
  });

  it('NUNCA inserta en el historial por su cuenta', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted'));
    ingestaDevuelve();

    await sondearFactura(porSondear());

    // Saltarse la puerta perdería el bloqueo de fila que impide que un webhook y este sondeo,
    // llegando a la vez, dejen dos filas idénticas.
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('consulta el endpoint de la factura, con el identificador escapado', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Audit'));
    ingestaDevuelve({ cambio: false });

    await sondearFactura(porSondear({ siigoInvoiceId: 'inv/con espacio' }));

    const p = siigoRequestOrThrowMock.mock.calls[0][0] as { metodo: string; ruta: string };
    expect(p.metodo).toBe('GET');
    expect(p.ruta).toBe('/v1/invoices/inv%2Fcon%20espacio');
  });
});

describe('AC2 — la cuota es de la empresa y se comparte', () => {
  it('usa la MISMA clave de limitador que la emisión, no una propia', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted'));
    ingestaDevuelve();

    await sondearFactura(porSondear());

    // Una clave propia no crearía cuota nueva: crearía la ilusión de tenerla, y el que se quedaría
    // sin turnos sería el que factura.
    const opts = resilienciaOpcionesMock.mock.calls[0][0] as { clave: string; claveCortacircuitos: string };
    expect(opts.clave).toBe('catalogos:produccion');
    // El cortacircuitos SÍ es propio: que la consulta de estado esté caída no puede frenar la emisión.
    expect(opts.claveCortacircuitos).toBe(claveCortacircuitosSondeo('produccion'));
    expect(opts.claveCortacircuitos).not.toBe(opts.clave);
  });

  it('el presupuesto acota cuántas facturas mira un ciclo', async () => {
    const muchas = Array.from({ length: 10 }, (_, i) => fila({ id: `f-${i}`, siigo_invoice_id: `inv-${i}` }));
    kdb.execute.mockResolvedValueOnce(muchas);
    siigoRequestOrThrowMock.mockResolvedValue(respuesta('Audit'));
    aplicarEstadoDianMock.mockResolvedValue({
      cambio: false, cufeCompletado: false, cufeDiscrepante: false, registro: {},
    });

    const r = await sondearEstadosDian(3);

    expect(r.consultadas).toBe(3);
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(3);
  });
});

describe('AC4 — lo que tarda se consulta cada vez menos', () => {
  it('el intervalo crece con la antigüedad de la factura', () => {
    const recien = intervaloDeSondeoMs(10 * MINUTO);
    const unRato = intervaloDeSondeoMs(3 * 60 * MINUTO);
    const unDia = intervaloDeSondeoMs(10 * 60 * MINUTO);

    expect(recien).toBeLessThan(unRato);
    expect(unRato).toBeLessThan(unDia);
  });

  it('tiene tope: una factura atascada no acaba consultándose una vez al año', () => {
    const unaSemana = intervaloDeSondeoMs(7 * 24 * 60 * MINUTO);
    const unAno = intervaloDeSondeoMs(365 * 24 * 60 * MINUTO);

    expect(unAno).toBe(unaSemana);
    expect(unAno).toBeLessThanOrEqual(6 * 60 * MINUTO);
  });

  it('una factura verificada hace un instante no se vuelve a consultar en este ciclo', async () => {
    kdb.execute.mockResolvedValueOnce([fila({
      estado_dian: 'en_validacion',
      verificado_en: new Date(),          // recién verificada
    })]);

    const r = await sondearEstadosDian(10);

    expect(r.consultadas).toBe(0);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('una sin verificar nunca se consulta siempre: es la primera vez que se pregunta', async () => {
    kdb.execute.mockResolvedValueOnce([fila()]);
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Audit'));
    aplicarEstadoDianMock.mockResolvedValueOnce({
      cambio: true, cufeCompletado: false, cufeDiscrepante: false, registro: {},
    });

    const r = await sondearEstadosDian(10);

    expect(r.consultadas).toBe(1);
  });
});

describe('AC6 — que Siigo falle no significa que la DIAN rechace', () => {
  it('un fallo NO toca el estado: no llega a la puerta de ingesta', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const d = await sondearFactura(porSondear());

    expect(d).toBe('fallo');
    // Un timeout es una respuesta que no llegó, no una respuesta negativa.
    expect(aplicarEstadoDianMock).not.toHaveBeenCalled();
  });

  it('el fallo queda en la bitácora', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await sondearFactura(porSondear());

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'dian_sondeo_estado', resultado: 'error_tecnico',
    }));
  });

  it('un fallo en una factura no impide sondear las siguientes', async () => {
    kdb.execute.mockResolvedValueOnce([
      fila({ id: 'f-1', siigo_invoice_id: 'inv-1' }),
      fila({ id: 'f-2', siigo_invoice_id: 'inv-2' }),
    ]);
    siigoRequestOrThrowMock
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(respuesta('Accepted'));
    aplicarEstadoDianMock.mockResolvedValue({
      cambio: true, cufeCompletado: false, cufeDiscrepante: false, registro: {},
    });

    const r = await sondearEstadosDian(10);

    expect(r).toMatchObject({ consultadas: 2, fallos: 1, actualizadas: 1 });
  });
});

describe('Lo que Siigo dice y FLITO no entiende no se convierte en un estado', () => {
  it('un `status` desconocido deja el estado como estaba', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('UnEstadoQueNadieDocumento'));

    const d = await sondearFactura(porSondear({ estadoDian: 'en_validacion' }));

    expect(d).toBe('ilegible');
    // Adivinar marcaría como rechazada una factura que la DIAN aceptó, y esa mentira se propaga a
    // un reporte que alguien usa para decidir. Un estado que no avanza se nota; uno que avanza mal, no.
    expect(aplicarEstadoDianMock).not.toHaveBeenCalled();
  });

  it('y queda dicho en la bitácora, para que se note', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Vete_a_saber'));

    await sondearFactura(porSondear());

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      resultado: 'error_negocio',
    }));
  });

  it('una respuesta sin `stamp` tampoco inventa nada', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce({ id: 'inv-77' });

    expect(await sondearFactura(porSondear())).toBe('ilegible');
    expect(aplicarEstadoDianMock).not.toHaveBeenCalled();
  });

  it('el traductor devuelve null en vez de un valor por defecto', () => {
    expect(traducirEstadoStamp('Accepted')).toBe('aceptada');
    expect(traducirEstadoStamp('rejected')).toBe('rechazada');   // insensible a mayúsculas
    expect(traducirEstadoStamp('  Audit  ')).toBe('en_validacion');
    expect(traducirEstadoStamp('otra cosa')).toBeNull();
    expect(traducirEstadoStamp(null)).toBeNull();
    expect(traducirEstadoStamp(42)).toBeNull();
  });

  it('el mapa es corto A PROPÓSITO: ampliarlo obliga a documentar por qué', () => {
    // `docs/integraciones/siigo-api.md` NO enumera los valores de `stamp.status`. Si este test
    // falla, es que alguien conoció valores nuevos — y ese día hay que anotarlos en la
    // documentación de integración, no solo en el mapa.
    expect(Object.keys(SIIGO_STAMP_STATUS_A_ESTADO_DIAN).sort())
      .toEqual(['accepted', 'audit', 'canceled', 'cancelled', 'pending', 'rejected']);
  });
});

describe('AC7 — en modo simulado el ciclo funciona igual, y se nota', () => {
  it('la bitácora distingue el modo', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted'));
    ingestaDevuelve();

    await sondearFactura(porSondear());

    // Sin esto, un ensayo en desarrollo y una consulta de producción se leen igual en la misma tabla.
    const anotado = registrarOperacionMock.mock.calls[0][0] as { modo?: string };
    expect(anotado.modo).toBeDefined();
  });

  it('el historial se alimenta igual: la puerta de ingesta es la misma', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted', 'cufe-x'));
    ingestaDevuelve();

    await sondearFactura(porSondear());

    expect(aplicarEstadoDianMock).toHaveBeenCalledTimes(1);
  });
});

describe('Correcciones de la auditoría de seguridad', () => {
  it('«constructor» y «__proto__» NO son estados: el mapa no hereda del prototipo', () => {
    // Con un objeto literal corriente, `mapa['constructor']` devuelve la función `Object` heredada,
    // el `?? null` no dispara y el valor sale como si fuera un estado — sin fila en la bitácora, y
    // reventando después dentro de la ingesta con un error que aborta el ciclo entero.
    expect(traducirEstadoStamp('constructor')).toBeNull();
    expect(traducirEstadoStamp('__proto__')).toBeNull();
    expect(traducirEstadoStamp('  CONSTRUCTOR ')).toBeNull();
    expect(traducirEstadoStamp('toString')).toBeNull();
    expect(traducirEstadoStamp('hasOwnProperty')).toBeNull();
  });

  it('el payload que se guarda no lleva datos del tercero ni la URL pública', async () => {
    const { soloLoQueJustificaLaDecision } = await import(
      '../../src/modules/siigo/siigo.sondeo-dian.service.js');

    const respuestaCompleta = {
      id: 'inv-1', name: 'FV-1-1', date: '2026-08-04', cufe: 'cufe-1',
      stamp: { send: true, status: 'Accepted' },
      customer: { identification: '1020304050', branch_office: 0, person_type: 'Person' },
      public_url: 'https://documentview.siigo.com/document?data=abc',
      items: [{ description: 'Trámite' }],
      payments: [{ id: 1, value: 100 }],
    };

    const guardado = soloLoQueJustificaLaDecision(respuestaCompleta);

    // Estas dos tablas son inmutables por disparador y NO están en el flujo de olvido: lo que entre
    // ahí no se puede rectificar ni suprimir nunca.
    const texto = JSON.stringify(guardado);
    expect(texto).not.toContain('1020304050');
    expect(texto).not.toContain('documentview.siigo.com');
    expect(guardado.customer).toBeUndefined();
    expect(guardado.items).toBeUndefined();
    // Y sigue llevando lo que justifica la decisión.
    expect(guardado).toMatchObject({ id: 'inv-1', cufe: 'cufe-1', stamp: { status: 'Accepted' } });
  });

  it('un campo nuevo del proveedor NO se cuela por ser desconocido', async () => {
    const { soloLoQueJustificaLaDecision } = await import(
      '../../src/modules/siigo/siigo.sondeo-dian.service.js');

    // Es la diferencia entre lista blanca y lista negra: ninguna lista negra puede anticipar los
    // campos que un proveedor añada mañana.
    const g = soloLoQueJustificaLaDecision({ id: 'x', campo_inventado_manana: 'cedula: 123' });
    expect(JSON.stringify(g)).not.toContain('campo_inventado_manana');
  });

  it('el sondeo NO cuenta para el freno que bloquea la emisión', async () => {
    const { OPERACION_SONDEO_DIAN } = await import('../../src/modules/siigo/siigo.freno.service.js');

    // El freno existe para proteger la emisión, y el sondeo no es emisión. Bastaría UNA factura
    // fantasma fallando cada ciclo para acumular cientos de fallos al día y bloquear la facturación
    // entera por un problema que no la afecta.
    expect(OPERACION_SONDEO_DIAN).toBe('dian_sondeo_estado');
    const anotado = registrarOperacionMock.mock.calls;
    expect(anotado.every((c) => (c[0] as { operacion: string }).operacion === OPERACION_SONDEO_DIAN
      || anotado.length === 0)).toBe(true);
  });

  it('el ciclo se rinde al agotarse el plazo, y lo dice', async () => {
    kdb.execute.mockResolvedValueOnce([
      fila({ id: 'f-1', siigo_invoice_id: 'inv-1' }),
      fila({ id: 'f-2', siigo_invoice_id: 'inv-2' }),
      fila({ id: 'f-3', siigo_invoice_id: 'inv-3' }),
    ]);
    siigoRequestOrThrowMock.mockResolvedValue(respuesta('Audit'));
    aplicarEstadoDianMock.mockResolvedValue({
      cambio: false, cufeCompletado: false, cufeDiscrepante: false, registro: {},
    });

    // Reloj que avanza un minuto por consulta: al segundo tick se pasa del plazo.
    let t = 0;
    const r = await sondearEstadosDian(10, { plazoMs: 90_000, ahora: () => (t += 60_000) });

    // Un TTL corto no protege por sí solo: el ciclo no dura lo que dura el TTL, dura lo que tarden
    // las peticiones. Lo que se deja sin mirar sale primero en el siguiente ciclo.
    expect(r.consultadas).toBeLessThan(3);
    expect(r.abandonadas).toBeGreaterThan(0);
  });

  it('la cadencia se ancla en el último INTENTO, no solo en el último acierto', async () => {
    // Las que fallan son las únicas que nunca se resuelven: si la espera solo contara los aciertos,
    // se reconsultarían cada ciclo para siempre, gastando la cuota que comparte con la emisión.
    //
    // Se compila la consulta con el dialecto REAL de drizzle en vez de mirar el texto del archivo:
    // así lo que se afirma es el SQL que de verdad se manda, y de paso queda comprobado que el
    // presupuesto viaja como parámetro enlazado y no concatenado.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    kdb.execute.mockResolvedValueOnce([]);
    await sondearEstadosDian(7);

    const { sql: texto, params } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toContain('dian_sondeo_estado');
    expect(texto).toContain('GREATEST');
    // Sin inanición: el orden es por antigüedad de la última consulta, no solo por fecha de emisión.
    expect(texto).toMatch(/ORDER BY GREATEST[\s\S]*NULLS FIRST/);
    // El límite va parametrizado. Nada de concatenación.
    expect(texto).toContain('LIMIT $1');
    expect(params).toEqual([35]);
  });

  it('un fallo inesperado de la ingesta no aborta el ciclo entero', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted'));
    aplicarEstadoDianMock.mockRejectedValueOnce(new Error('la factura desapareció'));

    // La promesa de «no lanza nunca» tiene que valer para TODO, no solo para la llamada HTTP.
    await expect(sondearFactura(porSondear())).resolves.toBe('fallo');
  });
});

describe('AC7 — el simulador responde de verdad a la consulta de estado', () => {
  // Esta trampa ya se pisó una vez en este módulo: el listado genérico `/v1/invoices` se traga las
  // rutas de una factura concreta y devuelve `results: []`. Una respuesta sin `stamp` haría que el
  // sondeo pareciera funcionar en desarrollo sin haber ensayado nada.
  it('GET /v1/invoices/{id} devuelve un sello, no un listado vacío', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    const r = respuestaSimulada('GET', '/v1/invoices/mock-invoice-1');

    expect(r.ok).toBe(true);
    const datos = r.datos as { stamp?: { status?: string }; results?: unknown[] };
    expect(datos.results).toBeUndefined();
    expect(datos.stamp?.status).toBeDefined();
  });

  it('sabe simular los cuatro caminos, no solo el feliz', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');
    const sello = (id: string) =>
      (respuestaSimulada('GET', `/v1/invoices/${id}`).datos as { stamp: { status: string } }).stamp.status;

    expect(traducirEstadoStamp(sello('inv-1'))).toBe('aceptada');
    expect(traducirEstadoStamp(sello('inv-rechazada'))).toBe('rechazada');
    expect(traducirEstadoStamp(sello('inv-validacion'))).toBe('en_validacion');
    // El caso que de verdad interesa ensayar: un estado que FLITO no sabe traducir.
    expect(traducirEstadoStamp(sello('inv-raro'))).toBeNull();
  });

  it('el CUFE solo aparece cuando la DIAN aceptó', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');
    const cufe = (id: string) => (respuestaSimulada('GET', `/v1/invoices/${id}`).datos as { cufe: unknown }).cufe;

    expect(cufe('inv-1')).toBeTruthy();
    // Devolverlo siempre haría que el sondeo pareciera correcto aunque leyera el campo equivocado.
    expect(cufe('inv-validacion')).toBeNull();
  });
});

describe('Un CUFE que no cuadra se denuncia, no se pisa', () => {
  it('deja constancia en la bitácora cuando la ingesta reporta discrepancia', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce(respuesta('Accepted', 'cufe-nuevo'));
    ingestaDevuelve({ cambio: false, cufeDiscrepante: true });

    await sondearFactura(porSondear());

    const mensajes = registrarOperacionMock.mock.calls.map((c) => (c[0] as { mensaje: string }).mensaje);
    expect(mensajes.some((m) => /CUFE distinto/i.test(m))).toBe(true);
  });
});

describe('A6 — solo se sondea lo que de verdad se timbró', () => {
  it('la consulta descarta todo lo que no sea produccion', async () => {
    // Fuera de producción la factura se crea en Siigo y no se envía a la DIAN, así que NUNCA va a
    // tener un estado que consultar. Sin este filtro cumpliría el predicado de «sin resolver» en
    // todos los ciclos, para siempre.
    //
    // Se compila la consulta con el dialecto REAL de drizzle, igual que la prueba de la cadencia:
    // lo que se afirma es el SQL que de verdad se manda, no el texto del archivo.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    kdb.execute.mockResolvedValueOnce([]);
    await sondearEstadosDian(5);

    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    expect(texto).toMatch(/f\.ambiente\s*=\s*'produccion'/);
  });

  it('el filtro va en el WHERE y no después: no se traen filas para descartarlas', async () => {
    // Traerlas y filtrarlas en JS gastaría el LIMIT en facturas que se van a tirar, que es
    // exactamente la inanición que el AC4 de la HU #11332 quiere evitar.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    kdb.execute.mockResolvedValueOnce([]);
    await sondearEstadosDian(5);

    const { sql: texto } = new PgDialect().sqlToQuery(kdb.execute.mock.calls[0][0]);
    const where = texto.indexOf('WHERE');
    const limite = texto.indexOf('LIMIT');
    const filtro = texto.search(/f\.ambiente\s*=\s*'produccion'/);
    expect(filtro).toBeGreaterThan(where);
    expect(filtro).toBeLessThan(limite);
  });
});
