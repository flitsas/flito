// HU #13890 (ADR-0028 D3/D8/§8) — worker del OCR de la fecha de expedición y su cron de rescate.
//
// Drizzle mockeado por tabla (`keyed-db`), con `update` envuelto para CAPTURAR el `set` y el `where` de
// cada escritura (el `where` se renderiza a SQL con el dialecto real de Postgres). El extractor de
// flito-ocr está mockeado: nada de red ni de Anthropic. El cifrado del rescate es el real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db }));
const streamMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn(), deleteEntityDocument: vi.fn(), getEntityDocumentStream: streamMock,
}));
vi.mock('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.bolsa-compania.js', () => ({
  estadoBolsaDeCompania: vi.fn().mockResolvedValue({ existe: true, activa: true }),
}));
const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr-expedicion.js', () => ({ extraerFechaExpedicion: extraerMock }));

const { procesarOcr, MAX_INTENTOS_OCR } = await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.ocr.js');
const { rescatarOcrPendientes } = await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos-ocr.cron.js');
const { expedienteDe, estadoDe } = await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.service.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { encryptPiiBuffer } = await import('../../src/shared/utils/crypto.js');
const { hoyColombia } = await import('../../src/shared/utils/fecha-rango.js');

const DOCS = 'flito_bolsas_documentos';
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '33333333-3333-4333-8333-333333333333';
const NONCE = '22222222-2222-4222-8222-222222222222';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const dialecto = new PgDialect();

function dias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const HOY = hoyColombia();

interface Escritura { datos: Record<string, unknown>; where?: { sql: string; params: unknown[] } }
let updates: Escritura[];
/** Filas que devuelve cada reclamo (UPDATE … ocr_intentos + 1 RETURNING), en orden. */
let reclamos: unknown[][];

function capturar() {
  kdb.update.mockImplementation(() => ({
    set: (v: Record<string, unknown>) => {
      const w: Escritura = { datos: v };
      updates.push(w);
      const filas = () => ('ocrIntentos' in v ? reclamos.shift() ?? [] : []);
      const c: Record<string, unknown> = {};
      c.where = (cond: SQL) => { const q = dialecto.sqlToQuery(cond); w.where = { sql: q.sql, params: q.params }; return c; };
      c.returning = () => c;
      c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas()).then(res, rej);
      return c;
    },
  }));
}

const reclamo = (tipo: string, ocrIntentos = 1) => [{ tipo, mime: 'application/pdf', ocrIntentos }];
const escriturasDeFecha = () => updates.filter((u) => 'fechaExpedicion' in u.datos);
const estadosOcr = () => updates.filter((u) => 'ocrEstado' in u.datos).map((u) => u.datos.ocrEstado);

/** Fila vigente tal como la devuelve `consultaDto()` en el expediente. */
function filaDto(tipo: string, over: Record<string, unknown> = {}) {
  return {
    id: ID, tipo, version: 1, vigente: true, mime: 'application/pdf', tamanoBytes: PDF.length,
    storageKey: 'k', fechaExpedicion: null, fechaOrigen: null, fechaManualEn: null, ocrEstado: 'validando',
    cargadoEn: new Date('2026-10-01T15:00:00Z'), reemplazadoEn: null, cargadoPorNombre: 'Ana', fechaManualPorNombre: null,
    ...over,
  };
}

beforeEach(() => {
  kdb.reset();
  updates = []; reclamos = [];
  capturar();
  extraerMock.mockReset();
  streamMock.mockReset();
  kdb.when.select('clients', [{ id: 7 }]);
});

describe('AC1 — Cámara legible: la fecha de expedición queda guardada en la vigente', () => {
  it('reclama la fila, envía el buffer al motor y guarda la fecha con origen OCR', async () => {
    const fecha = dias(HOY, -5);
    reclamos.push(reclamo('camara_comercio'));
    extraerMock.mockResolvedValue({ fecha, confiable: true });

    expect(await procesarOcr(ID, PDF)).toBe('leido');

    expect(extraerMock).toHaveBeenCalledTimes(1);
    expect(extraerMock.mock.calls[0]![1]).toBe('camara_comercio');
    expect((extraerMock.mock.calls[0]![0] as { contenido: Buffer }).contenido).toBe(PDF);
    expect(escriturasDeFecha().map((u) => u.datos)).toEqual([{ fechaExpedicion: fecha, fechaOrigen: 'ocr' }]);
    expect(estadosOcr()).toEqual(['leido']);
    // El reclamo solo toma filas en `validando` (la cédula y el adicional nacen `no_aplica`).
    expect(updates[0]!.where!.sql).toMatch(/"ocr_estado" = \$\d/);
    expect(updates[0]!.where!.params).toContain('validando');
  });

  it('nunca pisa una fecha manual: el UPDATE de la fecha excluye fecha_origen = manual', async () => {
    reclamos.push(reclamo('rut'));
    extraerMock.mockResolvedValue({ fecha: dias(HOY, -1), confiable: true });
    await procesarOcr(ID, PDF);
    const w = escriturasDeFecha()[0]!.where!;
    expect(w.sql).toMatch(/"fecha_origen" IS DISTINCT FROM \$\d/);
    expect(w.params).toContain('manual');
  });

  it('el rescate (sin buffer) descarga y descifra el archivo antes de enviarlo', async () => {
    const enc = encryptPiiBuffer(PDF, { table: 'flito_bolsas_documentos', column: 'archivo', empresaNit: ID, aadNonce: NONCE });
    kdb.when.selectOnce(DOCS, [{
      companiaId: 7, tipo: 'rut', version: 1, mime: 'application/pdf', storageKey: 'k',
      iv: enc.iv, tag: enc.authTag, keyVersion: enc.keyVersion, aadNonce: NONCE,
    }]);
    streamMock.mockResolvedValue(Readable.from([enc.cipher]));
    reclamos.push(reclamo('rut'));
    extraerMock.mockResolvedValue({ fecha: dias(HOY, -2), confiable: true });

    expect(await procesarOcr(ID)).toBe('leido');
    expect((extraerMock.mock.calls[0]![0] as { contenido: Buffer }).contenido.equals(PDF)).toBe(true);
  });
});

describe('AC2 / AC3 — vigencia de 30 días calculada al leer, sin reprocesar', () => {
  it('RUT expedido hace 30 días → Válido; el día siguiente (31) → Vigencia vencida, con un solo OCR', async () => {
    const fecha = dias(HOY, -30);
    reclamos.push(reclamo('rut'));
    extraerMock.mockResolvedValue({ fecha, confiable: true });
    await procesarOcr(ID, PDF);
    const guardada = escriturasDeFecha()[0]!.datos.fechaExpedicion as string;

    const fila = filaDto('rut', { fechaExpedicion: guardada, fechaOrigen: 'ocr', ocrEstado: 'leido' });
    kdb.when.select(DOCS, [fila]);
    const hoy = await expedienteDe(7, HOY);
    expect(hoy.documentos.find((d) => d.tipo === 'rut')!.estado).toBe('valido');
    const manana = await expedienteDe(7, dias(HOY, 1));
    expect(manana.documentos.find((d) => d.tipo === 'rut')!.estado).toBe('vencido');

    expect(extraerMock).toHaveBeenCalledTimes(1); // AC3: no se reprocesa
    expect(updates.filter((u) => 'ocrIntentos' in u.datos)).toHaveLength(1);
  });
});

describe('AC4 — certificado sin fecha legible → «No se pudo validar»', () => {
  it('queda en sin_fecha, sin escribir fecha, y el estado es no_validado', async () => {
    reclamos.push(reclamo('certificado_bancario'));
    extraerMock.mockResolvedValue({ fecha: null, confiable: false });
    expect(await procesarOcr(ID, PDF)).toBe('sin_fecha');
    expect(escriturasDeFecha()).toHaveLength(0);
    expect(estadosOcr()).toEqual(['sin_fecha']);
    expect(estadoDe({ tipo: 'certificado_bancario', fechaExpedicion: null, ocrEstado: 'sin_fecha' }, HOY)).toBe('no_validado');
  });

  it('una fecha leída pero no confiable, o futura, también es sin_fecha', async () => {
    reclamos.push(reclamo('rut'), reclamo('rut'));
    extraerMock.mockResolvedValueOnce({ fecha: dias(HOY, -3), confiable: false })
      .mockResolvedValueOnce({ fecha: dias(HOY, 2), confiable: true });
    expect(await procesarOcr(ID, PDF)).toBe('sin_fecha');
    expect(await procesarOcr(ID, PDF)).toBe('sin_fecha');
    expect(escriturasDeFecha()).toHaveLength(0);
  });
});

describe('AC7 — cédula y adicional: válidos por tenerlos, sin OCR', () => {
  it('cargados → Válido; sin archivo → Pendiente', async () => {
    kdb.when.select(DOCS, [
      filaDto('cedula_representante', { ocrEstado: 'no_aplica' }),
      filaDto('adicional', { id: ID2, ocrEstado: 'no_aplica' }),
    ]);
    const e = await expedienteDe(7, HOY);
    const estado = (t: string) => e.documentos.find((d) => d.tipo === t)!.estado;
    expect(estado('cedula_representante')).toBe('valido');
    expect(estado('adicional')).toBe('valido');
    expect(estado('rut')).toBe('pendiente');
    expect(estado('camara_comercio')).toBe('pendiente');
  });

  it('una cédula nunca llega al motor (no se reclama; y si se reclamara, se omite)', async () => {
    expect(await procesarOcr(ID, PDF)).toBe('omitido'); // `no_aplica` no cumple el WHERE del reclamo
    reclamos.push(reclamo('cedula_representante'));
    expect(await procesarOcr(ID, PDF)).toBe('omitido');
    expect(extraerMock).not.toHaveBeenCalled();
  });
});

describe('AC9 — límite del motor (429): el OCR queda pendiente y el estado no es «Válido»', () => {
  it('con intentos restantes sigue en validando para el rescate', async () => {
    reclamos.push(reclamo('rut', 1));
    extraerMock.mockRejectedValue(new OcrNoDisponibleError(429, 'rate limited'));
    expect(await procesarOcr(ID, PDF)).toBe('reintentar');
    expect(estadosOcr()).toEqual(['validando']);
    expect(escriturasDeFecha()).toHaveLength(0);
    expect(estadoDe({ tipo: 'rut', fechaExpedicion: null, ocrEstado: 'validando' }, HOY)).toBe('validando');
  });

  it(`al ${MAX_INTENTOS_OCR}.er intento pasa a fallido → «No se pudo validar»`, async () => {
    reclamos.push(reclamo('rut', MAX_INTENTOS_OCR));
    extraerMock.mockRejectedValue(new OcrNoDisponibleError(429, 'rate limited'));
    expect(await procesarOcr(ID, PDF)).toBe('fallido');
    expect(estadosOcr()).toEqual(['fallido']);
    expect(estadoDe({ tipo: 'rut', fechaExpedicion: null, ocrEstado: 'fallido' }, HOY)).toBe('no_validado');
  });

  it('con los intentos ya agotados no vuelve a llamar al motor', async () => {
    reclamos.push(reclamo('rut', MAX_INTENTOS_OCR + 1));
    expect(await procesarOcr(ID, PDF)).toBe('fallido');
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('un error que no es del motor (p. ej. descifrado) va directo a fallido', async () => {
    reclamos.push(reclamo('rut', 1));
    extraerMock.mockRejectedValue(new Error('boom'));
    expect(await procesarOcr(ID, PDF)).toBe('fallido');
    expect(estadosOcr()).toEqual(['fallido']);
  });
});

describe('cron de rescate', () => {
  it('toma los validando de más de 3 min (lote acotado) y los procesa sin buffer', async () => {
    kdb.when.selectOnce(DOCS, [{ id: ID }, { id: ID2 }]);
    // Cada fila con su propia AAD (id + nonce): un blob de otra fila no descifra.
    const cifrar = (id: string) => encryptPiiBuffer(PDF, { table: 'flito_bolsas_documentos', column: 'archivo', empresaNit: id, aadNonce: NONCE });
    const archivo = (enc: ReturnType<typeof cifrar>) => ({ companiaId: 7, tipo: 'rut', version: 1, mime: 'application/pdf', storageKey: 'k', iv: enc.iv, tag: enc.authTag, keyVersion: enc.keyVersion, aadNonce: NONCE });
    const enc1 = cifrar(ID);
    const enc2 = cifrar(ID2);
    kdb.when.selectOnce(DOCS, [archivo(enc1)]).selectOnce(DOCS, [archivo(enc2)]);
    streamMock.mockResolvedValueOnce(Readable.from([enc1.cipher])).mockResolvedValueOnce(Readable.from([enc2.cipher]));
    reclamos.push(reclamo('rut', 2), reclamo('camara_comercio', 2));
    extraerMock.mockResolvedValueOnce({ fecha: dias(HOY, -1), confiable: true })
      .mockRejectedValueOnce(new OcrNoDisponibleError(503, 'caído'));

    const r = await rescatarOcrPendientes(new Date('2026-10-23T15:00:00Z'));
    expect(r).toMatchObject({ leido: 1, reintentar: 1, fallido: 0 });
  });
});
