// HU #12614 (Feature #12589) — el sello PAGADO vigila la fase declarada y resuelve la placa repetida
// en el lote. Integración vía `cargarRecibos` (calco de flito-recibos.fases.test.ts): se mide lo que
// el servicio ESCRIBE (o no escribe), tabla a tabla, porque el `chain` de los helpers se traga los
// argumentos de `.values()` / `.set()`.
//
// El rechazo por fase se audita con `db.insert` (no hay transacción: no se escribió nada más), así
// que `insertMock` de nivel módulo también captura; sin eso devolvería `undefined`, `.values()`
// reventaría y el archivo caería a `noAsociados` por la razón equivocada.
//
// Mutantes del AC7 que caen aquí, nombrados:
//   · M1 — sin la vigilancia (un pago sin sello concilia)                     → AC2
//   · M2 — ante la duda se rechaza o se manda a revisión                      → AC4 (0.6 / null)
//   · M3 — la placa repetida no se resuelve por el sello                      → AC5 (i)
//   · «vigilar con `lote.porDefecto` en vez del umbral del organismo»        → AC4 gestor

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { CampoImpuesto, EstadoImpuesto, FaseRecibo, TipoSoporte } from '@operaciones/shared-types';

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

const { cargarRecibos } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { flitoImpuestos, flitoSoportes, flitoRevisiones, auditLogs } = await import('../../src/db/schema.js');
const { umbralPara } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_REVISIONES = getTableName(flitoRevisiones);
const T_AUDIT = getTableName(auditLogs);

interface Escritura { op: 'insert' | 'update'; tabla: string; datos: Record<string, unknown> }
/** Lo escrito con `db.insert` FUERA de transacción: la auditoría del rechazo. */
let fueraDeTx: Escritura[] = [];

function conTabla(op: Escritura['op'], destino: Escritura[]) {
  return (tbl: unknown) => {
    const c = chain([{ id: 'sop-1' }]) as unknown as Record<string, unknown>;
    const captura = (v: Record<string, unknown>) => { destino.push({ op, tabla: getTableName(tbl as never), datos: v }); return c; };
    c.values = captura; c.set = captura;
    return c;
  };
}

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/k.pdf');
  fueraDeTx = [];
  insertMock.mockImplementation(conTabla('insert', fueraDeTx));
});

const POR_DEFECTO = umbralPara(null);
const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= POR_DEFECTO });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const UUID_2 = '00000000-0000-0000-0000-0000000000de';
const ADMIN = { userId: 5, username: 'ops@flito.co', role: 'admin', organismos: [] as string[] };
const pdf = (nombre: string, contenido: string) => ({ originalname: nombre, mimetype: 'application/pdf', buffer: Buffer.from(contenido), size: contenido.length });
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const candidato = (over: Record<string, unknown> = {}) => ({
  impuestoId: UUID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 'TR-1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: null, diferenciaActiva: false, tolerancia: '0',
  liquidadoEn: null,
  ...over,
});

/** Extracción con el sello dado (`undefined` = el OCR no devolvió la clave, como los stubs viejos). */
const recibo = (sello?: ReturnType<typeof campo>, over: Record<string, unknown> = {}) => ({
  [CampoImpuesto.PLACA]: campo('QTQ100', 0.95),
  [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95),
  [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95),
  ...(sello ? { [CampoImpuesto.SELLO_PAGADO]: sello } : {}),
  ...over,
});

function txQueCaptura() {
  const escrituras: Escritura[] = [];
  const insert = vi.fn(conTabla('insert', escrituras));
  const update = vi.fn(conTabla('update', escrituras));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert, update }));
  const en = (op: Escritura['op'], tabla: string) => escrituras.filter((e) => e.op === op && e.tabla === tabla);
  const setImpuesto = (): Record<string, unknown> => {
    const u = en('update', T_IMPUESTOS);
    expect(u, 'se esperaba exactamente un UPDATE sobre flito_impuestos').toHaveLength(1);
    return u[0]!.datos;
  };
  return { escrituras, insert, update, en, setImpuesto };
}

/** Secuencia de `selectMock` para UN suelto de admin: hash libre → candidato → sin nº repetido. */
function unSuelto(cand: Record<string, unknown> | null) {
  selectMock.mockReturnValueOnce(chain([]));
  selectMock.mockReturnValueOnce(chain(cand ? [cand] : []));
  if (cand) selectMock.mockReturnValueOnce(chain([]));
}

/** El rechazo no llega al dedup por nº de recibo: hash libre → candidato, y nada más. */
function unRechazado(cand: Record<string, unknown>) {
  selectMock.mockReturnValueOnce(chain([]));
  selectMock.mockReturnValueOnce(chain([cand]));
}

const auditsDb = () => fueraDeTx.filter((e) => e.op === 'insert' && e.tabla === T_AUDIT);

function nadaEscrito(tx: ReturnType<typeof txQueCaptura>) {
  expect(uploadMock).not.toHaveBeenCalled();
  expect(transactionMock).not.toHaveBeenCalled();
  expect(tx.escrituras).toHaveLength(0);
  // Fuera de la tx, lo ÚNICO escrito es la auditoría: ni soporte, ni revisión, ni impuesto.
  expect(fueraDeTx.filter((e) => e.tabla !== T_AUDIT)).toHaveLength(0);
  expect(updateMock).not.toHaveBeenCalled();
}

// ═════════════════ AC2 · pago sin sello ══════════════════════════════════════════════════════════

describe('AC2 — fase Pago sin sello PAGADO (confiable) NO paga: faseNoCoincide + auditoría', () => {
  it('rechaza antes de archivar y de abrir transacción; audita usuario, impuesto, fase y lectura (M1)', async () => {
    unRechazado(candidato());
    extraerMock.mockResolvedValueOnce(recibo(campo('false', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-como-pago')], FaseRecibo.PAGO, ADMIN);

    expect(res.faseNoCoincide).toHaveLength(1);
    expect(res.faseNoCoincide[0]).toMatchObject({ archivo: 'QTQ100.pdf', placa: 'QTQ100', idFlit: 'FLIT-1', registroId: UUID });
    expect(res.faseNoCoincide[0]!.detalle).toBe('No se ve el sello PAGADO; súbelo con la fase Liquidación.');
    for (const k of ['conciliados', 'enRevision', 'liquidados', 'duplicados', 'noAsociados', 'complementos'] as const) {
      expect(res[k], k).toHaveLength(0);
    }
    nadaEscrito(tx);
    // Ni una consulta de más: hash y candidato (los tests §12053 cuentan SELECTs por archivo).
    expect(selectMock).toHaveBeenCalledTimes(2);

    const [audit, ...resto] = auditsDb();
    expect(resto).toHaveLength(0);
    expect(audit!.datos).toMatchObject({ userId: 5, userEmail: 'ops@flito.co', resource: 'flito_impuesto', resourceId: UUID, action: 'update' });
    const detail = String(audit!.datos.detail);
    expect(detail).toMatch(/declarada pago/);
    expect(detail).toMatch(/sello PAGADO leído false con confianza 0\.95/);
    expect(detail).toContain('QTQ100.pdf');
    expect(detail).toContain('FLIT-1');
  });

  it('borde: confianza EXACTAMENTE igual al umbral por defecto también veta (≥, no >)', async () => {
    unRechazado(candidato());
    extraerMock.mockResolvedValueOnce(recibo(campo('false', POR_DEFECTO)));
    const tx = txQueCaptura();
    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-borde')], FaseRecibo.PAGO, ADMIN);
    expect(res.faseNoCoincide).toHaveLength(1);
    expect(res.conciliados).toHaveLength(0);
    nadaEscrito(tx);
  });

  it('sin candidato SOLICITADO (impuesto ya pagado) el complemento se adjunta como hoy: la vigilancia no aplica', async () => {
    selectMock.mockReturnValueOnce(chain([]));                                                       // hash
    selectMock.mockReturnValueOnce(chain([]));                                                       // SOLICITADO: ninguno
    selectMock.mockReturnValueOnce(chain([candidato({ estado: EstadoImpuesto.PAGADO, liquidadoEn: null })])); // PAGADO
    selectMock.mockReturnValueOnce(chain([{ n: 0 }]));                                               // ¿ya tiene esa copia? no
    extraerMock.mockResolvedValueOnce(recibo(campo('true', 0.95)));
    const tx = txQueCaptura();
    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-tardia')], FaseRecibo.LIQUIDACION, ADMIN);
    expect(res.complementos).toHaveLength(1);
    expect(res.faseNoCoincide).toHaveLength(0);
    expect(tx.en('insert', T_SOPORTES)).toHaveLength(1);
  });
});

// ═════════════════ AC3 · liquidación con sello ═══════════════════════════════════════════════════

describe('AC3 — fase Liquidación con sello PAGADO (confiable) NO se archiva como liquidación', () => {
  it('faseNoCoincide «súbelo con la fase Pago»; sin liquidadoEn, sin soporte, sin revisión', async () => {
    unRechazado(candidato());
    extraerMock.mockResolvedValueOnce(recibo(campo('true', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-pago-como-liq')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.faseNoCoincide).toHaveLength(1);
    expect(res.faseNoCoincide[0]).toMatchObject({ registroId: UUID, detalle: 'Tiene sello PAGADO; súbelo con la fase Pago.' });
    expect(res.liquidados).toHaveLength(0);
    nadaEscrito(tx);
    const [audit] = auditsDb();
    expect(String(audit!.datos.detail)).toMatch(/declarada liquidacion/);
    expect(String(audit!.datos.detail)).toMatch(/leído true/);
  });

  it('la vigilancia aplica igual a la fase DEDUCIDA de la carpeta (rutas del navegador, AC6)', async () => {
    unRechazado(candidato());
    extraerMock.mockResolvedValueOnce(recibo(campo('true', 0.95)));
    const tx = txQueCaptura();
    // Defecto pago, pero la carpeta dice liquidación y el documento trae sello.
    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-orig')], FaseRecibo.PAGO, ADMIN, ['liquidaciones_originales/QTQ100.pdf']);
    expect(res.faseNoCoincide).toHaveLength(1);
    expect(res.faseNoCoincide[0]!.detalle).toMatch(/Tiene sello PAGADO/);
    expect(res.carpetasSinFase).toEqual([]);
    nadaEscrito(tx);
  });
});

// ═════════════════ AC4 · ante la duda, la fase declarada ════════════════════════════════════════

describe('AC4 — sello ilegible o bajo el umbral: se respeta la fase declarada, sin revisión (M2)', () => {
  it.each([
    ['clave ausente (OCR viejo / stub)', undefined],
    ['valor null con confianza 0', campo(null, 0)],
    ["'false' con confianza 0.6", campo('false', 0.6)],
    ["'true' confiable (coincide)", campo('true', 0.95)],
  ])('fase Pago + %s → concilia como hoy', async (_n, sello) => {
    unSuelto(candidato());
    extraerMock.mockResolvedValueOnce(recibo(sello));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-pago')], FaseRecibo.PAGO, ADMIN);

    expect(res.conciliados).toHaveLength(1);
    expect(res.faseNoCoincide).toHaveLength(0);
    expect(res.enRevision).toHaveLength(0);
    const set = tx.setImpuesto();
    expect(set.estado).toBe(EstadoImpuesto.PAGADO);
    expect(set.pagadoEn).toBeInstanceOf(Date);
    expect(tx.en('insert', T_SOPORTES)[0]!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO);
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
    expect(tx.escrituras.some((e) => 'modulo' in e.datos)).toBe(false);
    expect(auditsDb()).toHaveLength(0);
  });

  it.each([
    ["'true' con confianza 0.6", campo('true', 0.6)],
    ['valor null', campo(null, 0)],
    ["'false' confiable (coincide)", campo('false', 0.95)],
  ])('fase Liquidación + %s → liquida como hoy', async (_n, sello) => {
    unSuelto(candidato());
    extraerMock.mockResolvedValueOnce(recibo(sello));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.liquidados).toHaveLength(1);
    expect(res.faseNoCoincide).toHaveLength(0);
    const set = tx.setImpuesto();
    expect(set.liquidadoEn).toBeInstanceOf(Date);
    expect(set.valorLiquidado).toBe('634900');
    expect(set).not.toHaveProperty('estado');
    expect(tx.en('insert', T_SOPORTES)[0]!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
  });

  describe('el umbral del sello es el del ORGANISMO del candidato (gestor), no el por defecto', () => {
    const ORG_LAXO = '05001';
    const ORG_ESTRICTO = '11001';
    const GESTOR = { userId: 5, username: 'gestor@flito.co', role: 'gestor_impuestos', organismos: [ORG_LAXO, ORG_ESTRICTO] };
    const umbralesDelLote = () => chain([{ codigo: ORG_LAXO, u: '0.600' }, { codigo: ORG_ESTRICTO, u: '0.950' }]);
    const reciboMedio = (sello: ReturnType<typeof campo>) => recibo(sello, {
      [CampoImpuesto.PLACA]: campo('QTQ100', 0.9), [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.9),
    });

    it('premisa: el umbral por defecto cae entre los dos organismos', () => {
      expect(POR_DEFECTO).toBeGreaterThan(0.6);
      expect(POR_DEFECTO).toBeLessThan(0.95);
    });

    it('organismo ESTRICTO (0.95): sello false 0.9 es DUDA → no rechaza; sigue el flujo (a revisión por placa/valor)', async () => {
      selectMock.mockReturnValueOnce(umbralesDelLote());                          // abrirLote
      selectMock.mockReturnValueOnce(chain([]));                                  // hash
      selectMock.mockReturnValueOnce(chain([candidato({ organismoCodigo: ORG_ESTRICTO })]));
      selectMock.mockReturnValueOnce(chain([]));                                  // dedup nº
      extraerMock.mockResolvedValueOnce(reciboMedio(campo('false', 0.9)));
      const tx = txQueCaptura();

      const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-estricto')], FaseRecibo.PAGO, GESTOR);

      // Con `lote.porDefecto` (0.85) el sello 0.9 sería confiable y esto sería un rechazo.
      expect(res.faseNoCoincide).toHaveLength(0);
      expect(res.enRevision).toHaveLength(1);
      expect(tx.en('insert', T_REVISIONES)).toHaveLength(1);
    });

    it('organismo LAXO (0.6): el MISMO sello false 0.9 sí es confiable → rechazo, nada escrito', async () => {
      selectMock.mockReturnValueOnce(umbralesDelLote());                          // abrirLote
      selectMock.mockReturnValueOnce(chain([]));                                  // hash
      selectMock.mockReturnValueOnce(chain([candidato({ organismoCodigo: ORG_LAXO })]));
      extraerMock.mockResolvedValueOnce(reciboMedio(campo('false', 0.9)));
      const tx = txQueCaptura();

      const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-laxo')], FaseRecibo.PAGO, GESTOR);

      expect(res.faseNoCoincide).toHaveLength(1);
      expect(res.enRevision).toHaveLength(0);
      nadaEscrito(tx);
      expect(String(auditsDb()[0]!.datos.detail)).toContain('umbral 0.6');
    });
  });
});

// ═════════════════ AC5 · la misma placa dos veces en el lote ═════════════════════════════════════

describe('AC5 — placa repetida en el lote con la misma fase: el sello reparte liquidación y pago', () => {
  const A = pdf('ABC123.pdf', '%PDF-a');
  const B = pdf('ABC123.pdf', '%PDF-b');
  const cand = (over: Record<string, unknown> = {}) => candidato({ placa: 'ABC123', diferenciaActiva: true, tolerancia: '10000', ...over });
  const lectura = (valorTotal: string, numero: string, sello: ReturnType<typeof campo> | undefined, placa = 'ABC123') => recibo(sello, {
    [CampoImpuesto.PLACA]: campo(placa, 0.95), [CampoImpuesto.VALOR_TOTAL]: campo(valorTotal, 0.95), [CampoImpuesto.NUMERO_RECIBO]: campo(numero, 0.95),
  });
  /** Los dos archivos se llaman igual: se discriminan por el CONTENIDO, no por el nombre. */
  const porContenido = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    extraerMock.mockImplementation(async (doc: { contenido: Buffer }) => (doc.contenido.toString() === '%PDF-a' ? a : b));
  /** hash×2 → liquidación: candidato sin liquidar + dedup nº → pago: candidato ya liquidado + dedup nº. */
  function parLiquidacionLuegoPago() {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([cand()]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([cand({ valorLiquidado: '350000', liquidadoEn: new Date() })]));
    selectMock.mockReturnValueOnce(chain([]));
  }
  function esUnParResuelto(res: Awaited<ReturnType<typeof cargarRecibos>>, tx: ReturnType<typeof txQueCaptura>) {
    const updates = tx.en('update', T_IMPUESTOS);
    expect(updates).toHaveLength(2);
    const iLiq = tx.escrituras.findIndex((e) => e.op === 'update' && 'liquidadoEn' in e.datos);
    const iPago = tx.escrituras.findIndex((e) => e.op === 'update' && e.datos.estado === EstadoImpuesto.PAGADO);
    expect(iLiq).toBeGreaterThanOrEqual(0);
    expect(iPago).toBeGreaterThanOrEqual(0);
    expect(iLiq, 'la liquidación tiene que escribirse ANTES que el pago').toBeLessThan(iPago);
    expect(updates[0]!.datos.valorLiquidado).toBe('350000');
    // El pago vio el valor liquidado fresco: 420000 vs 350000 supera la tolerancia de 10000.
    expect(updates[1]!.datos.marcadoPorDiferencia).toBe(true);
    expect(tx.en('insert', T_SOPORTES).map((s) => s.datos.tipo).sort()).toEqual(
      [TipoSoporte.RECIBO_IMPUESTO, TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA].sort(),
    );
    expect(res.conciliados).toHaveLength(1);
    expect(res.conciliados[0]!.detalle).toContain('Incluye la liquidación');
    expect(res.liquidados).toHaveLength(0);
    expect(res.faseNoCoincide).toHaveLength(0);
    expect(res.duplicados).toHaveLength(0);
    expect(res.noAsociados).toHaveLength(0);
    expect(auditsDb()).toHaveLength(0);
  }

  it.each([FaseRecibo.PAGO, FaseRecibo.LIQUIDACION])('(i) sin sello + con sello, declarada %s → liquidación primero y pago después (M3)', async (fase) => {
    parLiquidacionLuegoPago();
    porContenido(lectura('350000', 'L-1', campo('false', 0.95)), lectura('420000', 'P-1', campo('true', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([A, B], fase, ADMIN);

    esUnParResuelto(res, tx);
  });

  it('(i bis) el con sello llega PRIMERO en el lote → se reordena: liquidación antes que pago', async () => {
    parLiquidacionLuegoPago();
    porContenido(lectura('350000', 'L-1', campo('false', 0.95)), lectura('420000', 'P-1', campo('true', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([B, A], FaseRecibo.PAGO, ADMIN);

    esUnParResuelto(res, tx);
    // El soporte de la liquidación es el de A (sin sello), no el primero del lote.
    const liq = tx.en('insert', T_SOPORTES).find((s) => s.datos.tipo === TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    expect(liq!.datos.hash).toBe(sha256(A.buffer));
  });

  it.each([
    ['null', campo(null, 0)],
    ["'true' bajo el umbral", campo('true', 0.6)],
    ['clave ausente', undefined],
  ])('(ii) un sello %s en el par → los dos a faseNoCoincide «no se distingue», nada escrito, sin cruzar', async (_n, dudoso) => {
    selectMock.mockReturnValueOnce(chain([]));   // hash A
    selectMock.mockReturnValueOnce(chain([]));   // hash B
    selectMock.mockReturnValue(chain([cand()])); // por si algo cruzara: NO debe pasar
    porContenido(lectura('350000', 'L-1', campo('false', 0.95)), lectura('420000', 'P-1', dudoso));
    const tx = txQueCaptura();

    const res = await cargarRecibos([A, B], FaseRecibo.PAGO, ADMIN);

    expect(res.faseNoCoincide).toHaveLength(2);
    for (const r of res.faseNoCoincide) {
      expect(r).toMatchObject({ archivo: 'ABC123.pdf', placa: 'ABC123', idFlit: null, registroId: null });
      expect(r.detalle).toBe('Dos documentos de ABC123 y no se distingue cuál es el pago.');
    }
    for (const k of ['conciliados', 'enRevision', 'liquidados', 'duplicados', 'noAsociados', 'complementos'] as const) {
      expect(res[k], k).toHaveLength(0);
    }
    nadaEscrito(tx);
    expect(selectMock).toHaveBeenCalledTimes(2); // solo los dos hash: no se buscó candidato
    const audits = auditsDb();
    expect(audits).toHaveLength(2);
    expect(audits[0]!.datos).toMatchObject({ resource: 'flito_impuesto', resourceId: 'ABC123', userId: 5 });
    expect(String(audits[0]!.datos.detail)).toMatch(/repetida en el lote/);
  });

  it.each([
    ['true', FaseRecibo.LIQUIDACION, 'conciliados', TipoSoporte.RECIBO_IMPUESTO],
    ['false', FaseRecibo.PAGO, 'liquidados', TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA],
  ])("(iii) los dos con sello '%s' (declarada %s) → el primero con la fase del sello (%s), el segundo a duplicados", async (sello, fase, categoria, tipo) => {
    selectMock.mockReturnValueOnce(chain([]));         // hash A
    selectMock.mockReturnValueOnce(chain([]));         // hash B
    selectMock.mockReturnValueOnce(chain([cand()]));   // candidato del PRIMERO (el único que cruza)
    selectMock.mockReturnValueOnce(chain([]));         // dedup nº
    porContenido(lectura('350000', 'L-1', campo(sello, 0.95)), lectura('350000', 'L-2', campo(sello, 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([A, B], fase, ADMIN);

    expect(res[categoria as 'conciliados' | 'liquidados']).toHaveLength(1);
    expect(res.duplicados).toHaveLength(1);
    expect(res.duplicados[0]).toMatchObject({ archivo: 'ABC123.pdf', placa: 'ABC123', registroId: null });
    expect(res.duplicados[0]!.detalle).toMatch(/mismo sello/);
    expect(res.faseNoCoincide).toHaveLength(0);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const soportes = tx.en('insert', T_SOPORTES);
    expect(soportes).toHaveLength(1);
    expect(soportes[0]!.datos.tipo).toBe(tipo);
    expect(soportes[0]!.datos.hash).toBe(sha256(A.buffer));
    expect(selectMock).toHaveBeenCalledTimes(4); // el duplicado no cruza
  });

  it('(iv) agrupa por la placa LEÍDA: a.pdf y b.pdf con la misma placa son el par…', async () => {
    parLiquidacionLuegoPago();
    extraerMock.mockImplementation(async (doc: { nombreArchivo: string }) => (
      doc.nombreArchivo === 'a.pdf' ? lectura('350000', 'L-1', campo('false', 0.95)) : lectura('420000', 'P-1', campo('true', 0.95))
    ));
    const tx = txQueCaptura();
    const res = await cargarRecibos([pdf('a.pdf', '%PDF-a'), pdf('b.pdf', '%PDF-b')], FaseRecibo.PAGO, ADMIN);
    esUnParResuelto(res, tx);
  });

  it('(iv) …y dos ABC123.pdf con placas leídas distintas NO se agrupan: dos conciliados', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([cand()]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([cand({ impuestoId: UUID_2, placa: 'XYZ789' })]));
    selectMock.mockReturnValueOnce(chain([]));
    porContenido(lectura('350000', 'P-1', campo('true', 0.95)), lectura('420000', 'P-2', campo('true', 0.95), 'XYZ789'));
    txQueCaptura();

    const res = await cargarRecibos([A, B], FaseRecibo.PAGO, ADMIN);

    expect(res.conciliados).toHaveLength(2);
    expect(res.conciliados.map((c) => c.registroId).sort()).toEqual([UUID, UUID_2].sort());
    expect(res.duplicados).toHaveLength(0);
    expect(res.faseNoCoincide).toHaveLength(0);
  });

  it('(v) misma placa con fases declaradas DISTINTAS (carpetas) no se agrupa: cada uno sigue AC2–AC4', async () => {
    parLiquidacionLuegoPago();
    // La de liquidación viene con sello ilegible (AC4: se respeta), la de pago con sello.
    porContenido(lectura('350000', 'L-1', campo(null, 0)), lectura('420000', 'P-1', campo('true', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([A, B], FaseRecibo.PAGO, ADMIN, ['liquidaciones_originales/ABC123.pdf', 'liquidaciones_pagadas/ABC123.pdf']);

    esUnParResuelto(res, tx);
    expect(res.carpetasSinFase).toEqual([]);
  });
});
