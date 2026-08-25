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
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

/**
 * Todo lo que el servicio loguea. El log es la tercera vía por la que una dirección devuelta por
 * Siigo puede salir del proceso, y la única que NINGUNA purga alcanza: `logger.redact` solo cubre
 * credenciales y un fichero de logs no se rectifica ni se suprime (Ley 1581, art. 8 d y e).
 */
const logueado: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { logueado.push(a); },
  info: (...a: unknown[]) => { logueado.push(a); },
  warn: (...a: unknown[]) => { logueado.push(a); },
  error: (...a: unknown[]) => { logueado.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

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
  correoDelTitularEn, correosDeBusqueda,
  enviarFacturaPorCorreo, facturaEnviable, registrarEnvioDeEmision, resolverDestinatarios,
  purgarDestinatariosDeClientes, redactarCorreos, resumenEnvios, SiigoEnvioError,
  validarDestinatarios,
} = await import('../../src/modules/siigo/siigo.envio-correo.service.js');
const { traducirErrorSiigo } = await import('../../src/modules/siigo/siigo.errors.js');

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
  espia.reiniciar();
  logueado.length = 0;
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

  it('la dirección escapada en una URL (`%40`) también se redacta', () => {
    // El escape que se colaba. Los errores de una API HTTP citan la ruta que falló, y en una ruta la
    // arroba va percent-encoded: `CONTA%40EMPRESA.COM` es la misma dirección y para quien lea la
    // bitácora WORM después es igual de identificable, pero no lleva `@` y el patrón no la veía.
    expect(redactarCorreos('CONTA%40EMPRESA.COM rechazada')).toBe('[correo] rechazada');
    // Dentro de una ruta se lleva por delante la ruta entera, y eso NO es un defecto de este caso:
    // es lo mismo que ya hacía con la arroba literal (`?email=a@b.test` → `[correo]`), porque nada
    // separa la dirección del `?email=` que la precede. Redactar de más en una bitácora que no se
    // puede editar es el lado correcto en el que equivocarse.
    expect(redactarCorreos('404 en /v1/invoices?email=CONTA%40EMPRESA.COM')).toBe('404 en [correo]');
    expect(redactarCorreos('404 en /v1/invoices?email=a@b.test')).toBe('404 en [correo]');
    // Y lo que no es una dirección sigue sin tocarse: el escape no puede volverse un comodín.
    expect(redactarCorreos('descuento del 40% aplicado')).toBe('descuento del 40% aplicado');
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

  it('cuando Siigo devuelve la dirección DENTRO de su error, no queda en el log, ni en la bitácora, ni en `motivo`', async () => {
    // El caso que el test de arriba NO cruza, y él mismo lo admite: un `new Error` corriente lo
    // traduce `motivoLegible` a la frase fija «Siigo no respondió», así que el texto del proveedor
    // nunca llega al redactor y quitarlo no rompía nada. Aquí el error se construye como NACE de
    // verdad —`traducirErrorSiigo` sobre el cuerpo de respuesta— y con la dirección ofensora dentro,
    // que es lo que hace un proveedor cuando rechaza un `mail_to`.
    //
    // El `Code` es de Siigo y FLITO no lo controla: cuando el catálogo no lo traduce, se interpola
    // TAL CUAL en la descripción operativa, que es la que acaba en `motivo` y en `siigo_operaciones`.
    // Ese es el hueco real que `redactarCorreos` tapa, y sin este caso estaba sin probar.
    //
    // Las tres vías se afirman por separado porque son tres destinos distintos y ninguno redime a
    // los otros: `motivo` es append-only (la purga solo vacía `destinatarios`), `siigo_operaciones`
    // es WORM por disparador, y el log no lo alcanza ninguna purga.
    const DIRECCION = 'facturacion@transportes.test';
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when.insert('siigo_factura_envios', () => [{
      id: 'acta-r', facturaId: FACTURA_ID, origen: 'reenvio', resultado: 'fallido',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: 'siigo_rechazo',
      motivo: null, solicitadoPor: null, createdAt: new Date(),
    }]);
    const rechazo = traducirErrorSiigo(400, {
      Status: 400,
      Errors: [{
        Code: `invalid_mail_to[${DIRECCION}]`,
        Message: `mail_to inválido: ${DIRECCION}`,
      }],
    });

    // Control: el error SÍ lleva la dirección por las DOS vías que el `catch` redacta. Sin esto, las
    // afirmaciones de abajo pasarían igual con un error que nunca la tuvo, que es exactamente lo que
    // pasaba con el `new Error` del caso anterior.
    expect(rechazo.descripcionOperativa).toContain(DIRECCION); // → `motivo` y `siigo_operaciones`
    expect(rechazo.message).toContain(DIRECCION); // → `detalleTecnico` → log

    // `traducirErrorSiigo` deja constancia del código que el catálogo no traduce, y ese código lleva
    // la dirección dentro (`siigo.errors.ts`, `registrarCodigoDesconocido`). Es un escape REAL y
    // ajeno a esta función —lo emite quien traduce el error, no quien lo captura, y ocurre una sola
    // vez por código y proceso—, así que se descarta aquí para que este caso afirme sobre lo que
    // `enviarFacturaPorCorreo` escribe, que es lo que la mutación cambia. Va inventariado aparte: no
    // se tapa redactando en `siigo.errors`, porque esa misma interpolación es la que hace que la
    // dirección llegue hasta aquí y lo que hay que decidir es si el código crudo debe registrarse.
    logueado.length = 0;

    siigoRequestOrThrowMock.mockRejectedValueOnce(rechazo);

    await enviarFacturaPorCorreo(FACTURA_ID);

    // 1. El log del servidor.
    expect(JSON.stringify(logueado)).not.toContain(DIRECCION);
    // 2. La bitácora WORM.
    expect(JSON.stringify(registrarOperacionMock.mock.calls)).not.toContain(DIRECCION);
    // 3. La columna `motivo` del acta, leída del INSERT real y no de lo que el mock devolvió.
    const escrito = espia.ultimoInsertEn('siigo_factura_envios');
    expect(String(escrito.motivo)).not.toContain(DIRECCION);
    // Y no se pierde el diagnóstico: la marca dice que ahí había una dirección.
    expect(String(escrito.motivo)).toContain('[correo]');
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

  it('alcanza la dirección que se TECLEÓ en mayúsculas y quedó guardada en minúsculas', async () => {
    // Primera mitad del defecto que cerró el retrabajo de la HU #11708. La ficha del cliente dice
    // `Contabilidad@Empresa.com`; alguien escribe esa misma dirección al enviar y la ruta la guarda
    // normalizada. El titular pide el olvido y lo único que el flujo conoce es la forma de la ficha
    // —`clients.email` se lee en crudo—, así que la búsqueda salía con las mayúsculas puestas y la
    // fila que ella misma había producido quedaba viva.
    kdb.when.select('siigo_factura_envios', [{ id: 'acta-1' }]);
    kdb.when.update('siigo_factura_envios', () => [{ id: 'acta-1' }]);

    expect(await purgarDestinatariosDeClientes([], ['  Contabilidad@Empresa.COM '])).toBe(1);

    // Los parámetros del `where` REAL que se ejecutó, serializados como los recibiría PostgreSQL —no
    // lo que el test quiso creer ni lo que el mock devolvió.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { params } = new PgDialect().sqlToQuery(espia.condicionesLeidas().at(-1) as never);

    expect(params).toContain('contabilidad@empresa.com');
    expect(params).not.toContain('  Contabilidad@Empresa.COM ');
  });

  it('y alcanza también la fila ANTIGUA, guardada en forma cruda: la comparación pliega mayúsculas', async () => {
    // Segunda mitad, y la que no se arregla normalizando hacia adelante. Las actas de la HU #11334
    // se escribieron sin normalizar, y las de `origen: 'compania'` copian `clients.email` tal cual.
    // La tabla es append-only —el disparador de la 0141 solo admite la purga—, así que esas filas no
    // se pueden reescribir para uniformarlas: o la consulta pliega mayúsculas, o sobreviven.
    //
    // Se afirma sobre el SQL que se genera porque es lo que la base ejecuta y aquí no hay PostgreSQL
    // (mismo recurso que `finanzas-facturacion-electronica.test.ts`). Lo que se comprueba son las
    // dos mitades de la simetría: el lado GUARDADO baja a minúsculas dentro de la consulta, y el
    // lado del TITULAR llega ya bajado.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { siigoFacturaEnvios } = await import('../../src/db/schema.js');

    const { sql: texto, params } = new PgDialect().sqlToQuery(
      correoDelTitularEn(siigoFacturaEnvios.destinatarios, correosDeBusqueda(['Contabilidad@Empresa.com'])),
    );

    expect(texto).toContain("lower(destinatario.valor ->> 'correo')");
    expect(params).toEqual(['contabilidad@empresa.com']);
    // Y ya NO se compara por contención de jsonb, que es byte a byte y es lo que dejaba viva la
    // forma cruda. Si alguien la reintroduce «para volver a usar el índice GIN», esto se pone rojo.
    expect(texto).not.toContain('@>');
  });

  it('la simetría es completa: el lado guardado también recorta los espacios envolventes', async () => {
    // El lado del titular pasa por `.trim()`; el guardado solo bajaba a minúsculas. Hoy los dos
    // caminos de escritura recortan —los dos esquemas de Zod llevan `.trim()`—, así que no hay fila
    // real que lo necesite; pero las cabeceras de las migraciones 0141 y 0161 contemplan por escrito
    // el `INSERT` «hecho desde otro sitio», y ahí ` a@b.test ` volvería a sobrevivir al olvido.
    // Cuesta una llamada.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { siigoFacturaEnvios } = await import('../../src/db/schema.js');

    const { sql: texto } = new PgDialect().sqlToQuery(
      correoDelTitularEn(siigoFacturaEnvios.destinatarios, correosDeBusqueda(['a@b.test'])),
    );

    expect(texto).toContain("btrim(lower(destinatario.valor ->> 'correo'))");
  });

  it('las direcciones repetidas del titular no se buscan dos veces', async () => {
    // Desde la corrección del bloqueante, el flujo de olvido reúne los correos de siete columnas:
    // la ficha del cliente, cuatro tablas de terceros, las validaciones de trámite y el comprador
    // del trámite digital. Un titular con cincuenta filas en `tenedores` que llevan su mismo correo
    // produciría un `ARRAY[…]` de cincuenta copias en cada una de las dos purgas. Se descartan
    // DESPUÉS de bajar a minúsculas, porque `A@B.test` y `a@b.test` son el mismo buzón.
    expect(correosDeBusqueda(['A@B.test', ' a@b.test ', 'a@b.test', 'otro@b.test']))
      .toEqual(['a@b.test', 'otro@b.test']);
  });

  it('una lista de correos vacía sigue sin ser «todos»: el predicado es falso, no verdadero', async () => {
    // La avería que importa del helper compartido: si con la lista vacía devolviera algo
    // satisfacible, un olvido sin direcciones vaciaría las actas de todo el mundo.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { siigoFacturaEnvios } = await import('../../src/db/schema.js');

    const { sql: texto } = new PgDialect().sqlToQuery(
      correoDelTitularEn(siigoFacturaEnvios.destinatarios, []),
    );

    expect(texto.trim()).toBe('false');
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

describe('A6 — el correo al cliente solo sale de producción', () => {
  it('una factura de pruebas se rechaza antes de tocar la red', async () => {
    // Omitir `mail` al crear la factura cierra la puerta de la emisión, no esta. El destinatario
    // sale de `clients.email`: es la dirección real de una empresa real, y un correo que salió ya
    // lo leyó alguien.
    kdb.when.select('siigo_facturas', [factura({ ambiente: 'pruebas' })]);

    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toMatchObject({
      codigo: 'ambiente_no_productivo',
    });
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('no deja acta: no es un envío que salió mal, es uno que no se intentó', async () => {
    // Un acta de `no_realizado` diría que se evaluaron los destinatarios, y no se llegó ni a eso.
    kdb.when.select('siigo_facturas', [factura({ ambiente: 'pruebas' })]);

    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toThrow(SiigoEnvioError);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('el ambiente manda por encima del estado de la factura', async () => {
    // Una factura de pruebas SIN emitir cumple dos motivos de rechazo. El que se devuelve es el del
    // ambiente, porque es el que sigue siendo cierto cuando el otro deje de serlo: arreglar la
    // factura no va a permitir mandar el correo desde QA.
    kdb.when.select('siigo_facturas', [factura({ ambiente: 'pruebas', estado: 'en_proceso', siigoInvoiceId: null })]);

    await expect(enviarFacturaPorCorreo(FACTURA_ID)).rejects.toMatchObject({
      codigo: 'ambiente_no_productivo',
    });
  });

  it('en producción sigue saliendo, con destinatarios y todo', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    elInsertDevuelveElActa();

    const acta = await enviarFacturaPorCorreo(FACTURA_ID);

    expect(siigoRequestOrThrowMock).toHaveBeenCalled();
    expect(acta.resultado).toBe('enviado');
  });
});
