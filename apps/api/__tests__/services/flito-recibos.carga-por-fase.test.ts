process.env.TZ = 'UTC';
// HU #13208 (Feature #12955) — carga de un comprobante de liquidación o de pago desde el impuesto,
// eligiendo la fase. Se llama a `cargarReciboPorFase` directo (calco de flito-recibo-caja.test.ts) y
// se mide lo que el servicio ESCRIBE, tabla a tabla, con `txQueCaptura`.
//
// Orden de `selectMock` para admin (abrirLote no consulta): acceso → hash → fase ya cargada (count) →
// candidato → [número de recibo en otro, si el OCR leyó número] → [count del complemento, si pagado].
// Dentro de la transacción (R-1): estado FOR UPDATE → count otra vez.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { getTableName, type SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';
import { CampoImpuesto, EstadoImpuesto, FaseRecibo, FlujoRevision, MotivoRevision, TipoSoporte } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerReciboImpuesto: extraerMock };
});
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const comprimirMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/flito-recibos.compresion.js', async (orig) => {
  const real = await orig() as typeof import('../../src/modules/flito-impuestos/flito-recibos.compresion.js');
  comprimirMock.mockImplementation(real.comprimirComprobante);
  return { ...real, comprimirComprobante: comprimirMock };
});

const { cargarReciboPorFase, evaluarPagoPorFase, CargaPorFaseError, DETALLE_CARGA_POR_FASE } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { DETALLE_PAGO_SIN_SELLO, DETALLE_LIQUIDACION_CON_SELLO } = await import('../../src/modules/flito-impuestos/flito-recibos.fase.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { flitoImpuestos, flitoSoportes, flitoRevisiones, auditLogs } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_REVISIONES = getTableName(flitoRevisiones);
const T_AUDIT = getTableName(auditLogs);

const AHORA = new Date('2026-09-30T15:00:00Z');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset(); comprimirMock.mockClear();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/r.pdf');
  // La auditoría de un rechazo va con `db` directo (no abre transacción).
  insertMock.mockImplementation(() => chain([]));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
});
afterEach(() => { vi.useRealTimers(); });

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const ADMIN = { userId: 5, username: 'ops@flito.co', role: 'admin', organismos: [] as string[], alcance: { enlace: 'ninguno' as const } };
const pdf = (contenido: string) => ({ originalname: 'comprobante.pdf', mimetype: 'application/pdf', buffer: Buffer.from(contenido), size: contenido.length });
const sha = (a: { buffer: Buffer }) => createHash('sha256').update(a.buffer).digest('hex');

const acceso = (over: Record<string, unknown> = {}) => ({
  imp: { id: UUID, tramiteId: 'TR-1', estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', gestionOperaciones: false, liquidadoEn: null, ...over },
  dentroDeFrontera: true,
});
const candidato = (over: Record<string, unknown> = {}) => ({
  impuestoId: UUID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 'TR-1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: '350000', diferenciaActiva: false, tolerancia: '0', liquidadoEn: null,
  ...over,
});

type Campo = ReturnType<typeof campo> | null;
/** Lectura del OCR. `null` = el campo no vino. Por defecto: placa del impuesto, valor y número confiables, sello según la fase. */
function lectura(o: { placa?: Campo; valor?: Campo; sello?: Campo; numero?: Campo } = {}) {
  const p = { placa: campo('QTQ-100', 0.95), valor: campo('350000', 0.95), sello: campo('true', 0.95), numero: null as Campo, ...o };
  return {
    ...(p.placa ? { [CampoImpuesto.PLACA]: p.placa } : {}),
    ...(p.valor ? { [CampoImpuesto.VALOR_TOTAL]: p.valor } : {}),
    ...(p.sello ? { [CampoImpuesto.SELLO_PAGADO]: p.sello } : {}),
    ...(p.numero ? { [CampoImpuesto.NUMERO_RECIBO]: p.numero } : {}),
  };
}
const SIN_SELLO = campo('false', 0.95);

/** Chain que además guarda el argumento de `.where()`: el mock ignora el filtro. */
function chainConWhere(rows: unknown[], sink: SQL[]) {
  const c = chain(rows) as unknown as Record<string, unknown>;
  c.where = (cond: SQL) => { sink.push(cond); return c; };
  return c;
}

/** acceso → hash → count de la fase → candidato. Devuelve los `where` leídos. */
function escenario(o: { acceso?: unknown[]; dup?: unknown[]; n?: number; cand?: unknown[] } = {}) {
  const wheres: SQL[] = [];
  selectMock.mockReturnValueOnce(chainConWhere(o.acceso ?? [acceso()], wheres));
  selectMock.mockReturnValueOnce(chainConWhere(o.dup ?? [], wheres));
  selectMock.mockReturnValueOnce(chainConWhere([{ n: o.n ?? 0 }], wheres));
  selectMock.mockReturnValueOnce(chainConWhere(o.cand ?? [candidato()], wheres));
  return wheres;
}

interface Escritura { op: 'insert' | 'update'; tabla: string; datos: Record<string, unknown> }

/**
 * Transacción que captura las escrituras con su tabla e ids distintos por tabla. `relectura` es lo que
 * devuelve la re-comprobación R-1 dentro de la tx: [fila del estado FOR UPDATE, count de la fase].
 */
function txQueCaptura(relectura: unknown[][] = [[{ estado: EstadoImpuesto.SOLICITADO }], [{ n: 0 }]]) {
  const escrituras: Escritura[] = [];
  const ids: Record<string, string> = { [T_SOPORTES]: 'sop-1', [T_REVISIONES]: 'rev-1' };
  const conTabla = (op: Escritura['op']) => (tbl: unknown) => {
    const tabla = getTableName(tbl as never);
    const c = chain([{ id: ids[tabla] ?? `id-${tabla}` }]) as unknown as Record<string, unknown>;
    const captura = (v: Record<string, unknown>) => { escrituras.push({ op, tabla, datos: v }); return c; };
    c.values = captura; c.set = captura;
    return c;
  };
  const cola = [...relectura];
  const forUpdate = vi.fn();
  const select = vi.fn(() => {
    const c = chain(cola.shift() ?? []) as unknown as Record<string, unknown>;
    c.for = (modo: string) => { forUpdate(modo); return c; };
    return c;
  });
  const insert = vi.fn(conTabla('insert'));
  const update = vi.fn(conTabla('update'));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select, insert, update }));
  const en = (op: Escritura['op'], tabla: string) => escrituras.filter((e) => e.op === op && e.tabla === tabla);
  return { escrituras, en, forUpdate, select };
}

/** Lo único que se escribe en un resultado sin escritura es la auditoría del rechazo (si la hay). */
function soloAuditoria(veces: number) {
  expect(uploadMock).not.toHaveBeenCalled();
  expect(transactionMock).not.toHaveBeenCalled();
  expect(updateMock).not.toHaveBeenCalled();
  expect(insertMock).toHaveBeenCalledTimes(veces);
  for (const [tbl] of insertMock.mock.calls) expect(getTableName(tbl as never)).toBe(T_AUDIT);
}

// ═════════════════ AC1 · liquidación ════════════════════════════════════════════════════════════

describe('AC1 — fase liquidación sobre un solicitado → liquidado', () => {
  it('soporte sin marca, `liquidado_en` y valor liquidado escritos; estado intacto; sin revisión', async () => {
    const archivo = pdf('%PDF-liq');
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello: SIN_SELLO }));
    const tx = txQueCaptura();

    const r = await cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, archivo, ADMIN);

    expect(r).toEqual({ resultado: 'liquidado', soporteId: 'sop-1', valorLiquidado: '350000' });
    expect(tx.en('insert', T_SOPORTES)[0]!.datos).toMatchObject({ tipo: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, impuestoId: UUID, hash: sha(archivo) });
    const [u] = tx.en('update', T_IMPUESTOS);
    expect(u!.datos).toMatchObject({ valorLiquidado: '350000' });
    expect((u!.datos.liquidadoEn as Date).toISOString()).toBe(AHORA.toISOString());
    expect(u!.datos).not.toHaveProperty('estado');
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
  });

  it('valor dudoso → liquidado con valorLiquidado null y la columna NO entra en el set', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello: SIN_SELLO, valor: campo('350000', 0.4) }));
    const tx = txQueCaptura();
    const r = await cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, pdf('%PDF-liq2'), ADMIN);
    expect(r).toEqual({ resultado: 'liquidado', soporteId: 'sop-1', valorLiquidado: null });
    expect(tx.en('update', T_IMPUESTOS)[0]!.datos).not.toHaveProperty('valorLiquidado');
  });
});

// ═════════════════ AC2 · pago (y P-1) ═══════════════════════════════════════════════════════════

describe('AC2 — fase pago: pagado solo con el sello PAGADO leído con confianza', () => {
  it('sello PAGADO y valor confiables → pagado: soporte con marca, impuesto pagado con el valor', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura());
    const tx = txQueCaptura();

    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-pago'), ADMIN);

    expect(r).toEqual({ resultado: 'pagado', soporteId: 'sop-1', valorPagado: '350000', marcadoPorDiferencia: false });
    expect(tx.en('insert', T_SOPORTES)[0]!.datos).toMatchObject({ tipo: TipoSoporte.RECIBO_IMPUESTO });
    const [u] = tx.en('update', T_IMPUESTOS);
    expect(u!.datos).toMatchObject({ estado: EstadoImpuesto.PAGADO, valorPagado: '350000' });
    expect((u!.datos.pagadoEn as Date).toISOString()).toBe(AHORA.toISOString());
  });

  it('P-1 (decisión 2026-09-30) — sello PAGADO dudoso y valor confiable → en_revision, NO pagado', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello: campo('true', 0.5) }));
    const tx = txQueCaptura();

    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-dudoso'), ADMIN);

    expect(r).toEqual({ resultado: 'en_revision', soporteId: 'sop-1', revisionId: 'rev-1' });
    const [rev] = tx.en('insert', T_REVISIONES);
    expect(rev!.datos).toMatchObject({
      modulo: FlujoRevision.IMPUESTOS, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE, detalle: DETALLE_CARGA_POR_FASE.SELLO_DUDOSO,
      registroId: UUID, soporteId: 'sop-1', placaSugerida: 'QTQ100',
    });
    expect(tx.en('update', T_IMPUESTOS)).toHaveLength(0);
  });

  it('sello no leído (ausente) y valor confiable → en_revision', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello: null }));
    txQueCaptura();
    expect((await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-sinsello'), ADMIN)).resultado).toBe('en_revision');
  });

  it('sello confiable y valor dudoso → en_revision; el impuesto no se toca', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ valor: campo('350000', 0.6) }));
    const tx = txQueCaptura();
    expect((await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-valor'), ADMIN)).resultado).toBe('en_revision');
    expect(tx.en('update', T_IMPUESTOS)).toHaveLength(0);
  });

  it('evaluarPagoPorFase: la placa NO se exige; sí el valor y el sello', () => {
    expect(evaluarPagoPorFase(lectura({ placa: null }), 0.85)).toEqual({ aprobada: true });
    expect(evaluarPagoPorFase(lectura({ sello: campo('true', 0.84) }), 0.85)).toMatchObject({ aprobada: false, detalle: DETALLE_CARGA_POR_FASE.SELLO_DUDOSO });
    expect(evaluarPagoPorFase(lectura({ valor: null }), 0.85)).toMatchObject({ aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE });
  });
});

// ═════════════════ AC3 · fase que contradice el sello ═══════════════════════════════════════════

describe('AC3 — la fase contradice el sello → fase_no_coincide sin escribir', () => {
  it.each([
    [FaseRecibo.PAGO, SIN_SELLO, DETALLE_PAGO_SIN_SELLO],
    [FaseRecibo.LIQUIDACION, campo('true', 0.95), DETALLE_LIQUIDACION_CON_SELLO],
  ])('fase %s con sello leído en contra → fase_no_coincide; solo la auditoría del rechazo', async (fase, sello, detalle) => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello }));
    const r = await cargarReciboPorFase(UUID, fase, pdf(`%PDF-${fase}`), ADMIN);
    expect(r).toEqual({ resultado: 'fase_no_coincide', detalle });
    soloAuditoria(1);
  });
});

// ═════════════════ AC4 · duplicados ═════════════════════════════════════════════════════════════

describe('AC4 — duplicado: archivo idéntico, número de recibo repetido o fase ya cargada', () => {
  it('archivo idéntico (hash del original) → duplicado sin OCR ni escritura', async () => {
    escenario({ dup: [{ impuestoId: 'otro' }] });
    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-dup'), ADMIN);
    expect(r).toEqual({ resultado: 'duplicado', detalle: DETALLE_CARGA_POR_FASE.ARCHIVO_REPETIDO });
    expect(extraerMock).not.toHaveBeenCalled();
    soloAuditoria(0);
  });

  it.each([FaseRecibo.LIQUIDACION, FaseRecibo.PAGO])('la fase %s ya tiene comprobante vigente en este impuesto → duplicado ANTES del OCR (no se reemplaza)', async (fase) => {
    const wheres = escenario({ n: 1 });
    const r = await cargarReciboPorFase(UUID, fase, pdf('%PDF-ocupada'), ADMIN);
    expect(r.resultado).toBe('duplicado');
    expect((r as { detalle: string }).detalle).toMatch(/ya tiene su .* cargad[ao]; no se reemplaza/);
    expect(extraerMock).not.toHaveBeenCalled();
    soloAuditoria(0);
    // El mock ignora el filtro: se lee la condición del count (tipo de ESA fase + impuesto + no descartado).
    const conteo = wheres.map((c) => renderizar(c)).find((q) => /"flito_soportes"\."impuesto_id"/.test(q.sql));
    expect(conteo, 'no se encontró el conteo de la fase').toBeDefined();
    expect(ligadoA(conteo!, '"flito_soportes"."impuesto_id"')).toBe(UUID);
    expect(ligadoA(conteo!, '"flito_soportes"."tipo"')).toBe(fase === FaseRecibo.PAGO ? TipoSoporte.RECIBO_IMPUESTO : TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    expect(ligadoA(conteo!, '"flito_soportes"."descartado"')).toBe(false);
  });

  it('número de recibo ya registrado en otro impuesto → duplicado tras el OCR, sin escribir', async () => {
    escenario();
    selectMock.mockReturnValueOnce(chain([{ id: 'otro-impuesto' }]));
    extraerMock.mockResolvedValueOnce(lectura({ numero: campo('R-555', 0.95) }));
    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-num'), ADMIN);
    expect(r).toEqual({ resultado: 'duplicado', detalle: DETALLE_CARGA_POR_FASE.NUMERO_REPETIDO });
    soloAuditoria(0);
  });

  it('R-1 — otra carga ocupó la fase entre la comprobación y la escritura: la re-lectura FOR UPDATE da duplicado y no inserta soporte', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura());
    const tx = txQueCaptura([[{ estado: EstadoImpuesto.SOLICITADO }], [{ n: 1 }]]);
    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-carrera'), ADMIN);
    expect(r.resultado).toBe('duplicado');
    expect(tx.forUpdate).toHaveBeenCalledWith('update');
    expect(tx.escrituras).toHaveLength(0);
  });

  it('R-1 — el estado cambió dentro de la tx (otro pago lo dejó pagado) → duplicado sin escribir', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ sello: SIN_SELLO }));
    const tx = txQueCaptura([[{ estado: EstadoImpuesto.PAGADO }], [{ n: 0 }]]);
    expect((await cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, pdf('%PDF-carrera2'), ADMIN)).resultado).toBe('duplicado');
    expect(tx.escrituras).toHaveLength(0);
  });
});

// ═════════════════ AC5 · placa ══════════════════════════════════════════════════════════════════

describe('AC5 — placa distinta leída con confianza → placa_no_coincide; dudosa o no leída, manda el id', () => {
  it('placa confiable distinta → placa_no_coincide; el detalle no repite la placa; solo auditoría', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ placa: campo('ZZZ999', 0.95) }));
    const r = await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-otra'), ADMIN);
    expect(r).toEqual({ resultado: 'placa_no_coincide', detalle: DETALLE_CARGA_POR_FASE.PLACA_DISTINTA });
    expect(JSON.stringify(r)).not.toContain('ZZZ999');
    soloAuditoria(1);
  });

  it.each([
    ['dudosa y distinta', campo('ZZZ999', 0.5)],
    ['no leída', null],
  ])('placa %s → sigue con el id y escribe (pagado)', async (_n, placa) => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ placa }));
    txQueCaptura();
    expect((await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-dudosa'), ADMIN)).resultado).toBe('pagado');
  });

  it('la misma placa con guion/espacios se normaliza y NO se rechaza', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(lectura({ placa: campo('qtq 100', 0.95), sello: SIN_SELLO }));
    txQueCaptura();
    expect((await cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, pdf('%PDF-norm'), ADMIN)).resultado).toBe('liquidado');
  });
});

// ═════════════════ AC6/AC8 · frontera y estado ══════════════════════════════════════════════════

describe('AC6/AC8 — frontera (404) y estado (409); pagado sin esa fase = complemento', () => {
  it('fuera de la frontera o inexistente → 404 no_encontrado; nada consultado más allá del acceso', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...acceso(), dentroDeFrontera: false }]));
    await expect(cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-x'), ADMIN)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado' });
    selectMock.mockReturnValueOnce(chain([]));
    await expect(cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-x'), ADMIN)).rejects.toBeInstanceOf(CargaPorFaseError);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it.each([EstadoImpuesto.PENDIENTE, EstadoImpuesto.CON_NOVEDAD])('estado %s → 409 estado_no_permitido sin OCR', async (estado) => {
    selectMock.mockReturnValueOnce(chain([acceso({ estado })]));
    await expect(cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, pdf('%PDF-x'), ADMIN)).rejects.toMatchObject({ status: 409, codigo: 'estado_no_permitido' });
    expect(extraerMock).not.toHaveBeenCalled();
    soloAuditoria(0);
  });

  it('pagado sin liquidación cargada + fase liquidación → complemento; marca liquidado_en; el estado no cambia', async () => {
    escenario({ acceso: [acceso({ estado: EstadoImpuesto.PAGADO })], cand: [candidato({ estado: EstadoImpuesto.PAGADO })] });
    selectMock.mockReturnValueOnce(chain([{ n: 0 }])); // count de adjuntarAPagado
    extraerMock.mockResolvedValueOnce(lectura({ sello: SIN_SELLO }));
    const tx = txQueCaptura([[{ estado: EstadoImpuesto.PAGADO }], [{ n: 0 }]]);

    const r = await cargarReciboPorFase(UUID, FaseRecibo.LIQUIDACION, pdf('%PDF-compl'), ADMIN);

    expect(r).toEqual({ resultado: 'complemento', soporteId: 'sop-1' });
    expect(tx.en('insert', T_SOPORTES)[0]!.datos).toMatchObject({ tipo: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA });
    const [u] = tx.en('update', T_IMPUESTOS);
    expect(u!.datos).toHaveProperty('liquidadoEn');
    expect(u!.datos).not.toHaveProperty('estado');
    expect(String(tx.en('insert', T_AUDIT)[0]!.datos.detail)).toContain('Comprobante complementario');
  });

  it('pagado que YA tiene esa fase → duplicado (no complemento) antes del OCR', async () => {
    escenario({ acceso: [acceso({ estado: EstadoImpuesto.PAGADO })], n: 1 });
    expect((await cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-x'), ADMIN)).resultado).toBe('duplicado');
    expect(extraerMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC9 · compresión; OCR caído ══════════════════════════════════════════════════

describe('AC9 — se guarda lo comprimido (misma compresión que la masiva); hash y OCR sobre el original', () => {
  it('storage recibe el comprimido; soporte con sha256(original) y tamanoBytes del comprimido', async () => {
    const archivo = pdf('%PDF-original-grande');
    escenario();
    extraerMock.mockResolvedValueOnce(lectura());
    const buffer = Buffer.from('%PDF-comprimido');
    comprimirMock.mockResolvedValueOnce({ buffer, escalon: 1, bytesAntes: archivo.size, bytesDespues: buffer.length, motivo: 'MAS_LIVIANO' });
    const tx = txQueCaptura();

    await cargarReciboPorFase(UUID, FaseRecibo.PAGO, archivo, ADMIN);

    expect(comprimirMock).toHaveBeenCalledWith({ buffer: archivo.buffer, mimetype: 'application/pdf' });
    expect(extraerMock.mock.calls[0]![0]).toMatchObject({ contenido: archivo.buffer });
    expect(uploadMock.mock.calls[0]![3]).toBe(buffer);
    expect(tx.en('insert', T_SOPORTES)[0]!.datos).toMatchObject({ hash: sha(archivo), tamanoBytes: buffer.length });
  });

  it('OcrNoDisponibleError se propaga; sin storage ni transacción', async () => {
    escenario();
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'timeout'));
    await expect(cargarReciboPorFase(UUID, FaseRecibo.PAGO, pdf('%PDF-503'), ADMIN)).rejects.toBeInstanceOf(OcrNoDisponibleError);
    soloAuditoria(0);
  });
});
