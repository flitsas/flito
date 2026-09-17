process.env.TZ = 'UTC';
// HU #12611 (Feature #12605, Épica #12245) — `cargarLote`: un soporte por archivo con S3 antes de BD
// (AC3), duplicado por contenido (AC4) y lectura persistida con confianza y motivo (AC5). `db` es el
// mock keyed por tabla con el espía de escrituras (la transacción ejecuta el callback contra el mismo
// `db`); `particionar` y `leerSubDocumento` van mockeados (certificados en la HU #12610); el storage,
// mockeado; el logger, capturado para afirmar que no lleva contenido leído.
//
// Mutantes nombrados (cada uno tiene su `it`):
//   · AC2-M1 envolver el envío entero en una transacción → «archivo 2 dañado no impide archivo 1».
//   · AC2-M2 validar por MIME declarado → «un .pdf que es texto plano va a fallidos».
//   · AC3-M1 invertir S3/BD → «upload que falla exige cero filas».
//   · AC3-M2 `tipo` fijo → «consolidado → consolidado_comprobantes; uno → comprobante_pago».
//   · AC4-M1 quitar `descartado = false` del dedup → «SQL renderizado liga descartado=false».
//   · AC4-M2 quitar `hashesVistos` → «dos idénticos en el mismo envío».
//   · AC5-M1 intercambiar dos escalones de la precedencia → «la matriz de 6 casos».
//   · AC5-M2 dejar que OcrNoDisponibleError suba → «OCR caído persiste igual con {}».
//   · AC5-M3 persistir tipo/concepto no confiables → «solo si confiable».
//
// HU #12632 (auto-aplicación, D5): `aplicar` se MOCKEA en su módulo (está certificado en aplicar.test.ts;
// aquí se afirma que la carga lo invoca por el mismo camino con `{ automatico: true }` y qué hace con
// el resultado); `decidirAutoAplicar` y los evaluadores de los dueños corren REALES.
//   · AC1-M8 concepto no confiable aplicando igual → «concepto con confianza 0.5 → pendiente concepto_desconocido».
//   · AC1-M11 flag ausente apagando → «sin la variable, el parse la deja en '1'» cae.
//   · AC2-M flag '0' aplicando igual → «flag '0': todo pendiente con la sugerencia» cae.
//   · AC3-M propagar la excepción de autoAplicar → «un fallo de auto-aplicar no vacía el resultado del envío» cae.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { CampoComprobante, MotivoPendienteComprobante, TipoSoporte } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar, ligadoA } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock, getEntityDocumentStream: vi.fn(), presignedGetEntityDocument: vi.fn(),
}));

const particionarMock = vi.fn();
const leerMock = vi.fn();
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: particionarMock, leerSubDocumento: leerMock }));
// HU #12632: `aplicar` mockeado en su módulo; el resto de aplicar.ts (esquema, constantes) es real.
const aplicarMock = vi.fn();
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, aplicar: aplicarMock };
});

const logLineas: unknown[][] = [];
const logMock = {
  info: (...a: unknown[]) => { logLineas.push(a); }, warn: (...a: unknown[]) => { logLineas.push(a); },
  error: (...a: unknown[]) => { logLineas.push(a); }, debug: (...a: unknown[]) => { logLineas.push(a); },
};
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

const { cargarLote, contentTypePorCabecera, puertaDelSoporte, textoNoLeidas, detalleAplicado, DETALLE_FALLIDO, CARPETA_COMPROBANTES } =
  await import('../../src/modules/flito-comprobantes/flito-comprobantes.carga.js');
const { motivoPendienteDe, columnasDeLectura, ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');
const { decidirAutoAplicar, autoAplicarEncendida } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.auto.js');
const { env } = await import('../../src/config/env.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { PdfDemasiadoGrandeError } = await import('../../src/shared/pdf/separar-paginas.js');
const { flitoComprobantes, flitoSoportes, flitoTramites } = await import('../../src/db/schema.js');

const T_SOP = getTableName(flitoSoportes);
const T_COMP = getTableName(flitoComprobantes);
const T_TRAM = getTableName(flitoTramites);
/** El trámite que las llaves de `lecturaCompleta` alcanzan (HU #12629: el cruce corre en la carga; el mock ignora el where, así que lo fija la primera llave: id_flit). */
const TRAMITE = '5a3c4c2e-0f9b-4e6e-9a1d-2c3b4a5d6e7f';
const candidato = () => ({
  tramiteId: TRAMITE, idFlit: 'FLIT-ARHZZ1', placa: 'ABC123', vin: null, tipoTramite: 'MATRICULA', empresa: 'Acme', flitEstado: 'Aprobado',
  soatId: 'soat-1', soatEstado: 'solicitado', impuestoEstado: null, derechoId: null, liquidacionId: null,
  docTramiteDigital: false, docLogistica: false, docServiciosAdicionales: false, createdAt: new Date('2026-09-01T00:00:00Z'),
});
const LOTE = '9c1d4d5e-3b7a-4c2e-9f0a-1b2c3d4e5f60';
const CTX = { userId: 7, username: 'fin@flitsas.io', role: 'financiera' };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const PDF_B = Buffer.from('%PDF-1.7\n%otro-documento\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const TEXTO = Buffer.from('esto no es un pdf aunque el nombre lo diga');

const archivo = (originalname: string, buffer: Buffer, mimetype = 'application/pdf') => ({ originalname, mimetype, buffer, size: buffer.length });
const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const sub = (buffer: Buffer, nombre: string, paginas: number[] | null = null, contentType = 'application/pdf') => ({ buffer, contentType, paginas, nombre });
const unico = (buffer: Buffer, nombre: string, contentType = 'application/pdf') =>
  ({ documentos: [sub(buffer, nombre, null, contentType)], paginasNoLeidas: [], metodo: 'unico' as const });

/** Lectura completa: tipo, pago, concepto, llave y valor confiables. */
const lecturaCompleta = (over: Record<string, ReturnType<typeof campo>> = {}) => ({
  extraccion: {
    [CampoComprobante.TIPO_DOCUMENTO]: campo('factura_soat', 0.95), [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('true', 0.95),
    [CampoComprobante.CONCEPTO]: campo('soat', 0.95), [CampoComprobante.PLACA]: campo('ABC123', 0.9),
    [CampoComprobante.VIN]: campo(null, 0), [CampoComprobante.ID_FLIT]: campo('FLIT-ARHZZ1', 0.7),
    [CampoComprobante.VALOR_TOTAL]: campo('350000', 0.95), [CampoComprobante.FECHA_PAGO]: campo('2026-09-10', 0.95),
    [CampoComprobante.NUMERO_DOCUMENTO]: campo('POL-778', 0.95), [CampoComprobante.EMISOR]: campo('Seguros Sura', 0.9),
    ...over,
  },
  tipoDestino: 'factura_soat' as const,
  extraccionDestino: { numeroPoliza: campo('POL-778', 0.95) },
});

let nComp = 0;
function armarBase() {
  kdb.when
    .select(T_SOP, [])
    .select(T_COMP, [])
    .select(T_TRAM, [candidato()])
    .insert(T_SOP, [{ id: 'sop-1' }])
    .insert(T_COMP, () => [{ id: `c-${++nComp}` }]);
}

const espia = crearEspia(kdb);

beforeEach(() => {
  kdb.reset(); espia.reiniciar();
  nComp = 0; logLineas.length = 0;
  uploadMock.mockReset(); particionarMock.mockReset(); leerMock.mockReset(); aplicarMock.mockReset();
  env.COMPROBANTES_AUTO_APLICAR = '1';
  uploadMock.mockResolvedValue('flito/comprobantes/lote/x.pdf');
  particionarMock.mockImplementation(async (a: { buffer: Buffer; nombre: string; contentType: string }) => unico(a.buffer, a.nombre, a.contentType));
  leerMock.mockResolvedValue(lecturaCompleta());
  armarBase();
});

// ═════════════════ AC2 · cada archivo por su cuenta; cabecera real ══════════════════════════════

describe('AC2 — cabecera real y procesamiento independiente', () => {
  it.each([
    ['PDF', PDF, 'application/pdf'], ['JPEG', JPG, 'image/jpeg'], ['PNG', PNG, 'image/png'], ['WEBP', WEBP, 'image/webp'],
  ])('%s: la cabecera decide el content-type', (_n, buf, ct) => {
    expect(contentTypePorCabecera(buf)).toBe(ct);
  });
  it('texto plano, vacío o RIFF que no es WEBP → null', () => {
    expect(contentTypePorCabecera(TEXTO)).toBeNull();
    expect(contentTypePorCabecera(Buffer.alloc(0))).toBeNull();
    expect(contentTypePorCabecera(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]))).toBeNull();
  });

  it('AC2-M2: un .pdf con MIME application/pdf que es texto plano va a fallidos con el copy exacto; sin soporte ni comprobante ni S3', async () => {
    const res = await cargarLote([archivo('factura.pdf', TEXTO, 'application/pdf')], LOTE, CTX);
    expect(res.fallidos).toEqual([expect.objectContaining({ archivo: 'factura.pdf', comprobanteId: null, detalle: DETALLE_FALLIDO.NO_ADMITIDO })]);
    expect(res.pendientes).toEqual([]);
    expect(res.documentos).toBe(0);
    expect(espia.inserts).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(particionarMock).not.toHaveBeenCalled();
  });

  it('PDF cifrado/dañado (pdf-lib lanza en particionar) → «El archivo está dañado o cifrado»; sin filas', async () => {
    particionarMock.mockRejectedValueOnce(new Error('Input document to `PDFDocument.load` is encrypted'));
    const res = await cargarLote([archivo('cifrado.pdf', PDF)], LOTE, CTX);
    expect(res.fallidos).toEqual([expect.objectContaining({ archivo: 'cifrado.pdf', detalle: DETALLE_FALLIDO.DANADO })]);
    expect(espia.inserts).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('PDF de más de 150 páginas → «PDF de más de 150 páginas: pártelo»; sin filas', async () => {
    particionarMock.mockRejectedValueOnce(new PdfDemasiadoGrandeError(151));
    const res = await cargarLote([archivo('grande.pdf', PDF)], LOTE, CTX);
    expect(res.fallidos).toEqual([expect.objectContaining({ archivo: 'grande.pdf', detalle: DETALLE_FALLIDO.DEMASIADAS_PAGINAS })]);
    expect(espia.inserts).toEqual([]);
  });

  it('AC2-M1: archivo 1 válido + archivo 2 dañado + archivo 3 válido → 1 y 3 persistidos, 2 en fallidos (una transacción por archivo)', async () => {
    particionarMock
      .mockImplementationOnce(async (a: { buffer: Buffer; nombre: string; contentType: string }) => unico(a.buffer, a.nombre, a.contentType))
      .mockRejectedValueOnce(new Error('dañado'))
      .mockImplementationOnce(async (a: { buffer: Buffer; nombre: string; contentType: string }) => unico(a.buffer, a.nombre, a.contentType));
    const res = await cargarLote([archivo('a.pdf', PDF), archivo('b.pdf', PDF_B), archivo('c.jpg', JPG, 'image/jpeg')], LOTE, CTX);
    expect(res.pendientes.map((p) => p.archivo)).toEqual(['a.pdf', 'c.jpg']);
    expect(res.fallidos.map((f) => f.archivo)).toEqual(['b.pdf']);
    expect(res.documentos).toBe(2);
    expect(res.aplicados).toEqual([]);
    expect(kdb.transaction).toHaveBeenCalledTimes(2);
    expect(espia.secuencia()).toEqual([T_SOP, T_COMP, T_SOP, T_COMP]);
  });
});

// ═════════════════ AC3 · un soporte por archivo, S3 antes de BD ═════════════════════════════════

describe('AC3 — un soporte por archivo, S3 antes de BD', () => {
  it('calcula el sha256, sube a S3 (carpeta del lote, content-type real) y DESPUÉS inserta un solo soporte sin FK', async () => {
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.pendientes).toHaveLength(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith(CARPETA_COMPROBANTES, LOTE, 'pol.pdf', PDF, 'application/pdf');
    const sop = espia.insertsEn(T_SOP);
    expect(sop).toHaveLength(1);
    const { createHash } = await import('node:crypto');
    expect(sop[0]!.datos).toMatchObject({
      tipo: TipoSoporte.COMPROBANTE_PAGO, nombreArchivo: 'pol.pdf', contentType: 'application/pdf',
      storageKey: 'flito/comprobantes/lote/x.pdf', hash: createHash('sha256').update(PDF).digest('hex'), tamanoBytes: PDF.length,
      subidoPorId: 7, subidoPorNombre: 'fin@flitsas.io',
    });
    for (const fk of ['soatId', 'impuestoId', 'derechoId', 'siigoFacturaId', 'conciliacionBoletaId']) expect(sop[0]!.datos[fk]).toBeUndefined();
    // El orden: el upload resolvió antes de que la transacción arrancara.
    expect(uploadMock.mock.invocationCallOrder[0]!).toBeLessThan(kdb.transaction.mock.invocationCallOrder[0]!);
  });

  it('AC3-M1: si el upload falla no se inserta NADA y el archivo va a fallidos', async () => {
    uploadMock.mockRejectedValueOnce(new Error('S3 caído'));
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.fallidos).toEqual([expect.objectContaining({ archivo: 'pol.pdf', detalle: DETALLE_FALLIDO.NO_GUARDADO })]);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(espia.inserts).toEqual([]);
  });

  it('AC3-M2: consolidado de 3 sub-documentos → tipo consolidado_comprobantes, 3 filas con soporte_id, lote_id, paginas base 1 y autoría; documentos = 3', async () => {
    particionarMock.mockResolvedValueOnce({
      documentos: [sub(PDF, 'lote - pág 1.pdf', [1]), sub(PDF, 'lote - págs 2-3.pdf', [2, 3]), sub(PDF, 'lote - pág 5.pdf', [5])],
      paginasNoLeidas: [4], metodo: 'modelo',
    });
    const res = await cargarLote([archivo('lote.pdf', PDF)], LOTE, CTX);
    expect(espia.ultimoInsertEn(T_SOP).tipo).toBe(TipoSoporte.CONSOLIDADO_COMPROBANTES);
    const comps = espia.insertsEn(T_COMP);
    expect(comps).toHaveLength(3);
    expect(comps.map((c) => c.datos.paginas)).toEqual([[1], [2, 3], [5]]);
    for (const c of comps) {
      expect(c.datos).toMatchObject({ soporteId: 'sop-1', loteId: LOTE, estado: 'pendiente', subidoPorId: 7, subidoPorNombre: 'fin@flitsas.io' });
      // HU #12629 AC4: el cruce único deja la SUGERENCIA escrita; nadie aplica (`aplicados` sigue vacío).
      expect(c.datos.tramiteId).toBe(TRAMITE);
      expect(c.datos.cruce).toBe('id_flit');
    }
    expect(res.documentos).toBe(3);
    expect(res.pendientes.map((p) => p.comprobanteId)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(res.pendientes.map((p) => p.paginas)).toEqual([[1], [2, 3], [5]]);
    // Las páginas no cubiertas por la partición van en el detalle de cada ítem del archivo.
    for (const p of res.pendientes) expect(p.detalle).toBe('Leído, pendiente de asociar · p. 4 no leída: portada o resumen');
  });

  it('archivo de un solo documento → paginas null en la fila y en el ítem', async () => {
    const res = await cargarLote([archivo('foto.jpg', JPG, 'image/jpeg')], LOTE, CTX);
    expect(espia.ultimoInsertEn(T_COMP).paginas).toBeNull();
    expect(res.pendientes[0]!.paginas).toBeNull();
    expect(res.pendientes[0]!.detalle).toBe('Leído, pendiente de asociar');
  });

  it('textoNoLeidas: 0 → null, 1 → «p. 7 no leída…», N → «pp. 1, 7 no leídas…»', () => {
    expect(textoNoLeidas([])).toBeNull();
    expect(textoNoLeidas([7])).toBe('p. 7 no leída: portada o resumen');
    expect(textoNoLeidas([1, 7])).toBe('pp. 1, 7 no leídas: portada o resumen');
  });
});

// ═════════════════ AC4 · duplicado por contenido ════════════════════════════════════════════════

describe('AC4 — duplicado por contenido', () => {
  const soporteVivo = (over: Record<string, unknown> = {}) => ({
    id: 'sop-0', tipo: TipoSoporte.COMPROBANTE_PAGO, subidoEn: new Date('2026-09-10T15:00:00Z'), soatId: null, impuestoId: null, derechoId: null, ...over,
  });

  it('hash vivo en flito_soportes con comprobante → duplicados con comprobanteId del ORIGINAL y «Ya cargado el {fecha}»; ni S3 ni lectura ni filas', async () => {
    kdb.when.selectOnce(T_SOP, [soporteVivo()]).selectOnce(T_COMP, [{ id: 'c-original' }]);
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.duplicados).toEqual([expect.objectContaining({ archivo: 'pol.pdf', comprobanteId: 'c-original', detalle: 'Ya cargado el 10/09/2026' })]);
    expect(res.pendientes).toEqual([]);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(leerMock).not.toHaveBeenCalled();
    expect(particionarMock).not.toHaveBeenCalled();
    expect(espia.inserts).toEqual([]);
  });

  it('AC4-M1: el dedup pregunta por hash Y descartado = false (SQL renderizado); un descartado se procesa como nuevo', async () => {
    await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    const q = renderizar(espia.condicionesLeidas()[0] as never);
    expect(q.sql).toMatch(/"flito_soportes"\."hash" = \$\d+ and "flito_soportes"\."descartado" = \$\d+/);
    const { createHash } = await import('node:crypto');
    expect(ligadoA(q, '"flito_soportes"."hash"')).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    // Sin ningún filtro por `tipo`: el hash cuenta venga de la puerta que venga.
    expect(q.sql).not.toMatch(/"flito_soportes"\."tipo"/);
  });

  it.each([
    ['SOAT', { tipo: TipoSoporte.FACTURA_SOAT, soatId: 's1' }],
    ['SOAT', { tipo: TipoSoporte.COMPROBANTE_PSE }],
    ['Impuestos', { tipo: TipoSoporte.RECIBO_IMPUESTO, impuestoId: 'i1' }],
    ['Impuestos', { tipo: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA }],
    ['Impuestos', { tipo: TipoSoporte.RECIBO_CAJA_IMPUESTO }],
    ['Derechos', { tipo: 'derecho_tramite', derechoId: 'd1' }],
    ['Impuestos', { tipo: TipoSoporte.FACTURA_VENTA, impuestoId: 'i1' }],
  ])('original por otra puerta (%s) sin comprobante → comprobanteId null y «Ya cargado el {fecha} en {puerta}», sin placa', async (puerta, over) => {
    kdb.when.selectOnce(T_SOP, [soporteVivo(over)]).selectOnce(T_COMP, []);
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.duplicados).toEqual([expect.objectContaining({ comprobanteId: null, placa: null, idFlit: null, detalle: `Ya cargado el 10/09/2026 en ${puerta}` })]);
  });

  it('puertaDelSoporte: tipo desconocido sin FK → null (el detalle queda «Ya cargado el {fecha}»)', () => {
    expect(puertaDelSoporte({ tipo: 'factura_electronica_pdf', soatId: null, impuestoId: null, derechoId: null })).toBeNull();
  });

  it('AC4-M2: dos archivos idénticos en el mismo envío → el segundo es duplicado del primero (comprobanteId del primero), una sola subida', async () => {
    const res = await cargarLote([archivo('a.pdf', PDF), archivo('a-copia.pdf', PDF)], LOTE, CTX);
    expect(res.pendientes).toHaveLength(1);
    expect(res.pendientes[0]!.comprobanteId).toBe('c-1');
    expect(res.duplicados).toEqual([expect.objectContaining({ archivo: 'a-copia.pdf', comprobanteId: 'c-1' })]);
    expect(res.duplicados[0]!.detalle).toMatch(/^Ya cargado el \d{2}\/\d{2}\/\d{4}$/);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(espia.insertsEn(T_SOP)).toHaveLength(1);
  });
});

// ═════════════════ AC5 · lectura persistida con confianza y motivo ══════════════════════════════

describe('AC5 — motivo por precedencia y columnas de lectura', () => {
  it('AC5-M1: la matriz de 6 casos, en orden de precedencia', () => {
    const base = lecturaCompleta().extraccion;
    expect(motivoPendienteDe(null)).toBe(MotivoPendienteComprobante.OCR_NO_DISPONIBLE);
    // Tipo no confiable manda sobre TODO lo demás (aunque no haya concepto ni llave ni valor).
    expect(motivoPendienteDe({ ...base, tipoDocumento: campo('factura_soat', 0.5), concepto: campo(null, 0), placa: campo(null, 0), idFlit: campo(null, 0), valorTotal: campo(null, 0) }))
      .toBe(MotivoPendienteComprobante.TIPO_NO_IDENTIFICADO);
    expect(motivoPendienteDe({ ...base, tipoDocumento: campo(null, 0) })).toBe(MotivoPendienteComprobante.TIPO_NO_IDENTIFICADO);
    // Concepto no confiable manda sobre llave y valor.
    expect(motivoPendienteDe({ ...base, concepto: campo('soat', 0.6), placa: campo(null, 0), idFlit: campo(null, 0), valorTotal: campo(null, 0) }))
      .toBe(MotivoPendienteComprobante.CONCEPTO_DESCONOCIDO);
    // Sin ninguna llave leída (ni con baja confianza) manda sobre el valor.
    expect(motivoPendienteDe({ ...base, placa: campo(null, 0), vin: campo(null, 0), idFlit: campo(null, 0), valorTotal: campo(null, 0) }))
      .toBe(MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE);
    // Una llave con confianza baja YA cuenta como leída.
    expect(motivoPendienteDe({ ...base, placa: campo(null, 0), idFlit: campo(null, 0), vin: campo('1HGCM82633A004352', 0.4), valorTotal: campo('350000', 0.5) }))
      .toBe(MotivoPendienteComprobante.CONFIANZA_INSUFICIENTE);
    // es_pago = true y valor no confiable.
    expect(motivoPendienteDe({ ...base, valorTotal: campo('350000', 0.5) })).toBe(MotivoPendienteComprobante.CONFIANZA_INSUFICIENTE);
    // Documentación (es_pago = false) sin valor: no exige valor → leído.
    expect(motivoPendienteDe({ ...base, esComprobantePago: campo('false', 0.95), valorTotal: campo(null, 0) })).toBe(MotivoPendienteComprobante.LEIDO);
    expect(motivoPendienteDe(base)).toBe(MotivoPendienteComprobante.LEIDO);
  });

  it('la fila guarda extraccion, extraccion_destino y las columnas planas con lo leído; tipo/es_pago/concepto solo si confiables (AC5-M3)', async () => {
    await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    const fila = espia.ultimoInsertEn(T_COMP);
    expect(fila.extraccion).toEqual(lecturaCompleta().extraccion);
    expect(fila.extraccionDestino).toEqual({ numeroPoliza: campo('POL-778', 0.95) });
    expect(fila).toMatchObject({
      tipoDocumento: 'factura_soat', esPago: true, concepto: 'soat',
      placaLeida: 'ABC123', vinLeido: null, idFlitLeido: 'FLIT-ARHZZ1', valor: '350000', fechaDocumento: '2026-09-10',
      numeroDocumento: 'POL-778', emisor: 'Seguros Sura', motivoPendiente: MotivoPendienteComprobante.LEIDO,
      tramiteId: TRAMITE, cruce: 'id_flit',
    });

    const cols = columnasDeLectura({
      ...lecturaCompleta({ tipoDocumento: campo('factura_soat', 0.6), concepto: campo('soat', 0.7), esComprobantePago: campo('true', 0.5), valorTotal: campo('12.345', 0.9) }),
    });
    // No confiables → NULL en columna (siguen en `extraccion` para el detalle); valor mal formado → NULL.
    expect(cols.tipoDocumento).toBeNull();
    expect(cols.concepto).toBeNull();
    expect(cols.esPago).toBeNull();
    expect(cols.valor).toBeNull();
    expect(cols.motivoPendiente).toBe(MotivoPendienteComprobante.TIPO_NO_IDENTIFICADO);
    // Un literal fuera del catálogo tampoco entra aunque venga «confiable».
    expect(columnasDeLectura(lecturaCompleta({ concepto: campo('peaje', 0.99) })).concepto).toBeNull();
  });

  it('AC5-M2: OcrNoDisponibleError en un sub-documento → se persiste igual con extraccion = {} y ocr_no_disponible; el ítem va a pendientes con su label', async () => {
    leerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'OCR no disponible'));
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.fallidos).toEqual([]);
    expect(res.pendientes).toEqual([expect.objectContaining({
      comprobanteId: 'c-1', motivo: MotivoPendienteComprobante.OCR_NO_DISPONIBLE, detalle: 'Sin lectura (OCR no disponible)',
      tipoDocumento: null, concepto: null, placa: null, idFlit: null,
    })]);
    const fila = espia.ultimoInsertEn(T_COMP);
    expect(fila.extraccion).toEqual({});
    expect(fila.extraccionDestino).toBeNull();
    expect(fila.motivoPendiente).toBe(MotivoPendienteComprobante.OCR_NO_DISPONIBLE);
    expect(fila.estado).toBe('pendiente');
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('los sub-documentos se leen con concurrencia 5 y el resultado conserva el orden de entrada', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => sub(PDF, `lote - pág ${i + 1}.pdf`, [i + 1]));
    particionarMock.mockResolvedValueOnce({ documentos: docs, paginasNoLeidas: [], metodo: 'por_pagina' });
    let enVuelo = 0; let maxEnVuelo = 0;
    leerMock.mockImplementation(async (s: { paginas: number[] }) => {
      enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      // Los primeros tardan más: si el orden fuera el de terminación, saldrían invertidos.
      await new Promise((r) => setTimeout(r, 30 - s.paginas[0]! * 3));
      enVuelo--;
      return lecturaCompleta({ numeroDocumento: campo(`DOC-${s.paginas[0]}`, 0.95) });
    });
    const res = await cargarLote([archivo('lote.pdf', PDF)], LOTE, CTX);
    expect(maxEnVuelo).toBe(5);
    expect(espia.insertsEn(T_COMP).map((c) => c.datos.numeroDocumento)).toEqual(docs.map((_, i) => `DOC-${i + 1}`));
    expect(res.pendientes.map((p) => p.paginas![0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ningún log imprime extraccion, llaves ni valores (Habeas Data)', async () => {
    leerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'OCR no disponible'));
    await cargarLote([archivo('a.pdf', PDF), archivo('b.pdf', PDF_B)], LOTE, CTX);
    expect(logLineas.length).toBeGreaterThan(0);
    const todo = JSON.stringify(logLineas);
    for (const secreto of ['ABC123', 'FLIT-ARHZZ1', '350000', 'POL-778', 'Seguros Sura', 'extraccion']) expect(todo).not.toContain(secreto);
  });

  it('el ítem pendiente lleva tipo, concepto, llaves y motivo del comprobante creado', async () => {
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res.pendientes[0]).toEqual({
      archivo: 'pol.pdf', comprobanteId: 'c-1', paginas: null, tipoDocumento: 'factura_soat', concepto: 'soat',
      idFlit: 'FLIT-ARHZZ1', placa: 'ABC123', motivo: MotivoPendienteComprobante.LEIDO, detalle: 'Leído, pendiente de asociar',
    });
  });
});

// ═════════════════ HU #12632 · auto-aplicación (D5) ═════════════════════════════════════════════

describe('HU #12632 — auto-aplicación con COMPROBANTES_AUTO_APLICAR', () => {
  const NBSP = ' ';
  /** Lo que `aplicar` devuelve (el DTO aplicado; su forma la certifica aplicar.test.ts). */
  const dtoAplicado = (id: string, over: Record<string, unknown> = {}) => ({
    id, estado: 'aplicado', motivoPendiente: null, tipoDocumento: 'factura_soat', esPago: true, concepto: 'soat', tramiteId: TRAMITE,
    cruce: 'id_flit', placaLeida: 'ABC123', idFlitLeido: 'FLIT-ARHZZ1', valor: '350000.00', aplicadoAutomaticamente: true, aplicadoPorNombre: null,
    aplicadoEn: new Date('2026-09-17T15:00:00Z'), candidatos: [], campos: [], ...over,
  });
  /** Extracción SOAT que `evaluarExtraccionSoat` aprueba contra el candidato (placa ABC123; póliza, valor y aseguradora sobre el umbral). */
  const destinoSoatAprobable = () => ({
    placa: campo('ABC123', 0.95), vin: campo(null, 0), numeroPoliza: campo('POL-778', 0.95), valorTotal: campo('350000', 0.95), aseguradora: campo('Seguros Sura', 0.9),
  });
  const lecturaSoatAprobable = (over: Record<string, ReturnType<typeof campo>> = {}) => ({ ...lecturaCompleta(over), extraccionDestino: destinoSoatAprobable() });
  /** Honorario: sin dueño, el candidato admite (no liquidado, no documentado). */
  const lecturaHonorario = () => lecturaCompleta({ [CampoComprobante.TIPO_DOCUMENTO]: campo('cuenta_cobro', 0.95), [CampoComprobante.CONCEPTO]: campo('tramite_digital', 0.95) });

  it('AC1 — SOAT: cruce único que admite, tipo/concepto/pago/valor confiables y veredicto del dueño aprobado → aplicar(id, {tramiteId sugerido, concepto, esPago: true, campos: {}}, ctx, { automatico: true }); va a aplicados con el copy «{Concepto} · {idFlit} · {pesos(valor)}»', async () => {
    leerMock.mockResolvedValue(lecturaSoatAprobable());
    aplicarMock.mockResolvedValue(dtoAplicado('c-1'));
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);

    // Persistido ANTES de aplicar (pendiente con la sugerencia): la fila y el archivo no dependen del intento.
    expect(espia.insertsEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'pendiente', tramiteId: TRAMITE, cruce: 'id_flit', motivoPendiente: MotivoPendienteComprobante.LEIDO });
    expect(aplicarMock).toHaveBeenCalledTimes(1);
    expect(aplicarMock).toHaveBeenCalledWith('c-1', { tramiteId: TRAMITE, concepto: 'soat', esPago: true, campos: {} }, CTX, { automatico: true });
    expect(res.pendientes).toEqual([]);
    expect(res.aplicados).toEqual([{
      archivo: 'pol.pdf', comprobanteId: 'c-1', paginas: null, tipoDocumento: 'factura_soat', concepto: 'soat', idFlit: 'FLIT-ARHZZ1', placa: 'ABC123',
      motivo: null, detalle: `SOAT · FLIT-ARHZZ1 · $${NBSP}350.000`,
    }]);
    expect(res.documentos).toBe(1);
    expect(detalleAplicado('tramite_digital', 'FLIT-1', '1234567')).toBe(`Trámite digital · FLIT-1 · $${NBSP}1.234.567`);
    // Ningún log con contenido leído.
    for (const secreto of ['ABC123', 'FLIT-ARHZZ1', 'POL-778', '350000']) expect(JSON.stringify(logLineas)).not.toContain(secreto);
  });

  it('AC1 — honorario (tramite_digital): sin dueño, basta cruce único que admite + lectura confiable', async () => {
    leerMock.mockResolvedValue(lecturaHonorario());
    aplicarMock.mockResolvedValue(dtoAplicado('c-1', { tipoDocumento: 'cuenta_cobro', concepto: 'tramite_digital' }));
    const res = await cargarLote([archivo('hon.pdf', PDF)], LOTE, CTX);
    expect(aplicarMock).toHaveBeenCalledWith('c-1', { tramiteId: TRAMITE, concepto: 'tramite_digital', esPago: true, campos: {} }, CTX, { automatico: true });
    expect(res.aplicados[0]).toMatchObject({ concepto: 'tramite_digital', detalle: `Trámite digital · FLIT-ARHZZ1 · $${NBSP}350.000` });
  });

  it('AC1 — el veredicto del dueño manda: la lectura base (destino SOAT sin placa ni VIN) NO se aplica aunque todo lo universal sea confiable; y con aseguradora bajo el umbral tampoco', async () => {
    const res1 = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(aplicarMock).not.toHaveBeenCalled();
    expect(res1.aplicados).toEqual([]);
    expect(res1.pendientes[0]).toMatchObject({ comprobanteId: 'c-1', motivo: MotivoPendienteComprobante.LEIDO, idFlit: 'FLIT-ARHZZ1' });

    leerMock.mockResolvedValue({ ...lecturaSoatAprobable(), extraccionDestino: { ...destinoSoatAprobable(), aseguradora: campo('Sura', 0.4) } });
    const res2 = await cargarLote([archivo('pol2.pdf', PDF_B)], LOTE, CTX);
    expect(aplicarMock).not.toHaveBeenCalled();
    expect(res2.pendientes[0]).toMatchObject({ motivo: MotivoPendienteComprobante.LEIDO });
  });

  it('AC1-M8 — concepto con confianza 0.5 → pendiente concepto_desconocido, aplicar no se invoca (aunque llave, tipo y valor sean confiables)', async () => {
    leerMock.mockResolvedValue(lecturaSoatAprobable({ [CampoComprobante.CONCEPTO]: campo('soat', 0.5) }));
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(aplicarMock).not.toHaveBeenCalled();
    expect(res.aplicados).toEqual([]);
    expect(res.pendientes[0]).toMatchObject({ comprobanteId: 'c-1', concepto: null, motivo: MotivoPendienteComprobante.CONCEPTO_DESCONOCIDO });
    expect(espia.insertsEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'pendiente', concepto: null });
  });

  it('las demás condiciones, una a una (decidirAutoAplicar real): es_pago=false confiable, valor bajo el umbral, destino que no admite, cruce ambiguo, sin lectura', () => {
    const cruceUnico = (over: Record<string, unknown> = {}) => ({
      tramiteId: TRAMITE, cruce: 'id_flit' as const, motivo: null,
      candidatos: [{ tramiteId: TRAMITE, idFlit: 'FLIT-ARHZZ1', placa: 'ABC123', vin: null, tipoTramite: null, empresa: null, flitEstado: 'Aprobado', liquidado: false,
        admite: { soat: 'admite', impuesto: 'no_gestionado', derecho: 'admite', tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' } }],
      ...over,
    });
    const ok = decidirAutoAplicar(lecturaSoatAprobable() as never, cruceUnico() as never, 0.85);
    expect(ok).toMatchObject({ body: { tramiteId: TRAMITE, concepto: 'soat', esPago: true, campos: {} } });

    const razon = (l: unknown, c: unknown) => (decidirAutoAplicar(l as never, c as never, 0.85) as { razon: string }).razon;
    expect(razon(lecturaSoatAprobable({ [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('false', 0.95) }), cruceUnico())).toBe('es_pago_no_confiable');
    expect(razon(lecturaSoatAprobable({ [CampoComprobante.VALOR_TOTAL]: campo('350000', 0.6) }), cruceUnico())).toBe('valor_no_confiable');
    expect(razon(lecturaSoatAprobable({ [CampoComprobante.TIPO_DOCUMENTO]: campo('factura_soat', 0.6) }), cruceUnico())).toBe('tipo_no_confiable');
    // AC1-M8 en la propia decisión: aunque el cruce viniera fijado, el concepto dudoso no aplica (en la carga el cruce ya lo frena antes; aquí se mide el hueco).
    expect(razon(lecturaSoatAprobable({ [CampoComprobante.CONCEPTO]: campo('soat', 0.5) }), cruceUnico())).toBe('concepto_no_confiable');
    const noAdmite = cruceUnico(); (noAdmite.candidatos[0] as { admite: Record<string, string> }).admite.soat = 'ya_pagado';
    expect(razon(lecturaSoatAprobable(), noAdmite)).toBe('destino_no_admite');
    expect(razon(lecturaSoatAprobable(), cruceUnico({ tramiteId: null, cruce: null, motivo: MotivoPendienteComprobante.CRUCE_AMBIGUO }))).toBe('sin_cruce_unico');
    expect(razon(null, cruceUnico())).toBe('sin_cruce_unico');
    expect(razon(lecturaSoatAprobable(), null)).toBe('sin_cruce_unico');
    // El umbral VIGENTE manda sobre el flag `confiable` que trajo el OCR: con umbral 0.96 nada de 0.95 pasa.
    expect((decidirAutoAplicar(lecturaSoatAprobable() as never, cruceUnico() as never, 0.96) as { razon: string }).razon).toBe('tipo_no_confiable');
  });

  it('AC2-M — flag \'0\': todo pendiente con la sugerencia (tramite_id y cruce escritos, motivo leido); aplicar no se invoca', async () => {
    env.COMPROBANTES_AUTO_APLICAR = '0';
    expect(autoAplicarEncendida()).toBe(false);
    leerMock.mockResolvedValue(lecturaSoatAprobable());
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(aplicarMock).not.toHaveBeenCalled();
    expect(res.aplicados).toEqual([]);
    expect(res.pendientes).toEqual([expect.objectContaining({ comprobanteId: 'c-1', motivo: MotivoPendienteComprobante.LEIDO, idFlit: 'FLIT-ARHZZ1' })]);
    expect(espia.insertsEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'pendiente', tramiteId: TRAMITE, cruce: 'id_flit', motivoPendiente: MotivoPendienteComprobante.LEIDO });
  });

  it('AC1-M11 — flag AUSENTE: el parse de env la deja en \'1\' (encendida) y el envío aplica', async () => {
    const previo = process.env.COMPROBANTES_AUTO_APLICAR;
    delete process.env.COMPROBANTES_AUTO_APLICAR;
    try {
      vi.resetModules();
      const fresco = await import('../../src/config/env.js');
      expect(fresco.env.COMPROBANTES_AUTO_APLICAR).toBe('1');
    } finally {
      if (previo !== undefined) process.env.COMPROBANTES_AUTO_APLICAR = previo;
    }
    expect(autoAplicarEncendida()).toBe(true);
    leerMock.mockResolvedValue(lecturaSoatAprobable());
    aplicarMock.mockResolvedValue(dtoAplicado('c-1'));
    const res = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(aplicarMock).toHaveBeenCalledTimes(1);
    expect(res.aplicados).toHaveLength(1);
  });

  it('AC3-M — un fallo de auto-aplicar no vacía el resultado del envío: el sub-documento queda pendiente con su motivo, el archivo persistido, el resto se aplica; log sin contenido leído', async () => {
    // Consolidado de dos sub-documentos (el primero falla en el dueño con 409 ya_pagado, el segundo se aplica) y un archivo suelto que se aplica.
    particionarMock
      .mockResolvedValueOnce({ documentos: [sub(PDF, 'consolidado.pdf', [1]), sub(PDF, 'consolidado.pdf', [2])], paginasNoLeidas: [], metodo: 'paginas' as const })
      .mockResolvedValueOnce(unico(PDF_B, 'otro.pdf'));
    leerMock.mockResolvedValue(lecturaSoatAprobable());
    aplicarMock
      .mockRejectedValueOnce(new ComprobanteError(409, 'ya_pagado' as never, 'Ese destino ya está pagado', { detalle: 'SOAT pagado el 2026-09-10 con placa ABC123', puedeAdjuntar: true }))
      .mockResolvedValueOnce(dtoAplicado('c-2'))
      .mockResolvedValueOnce(dtoAplicado('c-3', { placaLeida: null }));
    const res = await cargarLote([archivo('consolidado.pdf', PDF), archivo('otro.pdf', PDF_B)], LOTE, CTX);

    expect(aplicarMock).toHaveBeenCalledTimes(3);
    expect(espia.insertsEn(T_COMP)).toHaveLength(3);
    expect(res.fallidos).toEqual([]);
    expect(res.pendientes).toEqual([expect.objectContaining({ comprobanteId: 'c-1', paginas: [1], motivo: MotivoPendienteComprobante.LEIDO })]);
    expect(res.aplicados).toEqual([expect.objectContaining({ comprobanteId: 'c-2', paginas: [2] }), expect.objectContaining({ comprobanteId: 'c-3', archivo: 'otro.pdf' })]);
    expect(res.documentos).toBe(3);
    // El fallo se loguea por código, nunca con lo leído ni con el detalle del dueño.
    const fallo = logLineas.find((l) => JSON.stringify(l).includes('Auto-aplicación fallida'));
    expect(fallo?.[0]).toMatchObject({ comprobanteId: 'c-1', codigo: 'ya_pagado', status: 409 });
    for (const secreto of ['ABC123', 'FLIT-ARHZZ1', 'POL-778', '350000', 'pagado el']) expect(JSON.stringify(logLineas)).not.toContain(secreto);

    // Un error que NO es ComprobanteError (el dueño reventó) tampoco sube.
    aplicarMock.mockReset(); aplicarMock.mockRejectedValue(new Error('column "placa" ABC123 does not exist'));
    kdb.reset(); espia.reiniciar(); nComp = 0; armarBase();
    particionarMock.mockImplementation(async (a: { buffer: Buffer; nombre: string; contentType: string }) => unico(a.buffer, a.nombre, a.contentType));
    const res2 = await cargarLote([archivo('pol.pdf', PDF)], LOTE, CTX);
    expect(res2.pendientes).toHaveLength(1);
    expect(res2.fallidos).toEqual([]);
    expect(JSON.stringify(logLineas.at(-2))).not.toContain('ABC123');
  });
});
