// HU #13889 (ADR-0028) — servicio del expediente documental de la compañía: carga (AC1), reemplazo con
// historial (AC2), el adicional opcional (AC4), la regla de bolsa (AC8) y el cálculo de vigencia (D2).
//
// Drizzle está mockeado por tabla (`keyed-db`), con `insert`/`update` envueltos para CAPTURAR lo que el
// servicio escribe. El puerto S0 (`.bolsa-compania.ts`) se mockea: los tests no dependen de la tabla de
// bolsas de flito-df. El cifrado es el real (clave de `__tests__/setup.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db }));

const uploadMock = vi.fn();
const deleteMock = vi.fn().mockResolvedValue(true);
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  deleteEntityDocument: deleteMock,
  getEntityDocumentStream: vi.fn(),
}));

const estadoBolsaMock = vi.fn();
vi.mock('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.bolsa-compania.js', () => ({
  estadoBolsaDeCompania: estadoBolsaMock,
}));

const { cargarDocumento, expedienteDe, historialDe, estadoDe, retirarDocumento, BolsaDocumentoError } =
  await import('../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.service.js');
const { decryptPiiBuffer } = await import('../../src/shared/utils/crypto.js');

const COMPANIA = 7;
const USUARIO = 42;
const KEY = 'flito-bolsas-documentos/7/1700000000000_x.bin';
const DOCS = 'flito_bolsas_documentos';
/** PDF de 3 MB (AC1): cabecera real + relleno. */
const PDF_3MB = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024 - 9, 0x20)]);

interface Escritura { tabla: string; datos: Record<string, unknown> }
let inserts: Escritura[];
let updates: Escritura[];
let orden: string[];

function capturar() {
  const encadenable = (rows: unknown[]) => {
    const t: Record<string, unknown> = {};
    for (const m of ['where', 'returning', 'onConflictDoNothing', 'onConflictDoUpdate']) t[m] = () => t;
    t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
    return t;
  };
  kdb.insert.mockImplementation((tbl: unknown) => ({
    values: (v: Record<string, unknown>) => { inserts.push({ tabla: getTableName(tbl as never), datos: v }); orden.push('insert'); return encadenable([]); },
  }));
  kdb.update.mockImplementation((tbl: unknown) => ({
    set: (v: Record<string, unknown>) => { updates.push({ tabla: getTableName(tbl as never), datos: v }); orden.push('update'); return encadenable([]); },
  }));
}

/** Fila tal como la devuelve `consultaDto()` (join con el usuario que cargó). */
function filaDto(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111', tipo: 'rut', version: 1, vigente: true, mime: 'application/pdf',
    tamanoBytes: PDF_3MB.length, storageKey: KEY, fechaExpedicion: null, fechaOrigen: null, fechaManualEn: null,
    ocrEstado: 'validando', cargadoEn: new Date('2026-10-23T15:00:00Z'), reemplazadoEn: null,
    cargadoPorNombre: 'Ana Operaciones', fechaManualPorNombre: null,
    retiradoEn: null, motivoRetiro: null, retiradorNombre: null, ...over,
  };
}

beforeEach(() => {
  kdb.reset();
  inserts = []; updates = []; orden = [];
  capturar();
  uploadMock.mockReset().mockResolvedValue(KEY);
  deleteMock.mockClear();
  estadoBolsaMock.mockReset().mockResolvedValue({ existe: true, activa: true });
  kdb.when.select('clients', [{ id: COMPANIA }]);
});

describe('AC1 — carga de un PDF de 3 MB como RUT', () => {
  it('queda vigente en la versión 1, con autor y fecha, y el archivo se guarda CIFRADO', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto()]);

    const dto = await cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO });

    expect(dto).toMatchObject({ tipo: 'rut', version: 1, cargadoPor: 'Ana Operaciones', cargadoEn: '2026-10-23T15:00:00.000Z', estado: 'validando' });
    expect(inserts).toHaveLength(1);
    const fila = inserts[0]!.datos;
    expect(inserts[0]!.tabla).toBe(DOCS);
    expect(fila).toMatchObject({
      companiaId: COMPANIA, tipo: 'rut', version: 1, vigente: true, storageKey: KEY, mime: 'application/pdf',
      tamanoBytes: PDF_3MB.length, cargadoPor: USUARIO, ocrEstado: 'validando', cifradoKeyVersion: 1,
    });
    // Lo que viaja a MinIO es el texto cifrado, con clave sin PII y sin el nombre del archivo (D7).
    const [prefijo, entidad, nombre, subido, mime] = uploadMock.mock.calls[0]!;
    expect([prefijo, entidad, nombre, mime]).toEqual(['flito-bolsas-documentos', COMPANIA, 'archivo.bin', 'application/octet-stream']);
    expect((subido as Buffer).subarray(0, 4).toString()).not.toBe('%PDF');
    const plano = decryptPiiBuffer(
      { cipher: subido as Buffer, iv: fila.cifradoIv as Buffer, authTag: fila.cifradoTag as Buffer, keyVersion: 1 },
      { table: DOCS, column: 'archivo', empresaNit: fila.id as string, aadNonce: fila.aadNonce as string },
    );
    expect(plano.equals(PDF_3MB)).toBe(true);
  });

  it('la cédula y el adicional nacen con ocr_estado no_aplica (no van al OCR) y salen válidos', async () => {
    kdb.when.selectOnce(DOCS, [{ n: null }]).selectOnce(DOCS, [filaDto({ tipo: 'cedula_representante', ocrEstado: 'no_aplica' })]);
    const dto = await cargarDocumento({ companiaId: COMPANIA, tipo: 'cedula_representante', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO });
    expect(inserts[0]!.datos.ocrEstado).toBe('no_aplica');
    expect(dto.estado).toBe('valido');
  });

  it('si la transacción falla, borra el objeto subido (sin huérfanos)', async () => {
    kdb.transaction.mockRejectedValueOnce(new Error('caída de BD'));
    await expect(cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO }))
      .rejects.toThrow('caída de BD');
    expect(deleteMock).toHaveBeenCalledWith(KEY);
  });

  it('una carga concurrente (23505 en el índice de vigente) es 409 y borra el objeto', async () => {
    kdb.transaction.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO }))
      .rejects.toMatchObject({ estado: 409 });
    expect(deleteMock).toHaveBeenCalledWith(KEY);
  });
});

describe('AC2 — reemplazar un documento', () => {
  it('la vigente pasa a reemplazada (antes del insert) y la nueva entra como versión 2 vigente', async () => {
    kdb.when.selectOnce(DOCS, [{ n: 1 }]).selectOnce(DOCS, [filaDto({ version: 2 })]);

    const dto = await cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO });

    expect(orden).toEqual(['update', 'insert']);
    expect(updates[0]!.tabla).toBe(DOCS);
    expect(updates[0]!.datos.vigente).toBe(false);
    expect(updates[0]!.datos.reemplazadoEn).toBeInstanceOf(Date);
    expect(inserts[0]!.datos).toMatchObject({ version: 2, vigente: true, cargadoPor: USUARIO });
    expect(dto.version).toBe(2);
  });

  it('el historial muestra la nueva vigente y la anterior como reemplazada, con quién la cargó y cuándo', async () => {
    kdb.when.select(DOCS, [
      filaDto({ id: 'v2', version: 2, cargadoPorNombre: 'Beto Finanzas', cargadoEn: new Date('2026-10-23T16:00:00Z') }),
      filaDto({ id: 'v1', version: 1, vigente: false, reemplazadoEn: new Date('2026-10-23T16:00:00Z') }),
    ]);
    const versiones = await historialDe(COMPANIA, 'rut', '2026-10-23');
    expect(versiones.map((v) => [v.version, v.vigente, v.reemplazadoEn, v.cargadoPor, v.archivoDisponible])).toEqual([
      [2, true, null, 'Beto Finanzas', true],
      [1, false, '2026-10-23T16:00:00.000Z', 'Ana Operaciones', true],
    ]);
    // Sin PII en el DTO: ni clave de almacenamiento ni nombre de archivo.
    expect(JSON.stringify(versiones)).not.toContain(KEY);
  });

  it('una versión purgada sale sin archivo disponible', async () => {
    kdb.when.select(DOCS, [filaDto({ vigente: false, storageKey: null, reemplazadoEn: new Date() })]);
    const [v] = await historialDe(COMPANIA, 'rut', '2026-10-23');
    expect(v!.archivoDisponible).toBe(false);
  });
});

describe('AC4 — sin documento adicional', () => {
  it('el adicional figura como opcional y pendiente, no es error, y no cuenta para «completo»', async () => {
    const hoy = '2026-10-23';
    kdb.when.select(DOCS, [
      filaDto({ tipo: 'camara_comercio', fechaExpedicion: '2026-10-01', fechaOrigen: 'ocr', ocrEstado: 'leido' }),
      filaDto({ tipo: 'rut', fechaExpedicion: '2026-10-01', fechaOrigen: 'ocr', ocrEstado: 'leido' }),
      filaDto({ tipo: 'cedula_representante', ocrEstado: 'no_aplica' }),
      filaDto({ tipo: 'certificado_bancario', fechaExpedicion: '2026-10-20', fechaOrigen: 'ocr', ocrEstado: 'leido' }),
    ]);
    const exp = await expedienteDe(COMPANIA, hoy);
    const adicional = exp.documentos.find((d) => d.tipo === 'adicional')!;
    expect(adicional).toEqual({ tipo: 'adicional', estado: 'pendiente', opcional: true, vigente: null, tieneHistorial: false });
    expect(exp.documentos.filter((d) => d.opcional).map((d) => d.tipo)).toEqual(['adicional']);
    expect(exp.completo).toBe(true);
  });

  it('un principal faltante sí deja el expediente incompleto', async () => {
    kdb.when.select(DOCS, []);
    const exp = await expedienteDe(COMPANIA, '2026-10-23');
    expect(exp.completo).toBe(false);
    expect(exp.documentos.map((d) => d.estado)).toEqual(['pendiente', 'pendiente', 'pendiente', 'pendiente', 'pendiente']);
  });

  it('compañía inexistente → 404', async () => {
    kdb.when.select('clients', []);
    await expect(expedienteDe(999, '2026-10-23')).rejects.toMatchObject({ estado: 404 });
  });
});

describe('AC8 — la carga exige bolsa de compañía activa', () => {
  const cargar = () => cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO });

  it('compañía sin bolsa de compañía (p. ej. solo bolsa de tránsito) → 404, sin subir nada', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: false, activa: false });
    await expect(cargar()).rejects.toMatchObject({ estado: 404, message: expect.stringContaining('no tiene bolsa de compañía') });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('bolsa inactiva → 409, sin subir nada', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    await expect(cargar()).rejects.toBeInstanceOf(BolsaDocumentoError);
    await expect(cargar()).rejects.toMatchObject({ estado: 409 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('compañía inexistente → 404 sin consultar la bolsa', async () => {
    kdb.when.select('clients', []);
    await expect(cargar()).rejects.toMatchObject({ estado: 404 });
    expect(estadoBolsaMock).not.toHaveBeenCalled();
  });
});

describe('estadoDe — vigencia calculada al leer (D2)', () => {
  const f = (over: Record<string, unknown>) => ({ tipo: 'rut', fechaExpedicion: null, ocrEstado: 'leido', ...over }) as never;
  it('sin fila → pendiente', () => expect(estadoDe(null, '2026-10-23')).toBe('pendiente'));
  it('válido el día 30 y vencido el 31', () => {
    expect(estadoDe(f({ fechaExpedicion: '2026-09-23' }), '2026-10-23')).toBe('valido');
    expect(estadoDe(f({ fechaExpedicion: '2026-09-22' }), '2026-10-23')).toBe('vencido');
  });
  it('sin fecha: validando mientras el OCR está en curso, no_validado si no', () => {
    expect(estadoDe(f({ ocrEstado: 'validando' }), '2026-10-23')).toBe('validando');
    expect(estadoDe(f({ ocrEstado: 'fallido' }), '2026-10-23')).toBe('no_validado');
  });
  it('cédula y adicional: válidos por tenerlos', () => {
    expect(estadoDe(f({ tipo: 'cedula_representante', ocrEstado: 'no_aplica' }), '2026-10-23')).toBe('valido');
    expect(estadoDe(f({ tipo: 'adicional', ocrEstado: 'no_aplica' }), '2026-10-23')).toBe('valido');
  });
});

// ── HU #13964 — retiro de la versión vigente (E7, RN-BD7) ──────────────────────────────────────────

const DOC = '11111111-1111-4111-8111-111111111111';

/** WHERE renderizado a SQL parametrizado (para comprobar la condición real del UPDATE). */
const dialecto = new PgDialect();
type Condicion = { sql: string; params: unknown[] };

/**
 * El UPDATE del retiro devuelve `filas` en su `returning` (1 = ganó; 0 = otra operación le ganó).
 * Si `filas` es función, recibe el WHERE renderizado y decide qué filas «afecta» (simula la BD).
 */
function updateRetiro(filas: unknown[] | ((cond: Condicion) => unknown[])) {
  kdb.update.mockImplementation((tbl: unknown) => ({
    set: (v: Record<string, unknown>) => {
      updates.push({ tabla: getTableName(tbl as never), datos: v });
      let cond: Condicion = { sql: '', params: [] };
      const c: Record<string, unknown> = {};
      c.where = (w: SQL) => { cond = dialecto.sqlToQuery(w); return c; };
      c.returning = () => c;
      c.then = (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(typeof filas === 'function' ? filas(cond) : filas).then(res, rej);
      return c;
    },
  }));
}

describe('HU #13964 AC1 — retirar la versión vigente', () => {
  it('deja el tipo pendiente, la versión no vigente con retiro (mismo instante) y NO toca el almacenamiento', async () => {
    updateRetiro([{ id: DOC }]);
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', version: 2, vigente: true }]);

    const r = await retirarDocumento(DOC, 'Documento equivocado', USUARIO);

    expect(r.fila).toEqual({ tipo: 'rut', estado: 'pendiente', opcional: false, vigente: null, tieneHistorial: true });
    expect(r).toMatchObject({ companiaId: COMPANIA, version: 2 });
    expect(updates).toHaveLength(1);
    const d = updates[0]!.datos;
    expect(d).toMatchObject({ vigente: false, retiradoPor: USUARIO, motivoRetiro: 'Documento equivocado' });
    expect(d.retiradoEn).toBeInstanceOf(Date);
    // CHECK `ck_…_retiro`: reemplazado_en = retirado_en (la purga de 5 años cuenta desde el retiro).
    expect(d.reemplazadoEn).toBe(d.retiradoEn);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('sin motivo se retira igual (motivo NULL); el adicional retirado sale opcional', async () => {
    updateRetiro([{ id: DOC }]);
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'adicional', version: 1, vigente: true }]);
    const r = await retirarDocumento(DOC, null, USUARIO);
    expect(r.fila).toMatchObject({ tipo: 'adicional', opcional: true, estado: 'pendiente' });
    expect(updates[0]!.datos.motivoRetiro).toBeNull();
  });

  it('se puede retirar con el OCR en curso («validando»): la guarda solo mira vigente y bolsa', async () => {
    updateRetiro([{ id: DOC }]);
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'camara_comercio', version: 1, vigente: true }]);
    await expect(retirarDocumento(DOC, null, USUARIO)).resolves.toMatchObject({ fila: { estado: 'pendiente' } });
  });

  it('documento inexistente → 404 sin escribir', async () => {
    kdb.when.selectOnce(DOCS, []);
    await expect(retirarDocumento(DOC, null, USUARIO)).rejects.toMatchObject({ estado: 404 });
    expect(updates).toHaveLength(0);
  });
});

describe('HU #13964 AC5 — bolsa inactiva', () => {
  it('→ 409 bolsa_inactiva sin escribir', async () => {
    estadoBolsaMock.mockResolvedValue({ existe: true, activa: false });
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', version: 1, vigente: true }]);
    await expect(retirarDocumento(DOC, null, USUARIO)).rejects.toMatchObject({ estado: 409, codigo: 'bolsa_inactiva' });
    expect(updates).toHaveLength(0);
  });
});

describe('HU #13964 AC7 — una versión ya no vigente', () => {
  it('reemplazada o retirada en la lectura → 409 no_vigente sin escribir', async () => {
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', version: 1, vigente: false }]);
    await expect(retirarDocumento(DOC, null, USUARIO)).rejects.toMatchObject({ estado: 409, codigo: 'no_vigente' });
    expect(updates).toHaveLength(0);
  });

  it('carrera: el UPDATE filtra por id Y vigente = true, así que si otra operación ya la dejó no vigente afecta 0 filas → 409 no_vigente', async () => {
    // La lectura la vio vigente, pero en la «BD» otra carga/retiro ya la dejó vigente = false entre
    // la lectura y el UPDATE: solo un WHERE que exija vigente = true deja de encontrarla.
    let where: Condicion | undefined;
    updateRetiro((cond) => {
      where = cond;
      const exigeVigente = /"vigente" = \$\d+/.test(cond.sql) && cond.params.includes(true);
      return exigeVigente ? [] : [{ id: DOC }];
    });
    kdb.when.selectOnce(DOCS, [{ companiaId: COMPANIA, tipo: 'rut', version: 1, vigente: true }]);
    await expect(retirarDocumento(DOC, null, USUARIO)).rejects.toMatchObject({ estado: 409, codigo: 'no_vigente' });
    expect(where!.sql).toMatch(/"id" = \$\d+ and .*"vigente" = \$\d+/);
    expect(where!.params).toEqual([DOC, true]);
  });
});

describe('HU #13964 AC3 — completo depende solo de la vigente; E1 trae tieneHistorial', () => {
  it('con el RUT retirado: el RUT sale pendiente, el expediente incompleto y el RUT conserva su historial', async () => {
    kdb.when
      // 1.ª consulta: solo vigentes (el RUT retirado no está).
      .selectOnce(DOCS, [
        filaDto({ tipo: 'camara_comercio', fechaExpedicion: '2026-10-01', fechaOrigen: 'ocr', ocrEstado: 'leido' }),
        filaDto({ tipo: 'cedula_representante', ocrEstado: 'no_aplica' }),
        filaDto({ tipo: 'certificado_bancario', fechaExpedicion: '2026-10-20', fechaOrigen: 'ocr', ocrEstado: 'leido' }),
      ])
      // 2.ª consulta (agregada): tipos con alguna versión.
      .selectOnce(DOCS, [{ tipo: 'camara_comercio' }, { tipo: 'rut' }, { tipo: 'cedula_representante' }, { tipo: 'certificado_bancario' }]);
    const exp = await expedienteDe(COMPANIA, '2026-10-23');
    const por = (t: string) => exp.documentos.find((d) => d.tipo === t)!;
    expect(por('rut')).toEqual({ tipo: 'rut', estado: 'pendiente', opcional: false, vigente: null, tieneHistorial: true });
    expect(por('adicional').tieneHistorial).toBe(false);
    expect(por('camara_comercio').tieneHistorial).toBe(true);
    expect(exp.completo).toBe(false);
  });
});

describe('HU #13964 AC4 — cargar tras retirar', () => {
  it('la retirada conserva su número: tras retirar la v2, la carga siguiente es la v3', async () => {
    kdb.when.selectOnce(DOCS, [{ n: 2 }]).selectOnce(DOCS, [filaDto({ version: 3 })]);
    const dto = await cargarDocumento({ companiaId: COMPANIA, tipo: 'rut', buffer: PDF_3MB, mime: 'application/pdf', userId: USUARIO });
    expect(inserts[0]!.datos).toMatchObject({ version: 3, vigente: true });
    expect(dto.version).toBe(3);
  });
});

describe('HU #13964 AC2 — el historial distingue la retirada de la reemplazada', () => {
  it('retiro: { en, por: { nombre }, motivo } solo en la retirada; null en la vigente y en la reemplazada', async () => {
    const en = new Date('2026-10-25T14:00:00Z');
    kdb.when.select(DOCS, [
      filaDto({ id: 'v3', version: 3 }),
      filaDto({ id: 'v2', version: 2, vigente: false, reemplazadoEn: en, retiradoEn: en, motivoRetiro: 'Era de otra compañía', retiradorNombre: 'Beto Finanzas' }),
      filaDto({ id: 'v1', version: 1, vigente: false, reemplazadoEn: new Date('2026-10-20T10:00:00Z') }),
    ]);
    const versiones = await historialDe(COMPANIA, 'rut', '2026-10-23');
    expect(versiones.map((v) => v.retiro)).toEqual([
      null,
      { en: '2026-10-25T14:00:00.000Z', por: { nombre: 'Beto Finanzas' }, motivo: 'Era de otra compañía' },
      null,
    ]);
    // La retirada conserva el archivo (AC1): sigue descargable.
    expect(versiones[1]!.archivoDisponible).toBe(true);
  });

  it('retiro sin autor (usuario borrado, ON DELETE SET NULL) ni motivo', async () => {
    const en = new Date('2026-10-25T14:00:00Z');
    kdb.when.select(DOCS, [filaDto({ vigente: false, reemplazadoEn: en, retiradoEn: en })]);
    const [v] = await historialDe(COMPANIA, 'rut', '2026-10-23');
    expect(v!.retiro).toEqual({ en: '2026-10-25T14:00:00.000Z', por: { nombre: null }, motivo: null });
  });
});
