// HU #12590 (Feature #12589) — regla de fases en la carga de recibos: la LIQUIDACIÓN DEL IMPUESTO
// (el documento de la hacienda sin marca) deja el impuesto `solicitado` con la marca `liquidado_en`
// y el `valorLiquidado`; el PAGO CON MARCA (el mismo documento con el sello PAGADO) es la única vía a
// `pagado`. La fase la declara quien carga; el OCR no la deduce.
//
// Se llama a `cargarRecibos` directo (como en flito-recibos.test.ts §HU #12053): lo que se mide es
// lo que el servicio ESCRIBE, capturado tabla a tabla. El `chain` de los helpers se traga los
// argumentos de `.values()` / `.set()`, así que sin la captura de abajo cada aserto sería un verde
// vacío (memoria: el mock chain inventa columnas).
//
// Mutantes que estas pruebas atrapan, nombrados:
//   · M1 — la liquidación llama a `conciliar` en vez de `marcarLiquidado`  → AC2 (estado/pagadoEn en el set)
//   · M2 — la liquidación no confiable llama a `aRevision`                → AC3 (insert con `modulo`)
//   · M3 — `evaluarDiferencia` comparada contra el propio valor pagado    → AC5 (420000 → true)
//   · M4 — sin el sort «liquidaciones primero»                           → AC4(c) (orden de escrituras)
//   · M5 — el literal viejo `'recibo_impuesto_sin_marca'`                → AC2 (tipo del soporte)

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { flitoImpuestos, flitoSoportes, flitoRevisiones, auditLogs, flitoEstadoHistorial } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_REVISIONES = getTableName(flitoRevisiones);
const T_AUDIT = getTableName(auditLogs);
const T_HISTORIAL = getTableName(flitoEstadoHistorial);

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/k.pdf');
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const ADMIN = { userId: 5, username: 'ops@flito.co', role: 'admin', organismos: [] as string[] };
const pdf = (nombre: string, contenido: string) => ({ originalname: nombre, mimetype: 'application/pdf', buffer: Buffer.from(contenido), size: contenido.length });

/** Candidato `solicitado` sin liquidación cargada, como lo devuelve `SELECT_CAND`. */
const candidato = (over: Record<string, unknown> = {}) => ({
  impuestoId: UUID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 'TR-1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: null, diferenciaActiva: false, tolerancia: '0',
  liquidadoEn: null,
  ...over,
});

/** `null` = el OCR no devolvió el campo (un `undefined` activaría el valor por defecto). */
const recibo = (valorTotal: ReturnType<typeof campo> | null = campo('634900', 0.95)) => ({
  [CampoImpuesto.PLACA]: campo('QTQ100', 0.95),
  ...(valorTotal ? { [CampoImpuesto.VALOR_TOTAL]: valorTotal } : {}),
  [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95),
});

interface Escritura { op: 'insert' | 'update'; tabla: string; datos: Record<string, unknown> }

/**
 * Transacción que CAPTURA lo que se escribe, con la tabla de cada escritura. Sin esto el aserto
 * «el set NO lleva `estado`» sería verde aunque la liquidación pagara.
 */
function txQueCaptura() {
  const escrituras: Escritura[] = [];
  const conTabla = (op: Escritura['op']) => (tbl: unknown) => {
    const c = chain([{ id: 'sop-1' }]) as unknown as Record<string, unknown>;
    const captura = (v: Record<string, unknown>) => { escrituras.push({ op, tabla: getTableName(tbl as never), datos: v }); return c; };
    c.values = captura; c.set = captura;
    return c;
  };
  const insert = vi.fn(conTabla('insert'));
  const update = vi.fn(conTabla('update'));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert, update }));
  const en = (op: Escritura['op'], tabla: string) => escrituras.filter((e) => e.op === op && e.tabla === tabla);
  /** El ÚNICO update sobre `flito_impuestos`; lanza si hubo cero o más de uno. */
  const setImpuesto = (): Record<string, unknown> => {
    const u = en('update', T_IMPUESTOS);
    expect(u, 'se esperaba exactamente un UPDATE sobre flito_impuestos').toHaveLength(1);
    return u[0]!.datos;
  };
  return { escrituras, insert, update, en, setImpuesto };
}

/** Secuencia de `selectMock` para UN suelto de admin: hash libre → candidato → sin nº repetido. */
function unSuelto(cand: Record<string, unknown> | null) {
  selectMock.mockReturnValueOnce(chain([]));                    // dedup por hash
  selectMock.mockReturnValueOnce(chain(cand ? [cand] : []));    // candidato SOLICITADO
  if (cand) selectMock.mockReturnValueOnce(chain([]));          // dedup por número de recibo
}

// ═════════════════ AC2 · liquidación confiable sobre un solicitado ═══════════════════════════════

describe('AC2 — la liquidación del impuesto marca `liquidado_en` y NO paga', () => {
  it('deja el impuesto solicitado con liquidadoEn + valorLiquidado; soporte sin marca; sin revisión (M1, M5)', async () => {
    unSuelto(candidato());
    extraerMock.mockResolvedValueOnce(recibo());
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.liquidados).toHaveLength(1);
    expect(res.conciliados).toHaveLength(0);
    expect(res.enRevision).toHaveLength(0);
    expect(res.noAsociados).toHaveLength(0);
    expect(res.liquidados[0]).toMatchObject({ placa: 'QTQ100', idFlit: 'FLIT-1', registroId: UUID });
    expect(res.liquidados[0]!.detalle).toContain('634900');

    // Lo que se escribió sobre el impuesto: la marca y el valor, y NADA del pago.
    const set = tx.setImpuesto();
    expect(set.liquidadoEn).toBeInstanceOf(Date);
    expect(set.valorLiquidado).toBe('634900');
    for (const clave of ['estado', 'pagadoEn', 'valorPagado', 'marcadoPorDiferencia', 'motivoRechazo', 'extraccion']) {
      expect(set, `el set de la liquidación no debe llevar \`${clave}\``).not.toHaveProperty(clave);
    }
    // Ninguna escritura, en ninguna tabla, movió el estado a pagado.
    expect(tx.escrituras.some((e) => e.datos.estado === EstadoImpuesto.PAGADO)).toBe(false);

    // El soporte se persiste con el literal del CATÁLOGO (M5): el ZIP de soportes lo busca así.
    const [soporte] = tx.en('insert', T_SOPORTES);
    expect(soporte!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    expect(soporte!.datos.tipo).toBe('recibo_impuesto_sin_marca_agua');
    expect(soporte!.datos.impuestoId).toBe(UUID);

    // Ni revisión ni transición: el historial dice de dónde vino y a dónde va, y son el mismo.
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
    expect(tx.escrituras.some((e) => 'modulo' in e.datos)).toBe(false);
    const [hist] = tx.en('insert', T_HISTORIAL);
    expect(hist!.datos).toMatchObject({ registroId: UUID, estadoAnterior: EstadoImpuesto.SOLICITADO, estadoNuevo: EstadoImpuesto.SOLICITADO, usuarioId: 5 });
    const [audit] = tx.en('insert', T_AUDIT);
    expect(audit!.datos).toMatchObject({ resource: 'flito_impuesto', resourceId: UUID, userId: 5 });
    expect(String(audit!.datos.detail)).toMatch(/liquidacion/i);
    expect(String(audit!.datos.detail)).toContain('634900');
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════ AC3 · liquidación con OCR dudoso o caído ══════════════════════════════════════

describe('AC3 — una liquidación con lectura dudosa NO va a revisión; el OCR caído cae por archivo', () => {
  it('valorTotal bajo el umbral → liquidadoEn sí, valorLiquidado NO (sin la clave), sin revisión (M2)', async () => {
    unSuelto(candidato({ valorLiquidado: '500000' }));
    extraerMock.mockResolvedValueOnce(recibo(campo('634900', 0.3)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-dudosa')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.liquidados).toHaveLength(1);
    expect(res.enRevision).toHaveLength(0);
    expect(res.liquidados[0]!.detalle).toMatch(/no se leyó con confianza/);
    const set = tx.setImpuesto();
    expect(set.liquidadoEn).toBeInstanceOf(Date);
    // La clave no entra en el set: se CONSERVA el valor anterior (500000), no se escribe null.
    expect('valorLiquidado' in set).toBe(false);
    expect(set).not.toHaveProperty('estado');
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
    expect(tx.escrituras.some((e) => 'modulo' in e.datos)).toBe(false);
    expect(tx.en('insert', T_SOPORTES)).toHaveLength(1);
  });

  it('valorTotal ausente → mismo trato: liquidadoEn sin valorLiquidado', async () => {
    unSuelto(candidato());
    extraerMock.mockResolvedValueOnce(recibo(null));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-sin-total')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.liquidados).toHaveLength(1);
    expect(res.enRevision).toHaveLength(0);
    const set = tx.setImpuesto();
    expect(set.liquidadoEn).toBeInstanceOf(Date);
    expect('valorLiquidado' in set).toBe(false);
  });

  it('placa ilegible → noAsociados (regla vigente), sin escribir nada', async () => {
    selectMock.mockReturnValueOnce(chain([])); // dedup por hash
    extraerMock.mockResolvedValueOnce({ [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95) });
    txQueCaptura();

    const res = await cargarRecibos([pdf('sin-placa.pdf', '%PDF-sin-placa')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.noAsociados).toHaveLength(1);
    expect(res.liquidados).toHaveLength(0);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('OcrNoDisponibleError → noAsociados con el mensaje y 200 del lote; sin transacción ni storage', async () => {
    selectMock.mockReturnValueOnce(chain([])); // dedup por hash
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'El servicio de OCR no está disponible.'));
    txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-ocr-caido')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.noAsociados).toHaveLength(1);
    expect(res.noAsociados[0]!.detalle).toBe('El servicio de OCR no está disponible.');
    expect(res.liquidados).toHaveLength(0);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC4 · el pago con marca, con y sin liquidación previa ═════════════════════════

describe('AC4 — el pago con marca es la única vía a pagado', () => {
  it('(a) pago sin liquidación previa → pagado, como siempre; liquidados vacío', async () => {
    unSuelto(candidato());
    extraerMock.mockResolvedValueOnce(recibo());
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-pago')], FaseRecibo.PAGO, ADMIN);

    expect(res.conciliados).toHaveLength(1);
    expect(res.liquidados).toHaveLength(0);
    const set = tx.setImpuesto();
    expect(set.estado).toBe(EstadoImpuesto.PAGADO);
    expect(set.pagadoEn).toBeInstanceOf(Date);
    expect(set.valorPagado).toBe('634900');
    const [soporte] = tx.en('insert', T_SOPORTES);
    expect(soporte!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO);
  });

  it('(b) pago posterior sobre un liquidado → paga y CONSERVA liquidadoEn y valorLiquidado', async () => {
    unSuelto(candidato({ liquidadoEn: new Date('2026-09-10T10:00:00Z'), valorLiquidado: '350000' }));
    extraerMock.mockResolvedValueOnce(recibo());
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-pago-tras-liq')], FaseRecibo.PAGO, ADMIN);

    expect(res.conciliados).toHaveLength(1);
    const set = tx.setImpuesto();
    expect(set.estado).toBe(EstadoImpuesto.PAGADO);
    expect(set).not.toHaveProperty('liquidadoEn');
    expect(set).not.toHaveProperty('valorLiquidado');
  });

  it('(c) mismo lote en orden inverso [pago, liquidación]: la liquidación se escribe PRIMERO y el pago la ve (M4)', async () => {
    // El lote llega con el pago delante. Tras el sort, la liquidación se procesa primero y escribe
    // valorLiquidado; `buscarCandidato` relee la BD por archivo, así que el pago recibe un candidato
    // FRESCO. Con mocks, eso es un segundo candidato consumido en orden.
    selectMock.mockReturnValueOnce(chain([]));                                                    // hash 1
    selectMock.mockReturnValueOnce(chain([]));                                                    // hash 2
    selectMock.mockReturnValueOnce(chain([candidato({ diferenciaActiva: true, tolerancia: '10000' })])); // liquidación: candidato sin valor
    selectMock.mockReturnValueOnce(chain([]));                                                    // liquidación: dedup nº
    selectMock.mockReturnValueOnce(chain([candidato({ diferenciaActiva: true, tolerancia: '10000', valorLiquidado: '350000', liquidadoEn: new Date() })])); // pago: candidato ya liquidado
    selectMock.mockReturnValueOnce(chain([]));                                                    // pago: dedup nº
    extraerMock.mockImplementation(async (doc: { nombreArchivo: string }) => (
      doc.nombreArchivo === 'liq.pdf'
        ? { ...recibo(campo('350000', 0.95)), [CampoImpuesto.NUMERO_RECIBO]: campo('L-1', 0.95) }
        : { ...recibo(campo('420000', 0.95)), [CampoImpuesto.NUMERO_RECIBO]: campo('P-1', 0.95) }
    ));
    const tx = txQueCaptura();

    const res = await cargarRecibos(
      [pdf('pago.pdf', '%PDF-pago'), pdf('liq.pdf', '%PDF-liq')],
      FaseRecibo.PAGO, ADMIN,
      ['CON MARCA/pago.pdf', 'SIN MARCA/liq.pdf'],
    );

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
    // Y el resumen cuenta el impuesto UNA vez, en conciliados, con la liquidación dentro del detalle.
    expect(res.conciliados).toHaveLength(1);
    expect(res.liquidados).toHaveLength(0);
    expect(res.conciliados[0]!.detalle).toContain('liq.pdf');
    // Los dos soportes, uno por fase.
    expect(tx.en('insert', T_SOPORTES).map((s) => s.datos.tipo).sort()).toEqual(
      [TipoSoporte.RECIBO_IMPUESTO, TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA].sort(),
    );
  });
});

// ═════════════════ AC5 · la diferencia de valor se evalúa contra valorLiquidado ══════════════════

describe('AC5 — el pago compara contra el valor liquidado que dejó la liquidación', () => {
  const liquidado = (valorLiquidado: string | null) => candidato({ diferenciaActiva: true, tolerancia: '10000', valorLiquidado, liquidadoEn: valorLiquidado ? new Date() : null });

  it('420000 pagado vs 350000 liquidado, tolerancia 10000 → marcadoPorDiferencia true (M3)', async () => {
    unSuelto(liquidado('350000'));
    extraerMock.mockResolvedValueOnce(recibo(campo('420000', 0.95)));
    const tx = txQueCaptura();
    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-420')], FaseRecibo.PAGO, ADMIN);
    expect(res.conciliados).toHaveLength(1);
    expect(tx.setImpuesto().marcadoPorDiferencia).toBe(true);
    const [audit] = tx.en('insert', T_AUDIT);
    expect(String(audit!.datos.detail)).toContain('liquidado 350000');
  });

  it('355000 pagado → dentro de la tolerancia, no marca', async () => {
    unSuelto(liquidado('350000'));
    extraerMock.mockResolvedValueOnce(recibo(campo('355000', 0.95)));
    const tx = txQueCaptura();
    await cargarRecibos([pdf('QTQ100.pdf', '%PDF-355')], FaseRecibo.PAGO, ADMIN);
    expect(tx.setImpuesto().marcadoPorDiferencia).toBe(false);
  });

  it('sin valorLiquidado → no marca, y paga igual', async () => {
    unSuelto(liquidado(null));
    extraerMock.mockResolvedValueOnce(recibo(campo('420000', 0.95)));
    const tx = txQueCaptura();
    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-sin-liq')], FaseRecibo.PAGO, ADMIN);
    expect(res.conciliados).toHaveLength(1);
    const set = tx.setImpuesto();
    expect(set.marcadoPorDiferencia).toBe(false);
    expect(set.estado).toBe(EstadoImpuesto.PAGADO);
  });
});

// ═════════════════ AC6 · liquidación sobre un impuesto ya pagado ═════════════════════════════════

describe('AC6 — una liquidación que llega después del pago es un complemento', () => {
  /** Sin candidato SOLICITADO; `adjuntarComplemento` encuentra el PAGADO y cuenta 0 copias iguales. */
  function sobrePagado(pagado: Record<string, unknown>) {
    selectMock.mockReturnValueOnce(chain([]));          // dedup por hash
    selectMock.mockReturnValueOnce(chain([]));          // candidato SOLICITADO: ninguno
    selectMock.mockReturnValueOnce(chain([pagado]));    // candidato PAGADO
    selectMock.mockReturnValueOnce(chain([{ n: 0 }]));  // ¿ya tiene esa copia? no
  }

  it('adjunta el soporte sin marca y deja liquidadoEn si estaba vacío; NO toca estado ni pago', async () => {
    sobrePagado(candidato({ estado: EstadoImpuesto.PAGADO, liquidadoEn: null, valorLiquidado: '350000' }));
    extraerMock.mockResolvedValueOnce(recibo(campo('360000', 0.95)));
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-tardia')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.complementos).toHaveLength(1);
    expect(res.liquidados).toHaveLength(0);
    expect(res.conciliados).toHaveLength(0);
    expect(res.complementos[0]!.detalle).toMatch(/liquidación del impuesto/);
    const [soporte] = tx.en('insert', T_SOPORTES);
    expect(soporte!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    const set = tx.setImpuesto();
    expect(set.liquidadoEn).toBeInstanceOf(Date);
    for (const clave of ['estado', 'valorPagado', 'marcadoPorDiferencia', 'valorLiquidado', 'pagadoEn']) {
      expect(set, `el complemento no debe escribir \`${clave}\``).not.toHaveProperty(clave);
    }
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
  });

  it('con liquidadoEn ya puesto no se reescribe: cero updates', async () => {
    sobrePagado(candidato({ estado: EstadoImpuesto.PAGADO, liquidadoEn: new Date('2026-09-01T00:00:00Z') }));
    extraerMock.mockResolvedValueOnce(recibo());
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-liq-repetida')], FaseRecibo.LIQUIDACION, ADMIN);

    expect(res.complementos).toHaveLength(1);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.en('insert', T_SOPORTES)).toHaveLength(1);
  });

  it('un pago con marca sobre un pagado sigue siendo complemento «con marca», sin tocar liquidadoEn', async () => {
    sobrePagado(candidato({ estado: EstadoImpuesto.PAGADO, liquidadoEn: null }));
    extraerMock.mockResolvedValueOnce(recibo());
    const tx = txQueCaptura();

    const res = await cargarRecibos([pdf('QTQ100.pdf', '%PDF-pago-repetido')], FaseRecibo.PAGO, ADMIN);

    expect(res.complementos).toHaveLength(1);
    expect(res.complementos[0]!.detalle).toMatch(/pago con marca/);
    const [soporte] = tx.en('insert', T_SOPORTES);
    expect(soporte!.datos.tipo).toBe(TipoSoporte.RECIBO_IMPUESTO);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
