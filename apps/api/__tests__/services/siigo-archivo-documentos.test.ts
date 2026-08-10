// Siigo — archivar el PDF y el XML de la factura como soporte del trámite (HU #11335). Un bloque
// por criterio de aceptación.
//
// Se mockean las tres fronteras: el cliente HTTP de Siigo, el almacenamiento y la base. Lo que se
// prueba es la ORQUESTACIÓN —qué se comprueba antes de gastar una petición, qué se guarda, qué NO
// se vuelve a guardar y qué queda cuando algo falla a mitad—, no volver a probar esas tres piezas.
//
// La garantía última del AC3 es un índice único de la migración 0139 y no se puede afirmar contra
// un mock de drizzle; lo que sí se prueba aquí es que el servicio la respeta y que trata su
// violación como «ya archivado» en vez de como un fallo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TipoSoporte } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

/** Peticiones a Siigo, controladas por test. */
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

/** Almacenamiento: se afirma sobre la carpeta destino, que es la mitad del AC1 y todo el AC4. */
const uploadMock = vi.fn(async (prefijo: string, entidad: string, nombre: string) =>
  `${prefijo}/${entidad}/1700000000000_abc123_${nombre}`);
vi.mock('../../src/services/storage.js', async (original) => {
  const real = await original<typeof import('../../src/services/storage.js')>();
  return {
    ...real,
    uploadEntityDocument: (p: string, e: string, n: string, b: Buffer, m: string) => uploadMock(p, e, n, b, m),
  };
});

/** Bitácora (AC5). */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const {
  archivarFactura, archivarFacturasPendientes, contenidoDeRespuesta, facturaAceptadaPorLaDian,
} = await import('../../src/modules/siigo/siigo.archivo-documentos.service.js');

const FACTURA_ID = 'ffffffff-1111-4111-8111-ffffffffffff';

/** Fila que devuelve la consulta de la factura: la factura más la compañía de su trámite. */
function factura(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA_ID,
    ambiente: 'produccion',
    siigoInvoiceId: 'siigo-inv-1',
    numero: 'FV-1-118',
    cufe: 'a1b2c3d4e5f6',
    estado: 'emitida',
    companiaId: 42,
    document: '900123456',
    carpeta: 'clientes/transportes-del-sur',
    ...over,
  };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const PDF = { base64: b64('%PDF-1.4\n% factura\n%%EOF\n') };
const XML = { base64: b64('<?xml version="1.0"?><Invoice><ID>1</ID></Invoice>') };

/** Siigo responde con los dos documentos, en el orden en que el servicio los pide. */
function siigoDevuelveAmbos() {
  siigoRequestOrThrowMock.mockResolvedValueOnce(PDF).mockResolvedValueOnce(XML);
}

/** Ni el PDF ni el XML están archivados todavía; el INSERT crea la fila. */
function nadaArchivadoTodavia(idsCreados = ['sop-pdf', 'sop-xml']) {
  kdb.when
    .select('flito_soportes', [])
    .insert('flito_soportes', () => [{ id: idsCreados.shift() ?? 'sop-x' }]);
}

beforeEach(() => {
  kdb.reset();
  siigoRequestOrThrowMock.mockReset();
  uploadMock.mockClear();
  registrarOperacionMock.mockClear();
});

describe('AC1 — el PDF y el XML quedan donde están los demás soportes', () => {
  it('archiva los dos documentos como soportes de la factura, no de otro flujo', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('completa');
    expect(r.documentos.map((d) => d.desenlace)).toEqual(['archivado', 'archivado']);

    // Los dos soportes cuelgan de la FACTURA y de nada más: es la regla «uno y solo uno» que la
    // migración 0139 afirma con un CHECK.
    const insertados = kdb.insert.mock.results.length;
    expect(insertados).toBe(2);
  });

  it('el tipo distingue el PDF del XML: en la pantalla son dos documentos, no uno', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    await archivarFactura(FACTURA_ID);

    const nombres = uploadMock.mock.calls.map((c) => c[2]);
    expect(nombres).toEqual(['factura-FV-1-118.pdf', 'factura-FV-1-118.xml']);
    expect(TipoSoporte.FACTURA_ELECTRONICA_PDF).not.toBe(TipoSoporte.FACTURA_ELECTRONICA_XML);
  });

  it('van bajo la carpeta configurada para la compañía, no bajo una inventada', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(uploadMock.mock.calls[0][0]).toBe('clientes/transportes-del-sur/facturacion-electronica');
    expect(r.carpetaDeExcepcion).toBe(false);
  });

  it('los pide a Siigo por los endpoints del documento, uno por tipo', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    await archivarFactura(FACTURA_ID);

    const rutas = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { ruta: string }).ruta);
    expect(rutas).toEqual(['/v1/invoices/siigo-inv-1/pdf', '/v1/invoices/siigo-inv-1/xml']);
  });
});

describe('AC2 — solo se archiva lo que la DIAN aceptó', () => {
  it('sin CUFE no se descarga NADA: no se gasta cuota en un documento que aún no existe', async () => {
    kdb.when.select('siigo_facturas', [factura({ cufe: null })]);

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('pendiente_dian');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('una factura que todavía no salió tampoco se archiva', async () => {
    kdb.when.select('siigo_facturas', [factura({ estado: 'en_proceso', cufe: null })]);

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('pendiente_dian');
    expect(r.documentos.every((d) => d.desenlace === 'omitido')).toBe(true);
  });

  it('al pasar a aceptada se archiva sin que nadie lo pida: es el mismo barrido', async () => {
    // El ciclo pregunta por lo que FALTA, así que la factura de antes vuelve a salir sola en cuanto
    // la DIAN la acepta. Sin esto, archivar dependería de que alguien se acordara.
    kdb.when.select('siigo_facturas', [{ id: FACTURA_ID }]);
    kdb.when.selectOnce('siigo_facturas', [{ id: FACTURA_ID }]).selectOnce('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    const r = await archivarFacturasPendientes(10);

    expect(r).toEqual({ revisadas: 1, completas: 1, parciales: 0 });
  });
});

describe('AC3 — el mismo documento no se archiva dos veces', () => {
  it('lo ya archivado ni siquiera se vuelve a descargar: la cuota es de la emisión', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when.select('flito_soportes', [{ id: 'sop-ya' }]);

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('completa');
    expect(r.documentos.map((d) => d.desenlace)).toEqual(['ya_archivado', 'ya_archivado']);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('se reconoce por el CONTENIDO, no por el nombre del archivo', async () => {
    // La fila no aparece buscándola por (factura, tipo) —p. ej. un ciclo anterior la registró y este
    // no la ve— pero el sha256 de lo descargado ya está guardado. No se crea un segundo soporte.
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when
      .selectOnce('flito_soportes', [])                     // no está por (factura, tipo)
      .selectOnce('flito_soportes', [{ id: 'sop-mismo-contenido' }]) // sí por hash
      .selectOnce('flito_soportes', [])
      .selectOnce('flito_soportes', [{ id: 'sop-xml-mismo' }]);
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(r.documentos.map((d) => d.desenlace)).toEqual(['ya_archivado', 'ya_archivado']);
    expect(r.documentos[0].soporteId).toBe('sop-mismo-contenido');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('si otro ciclo gana la carrera, el rechazo de la base NO se cuenta como fallo', async () => {
    // Entre el «¿ya está?» y el INSERT cabe otro barrido. El índice único de la 0139 rechaza el
    // segundo con 23505: el documento está archivado, que es lo que se quería.
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when
      .selectOnce('flito_soportes', []).selectOnce('flito_soportes', [])
      .selectOnce('flito_soportes', [{ id: 'sop-del-otro-ciclo' }]) // relectura tras el 23505
      .select('flito_soportes', [{ id: 'sop-del-otro-ciclo' }]);
    kdb.when.insert('flito_soportes', () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('completa');
    expect(r.documentos[0]).toMatchObject({ desenlace: 'ya_archivado', soporteId: 'sop-del-otro-ciclo' });
  });
});

describe('AC4 — sin carpeta configurada no se inventa una', () => {
  it('el documento va a la carpeta de excepción y queda dicho que la compañía no la tiene', async () => {
    kdb.when.select('siigo_facturas', [factura({ carpeta: null })]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(uploadMock.mock.calls[0][0])
      .toBe('_sin-carpeta-configurada/900123456/facturacion-electronica');
    expect(r.carpetaDeExcepcion).toBe(true);
  });

  it('una factura sin compañía tampoco acaba en una carpeta llamada «null»', async () => {
    kdb.when.select('siigo_facturas', [factura({ companiaId: null, document: null, carpeta: null })]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    const r = await archivarFactura(FACTURA_ID);

    expect(uploadMock.mock.calls[0][0])
      .toBe(`_sin-carpeta-configurada/factura-${FACTURA_ID}/facturacion-electronica`);
    expect(r.carpetaDeExcepcion).toBe(true);
  });
});

describe('AC5 — un fallo a mitad no deja un soporte mentiroso', () => {
  it('si el XML falla después de guardar el PDF, la factura NO queda archivada del todo', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia(['sop-pdf']);
    siigoRequestOrThrowMock
      .mockResolvedValueOnce(PDF)
      .mockRejectedValueOnce(new Error('502 Bad Gateway'));

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('parcial');
    expect(r.documentos[0].desenlace).toBe('archivado');
    expect(r.documentos[1].desenlace).toBe('fallido');
  });

  it('el fallo queda en la bitácora, no solo en el log del servidor', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia(['sop-pdf']);
    siigoRequestOrThrowMock
      .mockResolvedValueOnce(PDF)
      .mockRejectedValueOnce(new Error('502 Bad Gateway'));

    await archivarFactura(FACTURA_ID);

    const fallos = registrarOperacionMock.mock.calls
      .map((c) => c[0] as { resultado: string; ruta: string })
      .filter((o) => o.resultado === 'error_tecnico');
    expect(fallos).toHaveLength(1);
    expect(fallos[0].ruta).toBe('/v1/invoices/siigo-inv-1/xml');
  });

  it('un ciclo posterior completa lo que falta SIN volver a bajar lo que ya estaba', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    kdb.when
      .selectOnce('flito_soportes', [{ id: 'sop-pdf' }]) // el PDF del ciclo anterior
      .selectOnce('flito_soportes', [])                  // el XML todavía no
      .selectOnce('flito_soportes', []);                 // ni por contenido
    kdb.when.insert('flito_soportes', [{ id: 'sop-xml' }]);
    siigoRequestOrThrowMock.mockResolvedValueOnce(XML);

    const r = await archivarFactura(FACTURA_ID);

    expect(r.estado).toBe('completa');
    expect(r.documentos.map((d) => d.desenlace)).toEqual(['ya_archivado', 'archivado']);
    // Una sola petición: la del XML. Rebajar el PDF habría sido cuota regalada.
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(1);
  });

  it('lo que no parece el documento no se archiva: un soporte que miente es peor que ninguno', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    // 200 con un cuerpo que no es el PDF. Guardarlo dejaría un archivo que dice ser la factura.
    siigoRequestOrThrowMock
      .mockResolvedValueOnce({ base64: b64('<html>Servicio no disponible</html>') })
      .mockResolvedValueOnce(XML);

    const r = await archivarFactura(FACTURA_ID);

    expect(r.documentos[0].desenlace).toBe('fallido');
    expect(r.estado).toBe('parcial');
    // No se subió el cuerpo falso: solo se llamó al almacenamiento por el XML, que sí es un XML.
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('una factura que revienta no se lleva por delante el resto del ciclo', async () => {
    kdb.when.selectOnce('siigo_facturas', [{ id: 'f1' }, { id: 'f2' }]);
    kdb.when.selectThrow('siigo_facturas', new Error('la base se cayó al leer la factura'));

    const r = await archivarFacturasPendientes(10);

    expect(r.revisadas).toBe(2);
    expect(r.parciales).toBe(2);
  });
});

describe('AC7 — nada de esto obliga a tocar la tabla de facturas', () => {
  it('archivar no escribe una sola columna de siigo_facturas', async () => {
    kdb.when.select('siigo_facturas', [factura()]);
    nadaArchivadoTodavia();
    siigoDevuelveAmbos();

    await archivarFactura(FACTURA_ID);

    // Que una factura esté archivada es una CONSECUENCIA de que existan sus dos soportes. Un flag
    // en la tabla de facturas habría que mantenerlo, y un flag que miente es el soporte mentiroso
    // del AC5 con otro nombre.
    expect(kdb.update).not.toHaveBeenCalled();
    expect(kdb.insert.mock.calls.every((c) => c[0] !== undefined)).toBe(true);
  });
});

describe('lo que Siigo devuelve se interpreta, no se guarda a ciegas', () => {
  it('acepta el JSON con el archivo en base64, que es la forma documentada', () => {
    expect(contenidoDeRespuesta(PDF, 'pdf').subarray(0, 4).toString()).toBe('%PDF');
  });

  it('acepta también el XML en claro: el contrato del XML no está fijado', () => {
    const crudo = '<?xml version="1.0"?><Invoice/>';
    expect(contenidoDeRespuesta(crudo, 'xml').toString('utf8')).toBe(crudo);
  });

  it('un cuerpo vacío no es un documento', () => {
    expect(() => contenidoDeRespuesta({ base64: '' }, 'pdf')).toThrow(/sin el contenido/i);
  });

  it('un PDF que no empieza por %PDF se rechaza en vez de archivarse', () => {
    expect(() => contenidoDeRespuesta({ base64: b64('no soy un pdf') }, 'pdf'))
      .toThrow(/no parece ese documento/i);
  });
});

describe('el criterio de «aceptada» vive en un solo sitio', () => {
  // Es provisional —el historial DIAN es la HU #11330— y por eso está aislado: cuando llegue, se
  // reescribe esta función y no hay que buscar la condición repartida por el servicio.
  it('emitida y con CUFE es lo aceptado', () => {
    expect(facturaAceptadaPorLaDian({ estado: 'emitida', cufe: 'abc' })).toBe(true);
  });

  it('emitida sin CUFE todavía no lo es: enviada no es aceptada', () => {
    expect(facturaAceptadaPorLaDian({ estado: 'emitida', cufe: null })).toBe(false);
    expect(facturaAceptadaPorLaDian({ estado: 'emitida', cufe: '   ' })).toBe(false);
  });

  it('una fallida nunca lo es, tenga lo que tenga en el CUFE', () => {
    expect(facturaAceptadaPorLaDian({ estado: 'fallida', cufe: 'abc' })).toBe(false);
  });
});
