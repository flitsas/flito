// Siigo — lo que se HACE desde la bandeja de fallidos (HU #11340). AC2, AC3, AC4, AC5, AC6.
//
// **El test que importa de este archivo es el del AC4**, y no se puede escribir mirando el resultado:
// «no se emitió dos veces» no se observa contra una base mockeada. Se comprueba sobre el MECANISMO —
// que este servicio no llama a Siigo, no toca `siigo_facturas` y delega en `encolar`, que es la
// puerta a la cadena donde vive `reclamarFallida()`—. Una implementación que emitiera directamente
// devolvería exactamente lo mismo en el camino feliz, así que un test de resultado la daría por buena.
//
// El segundo es el del AC3: lo que no se arregla reintentando no debe llegar a `encolar` NI gastar
// una petición. Se afirma con `expect(encolarMock).not.toHaveBeenCalled()`, que es lo único que
// distingue «lo descartó» de «lo intentó y le fue mal».

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Si alguien de este servicio sale a la red, que reviente y se vea. */
const siigoRequestOrThrowMock = vi.fn(async () => {
  throw new Error('la bandeja no puede llamar a Siigo para emitir');
});
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: siigoRequestOrThrowMock,
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

const encolarMock = vi.fn();
const descartarDefinitivoMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.cola.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/facturacion.cola.service.js')>();
  return {
    ...real,
    encolar: (...a: unknown[]) => encolarMock(...a),
    descartarDefinitivo: (...a: unknown[]) => descartarDefinitivoMock(...a),
  };
});

const registrarHitoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.linea-tiempo.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.linea-tiempo.service.js')>();
  return { ...real, registrarHito: (d: unknown) => registrarHitoMock(d) };
});

const enviarCorreoMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.envio-correo.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.envio-correo.service.js')>();
  return { ...real, enviarFacturaPorCorreo: (...a: unknown[]) => enviarCorreoMock(...a) };
});

const descartesVigentesMock = vi.fn().mockResolvedValue(new Map());
vi.mock('../../src/modules/siigo/siigo.bandeja.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.bandeja.service.js')>();
  return { ...real, descartesVigentes: (...a: unknown[]) => descartesVigentesMock(...a) };
});

const {
  descartarCaso, normalizarNota, reactivarCaso, reenviarCorreo, reintentarEmision, SiigoBandejaError,
} = await import('../../src/modules/siigo/siigo.bandeja-acciones.service.js');

const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const OTRA = 'ffffffff-2222-4111-8111-ffffffffffff';
const LOTE = 'llllllll-1111-4111-8111-llllllllllll';
const COLA = 'cccccccc-1111-4111-8111-cccccccccccc';
const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ACTA = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const AHORA = new Date('2026-08-23T15:00:00.000Z');

function filaFactura(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA, estado: 'fallida', loteId: LOTE, ambiente: 'pruebas',
    errorCode: 'service_unavailable', ...over,
  };
}

function filaCola(over: Record<string, unknown> = {}) {
  return {
    id: COLA, loteId: LOTE, estado: 'fallido_definitivo', errorCode: 'service_unavailable',
    intentos: 5, maxIntentos: 5, ...over,
  };
}

/** Un lote completo: con trámites y con conceptos. El camino que SÍ se puede reencolar. */
function escenario(): void {
  kdb.when
    .select('siigo_facturas', [filaFactura()])
    .select('siigo_lotes_facturacion', [{
      id: LOTE, conceptos: ['tramite_digital'], documentoTipoCodigo: 'FV',
      vendedorCodigo: 'V1', formaPagoCodigo: 'FP1', centroCostoCodigo: null,
    }])
    .select('siigo_lote_tramites', [{ loteId: LOTE, tramiteId: TRAMITE }])
    .select('siigo_cola_facturacion', [filaCola()])
    // `ambiente` viene del INNER JOIN con `siigo_facturas`: el acta no tiene columna propia.
    .select('siigo_factura_envios', [{
      id: ACTA, facturaId: FACTURA, codigo: 'siigo_rechazo', resultado: 'fallido',
      ambiente: 'pruebas',
    }]);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  vi.clearAllMocks();
  descartesVigentesMock.mockResolvedValue(new Map());
  encolarMock.mockResolvedValue({
    colaId: COLA, loteId: LOTE, estado: 'pendiente', resultado: 'reactivado',
  });
  descartarDefinitivoMock.mockResolvedValue({
    estado: 'marcada', fila: { id: COLA, estado: 'fallido_definitivo' },
  });
  escenario();
});

const REINTENTO = { ambiente: 'pruebas' as const, usuarioId: 9, ahora: AHORA };

// ── AC4 — LA LÍNEA QUE NO SE CRUZA ─────────────────────────────────────────

describe('AC4 — el reintento NO puede emitir dos veces', () => {
  it('no llama a Siigo ni una sola vez: solo rearma la fila de cola', async () => {
    await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    expect(encolarMock).toHaveBeenCalledTimes(1);
  });

  it('NO escribe en `siigo_facturas`: el estado del documento tiene otro dueño', async () => {
    // La idempotencia es de la Feature #11242 (`reclamarFallida`, cuya condición viaja DENTRO del
    // UPDATE). Un `UPDATE` desde aquí sería un SEGUNDO escritor sobre la fila que representa un
    // documento ante la DIAN — exactamente lo que produce una factura marcada fallida estando viva.
    await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    expect(espia.updatesEn('siigo_facturas')).toEqual([]);
    expect(espia.insertsEn('siigo_facturas')).toEqual([]);
  });

  it('delega en `encolar`, que es la puerta a la cadena donde vive el reclamo de clave', async () => {
    await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    const args = encolarMock.mock.calls[0]![0] as Record<string, unknown>;
    // Con el contenido REAL del lote: los mismos trámites y los mismos conceptos, para que
    // `asegurarLote` recupere el MISMO lote y no cree una segunda clave de idempotencia.
    expect(args.tramiteIds).toEqual([TRAMITE]);
    expect(args.conceptos).toEqual(['tramite_digital']);
    expect(args.ambiente).toBe('pruebas');
  });

  it('el ambiente sale de quien llama, nunca de la factura leída', async () => {
    kdb.when.select('siigo_facturas', [filaFactura({ ambiente: 'produccion' })]);
    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    // Una factura de otro ambiente no se toca: ni se encola ni se «adapta». Desaparece.
    expect(r.items[0]!.resultado).toBe('error');
    expect(encolarMock).not.toHaveBeenCalled();
  });

  // ── El estado de la factura, que es la primera puerta del AC4 ──────────────────────────────
  //
  // Los dos casos de abajo son LA carrera normal de esta pantalla, no un borde raro: quien opera
  // selecciona sobre una página que se cargó hace un rato, y entre la carga y el clic el trabajador
  // avanzó. Las dos comprobaciones de estado tienen que decir cosas DISTINTAS y ninguna puede
  // encolar, porque la de arriba habla de un documento que ya existe ante la DIAN y la de abajo de
  // una emisión que todavía está en vuelo. Sin un aserto sobre el resultado exacto de cada una, la
  // primera puerta se puede borrar entera sin que nada se ponga rojo.

  it('una factura ya `emitida` sale como `ya_enviado`, con «Ya está emitida.», sin reencolar', async () => {
    // Si esta rama no existiera, la factura caería a la comprobación siguiente y el servidor le
    // contestaría «la emisión sigue en curso» sobre algo que YA tiene documento ante la DIAN —y
    // encima la mandaría otra vez a la cola—.
    kdb.when.select('siigo_facturas', [filaFactura({ estado: 'emitida' })]);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('ya_enviado');
    expect(item.motivo).toBe('Ya está emitida.');
    expect(item.loteId).toBe(LOTE);
    // Lo único que separa «se lo contó» de «lo volvió a mandar a emitir».
    expect(encolarMock).not.toHaveBeenCalled();
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('«ya emitida» cuenta como `yaEstaban` y NO como descarte: pulsar dos veces no es un fallo', async () => {
    kdb.when.select('siigo_facturas', [filaFactura({ estado: 'emitida' })]);

    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    expect(r.resumen.yaEstaban).toBe(1);
    expect(r.resumen.descartados).toBe(0);
    expect(r.resumen.encolados).toBe(0);
    expect(r.resumen.porResultado.ya_enviado).toBe(1);
  });

  it('una factura `en_proceso` sale como `ya_en_cola`, con el texto de «sigue en curso», sin reencolar', async () => {
    // Un trabajador la tiene arrendada ahora mismo: reencolarla sería meter una segunda cita para
    // una emisión que todavía está en vuelo. Y el mensaje NO puede ser el de «ya está emitida»:
    // aquí todavía no hay documento ante la DIAN, así que quien opera tiene que volver a mirar.
    kdb.when.select('siigo_facturas', [filaFactura({ estado: 'en_proceso' })]);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('ya_en_cola');
    expect(item.motivo).toBe('La emisión sigue en curso: no hay nada que reintentar todavía.');
    expect(item.loteId).toBe(LOTE);
    expect(encolarMock).not.toHaveBeenCalled();
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

// ── AC3 — lo que no se arregla reintentando ────────────────────────────────

describe('AC3 — no se reintenta lo que no se arregla reintentando', () => {
  beforeEach(() => {
    kdb.when
      .select('siigo_facturas', [filaFactura({ errorCode: 'invalid_dian_resolution' })])
      .select('siigo_cola_facturacion', [filaCola({ errorCode: 'invalid_dian_resolution' })]);
  });

  it('un error de un dato nuestro sale como `descartado_datos` y NO llega a la cola', async () => {
    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] });

    expect(r.items[0]!.resultado).toBe('descartado_datos');
    // La afirmación del AC3: no se consume cuota. Con la base mockeada esto es lo ÚNICO que
    // distingue «lo descartó» de «lo encoló y ya se verá».
    expect(encolarMock).not.toHaveBeenCalled();
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('explica QUÉ corregir y QUIÉN lo hace, palabra por palabra del catálogo', async () => {
    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.motivo).toBe(item.guia!.texto);
    expect(item.guia!.accion.length).toBeGreaterThan(10);
    expect(item.guia!.responsableEtiqueta).toBe('contabilidad, en Siigo Nube');
    expect(item.motivo).toContain('Reintentar no lo arregla');
  });

  it('el código de la COLA manda sobre el de la factura: es el desenlace más reciente', async () => {
    kdb.when
      .select('siigo_facturas', [filaFactura({ errorCode: 'service_unavailable' })])
      .select('siigo_cola_facturacion', [filaCola({ errorCode: 'invalid_dian_resolution' })]);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;
    expect(item.resultado).toBe('descartado_datos');
    expect(item.guia!.codigo).toBe('invalid_dian_resolution');
  });

  it('sin fila de cola cae al código de la FACTURA, no se queda sin diagnóstico', async () => {
    kdb.when
      .select('siigo_facturas', [filaFactura({ errorCode: 'invalid_dian_resolution' })])
      .select('siigo_cola_facturacion', []);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;
    expect(item.guia!.codigo).toBe('invalid_dian_resolution');
    expect(item.resultado).toBe('descartado_datos');
  });

  it('un fallo transitorio SÍ se reintenta', async () => {
    kdb.when
      .select('siigo_facturas', [filaFactura({ errorCode: 'service_unavailable' })])
      .select('siigo_cola_facturacion', [filaCola({ errorCode: 'service_unavailable' })]);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;
    expect(item.resultado).toBe('reactivado');
    expect(encolarMock).toHaveBeenCalledTimes(1);
  });
});

// ── AC2 — el lote, sus contadores y su tope ────────────────────────────────

describe('AC2 — reintento en lote con recuento y tope', () => {
  it('dice cuántos se encolaron, cuántos se descartaron y por qué', async () => {
    kdb.when.select('siigo_facturas', [
      filaFactura({ errorCode: 'service_unavailable' }),
      filaFactura({ id: OTRA, errorCode: 'invalid_dian_resolution' }),
    ]);
    // Las dos comparten lote en este escenario, así que el código de la cola manda para las dos: se
    // fuerza el de cada factura dejando la cola sin código.
    kdb.when.select('siigo_cola_facturacion', []);

    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA, OTRA] });

    expect(r.resumen.total).toBe(2);
    expect(r.resumen.encolados).toBe(1);
    expect(r.resumen.descartados).toBe(1);
    // La suma del desglose cuadra con el total: ningún resultado se pierde por el camino.
    expect(Object.values(r.resumen.porResultado).reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.items.find((i) => i.facturaId === OTRA)!.motivo).toContain('Reintentar no lo arregla');
  });

  it('el tope se aplica aunque quien llame mande de más', async () => {
    const { SIIGO_BANDEJA_TOPE_REINTENTO, SIIGO_BANDEJA_PAGINA_MAX } =
      await import('@operaciones/shared-types');
    const { TOPE_TRAMITES_ENVIO } =
      await import('../../src/modules/siigo/facturacion.encolado.service.js');

    // Derivado de la página, no inventado, y por debajo del tope del envío desde el reporte.
    expect(SIIGO_BANDEJA_TOPE_REINTENTO).toBe(SIIGO_BANDEJA_PAGINA_MAX);
    expect(SIIGO_BANDEJA_TOPE_REINTENTO).toBeLessThanOrEqual(TOPE_TRAMITES_ENVIO);

    const muchas = Array.from({ length: SIIGO_BANDEJA_TOPE_REINTENTO + 25 }, (_, i) => `id-${i}`);
    const r = await reintentarEmision({ ...REINTENTO, facturaIds: muchas });
    expect(r.resumen.total).toBe(SIIGO_BANDEJA_TOPE_REINTENTO);
  });

  it('el fallo de una NO se lleva por delante a las demás', async () => {
    kdb.when.select('siigo_facturas', [
      filaFactura(), filaFactura({ id: OTRA }),
    ]);
    encolarMock
      .mockRejectedValueOnce(new Error('se cayó la base'))
      .mockResolvedValueOnce({ colaId: COLA, loteId: LOTE, estado: 'pendiente', resultado: 'encolado' });

    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA, OTRA] });

    expect(r.items[0]!.resultado).toBe('error');
    expect(r.items[1]!.resultado).toBe('encolado');
  });

  it('un mensaje de error del motor no se filtra en crudo a la respuesta', async () => {
    encolarMock.mockRejectedValue(new Error(
      'Failed query: insert into "siigo_cola_facturacion" params: 900123456, ABC123',
    ));
    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.motivo).not.toContain('900123456');
    expect(item.motivo).toContain('[consulta SQL omitida]');
  });

  it('en serie y no en paralelo: cada encolado espera al anterior', async () => {
    kdb.when.select('siigo_facturas', [filaFactura(), filaFactura({ id: OTRA })]);
    let vivos = 0;
    let maximo = 0;
    encolarMock.mockImplementation(async () => {
      vivos += 1; maximo = Math.max(maximo, vivos);
      await new Promise((r) => setTimeout(r, 1));
      vivos -= 1;
      return { colaId: COLA, loteId: LOTE, estado: 'pendiente', resultado: 'encolado' };
    });

    await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA, OTRA] });
    expect(maximo).toBe(1);
  });
});

// ── El caso que revienta en producción si se ignora ────────────────────────

describe('AC2 — un lote anterior a A1 no revienta el lote entero', () => {
  it('sin conceptos sale como `no_aplica` y dice qué hacer, no un 500', async () => {
    kdb.when.select('siigo_lotes_facturacion', [{
      id: LOTE, conceptos: [], documentoTipoCodigo: 'FV', vendedorCodigo: 'V1',
      formaPagoCodigo: 'FP1', centroCostoCodigo: null,
    }]);

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('no_aplica');
    expect(item.motivo).toContain('reporte de costos');
    // Y sobre todo: ni se intentó. `encolar` habría lanzado `sin_conceptos`.
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('sin pertenencia registrada también, y con su propio texto', async () => {
    kdb.when.select('siigo_lote_tramites', []);
    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('no_aplica');
    expect(item.motivo).toContain('no registra qué trámites');
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('una histórica sin conceptos no impide reintentar las demás de la selección', async () => {
    kdb.when
      .select('siigo_facturas', [filaFactura(), filaFactura({ id: OTRA, loteId: 'otro-lote' })])
      .select('siigo_lotes_facturacion', [
        { id: LOTE, conceptos: [], documentoTipoCodigo: 'FV', vendedorCodigo: 'V1', formaPagoCodigo: 'FP1', centroCostoCodigo: null },
        { id: 'otro-lote', conceptos: ['tramite_digital'], documentoTipoCodigo: 'FV', vendedorCodigo: 'V1', formaPagoCodigo: 'FP1', centroCostoCodigo: null },
      ])
      .select('siigo_lote_tramites', [
        { loteId: LOTE, tramiteId: TRAMITE }, { loteId: 'otro-lote', tramiteId: TRAMITE },
      ]);

    const r = await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA, OTRA] });
    expect(r.items.map((i) => i.resultado)).toEqual(['no_aplica', 'reactivado']);
  });
});

// ── AC5 vs AC2 — lo que una PERSONA dio por perdido no vuelve solo ─────────

describe('AC5 — un reintento normal no deshace la decisión de una persona', () => {
  it('lo descartado a mano sale como `fallido_definitivo` y no se reencola', async () => {
    descartesVigentesMock.mockResolvedValue(new Map([[COLA, {
      motivo: 'tramite_anulado', motivoEtiqueta: 'El trámite se anuló', nota: null,
      usuarioId: 42, marcadoEn: AHORA.toISOString(),
    }]]));

    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('fallido_definitivo');
    expect(item.motivo).toContain('El trámite se anuló');
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('lo que el TRABAJADOR dejó por agotamiento sí se desatasca: para eso existe la bandeja', async () => {
    // Misma fila `fallido_definitivo`, pero sin hito de descarte. Si esto no se reactivara, el botón
    // de reintentar no haría nada en la mayoría de los casos y el AC2 sería falso.
    descartesVigentesMock.mockResolvedValue(new Map());
    const item = (await reintentarEmision({ ...REINTENTO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('reactivado');
    expect((encolarMock.mock.calls[0]![0] as { reactivar: boolean }).reactivar).toBe(true);
  });
});

// ── AC5 — dar por perdido ──────────────────────────────────────────────────

describe('AC5 — dar por perdido exige motivo y registra quién y cuándo', () => {
  const DESCARTE = {
    ambiente: 'pruebas' as const, fuente: 'emision' as const, refId: FACTURA,
    motivo: 'tramite_anulado' as const, usuarioId: 42, ahora: AHORA,
  };

  it('deja de reintentarse: la fila de cola pasa a `fallido_definitivo`', async () => {
    const r = await descartarCaso(DESCARTE);

    expect(descartarDefinitivoMock).toHaveBeenCalledWith(
      expect.objectContaining({ colaId: COLA, usuarioId: 42 }),
    );
    expect(r.estado).toBe('fallido_definitivo');
  });

  it('el motivo, la nota, quién y cuándo van a la bitácora WORM, no a una columna nueva', async () => {
    await descartarCaso({ ...DESCARTE, nota: 'Lo canceló el cliente' });

    expect(registrarHitoMock).toHaveBeenCalledWith(expect.objectContaining({
      hito: 'marcada_fallido_definitivo',
      entidadTipo: 'siigo_cola',
      entidadId: COLA,
      codigo: 'tramite_anulado',
      detalle: 'Lo canceló el cliente',
      usuarioId: 42,
    }));
  });

  it('NO escribe el motivo encima del `error_code`: ahí vive el diagnóstico', async () => {
    // Sobrescribirlo perdería POR QUÉ falló —que es lo que decide si reintentar sirve (AC3)— y
    // guardaría la decisión en una fila que sí se puede sobrescribir. Justo al revés.
    await descartarCaso(DESCARTE);
    const args = descartarDefinitivoMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('motivo');
    expect(args).not.toHaveProperty('errorCode');
  });

  it('se registra igual cuando el trabajador ya la había agotado', async () => {
    // Es el caso NORMAL, no el raro: el estado ya cumple «deja de reintentarse», pero le falta la
    // decisión —motivo, quién y cuándo—, y son justo los que llevan más tiempo parados.
    descartarDefinitivoMock.mockResolvedValue({
      estado: 'ya_terminal', fila: { id: COLA, estado: 'fallido_definitivo' },
    });
    const r = await descartarCaso(DESCARTE);

    expect(r.descarte.motivo).toBe('tramite_anulado');
    expect(registrarHitoMock).toHaveBeenCalledTimes(1);
  });

  it('NO se pisa una fila que un trabajador está emitiendo ahora mismo', async () => {
    descartarDefinitivoMock.mockResolvedValue({
      estado: 'en_proceso', fila: { id: COLA, estado: 'pendiente' },
    });

    await expect(descartarCaso(DESCARTE)).rejects.toMatchObject({ codigo: 'en_proceso' });
    // Y no queda rastro de una decisión que no llegó a aplicarse.
    expect(registrarHitoMock).not.toHaveBeenCalled();
  });

  it('una factura ya emitida no se da por perdida: hay documento ante la DIAN', async () => {
    descartarDefinitivoMock.mockResolvedValue({
      estado: 'emitida', fila: { id: COLA, estado: 'enviado' },
    });
    await expect(descartarCaso(DESCARTE)).rejects.toMatchObject({ codigo: 'ya_emitida' });
  });

  it('un rechazo de la DIAN no se da por perdido: se corrige', async () => {
    await expect(descartarCaso({ ...DESCARTE, fuente: 'dian' }))
      .rejects.toMatchObject({ codigo: 'fuente_no_admite' });
    expect(registrarHitoMock).not.toHaveBeenCalled();
  });

  it('un correo abandonado se apunta sobre el ACTA y no toca `siigo_factura_envios`', async () => {
    kdb.when.select('siigo_factura_envios', [{
      id: ACTA, facturaId: FACTURA, resultado: 'fallido', ambiente: 'pruebas',
    }]);
    const r = await descartarCaso({ ...DESCARTE, fuente: 'correo', refId: ACTA });

    expect(registrarHitoMock).toHaveBeenCalledWith(expect.objectContaining({
      entidadTipo: 'factura_envio', entidadId: ACTA,
    }));
    // El acta es append-only con una sola puerta: abandonar es una decisión NUESTRA sobre el acta,
    // no un hecho nuevo del envío.
    expect(espia.updatesEn('siigo_factura_envios')).toEqual([]);
    expect(r.facturaId).toBe(FACTURA);
  });

  it('un envío que SÍ salió no se puede abandonar', async () => {
    kdb.when.select('siigo_factura_envios', [{
      id: ACTA, facturaId: FACTURA, resultado: 'enviado', ambiente: 'pruebas',
    }]);
    await expect(descartarCaso({ ...DESCARTE, fuente: 'correo', refId: ACTA }))
      .rejects.toMatchObject({ codigo: 'fuente_no_admite' });
  });

  it('la nota se sanea y se recorta antes de entrar en una tabla que nadie puede podar', async () => {
    const { SIIGO_BANDEJA_NOTA_MAX } = await import('@operaciones/shared-types');

    expect(normalizarNota('  ')).toBeNull();
    expect(normalizarNota(undefined)).toBeNull();
    expect(normalizarNota('x'.repeat(500))).toHaveLength(SIIGO_BANDEJA_NOTA_MAX);
    // La misma barrera que protege la bitácora del resto del módulo: lo que entra ahí no se
    // rectifica ni se suprime (Ley 1581, art. 8).
    expect(normalizarNota('nota Failed query: select * from "clients" params: 900123456'))
      .toBe('nota [consulta SQL omitida]');
  });

  // ── La nota es la puerta que quedaba abierta al lado de la que el catálogo cerró ───────────
  //
  // El `motivo` es un catálogo cerrado PRECISAMENTE para que no entre PII en `siigo_operaciones`,
  // que prohíbe UPDATE y DELETE. Si la nota de 200 caracteres que va al lado no se redacta, la
  // decisión queda sin efecto: se escribe lo mismo un renglón más abajo. `sanearMensaje` no bastaba
  // —solo entiende volcados de SQL y parejas `clave=valor`, o sea lo que escribe una máquina—.
  it('una nota con una cédula y un nombre dentro llega ENMASCARADA al INSERT', async () => {
    await descartarCaso({
      ...DESCARTE, nota: 'Lo pidió Juan Pérez, cédula 79123456, correo juan.perez@cliente.com',
    });

    const escrito = (registrarHitoMock.mock.calls[0]![0] as { detalle: string }).detalle;
    expect(escrito).not.toContain('79123456');
    expect(escrito).not.toContain('Juan Pérez');
    expect(escrito).not.toContain('juan.perez@cliente.com');
    // Y lo que sirve para operar sigue ahí: se enmascara el dato, no la frase.
    expect(escrito).toContain('cédula');
    expect(escrito).toContain('79***456');
    expect(escrito).toContain('J. P.');
  });

  it('lo mismo por la puerta del correo: la nota del acta pasa por el mismo filtro', async () => {
    await descartarCaso({
      ...DESCARTE, fuente: 'correo', refId: ACTA, nota: 'confirmó la placa ABC123 el titular',
    });

    const escrito = (registrarHitoMock.mock.calls[0]![0] as { detalle: string }).detalle;
    expect(escrito).not.toContain('ABC123');
  });

  it('lo que NO es un dato personal se queda: un tope, una fecha y un importe', async () => {
    // Si el enmascarado tapara esto, la nota dejaría de servir para lo único que existe —explicar la
    // decisión— y la gente escribiría la explicación en otro sitio peor.
    expect(normalizarNota('la resolución venció el 30-06-2026')).toBe('la resolución venció el 30-06-2026');
    expect(normalizarNota('se cobró por fuera $1.250.000')).toBe('se cobró por fuera $1.250.000');
    expect(normalizarNota('van 5 intentos con error 429')).toBe('van 5 intentos con error 429');
  });
});

// ── AC6 — resucitar ────────────────────────────────────────────────────────

describe('AC6 — lo dado por perdido se puede resucitar y el marcado anterior se conserva', () => {
  const ANTERIOR = {
    motivo: 'tramite_anulado' as const, motivoEtiqueta: 'El trámite se anuló',
    nota: 'lo canceló el cliente', usuarioId: 42, marcadoEn: '2026-08-20T15:00:00.000Z',
  };
  const REACTIVAR = {
    ambiente: 'pruebas' as const, fuente: 'emision' as const, refId: FACTURA,
    usuarioId: 9, ahora: AHORA,
  };

  beforeEach(() => {
    descartesVigentesMock.mockResolvedValue(new Map([[COLA, ANTERIOR]]));
  });

  it('vuelve a la cola con los contadores a cero, vía `encolar({reactivar:true})`', async () => {
    const r = await reactivarCaso(REACTIVAR);

    expect((encolarMock.mock.calls[0]![0] as { reactivar: boolean }).reactivar).toBe(true);
    expect(r.resultado).toBe('reactivado');
    expect(r.estado).toBe('pendiente');
  });

  it('devuelve el marcado anterior: es la prueba de que resucitar no lo borra', async () => {
    const r = await reactivarCaso(REACTIVAR);
    expect(r.descarteAnterior).toEqual(ANTERIOR);
  });

  it('no borra ni edita nada de la bitácora: la tabla lo prohíbe y este código tampoco lo intenta', async () => {
    await reactivarCaso(REACTIVAR);
    expect(espia.updatesEn('siigo_operaciones')).toEqual([]);
    expect(kdb.delete).not.toHaveBeenCalled();
  });

  it('resucitar algo que nadie dio por perdido es un rechazo, no un botón que no hace nada', async () => {
    descartesVigentesMock.mockResolvedValue(new Map());
    await expect(reactivarCaso(REACTIVAR)).rejects.toMatchObject({ codigo: 'no_descartado' });
    expect(encolarMock).not.toHaveBeenCalled();
  });

  it('un correo abandonado vuelve con su hito de activación, y SIN mandar el correo', async () => {
    descartesVigentesMock.mockResolvedValue(new Map([[ACTA, ANTERIOR]]));
    kdb.when.select('siigo_factura_envios', [{ id: ACTA, facturaId: FACTURA, ambiente: 'pruebas' }]);

    const r = await reactivarCaso({ ...REACTIVAR, fuente: 'correo', refId: ACTA });

    expect(registrarHitoMock).toHaveBeenCalledWith(expect.objectContaining({
      hito: 'reenvio_solicitado', entidadTipo: 'factura_envio', entidadId: ACTA,
    }));
    // Resucitar devuelve el caso a la bandeja; mandar el correo es la otra ruta, que gasta cuota.
    expect(enviarCorreoMock).not.toHaveBeenCalled();
    expect(r.descarteAnterior).toEqual(ANTERIOR);
  });

  it('un rechazo de la DIAN no se resucita', async () => {
    await expect(reactivarCaso({ ...REACTIVAR, fuente: 'dian' }))
      .rejects.toMatchObject({ codigo: 'fuente_no_admite' });
  });

  // Las cuatro acciones comprueban el ambiente, no dos de cuatro. El acta no tiene columna propia
  // —la lleva su factura—, y sin la comprobación el hito que se escribe después afirmaría en una
  // tabla inmutable un ambiente que no es el del caso.
  it.each([
    ['resucitar', async (refId: string) => reactivarCaso({ ...REACTIVAR, fuente: 'correo', refId })],
    ['abandonar', async (refId: string) => descartarCaso({
      ambiente: 'pruebas', fuente: 'correo', refId, motivo: 'tramite_anulado', usuarioId: 9,
    })],
  ] as const)('%s un acta de OTRO ambiente no encuentra nada', async (_accion, ejecutar) => {
    kdb.when.select('siigo_factura_envios', [{
      id: ACTA, facturaId: FACTURA, resultado: 'fallido', ambiente: 'produccion',
    }]);

    await expect(ejecutar(ACTA)).rejects.toMatchObject({ codigo: 'no_existe' });
    expect(registrarHitoMock).not.toHaveBeenCalled();
  });
});

// ── AC2 y AC3 en la rama que SÍ sale a la red ──────────────────────────────

describe('AC2/AC3 — reenviar el correo', () => {
  const REENVIO = { ambiente: 'pruebas' as const, usuarioId: 9 };

  beforeEach(() => {
    enviarCorreoMock.mockResolvedValue({
      id: ACTA, resultado: 'enviado', destinatarios: [{ correo: 'a@b.co', origen: 'compania' }],
      motivo: null, codigo: null,
    });
  });

  it('un cliente sin correo en su ficha NO gasta una petición', async () => {
    // `no_realizado` con `cliente_sin_correo` nunca llegó a Siigo: no hay cuota gastada ni nada que
    // reintentar. Lo que hay es un dato que falta y una persona que debe completarlo.
    kdb.when.select('siigo_factura_envios', [{
      id: ACTA, facturaId: FACTURA, codigo: 'cliente_sin_correo', resultado: 'no_realizado',
    }]);

    const item = (await reenviarCorreo({ ...REENVIO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.resultado).toBe('descartado_datos');
    expect(item.motivo).toContain('ficha del cliente');
    expect(enviarCorreoMock).not.toHaveBeenCalled();
  });

  it('un rechazo de Siigo sí se reintenta', async () => {
    const r = await reenviarCorreo({ ...REENVIO, facturaIds: [FACTURA] });

    expect(enviarCorreoMock).toHaveBeenCalledTimes(1);
    expect(r.items[0]!.resultado).toBe('enviado');
    expect(r.resumen.enviados).toBe(1);
  });

  it('devuelve CUÁNTAS direcciones, nunca cuáles', async () => {
    const item = (await reenviarCorreo({ ...REENVIO, facturaIds: [FACTURA] })).items[0]!;

    expect(item.destinatarios).toBe(1);
    expect(JSON.stringify(item)).not.toContain('a@b.co');
  });

  it('su tope es mucho más bajo que el de la emisión, porque gasta cuota', async () => {
    const { SIIGO_BANDEJA_TOPE_REENVIO, SIIGO_BANDEJA_TOPE_REINTENTO } =
      await import('@operaciones/shared-types');
    expect(SIIGO_BANDEJA_TOPE_REENVIO).toBeLessThan(SIIGO_BANDEJA_TOPE_REINTENTO);

    const muchas = Array.from({ length: SIIGO_BANDEJA_TOPE_REENVIO + 5 }, (_, i) => `f-${i}`);
    const r = await reenviarCorreo({ ...REENVIO, facturaIds: muchas });
    expect(r.resumen.total).toBe(SIIGO_BANDEJA_TOPE_REENVIO);
  });

  it('NO envuelve otra vez en `ejecutarConResiliencia`: serían hasta 16 peticiones por correo', async () => {
    // `enviarFacturaPorCorreo` ya lo hace por dentro. Dos capas multiplicarían los reintentos contra
    // una cuota de 100 por minuto compartida con la emisión.
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(
      new URL('../../src/modules/siigo/siigo.bandeja-acciones.service.ts', import.meta.url), 'utf8',
    );
    expect(fuente).not.toMatch(/^\s*(await\s+)?ejecutarConResiliencia\(/m);
  });

  it('un fallo del envío no tumba el lote', async () => {
    enviarCorreoMock.mockRejectedValue(new Error('la base se cayó'));
    const r = await reenviarCorreo({ ...REENVIO, facturaIds: [FACTURA] });
    expect(r.items[0]!.resultado).toBe('error');
    expect(r.resumen.total).toBe(1);
  });
});

// ── La clase de error ──────────────────────────────────────────────────────

describe('SiigoBandejaError distingue los rechazos que exigen cosas distintas', () => {
  it('cada código dice una acción distinta a quien opera', () => {
    const e = new SiigoBandejaError('en_proceso', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('SiigoBandejaError');
    expect(e.codigo).toBe('en_proceso');
  });
});
