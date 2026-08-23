// Siigo — elegir en el envío si la factura sale por correo y a quién (HU #11708). Un bloque por AC.
//
// El test que importa de esta historia es el del AC4, y no es el camino feliz de ninguno de los
// otros cinco: **la casilla del envío no puede abrir el candado del ambiente**. Fuera de producción
// las facturas son ensayos, pero las direcciones a las que saldrían son de clientes reales y un
// correo enviado no se deshace. Por eso ese bloque prueba la regla por el MECANISMO —qué se le pide
// a Siigo y qué queda escrito— y por los dos caminos: la función que decide y la emisión entera.
//
// Si alguien convierte el `&&` de `decidirCorreoDeEmision` en un `||` «para poder ensayar el envío
// en pruebas», los tres primeros casos del AC4 se ponen rojos. Esa es la garantía; el resto de este
// archivo describe qué queda escrito en cada desenlace, que es el AC2.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

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

const resolverMapeoMock = vi.fn();
vi.mock('../../src/modules/siigo/mapeo-conceptos.service.js', () => ({
  resolverMapeo: (amb: string, c: string, t: string | null) => resolverMapeoMock(amb, c, t),
}));

/** Las peticiones las atiende el SIMULADOR del módulo, incluida la ruta de correo. */
const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');
const { traducirErrorSiigo } = await import('../../src/modules/siigo/siigo.errors.js');

interface PeticionSiigo { metodo: string; ruta: string; cuerpo?: unknown; idempotencyKey?: string }
const peticiones: PeticionSiigo[] = [];

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

vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const { correoNoSolicitado, decidirCorreoDeEmision } = await import(
  '../../src/modules/siigo/facturacion.correo.js');
const { emitirFactura } = await import('../../src/modules/siigo/facturacion.emision.service.js');
const { enviarFacturaPorCorreo, validarDestinatarios } = await import(
  '../../src/modules/siigo/siigo.envio-correo.service.js');

const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const AHORA = new Date('2026-08-22T15:00:00.000Z');

/** Con qué se emite. Se elige al enviar y viaja con el lote; aquí se pasa como lo hace el cron. */
const EMISION = {
  documentoTipoCodigo: '24446', vendedorCodigo: '629', formaPagoCodigo: '5636',
  centroCostoCodigo: null,
};

/** La dirección que la FICHA del cliente resuelve. No es la elegida: esa se escribe en el envío. */
const DE_LA_FICHA = 'facturacion@empresa.test';
const manual = (correo: string) => ({ correo, origen: 'manual' as const });

function filaTramite(over: Record<string, unknown> = {}) {
  return {
    tramiteId: TRAMITE,
    idFlit: 'FLIT-9001',
    placa: 'ABC123',
    tipoTramite: 'Traspaso',
    companiaId: 7,
    liquidacionId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    valorSoat: null,
    valorImpuesto: null,
    valorDerecho: null,
    valorTramiteDigital: '50000.00',
    valorLogistica: null,
    valorGmf: null,
    ...over,
  };
}

/**
 * Todo en orden: el trámite es elegible, el tercero existe, la reserva se gana y la factura se
 * emite. Lo único que cambia entre casos es la elección del correo y el ambiente.
 */
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
    // La ficha del cliente, que es de donde salen los destinatarios cuando el envío no eligió.
    .select('clients', [{ email: DE_LA_FICHA, contactEmail: 'contadora@empresa.test' }])
    .select('siigo_lotes_facturacion', [{ id: 'lote-1' }])
    // La factura ya emitida, tal como la lee el envío de correo por su ruta propia.
    .select('siigo_facturas', [{
      id: FACTURA, ambiente: 'produccion', siigoInvoiceId: 'mock-invoice-1', numero: '1',
      estado: 'emitida', clienteEmail: DE_LA_FICHA, clienteContactEmail: null,
    }])
    .insert('siigo_lotes_facturacion', [{ id: 'lote-1' }])
    .insert('siigo_factura_tramites', [])
    .insert('siigo_facturas', [{
      id: FACTURA, estado: 'en_proceso', intentos: 1, enProcesoDesde: AHORA,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
    }])
    .insert('siigo_factura_envios', () => [{
      id: 'acta-1', facturaId: FACTURA, origen: 'emision', resultado: 'enviado',
      destinatarios: [], destinatariosPurgadosEn: null, codigo: null, motivo: null,
      solicitadoPor: null, createdAt: AHORA,
    }])
    .update('siigo_facturas', [{
      id: FACTURA, estado: 'emitida', intentos: 1, enProcesoDesde: null,
      siigoInvoiceId: 'mock-invoice-1', numero: '1', cufe: null, publicUrl: 'https://x',
      totalSiigo: '50000.00', requiereRevision: false, revisionMotivo: null,
      errorCode: null, errorDetalle: null,
    }]);
}

/** El acta que la emisión escribió, leída del INSERT real y no de lo que el mock devolvió. */
function acta(): Record<string, unknown> {
  return espia.ultimoInsertEn('siigo_factura_envios');
}

/** El cuerpo del `POST /v1/invoices`. Es lo que de verdad viaja a Siigo al crear la factura. */
function cuerpoDeLaCreacion(): Record<string, unknown> {
  return peticiones[0]!.cuerpo as Record<string, unknown>;
}

/** La petición de correo, si la hubo. `undefined` significa que no se le pidió a Siigo que mandara. */
function peticionDeCorreo(): PeticionSiigo | undefined {
  return peticiones.find((p) => p.ruta.endsWith('/mail'));
}

function emitirCon(
  correo: { solicitado: boolean; destinatarios: { correo: string; origen: 'manual' }[] },
  ambiente: 'pruebas' | 'produccion' = 'produccion',
) {
  return emitirFactura([TRAMITE], { ambiente, ahora: () => AHORA, emision: EMISION, correo });
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  peticiones.length = 0;
  vi.clearAllMocks();
  siigoRequestOrThrowMock.mockImplementation(atenderConSimulador);
  escenarioFeliz();
});

// ── AC4 — la elección NO abre el candado del ambiente ───────────────────────

describe('AC4 — marcar la casilla no manda correo desde un ambiente que no es producción', () => {
  it('la decisión es elección Y ambiente: pedirlo en pruebas NO enciende el correo', () => {
    // El caso que da nombre al criterio. Si el `&&` de `decidirCorreoDeEmision` se convirtiera en un
    // `||` —«que la elección mande»—, esto devolvería `enviar: true` y una factura de ensayo saldría
    // hacia un cliente real. La mutación tiene que poner rojo este test antes que ningún otro.
    const d = decidirCorreoDeEmision({
      elegido: { solicitado: true, destinatarios: [manual('cartera@empresa.test')] },
      deLaFicha: [],
      efectosExternos: false,
      ambiente: 'pruebas',
    });

    expect(d.enviar).toBe(false);
    expect(d.codigo).toBe('ambiente_no_productivo');
  });

  it('y el motivo dice que en ESE ambiente no se manda correo a nadie, no que falte un dato', () => {
    // Quien lo lee tiene que entender que no hay nada que corregir en la factura ni en la ficha: es
    // el ambiente. Un motivo genérico mandaría a alguien a revisar el correo del cliente.
    const d = decidirCorreoDeEmision({
      elegido: { solicitado: true, destinatarios: [] },
      deLaFicha: [{ correo: DE_LA_FICHA, origen: 'compania' }],
      efectosExternos: false,
      ambiente: 'pruebas',
    });

    expect(d.motivo).toContain('pruebas');
    expect(d.motivo).toMatch(/no se manda correo a nadie/i);
    // Ley 1581: ni siquiera aquí sale una dirección al texto que acabará en la columna `motivo`.
    expect(d.motivo).not.toContain('@');
  });

  it('emitiendo de verdad en pruebas: el cuerpo no lleva `mail` y NO se pide correo a Siigo', async () => {
    // La comprobación por el mecanismo: no basta con que la decisión diga que no. Lo que no puede
    // pasar es que salga una petición, y son dos las que podrían mandarlo —`mail: true` en la
    // creación y la ruta `/mail`—, así que se comprueban las dos.
    await emitirCon({ solicitado: true, destinatarios: [manual('cartera@empresa.test')] }, 'pruebas');

    expect(cuerpoDeLaCreacion()).not.toHaveProperty('mail');
    expect(peticionDeCorreo()).toBeUndefined();
  });

  it('y aun así queda acta: `no_realizado` con el ambiente como motivo', async () => {
    // No sale correo, pero la pregunta «¿por qué no le llegó?» tiene respuesta. Sin el acta, este
    // caso sería idéntico al de una emisión a la que se le olvidó el correo.
    await emitirCon({ solicitado: true, destinatarios: [manual('cartera@empresa.test')] }, 'pruebas');

    expect(acta()).toMatchObject({
      origen: 'emision', resultado: 'no_realizado', codigo: 'ambiente_no_productivo',
    });
  });
});

// ── AC1 — se pide el correo y el ambiente lo permite ────────────────────────

describe('AC1 — en producción y con el correo pedido, la factura se crea pidiendo la copia', () => {
  it('el cuerpo de la creación lleva `mail: true`', async () => {
    await emitirCon({ solicitado: true, destinatarios: [] });

    expect(cuerpoDeLaCreacion()).toHaveProperty('mail', true);
  });

  it('el acta queda `enviado` y con la dirección de la ficha, que es a quien Siigo mandó', async () => {
    // `mail: true` manda a la dirección que el tercero tiene registrada en Siigo, que es la de la
    // ficha. El acta tiene que decir eso y no una lista vacía: «se envió a nadie» no es una respuesta.
    await emitirCon({ solicitado: true, destinatarios: [] });

    expect(acta()).toMatchObject({ origen: 'emision', resultado: 'enviado', codigo: null });
    expect(acta().destinatarios).toEqual([{ correo: DE_LA_FICHA, origen: 'compania' }]);
  });

  it('y NO se le pide ADEMÁS por la ruta `/mail`: el cliente recibiría el documento dos veces', async () => {
    // La invariante que ningún otro caso de este archivo mira, y la única que separa este camino del
    // de al lado. Con `mail: true` Siigo YA mandó la factura a la dirección que el tercero tiene
    // registrada allá; pedirla otra vez por `POST /v1/invoices/{id}/mail` no añade destinatarios
    // —son los mismos— sino un SEGUNDO correo con el mismo documento adjunto.
    //
    // Se afirma sobre las PETICIONES SALIENTES a propósito. Las dos actas que los dos caminos
    // escriben son indistinguibles —`origen: 'emision'`, `resultado: 'enviado'`, los destinatarios
    // de la ficha, `codigo: null`—, así que mirar el acta no distingue «se apuntó el correo que la
    // creación produjo» de «se pidió un correo de más». El único sitio donde el envío doble existe
    // es la red, y por eso es donde hay que mirar.
    //
    // La guarda concreta es el `&& decision.explicitos` de `aplicarCorreoDeEmision`. Quitarlo
    // —dejar `if (decision.enviar)`— deja este caso rojo y ningún otro.
    await emitirCon({ solicitado: true, destinatarios: [] });

    expect(peticiones.map((p) => p.ruta)).toEqual(['/v1/invoices']);
    expect(peticionDeCorreo()).toBeUndefined();
  });

  it('el timbre ante la DIAN sigue derivándose del ambiente y no de esta elección', async () => {
    // Frontera de la historia, escrita a propósito: el timbre NO se elige por factura. Un
    // interruptor apagado produciría facturas que en FLITO figuran emitidas y ante la DIAN no
    // existen. Que el correo pase a elegirse no puede arrastrar al timbre consigo.
    await emitirCon({ solicitado: false, destinatarios: [] });

    expect(cuerpoDeLaCreacion()).toHaveProperty('stamp', { send: true });
  });
});

// ── AC2 — no se pide el correo: se registra que NO se pidió ─────────────────

describe('AC2 — el acta se escribe también cuando nadie pidió el correo', () => {
  it('no se le pide a Siigo que mande copia', async () => {
    await emitirCon({ solicitado: false, destinatarios: [] });

    expect(cuerpoDeLaCreacion()).not.toHaveProperty('mail');
    expect(peticionDeCorreo()).toBeUndefined();
  });

  it('queda acta `no_realizado` con el motivo «no solicitado en el envío»', async () => {
    // El criterio entero está aquí: sin esta fila, «nadie lo pidió» y «se nos olvidó» son
    // indistinguibles en la bandeja, y el segundo es un cliente esperando una factura que no llega.
    await emitirCon({ solicitado: false, destinatarios: [] });

    expect(acta()).toMatchObject({
      origen: 'emision', resultado: 'no_realizado', codigo: 'no_solicitado',
    });
    expect(String(acta().motivo)).toMatch(/no solicitado en el envío/i);
  });

  it('sin correo pedido no se consulta la ficha del cliente: no hace falta y es un dato personal', async () => {
    // Leer la ficha para no usarla es traer una dirección a memoria sin motivo. Además delata la
    // intención: si algún día alguien la consulta aquí, es que está pensando en mandar el correo.
    await emitirCon({ solicitado: false, destinatarios: [] });

    expect(acta().destinatarios).toEqual([]);
  });

  it('un lote sin elección —los anteriores a esta historia— no manda correo, y lo apunta', async () => {
    // Compatibilidad hacia atrás explícita: `correoNoSolicitado()` es lo que devuelve `correoDelLote`
    // para un lote de antes de la migración 0161. Antes de esta HU esas facturas SÍ salían por
    // correo en producción, así que el cambio de comportamiento se declara aquí en vez de aparecer
    // como sorpresa: no sale, y el acta dice por qué.
    await emitirFactura([TRAMITE], {
      ambiente: 'produccion', ahora: () => AHORA, emision: EMISION, correo: correoNoSolicitado(),
    });

    expect(cuerpoDeLaCreacion()).not.toHaveProperty('mail');
    expect(acta()).toMatchObject({ resultado: 'no_realizado', codigo: 'no_solicitado' });
  });
});

// ── AC3 — los destinatarios elegidos mandan sobre los de la ficha ───────────

describe('AC3 — con direcciones elegidas se usan esas, y no las que deduciría la ficha', () => {
  it('el correo se le pide a Siigo con las direcciones elegidas', async () => {
    await emitirCon({
      solicitado: true,
      destinatarios: [manual('cartera@cliente.test'), manual('contabilidad@cliente.test')],
    });

    expect(peticionDeCorreo()?.cuerpo).toEqual({
      mail_to: ['cartera@cliente.test', 'contabilidad@cliente.test'],
    });
  });

  it('la dirección de la ficha NO recibe nada: elegir es sustituir, no añadir', async () => {
    // Quien escribe una lista está diciendo a quién va, y a veces el cliente no está en ella —una
    // factura que va solo a su contadora—. Si la ficha se colara, esa decisión no se podría tomar.
    await emitirCon({ solicitado: true, destinatarios: [manual('cartera@cliente.test')] });

    const mailTo = (peticionDeCorreo()?.cuerpo as { mail_to: string[] }).mail_to;
    expect(mailTo).not.toContain(DE_LA_FICHA);
  });

  it('y la creación va SIN `mail`: pedirlo por los dos caminos mandaría el documento dos veces', async () => {
    // `mail: true` manda a la ficha, que es justo la dirección que se está sustituyendo. Dejarlo
    // puesto no sería «por si acaso»: sería un segundo correo con la misma factura adjunta.
    await emitirCon({ solicitado: true, destinatarios: [manual('cartera@cliente.test')] });

    expect(cuerpoDeLaCreacion()).not.toHaveProperty('mail');
  });

  it('con las dos cosas delante, la decisión se queda con las elegidas', () => {
    // Es el criterio en su forma más pura: elegidas Y ficha sobre la mesa, gana la elección. La
    // emisión ni siquiera llega a consultar la ficha cuando hay elección (el caso siguiente), así
    // que sin esta prueba la regla viviría en un solo sitio y nadie la vería si se invirtiera.
    const d = decidirCorreoDeEmision({
      elegido: { solicitado: true, destinatarios: [manual('cartera@cliente.test')] },
      deLaFicha: [{ correo: DE_LA_FICHA, origen: 'compania' }],
      efectosExternos: true,
      ambiente: 'produccion',
    });

    expect(d.destinatarios).toEqual([manual('cartera@cliente.test')]);
    expect(d.explicitos).toBe(true);
  });

  it('con direcciones elegidas la ficha del cliente ni se consulta', () => {
    // No es una optimización: es minimización de datos. Traer a memoria una dirección que no se va a
    // usar es manipular un dato personal sin motivo, y consultarla delataría además la intención de
    // acabar usándola.
    let fichaConsultada = false;
    kdb.when.select('clients', () => {
      fichaConsultada = true;
      return [{ email: DE_LA_FICHA, contactEmail: null }];
    });

    return emitirCon({ solicitado: true, destinatarios: [manual('cartera@cliente.test')] })
      .then(() => { expect(fichaConsultada).toBe(false); });
  });

  it('el acta dice que el envío lo originó la EMISIÓN, no un reenvío manual', async () => {
    // Sale por la misma función que el reenvío —una sola definición de «pedirle el correo a
    // Siigo»—, así que lo único que las distingue es el origen. Sin él, el historial diría que
    // alguien pulsó un botón que nadie pulsó.
    await emitirCon({ solicitado: true, destinatarios: [manual('cartera@cliente.test')] });

    expect(acta()).toMatchObject({ origen: 'emision', resultado: 'enviado', solicitadoPor: null });
    expect(acta().destinatarios).toEqual([manual('cartera@cliente.test')]);
  });
});

// ── AC5 — las direcciones se validan antes de salir a la red ────────────────

describe('AC5 — una lista que no se puede mandar no gasta petición y señala la POSICIÓN', () => {
  const casos = [
    {
      nombre: 'una dirección mal escrita',
      lista: [manual('bien@cliente.test'), manual('esto-no-es-un-correo')],
      codigo: 'destinatario_invalido',
      posicion: /número 2/,
    },
    {
      nombre: 'la misma dirección repetida',
      lista: [manual('cartera@cliente.test'), manual('CARTERA@cliente.test')],
      codigo: 'destinatario_repetido',
      posicion: /número 2 repite la número 1/,
    },
    {
      nombre: 'más direcciones de las que Siigo admite',
      lista: Array.from({ length: 6 }, (_, i) => manual(`persona${i}@cliente.test`)),
      codigo: 'demasiados_destinatarios',
      posicion: /5/,
    },
  ];

  for (const caso of casos) {
    it(`${caso.nombre}: la emisión no manda el correo`, async () => {
      await emitirCon({ solicitado: true, destinatarios: caso.lista });

      expect(peticionDeCorreo()).toBeUndefined();
      expect(cuerpoDeLaCreacion()).not.toHaveProperty('mail');
    });

    it(`${caso.nombre}: queda acta con el código propio y sin ninguna dirección en el motivo`, async () => {
      // Ley 1581: el `motivo` es append-only y la purga NO lo vacía —solo vacía `destinatarios`—,
      // así que una dirección escrita ahí sería una copia permanente e inalcanzable de un dato
      // personal. Se pierde nada: la dirección está en `destinatarios`, que sí se puede redactar.
      await emitirCon({ solicitado: true, destinatarios: caso.lista });

      expect(acta()).toMatchObject({ resultado: 'no_realizado', codigo: caso.codigo });
      expect(String(acta().motivo)).toMatch(caso.posicion);
      expect(String(acta().motivo)).not.toContain('@');
    });
  }

  it('las seis direcciones no se escriben en el acta: la tabla no admite más de cinco', async () => {
    // El CHECK de la migración 0141 (`jsonb_array_length(destinatarios) <= 5`) haría reventar el
    // INSERT, y el acta que se perdería sería justo la del caso en que hay algo que corregir. Se
    // guarda vacía y el motivo dice cuántas eran; recortarlas a cinco habría inventado una lista.
    const seis = Array.from({ length: 6 }, (_, i) => manual(`persona${i}@cliente.test`));

    await emitirCon({ solicitado: true, destinatarios: seis });

    expect(acta()).toMatchObject({ resultado: 'no_realizado', codigo: 'demasiados_destinatarios' });
    expect(acta().destinatarios).toEqual([]);
    expect(String(acta().motivo)).toContain('6');
  });

  it('cinco sí caben: el tope es cinco, no cuatro, y el acta las conserva', async () => {
    const cinco = Array.from({ length: 5 }, (_, i) => manual(`persona${i}@cliente.test`));

    await emitirCon({ solicitado: true, destinatarios: cinco });

    expect(acta()).toMatchObject({ resultado: 'enviado' });
    expect(acta().destinatarios).toHaveLength(5);
  });

  it('la factura SÍ se emite: un correo que no se puede mandar no cancela un documento fiscal', async () => {
    // La lista mal escrita se arregla reenviando; una factura que no se emitió por eso sería un
    // cobro que no sale por una errata.
    const r = await emitirCon({ solicitado: true, destinatarios: [manual('mal-escrito')] });

    expect(r.desenlace).toBe('emitida');
  });

  it('un cliente sin correo en su ficha tampoco sale a la red, y se dice cuál es el dato que falta', async () => {
    kdb.when.select('clients', [{ email: null, contactEmail: null }]);

    await emitirCon({ solicitado: true, destinatarios: [] });

    expect(peticionDeCorreo()).toBeUndefined();
    expect(acta()).toMatchObject({ resultado: 'no_realizado', codigo: 'cliente_sin_correo' });
  });

  it('la repetición se juzga sin distinguir mayúsculas ni espacios: es el mismo buzón', () => {
    // Comparar en crudo dejaría pasar dos formas del mismo correo, el cliente recibiría el documento
    // dos veces y las dos copias contarían contra el tope de cinco de Siigo.
    expect(validarDestinatarios([manual('  Cartera@Cliente.test '), manual('cartera@cliente.test')]))
      .toMatchObject({ codigo: 'destinatario_repetido' });
  });
});

// ── AC6 — el reenvío manual sigue igual ────────────────────────────────────

describe('AC6 — el reenvío manual no lo condiciona lo que se eligiera en el envío', () => {
  it('sigue dejando acta de origen `reenvio` cuando nadie le dice otra cosa', async () => {
    // No regresión: el origen por omisión es lo que la HU #11334 escribió, y esta historia solo
    // añadió un parámetro. Si el valor por omisión hubiera cambiado, el historial de facturas
    // emitidas hace meses empezaría a decir que sus reenvíos los pidió la emisión.
    await enviarFacturaPorCorreo(FACTURA, { solicitadoPor: 7 });

    expect(acta()).toMatchObject({ origen: 'reenvio', resultado: 'enviado', solicitadoPor: 7 });
  });

  it('no mira el lote ni la elección del envío: reenviar es una decisión nueva', async () => {
    // La prueba del «no lo condiciona»: si el reenvío consultara la elección del envío, una factura
    // enviada sin correo no se podría reenviar nunca — que es justo el caso en que hace falta.
    await enviarFacturaPorCorreo(FACTURA, { solicitadoPor: 7 });

    const tablasLeidas = kdb.select.mock.results.length;
    expect(tablasLeidas).toBeGreaterThan(0);
    expect(espia.secuencia()).not.toContain('siigo_lotes_facturacion');
    expect(peticionDeCorreo()?.cuerpo).toEqual({ mail_to: [DE_LA_FICHA] });
  });

  it('y su acta se puede pedir con direcciones propias, como hasta ahora', async () => {
    await enviarFacturaPorCorreo(FACTURA, {
      solicitadoPor: 7, destinatarios: [manual('otra@cliente.test')],
    });

    expect(acta()).toMatchObject({ origen: 'reenvio' });
    expect(peticionDeCorreo()?.cuerpo).toEqual({ mail_to: ['otra@cliente.test'] });
  });
});
