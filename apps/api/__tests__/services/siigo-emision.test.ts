// Siigo — reservar la clave y emitir sin duplicar ante la DIAN (HU #11326). Un bloque por criterio.
//
// El test que importa de esta historia no es el del camino feliz. Es el del AC3: **dos reintentos
// simultáneos sobre una fila `fallida` no pueden emitir los dos**. Lo que produce ese fallo no es una
// excepción ni un dato raro, sino dos documentos válidos ante la autoridad tributaria, y eso no se
// deshace desde aquí. Así que ese caso se prueba desde el mecanismo —quién recibe fila del UPDATE—,
// no desde el resultado.
//
// La orquestación se prueba contra el SIMULADOR REAL del módulo, no contra un mock del mock, porque
// el AC8 pide justamente poder recorrer el ciclo ahí. Un simulador que no honrara la clave de
// idempotencia daría por bueno un reintento que en producción crearía la segunda factura.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

/** El embudo de la HU #11324. Por defecto deja pasar; cada test del AC7 lo cierra a su manera. */
const evaluarElegibilidadMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.elegibilidad.service.js', () => ({
  evaluarElegibilidad: (ids: string[], amb: string) => evaluarElegibilidadMock(ids, amb),
}));

const asegurarTerceroMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.terceros.service.js', () => ({
  asegurarTercero: (id: number) => asegurarTerceroMock(id),
}));

const parametrosOperativosMock = vi.fn();
vi.mock('../../src/modules/siigo/config-emision.service.js', () => ({
  parametrosOperativos: (amb: string) => parametrosOperativosMock(amb),
}));

/**
 * Con qué se emite. Ya NO sale de una configuración global: se elige al enviar y viaja con el lote,
 * así que las pruebas lo pasan explícitamente igual que lo hace el trabajador de la cola.
 */
const EMISION = {
  documentoTipoCodigo: '24446',
  vendedorCodigo: '629',
  formaPagoCodigo: '5636',
  centroCostoCodigo: null,
};

const resolverMapeoMock = vi.fn();
vi.mock('../../src/modules/siigo/mapeo-conceptos.service.js', () => ({
  resolverMapeo: (amb: string, c: string, t: string | null) => resolverMapeoMock(amb, c, t),
}));

/** Las peticiones las atiende el SIMULADOR del módulo, que es lo que el AC8 quiere ensayar. */
const { respuestaSimulada, reiniciarConsecutivoSimulado } = await import(
  '../../src/modules/siigo/siigo.mock.js');
const { traducirErrorSiigo } = await import('../../src/modules/siigo/siigo.errors.js');

interface PeticionSiigo {
  metodo: string; ruta: string; cuerpo?: unknown; idempotencyKey?: string;
}
const peticiones: PeticionSiigo[] = [];

/**
 * Atender con el simulador es el comportamiento por defecto, y se REINSTALA en cada test.
 *
 * `vi.clearAllMocks()` borra las llamadas pero **no** las implementaciones: un `mockResolvedValue`
 * puesto por un test se filtraba a los siguientes y los hacía pasar o fallar por una razón que no
 * era la suya.
 */
const atenderConSimulador = async (req: PeticionSiigo) => {
  peticiones.push(req);
  const r = respuestaSimulada(req.metodo as 'GET', req.ruta, {
    cuerpo: req.cuerpo, idempotencyKey: req.idempotencyKey,
  });
  if (!r.ok) throw traducirErrorSiigo(r.status, r.datos);
  return r.datos;
};
const siigoRequestOrThrowMock = vi.fn(atenderConSimulador);
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req as PeticionSiigo),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

/**
 * La resiliencia se puede pasar por alto o ejercer de verdad, y hace falta poder hacer las dos cosas.
 *
 * Por defecto se pasa por alto: la mayoría de los tests hablan de la reserva y del conflicto, y
 * arrastrar el limitador de tasa a cada uno los haría lentos sin decir nada nuevo. Pero el bloque de
 * reintentos usa la REAL, porque el reintento del POST es el mecanismo más peligroso de la HU —cada
 * reintento es otra petición que puede crear otra factura— y probarlo contra un sustituto que llama
 * a la operación una sola vez es no probarlo.
 */
let usarResilienciaReal = false;

vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return {
    ...real,
    ejecutarConResiliencia: async (op: () => Promise<unknown>, opciones?: Record<string, unknown>) => (
      usarResilienciaReal
        ? real.ejecutarConResiliencia(op, { ...opciones, dormir: async () => {}, maxIntentos: 4 })
        : op()
    ),
  };
});

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const {
  arrendamientoVencido, cargarTramites, emitirFactura, fechaDocumento, normalizarFacturaEmitida,
  prepararEmision, reclamarFallida, reservarClave, revisionDeTotal, SiigoEmisionError,
} = await import('../../src/modules/siigo/facturacion.emision.service.js');

const {
  MAX_PAGINAS_BUSQUEDA, observacionesCoinciden, reconciliarFactura, resolverHuerfanaAMano,
  SiigoReconciliacionError,
} = await import('../../src/modules/siigo/facturacion.reconciliacion.service.js');

const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const AHORA = new Date('2026-08-11T15:00:00.000Z');

/** Una fila de trámite con su liquidación sellada. */
function filaTramite(over: Record<string, unknown> = {}) {
  return {
    tramiteId: TRAMITE,
    idFlit: 'FLIT-9001',
    placa: 'ABC123',
    tipoTramite: 'Traspaso',
    companiaId: 7,
    liquidacionId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    valorSoat: '100000.00',
    valorImpuesto: null,
    valorDerecho: null,
    valorTramiteDigital: '50000.00',
    valorLogistica: null,
    valorGmf: null,
    ...over,
  };
}

/** El estado por defecto: todo en orden, nada emitido todavía. */
function escenarioFeliz(): void {
  evaluarElegibilidadMock.mockResolvedValue([{ tramiteId: TRAMITE, elegible: true, motivos: [] }]);
  asegurarTerceroMock.mockResolvedValue({
    clienteId: 7, siigoCustomerId: 'cus-1', identificacion: '900123456', sucursal: 0,
    desenlace: 'sin_cambios',
  });
  parametrosOperativosMock.mockResolvedValue({
    historicoDesde: '2026-01-01', arrendamientoEnProcesoMin: 15,
  });
  resolverMapeoMock.mockImplementation(async (_a: string, concepto: string) => ({
    origen: 'generica',
    mapeo: {
      concepto, codigoProducto: `P-${concepto}`, nombreProducto: `Producto ${concepto}`,
      impuestos: [], facturaLineaPropia: true,
    },
  }));

  kdb.when
    .select('flito_tramites', [filaTramite()])
    .select('siigo_lotes_facturacion', [{ id: 'lote-1' }])
    .select('siigo_facturas', [])
    .insert('siigo_lotes_facturacion', [{ id: 'lote-1' }])
    .insert('siigo_factura_tramites', [])
    .insert('siigo_facturas', [{
      id: FACTURA, estado: 'en_proceso', intentos: 1, enProcesoDesde: AHORA,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    }])
    .update('siigo_facturas', [{
      id: FACTURA, estado: 'emitida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: 'mock-invoice-1', numero: '1', cufe: null, publicUrl: 'https://x',
      totalSiigo: '150000.00', requiereRevision: false, revisionMotivo: null,
      errorCode: null, errorDetalle: null,
    }]);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  peticiones.length = 0;
  vi.clearAllMocks();
  siigoRequestOrThrowMock.mockImplementation(atenderConSimulador);
  usarResilienciaReal = false;
  reiniciarConsecutivoSimulado();
  escenarioFeliz();
});

// ── AC1 — la clave se reserva antes de llamar a Siigo ───────────────────────

describe('AC1 — la reserva precede a la red', () => {
  it('emite y devuelve el resultado con lo que Siigo contestó', async () => {
    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('emitida');
    expect(r.siigoInvoiceId).toBe('mock-invoice-1');
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0]!.ruta).toBe('/v1/invoices');
  });

  it('la fila se inserta ANTES de que salga la petición', async () => {
    // El orden es la garantía del AC1 y no se puede comprobar mirando el resultado: las dos cosas
    // ocurren en la misma llamada. Se anota cuándo pasó cada una.
    const orden: string[] = [];
    kdb.when.insert('siigo_facturas', () => {
      orden.push('reserva');
      return [{
        id: FACTURA, estado: 'en_proceso', intentos: 1, enProcesoDesde: AHORA,
        siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
        requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
      }];
    });
    siigoRequestOrThrowMock.mockImplementationOnce(async (req: PeticionSiigo) => {
      orden.push('post');
      peticiones.push(req);
      const r = respuestaSimulada('POST', req.ruta, {
        cuerpo: req.cuerpo, idempotencyKey: req.idempotencyKey,
      });
      return r.datos;
    });

    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    expect(orden).toEqual(['reserva', 'post']);
  });

  it('la clave de idempotencia viaja en el POST y es estable entre llamadas', async () => {
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    const primera = peticiones[0]!.idempotencyKey;

    peticiones.length = 0;
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(primera).toBeTruthy();
    expect(peticiones[0]!.idempotencyKey).toBe(primera);
  });

  it('reservarClave devuelve null cuando la clave ya existe, sin lanzar', async () => {
    // «La reserva se hace sin fallar cuando la clave ya existe» es literal: `ON CONFLICT DO NOTHING`
    // no devuelve fila, y quien llama resuelve el conflicto. Lanzar aquí obligaría a distinguir el
    // conflicto de un error real leyendo un mensaje.
    kdb.when.insert('siigo_facturas', []);
    const fila = await reservarClave({
      loteId: 'lote-1', ambiente: 'pruebas', clave: 'abc', tramites: [], ahora: AHORA,
    });
    expect(fila).toBeNull();
  });

  it('el cuerpo que viaja a Siigo NO lleva _total', async () => {
    // `_total` es trazabilidad interna: el armador lo marca así. Enviarlo sería un campo desconocido
    // en un documento fiscal, y Siigo rechaza lo que su comprobante no tiene configurado.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('_total');
    expect(peticiones[0]!.cuerpo).toHaveProperty('items');
  });

  it('A6 — en pruebas el cuerpo NO pide timbrar ni enviar correo', async () => {
    // La factura se crea en Siigo Nube y ahí se queda. Es lo único que separa un ensayo de un
    // documento ante la DIAN y un correo a un cliente real, y ninguna de las dos cosas se deshace.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('stamp');
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('mail');
  });

  it('A6 — en producción el timbre sí, y sin que nadie lo configure', async () => {
    // El TIMBRE se sigue derivando del ambiente, y esta prueba es la que obliga a decidirlo a
    // propósito el día que alguien quiera hacerlo configurable, en vez de descubrirlo con una
    // factura sin timbrar. La HU #11708 movió el correo —y solo el correo— a una elección del
    // envío: por eso `mail` ya no aparece aquí, donde nadie lo pidió.
    await emitirFactura([TRAMITE], { ambiente: 'produccion', ahora: () => AHORA, emision: EMISION });
    expect(peticiones[0]!.cuerpo).toHaveProperty('stamp', { send: true });
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('mail');
  });
});

// ── AC2 — el conflicto se resuelve según el estado ──────────────────────────

describe('AC2 — cada estado de la fila reservada tiene una salida', () => {
  /** La reserva choca: no hay fila nueva y la existente es la que diga cada test. */
  function conflictoCon(fila: Record<string, unknown>): void {
    kdb.when.insert('siigo_facturas', []).select('siigo_facturas', [fila]);
  }

  it('emitida — devuelve la que ya existe y NO llama a Siigo', async () => {
    conflictoCon({
      id: FACTURA, estado: 'emitida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: 'inv-viejo', numero: '77', cufe: 'cufe-x', publicUrl: 'https://y',
      totalSiigo: '150000.00', requiereRevision: false, revisionMotivo: null,
      errorCode: null, errorDetalle: null,
    });

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('ya_emitida');
    expect(r.siigoInvoiceId).toBe('inv-viejo');
    expect(peticiones).toHaveLength(0);
  });

  it('en proceso dentro del arrendamiento — no emite en paralelo', async () => {
    conflictoCon({
      id: FACTURA, estado: 'en_proceso', intentos: 1,
      enProcesoDesde: new Date(AHORA.getTime() - 60_000),
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    });

    const r = await emitirFactura([TRAMITE], {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15, emision: EMISION,
    });

    expect(r.desenlace).toBe('en_curso');
    expect(peticiones).toHaveLength(0);
  });

  it('en proceso con el arrendamiento vencido — va a reconciliación, no a una segunda emisión', async () => {
    conflictoCon({
      id: FACTURA, estado: 'en_proceso', intentos: 1,
      enProcesoDesde: new Date(AHORA.getTime() - 3_600_000),
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    });

    const r = await emitirFactura([TRAMITE], {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15, emision: EMISION,
    });

    expect(r.desenlace).toBe('huerfana');
    expect(peticiones).toHaveLength(0);
  });

  it('fallida — un reintento legítimo la reclama y vuelve a intentar', async () => {
    conflictoCon({
      id: FACTURA, estado: 'fallida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: 'x', errorDetalle: 'y',
    });
    kdb.when.update('siigo_facturas', [{
      id: FACTURA, estado: 'en_proceso', intentos: 2, enProcesoDesde: AHORA,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(peticiones).toHaveLength(1);
    expect(r.desenlace).toBe('emitida');
  });
});

// ── AC3 — la toma de una clave fallida es atómica ───────────────────────────

describe('AC3 — dos reintentos simultáneos, una sola factura', () => {
  it('reclamarFallida devuelve null cuando otro se llevó la fila', async () => {
    // El UPDATE condicionado devuelve cero filas al perdedor. Es TODA la garantía: si en vez de esto
    // se leyera el estado y luego se actualizara, los dos leerían `fallida` y los dos emitirían.
    kdb.when.update('siigo_facturas', []);
    const fila = await reclamarFallida({ ambiente: 'pruebas', clave: 'abc', ahora: AHORA });
    expect(fila).toBeNull();
  });

  it('el reintento que NO recibe fila termina sin llamar a Siigo', async () => {
    kdb.when
      .insert('siigo_facturas', [])
      .select('siigo_facturas', [{
        id: FACTURA, estado: 'fallida', intentos: 1, enProcesoDesde: null,
        siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
        requiereRevision: false, revisionMotivo: null, errorCode: 'x', errorDetalle: 'y',
      }])
      // El UPDATE no devuelve fila: se la llevó el otro reintento.
      .update('siigo_facturas', []);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(peticiones).toHaveLength(0);
    expect(r.desenlace).toBe('en_curso');
  });

  it('la condición «estado = fallida» viaja DENTRO del UPDATE', async () => {
    // Este es el test del mecanismo, y hace falta precisamente porque el mock ignora el `where`:
    // sin él, un `UPDATE` sin condición devolvería fila igual y todos los demás tests de este
    // bloque seguirían en verde mientras el código emite dos facturas. Aquí se mira la sentencia.
    await reclamarFallida({ ambiente: 'pruebas', clave: 'abc123', ahora: AHORA });

    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.filtros).toContain('fallida');
    expect(update!.filtros).toContain('abc123');
    expect(update!.filtros).toContain('pruebas');
    // Y el contador sube en el MISMO UPDATE que gana la carrera: en dos sentencias, el perdedor
    // también incrementaría.
    expect(update!.datos).toHaveProperty('intentos');
    expect(update!.datos.estado).toBe('en_proceso');
  });

  it('el reclamo borra el error anterior: describía otro intento', async () => {
    await reclamarFallida({ ambiente: 'pruebas', clave: 'abc123', ahora: AHORA });
    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.errorCode).toBeNull();
    expect(update!.datos.errorDetalle).toBeNull();
  });

  it('MUTACIÓN — si el reclamo no condicionara por estado, los dos emitirían', async () => {
    // Se simula el bug: el UPDATE devuelve fila a los DOS reintentos, que es lo que pasaría si la
    // condición `estado='fallida'` no viajara dentro de la sentencia. El test comprueba que ese
    // escenario produce dos POST — es decir, que la condición es lo único que lo impide, y no una
    // casualidad del orden de las llamadas.
    const reclamada = {
      id: FACTURA, estado: 'en_proceso', intentos: 2, enProcesoDesde: AHORA,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    };
    kdb.when
      .insert('siigo_facturas', [])
      .select('siigo_facturas', [{ ...reclamada, estado: 'fallida', intentos: 1 }])
      .update('siigo_facturas', [reclamada]);

    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const posts = peticiones.filter((p) => p.metodo === 'POST');
    expect(posts).toHaveLength(2);
    // Y aun así el simulador NO crea dos facturas, porque honra la clave de idempotencia igual que
    // Siigo. Esa es la segunda red: la primera es el UPDATE condicionado.
    expect(posts[0]!.idempotencyKey).toBe(posts[1]!.idempotencyKey);
  });
});

describe('AC3 — el reintento del POST no puede crear una segunda factura', () => {
  it('los cuatro intentos llevan la MISMA clave, y el simulador solo crea una factura', async () => {
    // Con la resiliencia REAL. Es el mecanismo más peligroso de la historia: cada reintento es otra
    // petición que puede crear otro documento ante la DIAN, y lo único que lo impide es que la clave
    // viaje idéntica en todos. Probarlo contra un sustituto que llama a la operación una sola vez
    // sería no probarlo.
    usarResilienciaReal = true;
    let intentos = 0;
    siigoRequestOrThrowMock.mockImplementation(async (req: PeticionSiigo) => {
      intentos += 1;
      peticiones.push(req);
      // Los tres primeros: Siigo no contesta. El cuarto sí, y crea la factura.
      if (intentos < 4) throw new Error('ETIMEDOUT');
      return atenderConSimulador(req);
    });

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(intentos).toBe(4);
    const claves = new Set(peticiones.map((p) => p.idempotencyKey));
    expect(claves.size).toBe(1);
    expect(r.desenlace).toBe('emitida');
    // El simulador honra la clave igual que Siigo: cuatro POST, una sola factura.
    const listado = respuestaSimulada('GET', '/v1/invoices?customer_identification=900123456');
    expect((listado.datos as { results: unknown[] }).results).toHaveLength(1);
  });

  it('si se agotan los intentos sin respuesta, la fila NO se declara fallida', async () => {
    // «No obtuve respuesta» no es «Siigo la rechazó». Declararla fallida liberaría el trámite por
    // disparador y habilitaría un reintento sobre una factura que quizá ya existe ante la DIAN. Es
    // la misma conversión que la reconciliación se niega a hacer, en el sentido contrario.
    usarResilienciaReal = true;
    siigoRequestOrThrowMock.mockRejectedValue(new Error('ETIMEDOUT'));

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('huerfana');
    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  it.each([
    [500, 'un 500 puede llegar con el documento YA creado'],
    [502, 'la pasarela no dice nada del backend'],
    [504, 'el backend no contestó a tiempo: pudo procesarlo entero'],
    [408, 'timeout'],
    [429, 'ni siquiera se procesó, pero tampoco consta'],
  ])('un %i NO prueba que la factura no exista: la fila no se declara fallida', async (status) => {
    // Es el fallo más sutil de la HU: `traducirErrorSiigo` fabrica un `SiigoApiError` para CUALQUIER
    // respuesta no-ok, así que «es un SiigoApiError» no significa «Siigo la rechazó». Y el 500 ni
    // siquiera es reintentable, así que llegaba como definitivo al primer intento y marcaba fallida
    // —liberando el trámite por disparador— sobre una factura que podía existir ante la DIAN.
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      traducirErrorSiigo(status, { Status: status, Errors: [{ Code: 'x', Message: 'y', Params: [] }] }),
    );

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('huerfana');
    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  it('si Siigo SÍ contesta rechazando, entonces sí es fallida', async () => {
    // Aquí hubo respuesta: el documento no existe y `fallida` es la verdad, no una suposición.
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      traducirErrorSiigo(400, {
        Status: 400,
        Errors: [{ Code: 'parameter_required', Message: 'seller is required', Params: ['seller'] }],
      }),
    );
    kdb.when.update('siigo_facturas', [{
      id: FACTURA, estado: 'fallida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null,
      errorCode: 'parameter_required', errorDetalle: 'seller',
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    expect(r.desenlace).toBe('fallida');
  });
});

describe('las escrituras del emisor se condicionan por estado', () => {
  it('marcar emitida exige que la fila siga en proceso', async () => {
    // Sin esta condición, un emisor lento que sobreviva a su arrendamiento pisa lo que el barrido ya
    // reconcilió. La reconciliación se protege así desde el principio; esto era la mitad que faltaba.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.estado).toBe('emitida');
    expect(update!.filtros).toContain('en_proceso');
  });

  it('marcar fallida también', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      traducirErrorSiigo(400, {
        Status: 400, Errors: [{ Code: 'parameter_required', Message: 'x', Params: [] }],
      }),
    );
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.estado).toBe('fallida');
    expect(update!.filtros).toContain('en_proceso');
  });

  it('y por el arrendamiento PROPIO, no por uno cualquiera', async () => {
    // `estado='en_proceso'` no dice de QUIÉN es la reserva. Entre medias la fila pudo pasar a
    // `fallida`, ser reclamada por otro emisor y volver a `en_proceso` con su marca: un emisor
    // zombi cumpliría la condición sobre la fila de ese otro y la pisaría, liberando el trámite con
    // una petición todavía en vuelo. `en_proceso_desde` es el sello de quién la tiene ahora.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const [update] = espia.updatesEn('siigo_facturas');
    const enlazados = espia.updatesEn('siigo_facturas')[0]!.filtros;
    expect(update!.datos.estado).toBe('emitida');
    // El arrendamiento va como parámetro del WHERE junto al estado.
    expect(enlazados).toContain('en_proceso');
    expect(kdb.update).toHaveBeenCalled();
  });

  it('el reclamo de una fallida limpia la marca de revisión caducada', async () => {
    // Describía el intento anterior, igual que el error. Heredarla haría nacer la nueva emisión
    // señalada por algo que ya no es cierto.
    await reclamarFallida({ ambiente: 'pruebas', clave: 'abc123', ahora: AHORA });

    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.requiereRevision).toBe(false);
    expect(update!.datos.revisionMotivo).toBeNull();
  });
});

// ── AC4 — en proceso lleva arrendamiento ───────────────────────────────────

describe('AC4 — el arrendamiento de en_proceso', () => {
  const base = { estado: 'en_proceso' as const };

  it('dentro del plazo, no se toca', () => {
    expect(arrendamientoVencido(
      { ...base, enProcesoDesde: new Date(AHORA.getTime() - 14 * 60_000) }, 15, AHORA,
    )).toBe(false);
  });

  it('pasado el plazo, es huérfana', () => {
    expect(arrendamientoVencido(
      { ...base, enProcesoDesde: new Date(AHORA.getTime() - 16 * 60_000) }, 15, AHORA,
    )).toBe(true);
  });

  it('MUTACIÓN — el borde exacto NO vence', () => {
    // Justo a los quince minutos la fila sigue viva. Que el borde caiga de este lado importa: al
    // otro, un barrido que corriera en el mismo instante competiría con un proceso todavía activo.
    expect(arrendamientoVencido(
      { ...base, enProcesoDesde: new Date(AHORA.getTime() - 15 * 60_000) }, 15, AHORA,
    )).toBe(false);
  });

  it('sin reloj se considera vencida: una fila así es corrupta, no una emisión en curso', () => {
    expect(arrendamientoVencido({ ...base, enProcesoDesde: null }, 15, AHORA)).toBe(true);
  });

  it('una fila que no está en proceso nunca vence', () => {
    expect(arrendamientoVencido({ estado: 'emitida', enProcesoDesde: null }, 15, AHORA)).toBe(false);
    expect(arrendamientoVencido({ estado: 'fallida', enProcesoDesde: null }, 15, AHORA)).toBe(false);
  });
});

// ── AC5 — la reconciliación ────────────────────────────────────────────────

describe('AC5 — reconciliar lo que se emitió y aquí no consta', () => {
  const VENCIDA = new Date(AHORA.getTime() - 3_600_000);

  /**
   * La huérfana, sus trámites y su tercero.
   *
   * **Trae el contenido de su lote**, y no es decoración: `cargarHuerfana` lo lee por un JOIN desde
   * `siigo_facturas`, así que en el mock —que enruta por la tabla del `from`— viaja en esta misma
   * fila. Sin él, el recálculo del total esperado no se puede hacer y la comprobación de descuadre
   * se apaga entera, que es justo lo que estas pruebas existen para no volver a permitir.
   */
  function huerfana(estado = 'en_proceso'): void {
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
        enProcesoDesde: VENCIDA, estado,
        // `EMISION` tal cual: sus cuatro claves son las mismas que devuelve el `select` del JOIN.
        conceptos: ['soat', 'tramite_digital'], ...EMISION,
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
      // El UPDATE devuelve fila: la reconciliación comprueba que llegó a escribir antes de afirmar
      // su desenlace. Con cero filas, la respuesta correcta es `indeterminada` — lo comprueba su
      // propio test más abajo.
      .update('siigo_facturas', [{ id: FACTURA }]);
    kdb.execute.mockResolvedValue([
      { id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 },
    ]);
  }

  /** Lo que la reconciliación escribió sobre `siigo_facturas`, si escribió algo. */
  function loEscrito(): Record<string, unknown> {
    return espia.updatesEn('siigo_facturas')[0]?.datos ?? {};
  }

  it('la encuentra por las observaciones y la deja emitida', async () => {
    // Primero se emite de verdad contra el simulador, para que exista una factura con las
    // observaciones que escribe el armador. Buscar una factura inventada no probaría el
    // reconocimiento, que es lo único que esta función hace.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    peticiones.length = 0;
    huerfana();

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('emitida');
    expect(r.siigoInvoiceId).toBe('mock-invoice-1');
    expect(peticiones.every((p) => p.metodo === 'GET')).toBe(true);
  });

  it('si Siigo no la tiene y la búsqueda fue concluyente, la deja fallida', async () => {
    huerfana();
    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('fallida');
  });

  it('NUNCA emite: en ningún desenlace sale un POST', async () => {
    huerfana();
    await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });
    expect(peticiones.filter((p) => p.metodo === 'POST')).toHaveLength(0);
  });

  it('un fallo de consulta deja la fila INTACTA, no fallida', async () => {
    // Es la distinción que sostiene toda la seguridad del archivo. Si un error de red se tradujera a
    // «no existe», la fila pasaría a fallida, un reintento la reclamaría y emitiría la SEGUNDA
    // factura ante la DIAN por un problema que no tenía nada que ver con la factura.
    huerfana();
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    // Sí se escribe —`updated_at`, que es el descanso entre intentos— pero NO el estado: seguimos
    // sin saber si la factura existe, y afirmarlo es exactamente lo que este archivo no hace.
    expect(loEscrito()).not.toHaveProperty('estado');
  });

  it('un cuerpo sin resultados legibles tampoco concluye', async () => {
    huerfana();
    siigoRequestOrThrowMock.mockResolvedValueOnce({ pagination: {} });

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(loEscrito()).not.toHaveProperty('estado');
  });

  /** Una página del listado, con la paginación que Siigo devuelve de verdad. */
  function pagina(n: number, cuantos: number, total: number, extra: unknown[] = []) {
    return {
      pagination: { page: n, page_size: cuantos, total_results: total },
      results: [
        ...Array.from({ length: cuantos - extra.length }, (_, i) => ({
          id: `otra-${n}-${i}`, observations: 'FLITO · FLIT-0000',
        })),
        ...extra,
      ],
    };
  }

  it('una página MENOR de la pedida no significa que se haya visto todo', async () => {
    // El fallo que este test cierra: terminar cuando `results.length < page_size PEDIDO`. El tamaño
    // lo decide el servidor —la documentación de Siigo muestra `page_size: 25` con
    // `total_results: 253`—, así que una primera página de 25 sobre 253 se daba por completa y la
    // búsqueda concluía «no existe» habiendo mirado una de cada diez facturas.
    huerfana();
    siigoRequestOrThrowMock.mockResolvedValue(pagina(1, 25, 253));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).not.toBe('fallida');
    expect(r.desenlace).toBe('indeterminada');
  });

  it('agotar el tope de páginas NO es «no existe»', async () => {
    huerfana();
    siigoRequestOrThrowMock.mockResolvedValue(pagina(1, 25, 5000));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(r.motivo).toContain('tope');
    // Se cuenta sobre el mock y no sobre `peticiones`: este test sustituye la implementación que
    // las anota, así que mirar la lista diría cero y el test pasaría sin comprobar nada.
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(MAX_PAGINAS_BUSQUEDA);
  });

  it('sin `total_results` no se concluye nada', async () => {
    huerfana();
    siigoRequestOrThrowMock.mockResolvedValue({ pagination: { page: 1 }, results: [] });

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(loEscrito()).not.toHaveProperty('estado');
  });

  it('recorre hasta agotar el total y la encuentra en la última página', async () => {
    huerfana();
    siigoRequestOrThrowMock
      .mockResolvedValueOnce(pagina(1, 25, 30))
      .mockResolvedValueOnce(pagina(2, 5, 30, [
        { id: 'inv-buena', observations: 'FLITO · FLIT-9001 · placa ABC123', total: 150000 },
      ]));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('emitida');
    expect(r.siigoInvoiceId).toBe('inv-buena');
  });

  it('agotado el total sin encontrarla, ENTONCES sí se puede afirmar que no existe', async () => {
    huerfana();
    siigoRequestOrThrowMock.mockResolvedValue(pagina(1, 3, 3));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('fallida');
  });

  it('repeticiones entre páginas no cuentan como facturas nuevas', async () => {
    // El listado no garantiza orden estable, y FLITO mismo crea facturas del mismo cliente mientras
    // el barrido pagina. Contando FILAS, una repetición alcanza el total sin haber visto el conjunto
    // entero — y ese «ya las vi todas» falso se convierte en «la factura no existe».
    huerfana();
    // Dos filas, pero la MISMA factura repetida, sobre un total de dos. Contando filas se declara
    // «ya las vi todas» y la fila local pasa a `fallida` — con la otra factura sin mirar. Contando
    // ids distintos, se ha visto una de dos y no se concluye nada.
    siigoRequestOrThrowMock.mockResolvedValue({
      pagination: { page: 1, page_size: 2, total_results: 2 },
      results: [{ id: 'dup-1', observations: 'FLITO · OTRO' }, { id: 'dup-1', observations: 'FLITO · OTRO' }],
    });

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).not.toBe('fallida');
    expect(r.desenlace).toBe('indeterminada');
  });

  it('la ventana no crece con la edad, y cubre TODOS los intentos de la clave', async () => {
    // Dos errores simétricos, los dos peligrosos. Anclada en `ahora` por arriba, la ventana crecía
    // sin límite con la edad de la huérfana y acababa rebasando el tope de páginas siempre. Anclada
    // solo en `enProcesoDesde`, se saltaba la factura que creó un intento ANTERIOR —`reclamarFallida`
    // reescribe esa marca en cada reintento—, y esa ausencia se concluía como «no existe».
    //
    // Aquí: reservada el 1 de julio, reintentada el 11 de agosto. La ventana va del primero al
    // último, con su margen.
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
        createdAt: new Date('2026-07-01T15:00:00.000Z'),
        enProcesoDesde: new Date('2026-08-11T10:00:00.000Z'),
        estado: 'en_proceso',
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
      .update('siigo_facturas', [{ id: FACTURA }]);
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 }]);

    await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });

    const ruta = peticiones[0]!.ruta;
    expect(ruta).toContain('created_start=2026-06-29');
    expect(ruta).toContain('created_end=2026-08-13');
  });

  it('lo estructural se marca para revisión pero NO desaparece del barrido', async () => {
    // Una compañía sin tercero vinculado no se arregla reintentando: sin esta marca, la fila volvía
    // a entrar en cada barrido, gastaba cuota de la que necesita la emisión, ensuciaba la bitácora
    // que alimenta el freno — y su trámite quedaba ocupado para siempre.
    huerfana();
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: null, sucursal: null }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(loEscrito().requiereRevision).toBe(true);
    // El ESTADO no cambia: seguimos sin saber si la factura existe.
    expect(loEscrito()).not.toHaveProperty('estado');
  });

  it('lo permanente NO cuenta como fallo del servicio: frenaría la facturación entera', async () => {
    // El bloqueante que encontró la auditoría de la HU #11327 al enganchar el barrido a un cron.
    // `error_tecnico` cuenta en el numerador Y en el denominador del freno; `error_negocio` queda
    // fuera de los dos. Una huérfana con impedimento permanente —compañía sin tercero, identificación
    // anonimizada por un derecho de supresión— vuelve cada media hora y produce ~48 registros al día
    // SIN una sola petición a la red. Bastaba una factura atascada y un fin de semana flojo para que
    // el freno saltara y la empresa dejara de facturar por algo que no tiene que ver con Siigo.
    huerfana();
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: null, sucursal: null }]);

    await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'factura_reconciliar',
      codigo: 'reconciliacion_indeterminada',
      resultado: 'error_negocio',
    }));
  });

  it('lo transitorio SÍ cuenta: un corte de red sí habla de la salud de Siigo', async () => {
    // La otra mitad de la misma regla. Si se excluyera todo, el freno dejaría de ver los fallos de
    // reconciliación que sí son del servicio, que es justo lo que existe para detectar.
    huerfana();
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'factura_reconciliar',
      resultado: 'error_tecnico',
    }));
  });

  it('lo transitorio NO se marca para revisión, solo descansa', async () => {
    huerfana();
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });

    // Se toca `updated_at` para espaciar el siguiente intento, y nada más.
    expect(loEscrito()).not.toHaveProperty('requiereRevision');
    expect(loEscrito()).toHaveProperty('updatedAt');
  });

  it('si el emisor resolvió la fila mientras se buscaba, no se afirma nada', async () => {
    // El UPDATE condicionado no encuentra fila. Afirmar igualmente el desenlace escribiría en una
    // bitácora que prohíbe rectificar un hecho que no ocurrió.
    huerfana();
    kdb.when.update('siigo_facturas', []);
    siigoRequestOrThrowMock.mockResolvedValue(pagina(1, 3, 3));

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(r.motivo).toContain('dejó de estar en proceso');
  });

  it('sin tercero vinculado no se puede buscar, y eso no es «no existe»', async () => {
    huerfana();
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: null, sucursal: null }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(peticiones).toHaveLength(0);
  });

  it('no reconcilia una factura de otro ambiente', async () => {
    // `pruebas` y `produccion` son EMPRESAS distintas de Siigo. Buscarla donde no está la daría por
    // inexistente, la dejaría fallida y un reintento la emitiría de verdad.
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'produccion', idempotencyKey: 'abc123',
        enProcesoDesde: VENCIDA, estado: 'en_proceso',
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }]);
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(peticiones).toHaveLength(0);
    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  it('una fila dentro de su arrendamiento no se toca', async () => {
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
        enProcesoDesde: new Date(AHORA.getTime() - 60_000), estado: 'en_proceso',
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }]);
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('en_curso');
    expect(peticiones).toHaveLength(0);
  });

  /**
   * AC6 desde la reconciliación — la comprobación de descuadre TIENE que ejecutarse.
   *
   * Este bloque nace de una regresión que 4.628 pruebas dejaron pasar, y por eso está escrito por
   * el mecanismo y no por el resultado. `revisionEsperada` llamaba a `prepararEmision` sin los
   * conceptos ni la emisión del lote. Mientras existió la configuración global de emisión eso caía
   * al respaldo y funcionaba; al retirarla, la llamada lanza `sin_configuracion` SIEMPRE, el `catch`
   * lo convierte en «no se pudo recalcular el total esperado» y el resultado es que la comprobación
   * que detecta un descuadre entre lo que Siigo cobró y la liquidación NO SE EJECUTA NUNCA.
   *
   * Es el peor tipo de fallo: nada se rompe, nada se registra como error, todas las facturas quedan
   * marcadas «para revisión» con un motivo que parece técnico, y nadie se entera de que la puerta
   * está abierta. Lo único que lo delata es afirmar las dos mitades —que lo que cuadra NO se marca,
   * y que lo que no cuadra se marca CON SUS NÚMEROS—, que es lo que se hace aquí.
   */
  describe('la comprobación de descuadre se ejecuta de verdad', () => {
    /** El listado de Siigo devuelve UNA factura, la de este trámite, con el total que se le pida. */
    function siigoLaTieneCon(total: number): void {
      siigoRequestOrThrowMock.mockResolvedValue({
        pagination: { page: 1, page_size: 1, total_results: 1 },
        results: [{
          id: 'inv-rec', observations: 'FLITO · FLIT-9001 · placa ABC123',
          name: '1', total,
        }],
      });
    }

    it('un total que cuadra NO se marca para revisión', async () => {
      // La mitad que el fallo hacía imposible: con el recálculo apagado, TODA factura reconciliada
      // salía marcada. Una alarma que suena siempre es una alarma que se ignora, y con ella se
      // ignora el descuadre real del test siguiente.
      huerfana();
      siigoLaTieneCon(150_000); // SOAT 100.000 + trámite digital 50.000

      const r = await reconciliarFactura(FACTURA, {
        ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
      });

      expect(r.desenlace).toBe('emitida');
      expect(loEscrito().requiereRevision).toBe(false);
      expect(loEscrito().revisionMotivo).toBeNull();
    });

    it('un total que NO cuadra se marca, y el motivo trae los dos números', async () => {
      huerfana();
      siigoLaTieneCon(200_000);

      const r = await reconciliarFactura(FACTURA, {
        ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
      });

      expect(r.desenlace).toBe('emitida');
      expect(loEscrito().requiereRevision).toBe(true);
      // El motivo tiene que ser el del descuadre, no un «no se pudo comprobar»: son diagnósticos
      // opuestos y mandan a mirar sitios distintos.
      expect(loEscrito().revisionMotivo).toContain('200000.00');
      expect(loEscrito().revisionMotivo).toContain('150000.00');
      expect(loEscrito().revisionMotivo).not.toMatch(/no se pudo recalcular/i);
    });

    it('una factura de selección PARCIAL no inventa un descuadre', async () => {
      // El matiz que convierte el arreglo fácil en el arreglo correcto: pasar `conceptos: []` haría
      // pasar los dos tests de arriba, porque vacío significa «todos los aplicables». Sobre una
      // factura que solo cobró el trámite digital, ese recálculo sumaría además el SOAT y marcaría
      // un descuadre de 100.000 en una factura perfectamente correcta.
      kdb.when
        .select('siigo_facturas', [{
          id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
          enProcesoDesde: VENCIDA, estado: 'en_proceso',
          conceptos: ['tramite_digital'], ...EMISION,
        }])
        .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
        .update('siigo_facturas', [{ id: FACTURA }]);
      kdb.execute.mockResolvedValue([
        { id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 },
      ]);
      siigoLaTieneCon(50_000); // solo el trámite digital

      await reconciliarFactura(FACTURA, { ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15 });

      expect(loEscrito().requiereRevision).toBe(false);
      expect(loEscrito().revisionMotivo).toBeNull();
    });

    it('un lote sin snapshot de emisión NO se da por cuadrado: se dice que no se pudo', async () => {
      // Los lotes encolados antes del 2026-08-13 no guardan con qué se emitió, así que el armador
      // los rechaza y el total no se puede reconstruir. La respuesta correcta no es callar —eso
      // sería un descuadre dado por bueno— sino marcarla para que alguien la mire.
      kdb.when
        .select('siigo_facturas', [{
          id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
          enProcesoDesde: VENCIDA, estado: 'en_proceso',
          conceptos: ['soat', 'tramite_digital'],
          documentoTipoCodigo: null, vendedorCodigo: null,
          formaPagoCodigo: null, centroCostoCodigo: null,
        }])
        .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
        .update('siigo_facturas', [{ id: FACTURA }]);
      kdb.execute.mockResolvedValue([
        { id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 },
      ]);
      siigoLaTieneCon(150_000);

      const r = await reconciliarFactura(FACTURA, {
        ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
      });

      // Queda `emitida`: el documento existe ante la DIAN pase lo que pase. Lo que cambia es la
      // marca, que es APARTE del estado justo para poder decir las dos cosas a la vez.
      expect(r.desenlace).toBe('emitida');
      expect(loEscrito().requiereRevision).toBe(true);
      expect(loEscrito().revisionMotivo).toMatch(/no se pudo recalcular/i);
    });
  });

  describe('reconocer la factura por sus observaciones', () => {
    it('exige TODOS los identificadores del grupo', () => {
      expect(observacionesCoinciden('FLITO · FLIT-1 | FLIT-2', ['FLIT-1', 'FLIT-2'])).toBe(true);
      // Una factura consolidada y otra de uno solo de sus trámites comparten marcas. Confundirlas
      // daría por emitido un grupo que no lo está.
      expect(observacionesCoinciden('FLITO · FLIT-1', ['FLIT-1', 'FLIT-2'])).toBe(false);
    });

    it('sin observaciones o sin identificadores, no coincide', () => {
      expect(observacionesCoinciden(null, ['FLIT-1'])).toBe(false);
      expect(observacionesCoinciden('FLITO · FLIT-1', [])).toBe(false);
    });

    it('compara por segmento, NO por subcadena', () => {
      // El `idFlit` llega tal cual del reporte de FLIT, sin formato garantizado. Con `includes`,
      // «9001» estaba contenido en «90012» y la factura del trámite 90012 se adjudicaba al 9001:
      // la fila local guardaba el identificador, el número y el CUFE de un documento AJENO, dado
      // por emitido, y el trámite real no se facturaba nunca.
      expect(observacionesCoinciden('FLITO · 90012 · placa XYZ789', ['9001'])).toBe(false);
      expect(observacionesCoinciden('FLITO · 19001 · placa XYZ789', ['9001'])).toBe(false);
      expect(observacionesCoinciden('FLITO · 9001 · placa ABC123', ['9001'])).toBe(true);
    });

    it('reconoce cada trámite de una factura de varios', () => {
      const obs = 'FLITO · 9001 · placa ABC123 · Traspaso | 9002 · placa DEF456 · Traspaso';
      expect(observacionesCoinciden(obs, ['9001', '9002'])).toBe(true);
      expect(observacionesCoinciden(obs, ['9001', '9003'])).toBe(false);
    });

    it('un grupo de uno NO se queda con la factura de dos', () => {
      // Con `every`, {A} satisfacía la factura de {A, B}: se adjudicaba un documento que cubre además
      // otro trámite, y ese otro quedaba contabilizado como facturado por algo que aquí no consta.
      const obs = 'FLITO · 9001 · placa ABC123 | 9002 · placa DEF456';
      expect(observacionesCoinciden(obs, ['9001'])).toBe(false);
    });

    it('los espacios sobrantes del identificador no rompen el reconocimiento', () => {
      // `idFlit` entra verbatim del reporte de FLIT, sin recorte. Un espacio final hacía que la
      // factura no se reconociera A SÍ MISMA: la búsqueda agotaba el listado, concluía «no existe» y
      // dejaba `fallida` una factura que sí está ante la DIAN. Se recortan LOS DOS lados, así que da
      // igual de qué lado venga el espacio.
      expect(observacionesCoinciden('FLITO · FL-1001  · placa ABC123', ['FL-1001'])).toBe(true);
      expect(observacionesCoinciden('FLITO ·  FL-1001 · placa ABC123', [' FL-1001'])).toBe(true);
      // Aun así, un identificador con espacios se rechaza un nivel más arriba —en la guarda de
      // ambigüedad— porque si trae espacios puede traer también un separador. Defensa en dos capas:
      // el reconocedor es tolerante, quien decide sobre un documento fiscal es estricto.
    });
  });

  describe('un identificador ambiguo no se adivina', () => {
    /** La huérfana con el `idFlit` que diga cada caso. */
    function conIdFlit(idFlit: string): void {
      kdb.when
        .select('siigo_facturas', [{
          id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
          enProcesoDesde: VENCIDA, createdAt: VENCIDA, estado: 'en_proceso',
        }])
        .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
        .update('siigo_facturas', [{ id: FACTURA }]);
      kdb.execute.mockResolvedValue([{ id_flit: idFlit, identificacion: '900123456', sucursal: 0 }]);
    }

    it.each(['FL|9', 'FL·1001', 'FL-1001 '])(
      'el identificador %s hace ambiguas las observaciones: no se concluye nada',
      async (idFlit) => {
        // `FL|9` produce las marcas {FL, 9}: un grupo cuyo id fuera `FL` se adjudicaría esa factura
        // ajena. Y un id con `·` dentro no se reconoce a sí mismo. En los dos sentidos el
        // reconocimiento deja de ser fiable, así que no se afirma nada sobre el documento.
        conIdFlit(idFlit);

        const r = await reconciliarFactura(FACTURA, {
          ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
        });

        expect(r.desenlace).toBe('indeterminada');
        expect(r.motivo).toContain('ambiguas');
        expect(peticiones).toHaveLength(0);
      },
    );
  });
});

describe('la salida humana de una huérfana que la máquina no puede comprobar', () => {
  const VENCIDA_H = new Date(AHORA.getTime() - 3_600_000);

  function atascada(over: Record<string, unknown> = {}): void {
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
        enProcesoDesde: VENCIDA_H, createdAt: VENCIDA_H, estado: 'en_proceso', ...over,
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
      .update('siigo_facturas', [{ id: FACTURA }]);
    kdb.execute.mockResolvedValue([{ id_flit: 'FLIT-9001', identificacion: '900123456', sucursal: 0 }]);
  }

  /** Siigo confirma el documento y sus observaciones son las de este trámite. */
  function siigoConfirma(id: string, observaciones = 'FLITO · FLIT-9001 · placa ABC123'): void {
    siigoRequestOrThrowMock.mockImplementationOnce(async (req: PeticionSiigo) => {
      peticiones.push(req);
      return { id, observations: observaciones, total: 150000 };
    });
  }

  it('«sí existe» se COMPRUEBA en Siigo antes de escribir', async () => {
    atascada();
    siigoConfirma('inv-humano');

    const r = await resolverHuerfanaAMano(
      FACTURA, { existe: true, siigoInvoiceId: 'inv-humano' },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    );

    expect(r.desenlace).toBe('emitida');
    // Se leyó el documento: `emitida` no tiene marcha atrás en todo el repositorio, así que no se
    // acepta un identificador a ciegas.
    expect(peticiones[0]!.metodo).toBe('GET');
    expect(peticiones[0]!.ruta).toContain('inv-humano');
    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.estado).toBe('emitida');
    expect(update!.datos.siigoInvoiceId).toBe('inv-humano');
    expect(update!.datos.requiereRevision).toBe(true);
  });

  it('un identificador inventado NO deja la fila emitida', async () => {
    // Bastaba un error de dedo: `emitida` es terminal, el trámite quedaba retenido para siempre y el
    // sondeo DIAN consultaría eternamente un documento inexistente, alimentando el freno.
    atascada();
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      traducirErrorSiigo(404, { Status: 404, Errors: [{ Code: 'not_found', Message: 'x', Params: [] }] }),
    );

    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: true, siigoInvoiceId: 'no-existe' },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(/no se pudo comprobar/i);

    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  it('la factura de OTRO trámite se rechaza aunque exista en Siigo', async () => {
    atascada();
    siigoConfirma('inv-ajena', 'FLITO · FLIT-0000 · placa ZZZ999');

    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: true, siigoInvoiceId: 'inv-ajena' },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(/no es la de este trámite/);

    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  /** Una huérfana vencida, lista para reconciliar automáticamente. */
  function atascadaRec(): void {
    kdb.when
      .select('siigo_facturas', [{
        id: FACTURA, ambiente: 'pruebas', idempotencyKey: 'abc123',
        enProcesoDesde: VENCIDA_H, createdAt: VENCIDA_H, estado: 'en_proceso',
      }])
      .select('siigo_factura_tramites', [{ tramiteId: TRAMITE }])
      .update('siigo_facturas', [{ id: FACTURA }]);
  }

  it('no concluye «no existe» si la identificación está anonimizada', async () => {
    // El derecho al olvido sustituye `siigo_terceros.identificacion` por `ANON-…`. Buscar con esa
    // llave devuelve `total_results: 0` —correctamente, nadie tiene facturas con ella— y el recorrido
    // concluía que la factura no existe: fila `fallida`, trámite liberado, y una afirmación FALSA
    // sobre un documento vivo ante la DIAN escrita en una bitácora que prohíbe rectificar.
    atascadaRec();
    kdb.execute.mockResolvedValue([{
      id_flit: 'FLIT-9001', identificacion: 'ANON-a1b2c3d4', sucursal: 0,
      tercero_actualizado_en: VENCIDA_H,
    }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(r.motivo).toContain('anonimizada');
    expect(peticiones).toHaveLength(0);
  });

  it('no concluye «no existe» si el tercero cambió DESPUÉS de reservarse la factura', async () => {
    // `asegurarTercero` reescribe la identificación cuando cambia la ficha fiscal del cliente. Si eso
    // pasó después de la reserva, la llave de ahora puede no ser la de entonces — y no se puede
    // afirmar que se buscó donde se emitió.
    atascadaRec();
    kdb.execute.mockResolvedValue([{
      id_flit: 'FLIT-9001', identificacion: '900999999', sucursal: 0,
      tercero_actualizado_en: new Date(AHORA.getTime() - 60_000),
    }]);

    const r = await reconciliarFactura(FACTURA, {
      ambiente: 'pruebas', ahora: () => AHORA, arrendamientoMin: 15,
    });

    expect(r.desenlace).toBe('indeterminada');
    expect(r.motivo).toContain('se modificó después');
    expect(peticiones).toHaveLength(0);
  });

  it('no toca una fila con una emisión EN CURSO', async () => {
    // El veredicto humano es rancio por construcción: entre mirar Siigo y pulsar cabe un reintento
    // entero que sí creó el documento. Resolverla entonces liberaría el trámite con la factura viva.
    atascada({ enProcesoDesde: new Date(AHORA.getTime() - 60_000) });

    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: false },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(/emisión en curso/);

    expect(espia.updatesEn('siigo_facturas')).toHaveLength(0);
  });

  it('«no existe» la deja fallida y libera el trámite', async () => {
    atascada();
    const r = await resolverHuerfanaAMano(
      FACTURA, { existe: false }, { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    );

    expect(r.desenlace).toBe('fallida');
    expect(espia.updatesEn('siigo_facturas')[0]!.datos.errorCode).toBe('resuelta_a_mano');
  });

  it('NO consulta ni emite: registra lo que una persona fue a mirar', async () => {
    atascada();
    await resolverHuerfanaAMano(
      FACTURA, { existe: false },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    );
    expect(peticiones).toHaveLength(0);
  });

  it('queda en la bitácora con su autor: es una afirmación humana sobre un documento fiscal', async () => {
    atascada();
    siigoConfirma('inv-humano');
    await resolverHuerfanaAMano(
      FACTURA, { existe: true, siigoInvoiceId: 'inv-humano' },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    );

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'factura_reconciliar',
      codigo: 'resuelta_a_mano_existe',
      createdBy: 42,
    }));
  });

  it('no toca una factura que ya no está en proceso', async () => {
    atascada({ estado: 'emitida' });
    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: false },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(SiigoReconciliacionError);
  });

  it('si la resolvió su emisor mientras la persona miraba, gana la máquina', async () => {
    // La misma guarda que usa el barrido. Sin ella, un veredicto humano tomado sobre información de
    // hace cinco minutos pisaría el que la emisión acaba de escribir con la respuesta de Siigo.
    atascada();
    kdb.when.update('siigo_facturas', []);

    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: false },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(/dejó de estar en proceso/);
  });

  it('no cruza ambientes', async () => {
    atascada({ ambiente: 'produccion' });
    await expect(resolverHuerfanaAMano(
      FACTURA, { existe: false },
      { ambiente: 'pruebas', usuarioId: 42, ahora: () => AHORA, arrendamientoMin: 15 },
    )).rejects.toThrow(/ambiente/);
  });
});

// ── AC6 — el total que no cuadra ───────────────────────────────────────────

describe('AC6 — un total distinto se marca, no se acepta', () => {
  it('cuadrando, no hay nada que revisar', () => {
    expect(revisionDeTotal(150000, 150000)).toBeNull();
  });

  it('la diferencia de redondeo no es un descuadre', () => {
    expect(revisionDeTotal(150000.004, 150000)).toBeNull();
  });

  it('un total distinto se explica con las dos cifras y la diferencia', () => {
    const motivo = revisionDeTotal(151000, 150000);
    expect(motivo).toContain('151000.00');
    expect(motivo).toContain('150000.00');
    expect(motivo).toContain('1000.00');
  });

  it('que Siigo NO reporte total también es motivo de revisión', () => {
    // No poder comprobarlo no es lo mismo que haberlo comprobado. Tratar el hueco como «cuadra» es
    // exactamente la forma de que un descuadre pase en silencio.
    expect(revisionDeTotal(null, 150000)).toContain('no reportó el total');
  });

  it('la factura queda emitida y marcada cuando Siigo liquida otro total', async () => {
    // Se afirma sobre lo que el servicio ESCRIBE, no sobre la fila que el propio test devolvió: eso
    // último sería una tautología —el test comprobaría su propio fixture—. La liquidación suma
    // 150.000; se hace que Siigo conteste 151.000, que es el descuadre real que el AC6 describe.
    siigoRequestOrThrowMock.mockImplementationOnce(async (req: PeticionSiigo) => {
      peticiones.push(req);
      return { id: 'mock-invoice-1', number: 1, name: 'FV-1-1', total: 151000, public_url: 'https://x' };
    });

    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const [update] = espia.updatesEn('siigo_facturas');
    // Emitida: el documento existe ante la DIAN pase lo que pase con el total.
    expect(update!.datos.estado).toBe('emitida');
    expect(update!.datos.requiereRevision).toBe(true);
    expect(String(update!.datos.revisionMotivo)).toContain('1000.00');
    expect(update!.datos.totalSiigo).toBe('151000.00');
  });

  it('cuadrando, no se marca nada', async () => {
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const [update] = espia.updatesEn('siigo_facturas');
    expect(update!.datos.requiereRevision).toBe(false);
    expect(update!.datos.revisionMotivo).toBeNull();
  });
});

// ── AC7 — las guardas, antes de salir a la red ─────────────────────────────

describe('AC7 — un rechazo no consume cuota ni deja la clave reservada', () => {
  it('un trámite no elegible se rechaza sin petición y sin reserva', async () => {
    evaluarElegibilidadMock.mockResolvedValue([{
      tramiteId: TRAMITE,
      elegible: false,
      motivos: [{ motivo: 'compuerta_cerrada', detalle: 'La parametrización no está confirmada.' }],
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('no_elegible');
    expect(r.motivos).toEqual(['La parametrización no está confirmada.']);
    expect(peticiones).toHaveLength(0);
    expect(r.facturaId).toBeNull();
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('los motivos se propagan tal cual, sin reinterpretarse', async () => {
    evaluarElegibilidadMock.mockResolvedValue([{
      tramiteId: TRAMITE,
      elegible: false,
      motivos: [
        { motivo: 'cliente_no_facturable', detalle: 'Falta el tipo de identificación.' },
        { motivo: 'documentacion_incompleta', detalle: 'Falta el soporte del SOAT.' },
      ],
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });
    expect(r.motivos).toEqual(['Falta el tipo de identificación.', 'Falta el soporte del SOAT.']);
  });

  it('«ya facturado» sobre la MISMA clave devuelve la factura, no un rechazo', async () => {
    // No es un error de configuración: es la respuesta idempotente. Devolver «no elegible» haría
    // pensar que hay algo que corregir cuando lo correcto ya ocurrió.
    evaluarElegibilidadMock.mockResolvedValue([{
      tramiteId: TRAMITE,
      elegible: false,
      motivos: [{ motivo: 'ya_facturado', detalle: 'Ya tiene una factura viva.' }],
    }]);
    kdb.when.select('siigo_facturas', [{
      id: FACTURA, estado: 'emitida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: 'inv-1', numero: '5', cufe: 'cufe-1', publicUrl: 'https://z',
      totalSiigo: '150000.00', requiereRevision: false, revisionMotivo: null,
      errorCode: null, errorDetalle: null,
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('ya_emitida');
    expect(r.siigoInvoiceId).toBe('inv-1');
    expect(peticiones).toHaveLength(0);
  });

  it('«ya facturado» por una factura de OTRA clave sí es un rechazo', async () => {
    // El día que se consolide, un trámite podrá estar vivo en una factura cuyo lote no es este.
    // Emitir entonces lo pondría en dos facturas distintas.
    evaluarElegibilidadMock.mockResolvedValue([{
      tramiteId: TRAMITE,
      elegible: false,
      motivos: [{ motivo: 'ya_facturado', detalle: 'Ya tiene una factura viva.' }],
    }]);
    kdb.when.select('siigo_facturas', []);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('no_elegible');
    expect(peticiones).toHaveLength(0);
  });

  it('se miran TODOS los trámites del grupo, no solo el primero', async () => {
    // Hoy el agrupador entrega grupos de uno y esto daría igual. El día que se consolide, quedarse
    // con el primer veredicto facturaría un grupo cuyo segundo trámite no está en regla — y no se
    // vería, porque la factura saldría bien.
    const otro = 'cccccccc-1111-4111-8111-cccccccccccc';
    evaluarElegibilidadMock.mockResolvedValue([
      { tramiteId: TRAMITE, elegible: true, motivos: [] },
      { tramiteId: otro, elegible: false, motivos: [{ motivo: 'documentacion_incompleta', detalle: 'Falta el SOAT.' }] },
    ]);

    const r = await emitirFactura([TRAMITE, otro], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('no_elegible');
    expect(r.motivos).toContain('Falta el SOAT.');
    expect(peticiones).toHaveLength(0);
  });

  it('un trámite del que la elegibilidad no dice nada NO es un trámite aprobado', async () => {
    const otro = 'cccccccc-1111-4111-8111-cccccccccccc';
    evaluarElegibilidadMock.mockResolvedValue([{ tramiteId: TRAMITE, elegible: true, motivos: [] }]);

    const r = await emitirFactura([TRAMITE, otro], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('no_elegible');
    expect(peticiones).toHaveLength(0);
  });

  it('si otro proceso gana la carrera del trámite, no se emite y no queda clave reservada', async () => {
    // El índice parcial de la base impide que un trámite esté en dos facturas vivas. La violación se
    // traduce a un error de dominio: el de Postgres, envuelto por drizzle, lleva la sentencia y sus
    // parámetros dentro y acabaría en un log.
    kdb.when.insert('siigo_factura_tramites', () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    });

    await expect(emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION }))
      .rejects.toThrow(/Otro proceso acaba de facturar/);
    expect(peticiones).toHaveLength(0);
  });

  it('trámites de compañías distintas no se facturan juntos', async () => {
    // No es una factura rara: es una factura de la que no se sabe quién es el adquiriente. Los dos
    // trámites son elegibles por separado — el problema es juntarlos, y por eso la elegibilidad no
    // puede verlo: ella juzga fila a fila.
    const otro = 'cccccccc-1111-4111-8111-cccccccccccc';
    evaluarElegibilidadMock.mockResolvedValue([
      { tramiteId: TRAMITE, elegible: true, motivos: [] },
      { tramiteId: otro, elegible: true, motivos: [] },
    ]);
    kdb.when.select('flito_tramites', [
      filaTramite(), filaTramite({ tramiteId: otro, idFlit: 'FLIT-9002', companiaId: 9 }),
    ]);

    await expect(emitirFactura([TRAMITE, otro], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION }))
      .rejects.toThrow(/compañías distintas/);
    expect(peticiones).toHaveLength(0);
  });

  it('sin compañía no hay a quién facturarle', async () => {
    kdb.when.select('flito_tramites', [filaTramite({ companiaId: null })]);

    await expect(emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION }))
      .rejects.toThrow(/compañía asociada/);
    expect(peticiones).toHaveLength(0);
  });
});

// ── AC8 — bitácora y modo simulado ─────────────────────────────────────────

describe('AC8 — todo intento queda registrado', () => {
  it('el éxito se registra con ambiente, modo, duración y resultado', async () => {
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, usuarioId: 3, emision: EMISION });

    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'factura_emitir',
      ambiente: 'pruebas',
      resultado: 'ok',
      entidadTipo: 'siigo_factura',
      entidadId: FACTURA,
      createdBy: 3,
    }));
    const r = registrarOperacionMock.mock.calls[0]![0] as { duracionMs: number; modo: string };
    expect(typeof r.duracionMs).toBe('number');
    expect(r.modo).toBeTruthy();
  });

  it('A6 — la bitácora dice que NO se timbró, no se calla', async () => {
    // `undefined` desaparece al serializar el JSON. Sin normalizar la ausencia a un `false`
    // explícito, una factura deliberadamente sin timbrar quedaría idéntica a una anotada por una
    // versión vieja de esta función, y nadie podría distinguirlas después.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const { requestBody } = registrarOperacionMock.mock.calls[0]![0] as { requestBody: Record<string, unknown> };
    expect(requestBody.stamp).toEqual({ send: false });
    expect(requestBody.mail).toBe(false);
    // Y el `false` es lo REGISTRADO, no lo enviado: a Siigo no le viajó ninguna de las dos claves.
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('stamp');
  });

  it('la respuesta se registra NORMALIZADA, no cruda', async () => {
    // El cuerpo de Siigo trae el cliente entero. Esta tabla prohíbe UPDATE y DELETE por disparador,
    // así que un dato personal escrito aquí por error ya no se puede rectificar ni suprimir.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const registro = registrarOperacionMock.mock.calls[0]![0] as { responseBody: unknown };
    expect(registro.responseBody).not.toHaveProperty('customer');
    expect(registro.responseBody).not.toHaveProperty('items');
    expect(registro.responseBody).toHaveProperty('siigoInvoiceId');
  });

  it('la PETICIÓN registrada no lleva identificación ni placa', async () => {
    // `siigo_operaciones` es WORM: lo que entra ahí no se puede rectificar ni suprimir, así que los
    // derechos del art. 8 de la Ley 1581 no se pueden ejercer sobre su contenido. La identificación
    // puede ser una cédula —el modelo admite `personType: 'Person'`— y la placa es dato personal en
    // cuanto es asociable a su propietario, que es justo lo que FLITO guarda.
    await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    const { requestBody } = registrarOperacionMock.mock.calls[0]![0] as { requestBody: Record<string, unknown> };
    expect(JSON.stringify(requestBody)).not.toContain('900123456');
    expect(JSON.stringify(requestBody)).not.toContain('ABC123');
    // Y sí lleva lo que hace falta para reconstruir qué se envió y a quién.
    expect(requestBody.clienteId).toBe(7);
    expect(requestBody.tramites).toEqual(['FLIT-9001']);
    expect(requestBody).toHaveProperty('items');
  });

  it('el fallo se registra y la fila queda fallida', async () => {
    siigoRequestOrThrowMock.mockRejectedValueOnce(
      traducirErrorSiigo(400, {
        Status: 400,
        Errors: [{ Code: 'parameter_required', Message: 'seller is required', Params: ['seller'] }],
      }),
    );
    kdb.when.update('siigo_facturas', [{
      id: FACTURA, estado: 'fallida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null,
      errorCode: 'parameter_required', errorDetalle: 'seller',
    }]);

    const r = await emitirFactura([TRAMITE], { ambiente: 'pruebas', ahora: () => AHORA, emision: EMISION });

    expect(r.desenlace).toBe('fallida');
    expect(r.errorCode).toBe('parameter_required');
    expect(registrarOperacionMock).toHaveBeenCalledWith(expect.objectContaining({
      operacion: 'factura_emitir',
      resultado: 'error_negocio',
      codigo: 'parameter_required',
    }));
  });
});

// ── El simulador, que es donde se recorre el ciclo ─────────────────────────

describe('el simulador impone lo que impone Siigo', () => {
  it('honra la clave de idempotencia: la misma clave NO crea una segunda factura', async () => {
    const cuerpo = {
      document: { id: 24446 }, date: '2026-08-11',
      customer: { identification: '900123456', branch_office: 0 }, seller: 629,
      items: [{ code: 'P-1', quantity: 1, price: 1000 }], payments: [{ id: 5636, value: 1000 }],
    };

    const uno = respuestaSimulada('POST', '/v1/invoices', { cuerpo, idempotencyKey: 'K1' });
    const dos = respuestaSimulada('POST', '/v1/invoices', { cuerpo, idempotencyKey: 'K1' });

    expect(uno.status).toBe(201);
    // 200 y no 201: Siigo devuelve el comprobante YA creado, no uno nuevo.
    expect(dos.status).toBe(200);
    expect((dos.datos as { id: string }).id).toBe((uno.datos as { id: string }).id);
  });

  it('exige los obligatorios que exige Siigo', () => {
    const r = respuestaSimulada('POST', '/v1/invoices', { cuerpo: { document: { id: 1 } } });
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
  });

  it('rechaza una factura sin líneas', () => {
    const r = respuestaSimulada('POST', '/v1/invoices', {
      cuerpo: {
        document: { id: 1 }, date: '2026-08-11', customer: { identification: '9' }, seller: 1,
        items: [], payments: [{ id: 1, value: 1 }],
      },
    });
    expect(r.status).toBe(400);
  });

  it('calcula el total de las líneas en vez de devolver cero', () => {
    const r = respuestaSimulada('POST', '/v1/invoices', {
      cuerpo: {
        document: { id: 1 }, date: '2026-08-11', customer: { identification: '9' }, seller: 1,
        items: [{ code: 'A', quantity: 2, price: 1000 }, { code: 'B', quantity: 1, price: 500 }],
        payments: [{ id: 1, value: 2500 }],
      },
    });
    expect((r.datos as { total: number }).total).toBe(2500);
  });

  it('el listado filtra por identificación del cliente', () => {
    respuestaSimulada('POST', '/v1/invoices', {
      cuerpo: {
        document: { id: 1 }, date: '2026-08-11', customer: { identification: '111' }, seller: 1,
        items: [{ code: 'A', quantity: 1, price: 10 }], payments: [{ id: 1, value: 10 }],
      },
    });

    const mias = respuestaSimulada('GET', '/v1/invoices?customer_identification=111');
    const ajenas = respuestaSimulada('GET', '/v1/invoices?customer_identification=222');

    expect((mias.datos as { results: unknown[] }).results).toHaveLength(1);
    expect((ajenas.datos as { results: unknown[] }).results).toHaveLength(0);
  });
});

// ── Piezas puras ───────────────────────────────────────────────────────────

describe('normalizar lo que Siigo devuelve', () => {
  it('lee solo lo que se guarda', () => {
    const r = normalizarFacturaEmitida({
      id: 'inv-1', number: 22, name: 'FV-2-22', cufe: 'c1', public_url: 'https://p', total: 1500,
      customer: { identification: '900123456' }, items: [{ code: 'A' }],
    });
    expect(r).toEqual({
      siigoInvoiceId: 'inv-1', numero: '22', comprobanteNombre: 'FV-2-22',
      cufe: 'c1', publicUrl: 'https://p', total: 1500,
    });
  });

  it('sin identificador lanza: no habría nada que reconciliar después', () => {
    expect(() => normalizarFacturaEmitida({ number: 1 })).toThrow(SiigoEmisionError);
  });

  it('un cuerpo ilegible lanza en vez de dar por buena una emisión', () => {
    expect(() => normalizarFacturaEmitida('vaya')).toThrow(SiigoEmisionError);
    expect(() => normalizarFacturaEmitida(null)).toThrow(SiigoEmisionError);
  });

  it('sin CUFE no es un error: la DIAN todavía no se ha pronunciado', () => {
    expect(normalizarFacturaEmitida({ id: 'inv-1' }).cufe).toBeNull();
  });

  it('un total no numérico se trata como ausente, no como cero', () => {
    // Cero es un total; ausente es no saberlo. Confundirlos haría que una factura sin total
    // reportado se comparara contra cero y saliera «descuadrada» por la razón equivocada.
    expect(normalizarFacturaEmitida({ id: 'i', total: 'mil' }).total).toBeNull();
    expect(normalizarFacturaEmitida({ id: 'i', total: 0 }).total).toBe(0);
  });
});

describe('la fecha del documento', () => {
  it('se resuelve en hora de Colombia, no en UTC', () => {
    // Las 02:00 UTC del día 12 son las 21:00 del día 11 en Bogotá. Con UTC, Siigo recibiría una
    // fecha de mañana, y en electrónicas no admite fecha distinta de hoy.
    expect(fechaDocumento(new Date('2026-08-12T02:00:00.000Z'))).toBe('2026-08-11');
    expect(fechaDocumento(new Date('2026-08-11T15:00:00.000Z'))).toBe('2026-08-11');
  });
});

describe('preparar el armado', () => {
  const TERCERO = { identificacion: '900123456', sucursal: 0 };

  it('sin trámites no se prepara nada', async () => {
    await expect(prepararEmision({
      tramiteIds: [TRAMITE], tramites: [], ambiente: 'pruebas', tercero: TERCERO, ahora: AHORA,
    })).rejects.toThrow(SiigoEmisionError);
  });

  it('un lote sin con qué emitir se rechaza y dice que hay que reenviarlo', async () => {
    // Ya no existe una configuración global a la que caer: si el lote no trae comprobante,
    // vendedor y forma de pago, es un lote encolado antes del cambio y no se puede emitir. El
    // mensaje tiene que decir la salida —reenviar—, no solo que falta algo.
    await expect(prepararEmision({
      tramiteIds: [TRAMITE], tramites: await cargarTramites([TRAMITE]),
      ambiente: 'pruebas', tercero: TERCERO, ahora: AHORA,
    })).rejects.toThrow(/vuelve a enviar los trámites/);
  });

  it('la clave de idempotencia no depende del orden de los trámites', async () => {
    const otro = 'cccccccc-1111-4111-8111-cccccccccccc';
    kdb.when.select('flito_tramites', [filaTramite(), filaTramite({ tramiteId: otro, idFlit: 'FLIT-9002' })]);
    const tramites = await cargarTramites([TRAMITE, otro]);

    const a = await prepararEmision({
      tramiteIds: [TRAMITE, otro], tramites, ambiente: 'pruebas', tercero: TERCERO, ahora: AHORA,
      emision: EMISION });
    const b = await prepararEmision({
      tramiteIds: [otro, TRAMITE], tramites, ambiente: 'pruebas', tercero: TERCERO, ahora: AHORA,
      emision: EMISION });

    expect(a.clave).toBe(b.clave);
  });
});
