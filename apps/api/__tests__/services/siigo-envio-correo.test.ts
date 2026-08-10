// Siigo — entrega de la factura por correo y reenvío (HU #11334). Un bloque por criterio.
//
// Se mockean las dos fronteras: el cliente HTTP de Siigo y la base. Lo que se prueba es la
// ORQUESTACIÓN —qué se comprueba antes de gastar una petición, qué queda escrito cuando sale bien,
// cuando sale mal y cuando no sale— y no volver a probar esas dos piezas.
//
// Lo que NO se puede afirmar contra un mock de drizzle: que el disparador de la migración 0141
// rechace un UPDATE que no sea la purga. Eso se verificó contra PostgreSQL 16 real con savepoints
// (siete casos) y su garantía vive en la base, no aquí.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SIIGO_ENVIO_MAX_DESTINATARIOS } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

/** Paso directo: los reintentos con espera harían que cada caso de fallo tardara segundos. */
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const {
  enviarFacturaPorCorreo, facturaEnviable, registrarEnvioDeEmision, resolverDestinatarios,
  purgarDestinatariosDeClientes, redactarCorreos, resumenEnvios, SiigoEnvioError,
  validarDestinatarios,
} = await import('../../src/modules/siigo/siigo.envio-correo.service.js');

const FACTURA_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

function factura(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA_ID,
    ambiente: 'produccion',
    siigoInvoiceId: 'siigo-inv-9',
    numero: 'FV-1-42',
    estado: 'emitida',
    clienteEmail: 'facturacion@transportes.test',
    clienteContactEmail: 'contadora@transportes.test',
    ...over,
  };
}

/** Devuelve el acta que el servicio acaba de insertar, tal como haría el RETURNING. */
function elInsertDevuelveElActa() {
  kdb.when.insert('siigo_factura_envios', () => [{
    id: 'acta-1',
    facturaId: FACTURA_ID,
    origen: 'reenvio',
    resultado: 'enviado',
    destinatarios: [],
    destinatariosPurgadosEn: null,
    codigo: null,
    motivo: null,
    solicitadoPor: 7,
    createdAt: new Date('2026-08-10T12:00:00.000Z'),
  }]);
}

beforeEach(() => {
  kdb.reset();
  siigoRequestOrThrowMock.mockReset();
  registrarOperacionMock.mockClear();
});

describe('AC2 — los destinatarios se resuelven, no se escriben a mano', () => {
  it('el destinatario es el correo de la compañía y queda dicho de dónde salió', () => {
    const d = resolverDestinatarios({ email: 'pagos@empresa.test', contactEmail: 'otra@empresa.test' });
    expect(d).toEqual([{ correo: 'pagos@empresa.test', origen: 'compania' }]);
  });

  it('no hay ninguna dirección fija en el código: sin ficha, no hay destinatarios', () => {
    expect(resolverDestinatarios({ email: null, contactEmail: null })).toEqual([]);
    expect(resolverDestinatarios({ email: '   ', contactEmail: 'contacto@x.test' })).toEqual([]);
  });

  it('el contacto fiscal NO se incluye todavía: es una pregunta de contabilidad sin responder', () => {
    // Si algún día esto falla, es que alguien respondió la pregunta — y entonces hay que
    // documentarlo, no cambiar el test para que pase.
    const d = resolverDestinatarios({ email: 'compania@x.test', contactEmail: 'fiscal@x.test' });
    expect(d.map((x) => x.correo)).not.toContain('fiscal@x.test');
  });
});

describe('AC6 — el tope y el formato se respetan ANTES de llamar', () => {
  const uno = (correo: string) => ({ correo, origen: 'manual' as const });

  it('ninguna dirección válida se filtra tampoco al mensaje del tope', () => {
    const seis = Array.from({ length: 6 }, (_, i) => uno(`persona${i}@empresa.test`));
    expect(validarDestinatarios(seis)?.mensaje).not.toMatch(/@/);
  });

  it('seis direcciones se rechazan diciendo cuál es el tope', () => {
    const seis = Array.from({ length: 6 }, (_, i) => uno(`d${i}@x.test`));
    const p = validarDestinatarios(seis);
    expect(p?.codigo).toBe('demasiados_destinatarios');
    expect(p?.mensaje).toContain(String(SIIGO_ENVIO_MAX_DESTINATARIOS));
  });

  it('cinco direcciones pasan: el tope es cinco, no cuatro', () => {
    const cinco = Array.from({ length: 5 }, (_, i) => uno(`d${i}@x.test`));
    expect(validarDestinatarios(cinco)).toBeNull();
  });

  it('una dirección con formato inválido se rechaza señalando su POSICIÓN, no su valor', () => {
    const p = validarDestinatarios([uno('bien@x.test'), uno('esto-no-es-un-correo')]);
    expect(p?.codigo).toBe('destinatario_invalido');
    expect(p?.mensaje).toContain('2');
    // El mensaje acaba en `motivo`, que la purga por derecho de supresión NO vacía. Escribir ahí la
    // dirección abriría una copia permanente e inalcanzable de un dato personal.
    expect(p?.mensaje).not.toContain('esto-no-es-un-correo');
  });

  it('no se gasta ni una petición cuando el envío no puede salir', async () => {
    kdb.when.select('siigo_facturas', [factura({ clienteEmail: null })]);
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-x', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'no_realizado',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: 'cliente_sin_correo',
      motivo: 'falta', solicitadoPor: null, createdAt: new Date(),
    }]);

    await enviarFacturaPorCorreo(FACTURA_ID);

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

describe('AC3 — un cliente sin correo no dispara un envío a la nada', () => {
  beforeEach(() => {
    kdb.when.select('siigo_facturas', [factura({ clienteEmail: null })]);
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-2', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'no_realizado',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: 'cliente_sin_correo',
      motivo: 'El cliente no tiene un correo registrado en su ficha.',
      solicitadoPor: null, createdAt: new Date(),
    }]);
  });

  it('no se llama a Siigo y el intento queda como no realizado, no como fallido', async () => {
    const acta = await enviarFacturaPorCorreo(FACTURA_ID);

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    // La distinción es el AC entero: `fallido` invitaría a reintentar algo que va a volver a no
    // salir; `no_realizado` dice que falta un dato y quién debe completarlo.
    expect(acta.resultado).toBe('no_realizado');
    expect(acta.codigo).toBe('cliente_sin_correo');
  });

  it('el motivo dice qué falta, no solo que falló', async () => {
    const acta = await enviarFacturaPorCorreo(FACTURA_ID);
    expect(acta.motivo).toMatch(/correo/i);
  });
});

describe('AC5 — no se reenvía lo que no existe todavía en Siigo', () => {
  it('una factura en proceso se rechaza sin gastar cuota', async () => {
    kdb.when.select('siigo_facturas', [factura({ estado: 'en_proceso', siigoInvoiceId: null })]);

    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toThrow(SiigoEnvioError);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('una fallida tampoco se envía', async () => {
    kdb.when.select('siigo_facturas', [factura({ estado: 'fallida', siigoInvoiceId: null })]);
    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toMatchObject({
      codigo: 'factura_no_emitida',
    });
  });

  it('«emitida» sin identificador de Siigo no basta: sin él no hay ni ruta a la que llamar', () => {
    expect(facturaEnviable({ estado: 'emitida', siigoInvoiceId: null })).toBe(false);
    expect(facturaEnviable({ estado: 'emitida', siigoInvoiceId: '  ' })).toBe(false);
    expect(facturaEnviable({ estado: 'emitida', siigoInvoiceId: 'inv-1' })).toBe(true);
  });

  it('una factura que no existe da un fallo distinto del de no emitida', async () => {
    kdb.when.select('siigo_facturas', []);
    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toMatchObject({ codigo: 'no_existe' });
  });
});

describe('AC1 — cada envío queda registrado', () => {
  it('se pide a Siigo por su endpoint de correo, con las direcciones resueltas', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    elInsertDevuelveElActa();
    siigoRequestOrThrowMock.mockResolvedValueOnce({ mail: { send: true } });

    await enviarFacturaPorCorreo(FACTURA_ID, { solicitadoPor: 7 });

    const peticion = siigoRequestOrThrowMock.mock.calls[0][0] as { metodo: string; ruta: string; cuerpo: unknown };
    expect(peticion.metodo).toBe('POST');
    expect(peticion.ruta).toBe('/v1/invoices/siigo-inv-9/mail');
    expect(peticion.cuerpo).toEqual({ mail_to: ['facturacion@transportes.test'] });
  });

  it('un envío fallido queda registrado como fallido: no se pierde ni lanza', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-3', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'fallido',
      destinatarios: [{ correo: 'facturacion@transportes.test', origen: 'compania' }],
      destinatariosPurgadosEn: null, codigo: 'siigo_rechazo', motivo: 'Siigo respondió 500',
      solicitadoPor: 7, createdAt: new Date(),
    }]);
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('Siigo respondió 500'));

    // No lanza: quien reenvía necesita ver en la pantalla qué pasó la vez anterior.
    const acta = await enviarFacturaPorCorreo(FACTURA_ID, { solicitadoPor: 7 });

    expect(acta.resultado).toBe('fallido');
    expect(kdb.insert).toHaveBeenCalled();
  });

  it('la bitácora anota cuántas direcciones, nunca cuáles', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    elInsertDevuelveElActa();
    siigoRequestOrThrowMock.mockResolvedValueOnce({ mail: { send: true } });

    await enviarFacturaPorCorreo(FACTURA_ID, { solicitadoPor: 7 });

    const anotado = JSON.stringify(registrarOperacionMock.mock.calls);
    expect(anotado).not.toContain('facturacion@transportes.test');
    expect(anotado).toContain('1 destinatario');
  });
});

describe('AC4 — el reenvío deja rastro y no borra el anterior', () => {
  const acta = (over: Record<string, unknown>) => ({
    id: 'x', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'enviado',
    destinatarios: [], destinatariosPurgadosEn: null, codigo: null, motivo: null,
    solicitadoPor: null, createdAt: new Date('2026-08-01T10:00:00.000Z'), ...over,
  });

  it('cuenta los envíos y devuelve el más reciente primero', async () => {
    kdb.when.select('siigo_factura_envios', [
      acta({ id: 'nuevo', createdAt: new Date('2026-08-10T10:00:00.000Z') }),
      acta({ id: 'viejo' }),
    ]);

    const r = await resumenEnvios(FACTURA_ID);

    expect(r.veces).toBe(2);
    expect(r.ultimo?.id).toBe('nuevo');
    // El anterior se conserva: reenviar añade, no sustituye.
    expect(r.envios.map((e) => e.id)).toEqual(['nuevo', 'viejo']);
  });

  it('si el último intento falló, sigue diciendo cuándo el cliente SÍ recibió algo', async () => {
    kdb.when.select('siigo_factura_envios', [
      acta({ id: 'fallo-hoy', resultado: 'fallido', createdAt: new Date('2026-08-10T10:00:00.000Z') }),
      acta({ id: 'ok-hace-un-mes' }),
    ]);

    const r = await resumenEnvios(FACTURA_ID);

    // Colapsar los dos campos haría que una factura entregada hace un mes pareciera no entregada.
    expect(r.ultimo?.id).toBe('fallo-hoy');
    expect(r.ultimoEnviado?.id).toBe('ok-hace-un-mes');
    expect(r.vecesEnviado).toBe(1);
  });

  it('una factura que nunca se envió lo dice sin inventar filas', async () => {
    kdb.when.select('siigo_factura_envios', []);
    const r = await resumenEnvios(FACTURA_ID);
    expect(r).toMatchObject({ veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null });
  });
});

describe('La puerta de purga cubre TODAS las columnas del acta', () => {
  // El encabezado de la migración 0141 promete que «una columna nueva tiene que entrar por esta
  // lista a mano — un olvido tiene que romper el test». Este es ese test.
  //
  // El disparador enumera columna por columna en vez de comparar la fila entera, precisamente para
  // que añadir una columna sin decidir de qué lado cae sea imposible por descuido. Aquí se compara
  // la lista real de la tabla drizzle contra la que el SQL nombra: si alguien añade una columna y
  // no toca el disparador, esa columna sería silenciosamente mutable dentro de la purga.
  it('el disparador nombra cada columna, o la purga podría cambiarla sin que nadie lo note', async () => {
    const { getTableColumns } = await import('drizzle-orm');
    const { siigoFacturaEnvios } = await import('../../src/db/schema.js');
    const { readFileSync } = await import('node:fs');

    const sqlMigracion = readFileSync(
      new URL('../../src/db/migrations/0141_siigo_factura_envios.sql', import.meta.url), 'utf8',
    );
    const puerta = sqlMigracion.slice(
      sqlMigracion.indexOf("IF TG_OP = 'UPDATE'"), sqlMigracion.indexOf('RETURN NEW;'),
    );

    const columnasSql = Object.values(getTableColumns(siigoFacturaEnvios)).map((c) => c.name);
    expect(columnasSql.length).toBeGreaterThan(0);

    for (const columna of columnasSql) {
      // Cada columna aparece en el guard: o se exige idéntica, o es una de las dos que la purga
      // toca (`destinatarios`, `destinatarios_purgados_en`).
      expect(puerta, `la columna «${columna}» no aparece en la puerta del disparador`)
        .toContain(columna);
    }
  });
});

describe('Ley 1581 — las direcciones solo viven donde se pueden purgar', () => {
  it('lo que contesta Siigo se redacta antes de guardarse en `motivo`', () => {
    expect(redactarCorreos('Rechazado: juan.perez@cliente.test no existe'))
      .toBe('Rechazado: [correo] no existe');
    expect(redactarCorreos('a@x.test y b@y.test')).toBe('[correo] y [correo]');
    expect(redactarCorreos('Sin direcciones aquí')).toBe('Sin direcciones aquí');
  });

  it('el motivo de un fallo de Siigo no conserva la dirección que Siigo devolvió', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-r', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'fallido',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: 'siigo_rechazo',
      motivo: null, solicitadoPor: null, createdAt: new Date(),
    }]);
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      new Error('mail_to inválido: facturacion@transportes.test rebotó'),
    );

    await enviarFacturaPorCorreo(FACTURA_ID);

    // Se afirma sobre la bitácora porque recibe EL MISMO valor que se guarda en `motivo` —una sola
    // variable alimenta a los dos— y sus argumentos sí son inspeccionables, mientras que los del
    // insert arrastran la tabla de drizzle, que es circular.
    //
    // Aquí hay dos defensas y esta prueba solo cruza la primera: `motivoLegible` traduce la mayoría
    // de los fallos a un catálogo cerrado de frases nuestras, así que el texto del proveedor no
    // llega. La que NO traduce es `SiigoApiError.descripcionOperativa`, que sí puede llevar el texto
    // de Siigo — y ese es el hueco que tapa `redactarCorreos`, probado por separado arriba.
    const anotado = JSON.stringify(registrarOperacionMock.mock.calls);
    expect(anotado).not.toContain('facturacion@transportes.test');
  });
});

describe('La purga alcanza lo que dice alcanzar', () => {
  it('sin compañías y sin correos no consulta nada: no hay a quién olvidar', async () => {
    expect(await purgarDestinatariosDeClientes([], [])).toBe(0);
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('busca aunque no haya compañías, si hay un correo del titular', async () => {
    // Es el caso 2 del hallazgo: una dirección escrita a mano en la factura de OTRA empresa. La
    // búsqueda por compañía no la ve, y el titular pediría supresión y se le diría que se hizo.
    kdb.when.select('siigo_factura_envios', [{ id: 'acta-1' }]);
    kdb.when.update('siigo_factura_envios', () => [{ id: 'acta-1' }]);

    expect(await purgarDestinatariosDeClientes([], ['juan@titular.test'])).toBe(1);
    expect(kdb.update).toHaveBeenCalled();
  });

  it('busca aunque no haya correos, si hay compañías', async () => {
    kdb.when.select('siigo_factura_envios', [{ id: 'acta-2' }]);
    kdb.when.update('siigo_factura_envios', () => [{ id: 'acta-2' }]);

    expect(await purgarDestinatariosDeClientes([42], [])).toBe(1);
  });

  it('las direcciones en blanco no cuentan como criterio de búsqueda', async () => {
    // Un `clients.email` vacío no puede convertirse en «purga todo lo que tenga una dirección».
    expect(await purgarDestinatariosDeClientes([], ['', '   '])).toBe(0);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('si no hay actas que redactar no toca la tabla: llamar dos veces no falla', async () => {
    kdb.when.select('siigo_factura_envios', []);

    expect(await purgarDestinatariosDeClientes([42], ['x@y.test'])).toBe(0);
    // El disparador rechaza volver a purgar una fila ya redactada, así que un UPDATE de más
    // abortaría la transacción entera del olvido.
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('AC7 — frontera con la emisión', () => {
  it('el correo que produjo la creación se anota con origen `emision`, no `reenvio`', async () => {
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-em', facturaId: FACTURA_ID, origen: 'emision', resultado: 'enviado',
      destinatarios: [{ correo: 'c@x.test', origen: 'compania' }], destinatariosPurgadosEn: null,
      codigo: null, motivo: null, solicitadoPor: null, createdAt: new Date(),
    }]);

    const acta = await registrarEnvioDeEmision(FACTURA_ID, {
      enviado: true,
      destinatarios: [{ correo: 'c@x.test', origen: 'compania' }],
    });

    expect(acta.origen).toBe('emision');
    // Sin persona: la creación no la pidió nadie pulsando un botón.
    expect(acta.solicitadoPor).toBeNull();
  });

  it('esta historia NO reimplementa el envío de la creación: registrar no llama a Siigo', async () => {
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-em2', facturaId: FACTURA_ID, origen: 'emision', resultado: 'no_realizado',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: 'emision_sin_correo',
      motivo: 'Siigo no envió el correo al crear la factura.', solicitadoPor: null,
      createdAt: new Date(),
    }]);

    const acta = await registrarEnvioDeEmision(FACTURA_ID, { enviado: false, destinatarios: [] });

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    // `enviado` sale de lo que Siigo contestó, no de lo que pedimos: pedir no es enviar.
    expect(acta.resultado).toBe('no_realizado');
  });
});
