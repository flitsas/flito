process.env.TZ = 'UTC';
// HU #12591 (Feature #12589) — recibo de caja puntual desde el detalle del impuesto: la segunda vía a
// `pagado`. Se llama a `cargarReciboCaja` directo (calco de flito-recibos.fases.test.ts) y se mide lo
// que el servicio ESCRIBE, tabla a tabla, con `txQueCaptura` (el `chain` se traga `.values()`/`.set()`).
//
// TZ=UTC en la primera línea: la fecha del recibo se ancla a medianoche de Bogotá (-05:00) y el aserto
// es el ISO exacto; sin fijar el huso el mutante del reloj sobrevive en -05 (memoria).
//
// Mutantes del AC8 que estas pruebas atrapan, nombrados:
//   · M-A — quitar la guarda `liquidadoEn === null → 409 sin_liquidacion`  → «AC3 — sin liquidación»
//   · M-B — en la rama no confiable llamar a `conciliar` en vez de `aRevision` → «AC5 — no confiable → revisión»
//   · M-E — `conciliar` sin `evaluarDiferencia`                              → «AC4 — 420000 vs 350000 → true»
//   · extra — reutilizar `conciliar` con `new Date()` fijo                   → «AC4 — pagadoEn = fecha del recibo»

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, type SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { ligadoA, ligadosA, renderizar } from '../helpers/sql-ligado.js';
import {
  CampoImpuesto, EstadoImpuesto, ESTADO_IMPUESTO_LABEL, FlujoRevision, MotivoRevision, ORDEN_TIPOS_SOPORTE_ZIP,
  TipoSoporte, TipoSoporteZip,
} from '@operaciones/shared-types';

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
  return { ...real, extraerReciboCaja: extraerMock };
});
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const { cargarReciboCaja, evaluarReciboCaja, ReciboCajaError } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { flitoImpuestos, flitoSoportes, flitoRevisiones, auditLogs, flitoEstadoHistorial } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_REVISIONES = getTableName(flitoRevisiones);
const T_AUDIT = getTableName(auditLogs);
const T_HISTORIAL = getTableName(flitoEstadoHistorial);

const AHORA = new Date('2026-09-16T15:00:00Z');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/caja.pdf');
  // Solo `Date`: los timers reales siguen (el servicio no los usa y las promesas no se congelan).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
});
afterEach(() => { vi.useRealTimers(); });

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const ADMIN = { userId: 5, username: 'ops@flito.co', role: 'admin', organismos: [] as string[] };
const LIQUIDADO_EN = new Date('2026-09-01T00:00:00Z');
const pdf = (nombre: string, contenido: string) => ({ originalname: nombre, mimetype: 'application/pdf', buffer: Buffer.from(contenido), size: contenido.length });
const sha = (a: { buffer: Buffer }) => createHash('sha256').update(a.buffer).digest('hex');

/** La fila que devuelve `buscarConAcceso` (select 1): `{ imp, dentroDeFrontera }`. */
const acceso = (over: Record<string, unknown> = {}) => ({
  imp: { id: UUID, tramiteId: 'TR-1', estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', gestionOperaciones: false, liquidadoEn: LIQUIDADO_EN, ...over },
  dentroDeFrontera: true,
});

/** El `Candidato` de `SELECT_CAND` (select 3). */
const candidato = (over: Record<string, unknown> = {}) => ({
  impuestoId: UUID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 'TR-1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: '350000', diferenciaActiva: false, tolerancia: '0',
  liquidadoEn: LIQUIDADO_EN,
  ...over,
});

/** Lectura del recibo de caja: valor + fecha + número, SIN placa. `null` = el OCR no devolvió el campo. */
const reciboCaja = (valorTotal: ReturnType<typeof campo> | null = campo('350000', 0.95), fechaPago: ReturnType<typeof campo> = campo('2026-09-10', 0.95)) => ({
  ...(valorTotal ? { [CampoImpuesto.VALOR_TOTAL]: valorTotal } : {}),
  [CampoImpuesto.FECHA_PAGO]: fechaPago,
  [CampoImpuesto.NUMERO_RECIBO]: campo('RC-778', 0.95),
});

/** Chain que además guarda el argumento de `.where()`: el mock ignora el filtro (memoria). */
function chainConWhere(rows: unknown[], sink: SQL[]) {
  const c = chain(rows) as unknown as Record<string, unknown>;
  c.where = (cond: SQL) => { sink.push(cond); return c; };
  return c;
}

/** Secuencia de `selectMock` para admin: acceso → hash → candidato. `abrirLote` no consulta para admin. */
function escenario(opts: { acceso?: unknown[]; dup?: unknown[]; cand?: unknown[]; wheres?: SQL[] } = {}) {
  const wheres = opts.wheres ?? [];
  selectMock.mockReturnValueOnce(chainConWhere(opts.acceso ?? [acceso()], wheres));  // buscarConAcceso
  selectMock.mockReturnValueOnce(chainConWhere(opts.dup ?? [], wheres));             // hashReciboYaCargado
  selectMock.mockReturnValueOnce(chainConWhere(opts.cand ?? [candidato()], wheres)); // candidatoPorId
  return wheres;
}

interface Escritura { op: 'insert' | 'update'; tabla: string; datos: Record<string, unknown> }

/**
 * Transacción que CAPTURA lo que se escribe, con la tabla de cada escritura, y devuelve un id
 * DISTINTO por tabla: sin eso el aserto `revisionId === 'rev-1'` sería verde con el id del soporte.
 */
function txQueCaptura() {
  const escrituras: Escritura[] = [];
  const ids: Record<string, string> = { [T_SOPORTES]: 'sop-1', [T_REVISIONES]: 'rev-1' };
  const conTabla = (op: Escritura['op']) => (tbl: unknown) => {
    const tabla = getTableName(tbl as never);
    const c = chain([{ id: ids[tabla] ?? `id-${tabla}` }]) as unknown as Record<string, unknown>;
    const captura = (v: Record<string, unknown>) => { escrituras.push({ op, tabla, datos: v }); return c; };
    c.values = captura; c.set = captura;
    return c;
  };
  const insert = vi.fn(conTabla('insert'));
  const update = vi.fn(conTabla('update'));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert, update }));
  const en = (op: Escritura['op'], tabla: string) => escrituras.filter((e) => e.op === op && e.tabla === tabla);
  const setImpuesto = (): Record<string, unknown> => {
    const u = en('update', T_IMPUESTOS);
    expect(u, 'se esperaba exactamente un UPDATE sobre flito_impuestos').toHaveLength(1);
    return u[0]!.datos;
  };
  return { escrituras, insert, update, en, setImpuesto };
}

function nadaEscrito() {
  expect(extraerMock).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(transactionMock).not.toHaveBeenCalled();
  expect(insertMock).not.toHaveBeenCalled();
  expect(updateMock).not.toHaveBeenCalled();
}

// ═════════════════ AC3 · precondiciones ═════════════════════════════════════════════════════════

describe('AC3 — precondiciones: liquidación cargada y en gestión', () => {
  it('sin liquidación → 409 sin_liquidacion con el mensaje literal; nada escrito y el OCR NO se llama (M-A)', async () => {
    selectMock.mockReturnValueOnce(chain([acceso({ liquidadoEn: null })]));
    extraerMock.mockResolvedValue(reciboCaja());
    txQueCaptura();

    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-1'), ADMIN)).rejects.toMatchObject({
      status: 409, codigo: 'sin_liquidacion',
      message: 'Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación',
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
    nadaEscrito();
  });

  it.each([EstadoImpuesto.PAGADO, EstadoImpuesto.PENDIENTE, EstadoImpuesto.CON_NOVEDAD])(
    'con liquidación pero en %s → 409 estado_no_permitido con el estado actual en el mensaje', async (estado) => {
      selectMock.mockReturnValueOnce(chain([acceso({ estado })]));
      extraerMock.mockResolvedValue(reciboCaja());

      const err = await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-1'), ADMIN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReciboCajaError);
      expect(err).toMatchObject({ status: 409, codigo: 'estado_no_permitido' });
      expect((err as Error).message).toContain(`"${ESTADO_IMPUESTO_LABEL[estado]}"`);
      nadaEscrito();
    },
  );

  it('id inexistente, fuera de la frontera o sin candidato → 404 no_encontrado', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-1'), ADMIN)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado', message: 'El impuesto no existe' });

    selectMock.mockReturnValueOnce(chain([{ ...acceso(), dentroDeFrontera: false }]));
    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-1'), ADMIN)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado' });

    escenario({ cand: [] });
    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-1'), ADMIN)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado' });
    nadaEscrito();
  });
});

// ═════════════════ AC6 · duplicado por hash ═════════════════════════════════════════════════════

describe('AC6 — el mismo archivo ya cargado (de este impuesto o de otro) → 409 duplicado', () => {
  it.each([UUID, '00000000-0000-0000-0000-0000000000ee'])('duplicado en el impuesto %s: sin OCR, sin storage, sin tx', async (impuestoId) => {
    escenario({ dup: [{ impuestoId }] });
    extraerMock.mockResolvedValue(reciboCaja());

    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-dup'), ADMIN)).rejects.toMatchObject({
      status: 409, codigo: 'duplicado', message: 'Ese recibo ya está registrado: el archivo es idéntico a uno cargado antes.',
    });
    expect(selectMock).toHaveBeenCalledTimes(2);
    nadaEscrito();
  });

  it('la consulta de dedup liga el sha256 del buffer, `descartado = false` y los TRES tipos (leído del SQL; el mock ignora el where)', async () => {
    const archivo = pdf('caja.pdf', '%PDF-hash');
    const wheres = escenario();
    extraerMock.mockResolvedValue(reciboCaja());
    txQueCaptura();

    await cargarReciboCaja(UUID, archivo, ADMIN);

    const consultas = wheres.map((c) => renderizar(c));
    const dedup = consultas.find((q) => /"flito_soportes"\."hash"/.test(q.sql));
    expect(dedup, 'no se encontró la consulta de dedup por hash').toBeDefined();
    expect(ligadoA(dedup!, '"flito_soportes"."hash"')).toBe(sha(archivo));
    expect(ligadoA(dedup!, '"flito_soportes"."descartado"')).toBe(false);
    expect(ligadosA(dedup!, '"flito_soportes"."tipo"').sort()).toEqual(
      [TipoSoporte.RECIBO_IMPUESTO, TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, TipoSoporte.RECIBO_CAJA_IMPUESTO].sort(),
    );
  });
});

// ═════════════════ AC4 · valor confiable → pagado ═══════════════════════════════════════════════

describe('AC4 — valor confiable: soporte recibo_caja_impuesto + impuesto pagado', () => {
  it('pagadoEn = fecha del recibo (medianoche Bogotá), NO el reloj; valorPagado; auditoría e historial; sin revisión', async () => {
    const archivo = pdf('caja.pdf', '%PDF-ok');
    escenario();
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('350000', 0.95), campo('2026-09-10', 0.95)));
    const tx = txQueCaptura();

    const r = await cargarReciboCaja(UUID, archivo, ADMIN);

    expect(r).toEqual({ resultado: 'pagado', valorPagado: '350000', pagadoEn: '2026-09-10T05:00:00.000Z', marcadoPorDiferencia: false, soporteId: 'sop-1' });
    expect(extraerMock).toHaveBeenCalledTimes(1);
    expect(extraerMock).toHaveBeenCalledWith({ nombreArchivo: 'caja.pdf', contentType: 'application/pdf', contenido: archivo.buffer, umbral: 0.85 });
    expect(uploadMock).toHaveBeenCalledTimes(1);

    const [soporte] = tx.en('insert', T_SOPORTES);
    expect(soporte!.datos).toMatchObject({ tipo: TipoSoporte.RECIBO_CAJA_IMPUESTO, impuestoId: UUID, hash: sha(archivo), subidoPorId: 5, nombreArchivo: 'caja.pdf' });
    expect(soporte!.datos.tipo).toBe('recibo_caja_impuesto');

    const set = tx.setImpuesto();
    expect(set).toMatchObject({ estado: EstadoImpuesto.PAGADO, valorPagado: '350000', marcadoPorDiferencia: false, motivoRechazo: null });
    expect((set.pagadoEn as Date).toISOString()).toBe('2026-09-10T05:00:00.000Z');
    expect((set.pagadoEn as Date).toISOString()).not.toBe(AHORA.toISOString());

    const [audit] = tx.en('insert', T_AUDIT);
    expect(audit!.datos).toMatchObject({ userId: 5, resourceId: UUID });
    expect(String(audit!.datos.detail)).toContain('350000');
    const [hist] = tx.en('insert', T_HISTORIAL);
    expect(hist!.datos).toMatchObject({ estadoAnterior: EstadoImpuesto.SOLICITADO, estadoNuevo: EstadoImpuesto.PAGADO });
    expect(tx.en('insert', T_REVISIONES)).toHaveLength(0);
  });

  it.each([
    ['null', campo(null, 0)],
    ['confianza 0.3', campo('2026-09-10', 0.3)],
  ])('fecha del recibo %s pero valor confiable → pagado con pagadoEn = fecha de carga', async (_n, fechaPago) => {
    escenario();
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('350000', 0.95), fechaPago));
    const tx = txQueCaptura();

    const r = await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-sinfecha'), ADMIN);

    expect(r.resultado).toBe('pagado');
    expect((tx.setImpuesto().pagadoEn as Date).toISOString()).toBe('2026-09-16T15:00:00.000Z');
    expect(r).toMatchObject({ pagadoEn: '2026-09-16T15:00:00.000Z' });
  });

  it('420000 vs liquidado 350000, tolerancia 10000 y diferencia activa → marcadoPorDiferencia true y AUN ASÍ pagado (M-E); inactiva → false', async () => {
    escenario({ cand: [candidato({ diferenciaActiva: true, valorLiquidado: '350000', tolerancia: '10000' })] });
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('420000', 0.95)));
    const tx = txQueCaptura();
    const r = await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-dif'), ADMIN);
    expect(r).toMatchObject({ resultado: 'pagado', valorPagado: '420000', marcadoPorDiferencia: true });
    expect(tx.setImpuesto()).toMatchObject({ estado: EstadoImpuesto.PAGADO, marcadoPorDiferencia: true });
    expect(String(tx.en('insert', T_AUDIT)[0]!.datos.detail)).toContain('MARCADO por diferencia');

    escenario({ cand: [candidato({ diferenciaActiva: false, valorLiquidado: '350000', tolerancia: '10000' })] });
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('420000', 0.95)));
    const tx2 = txQueCaptura();
    const r2 = await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-dif2'), ADMIN);
    expect(r2).toMatchObject({ resultado: 'pagado', marcadoPorDiferencia: false });
    expect(tx2.setImpuesto().marcadoPorDiferencia).toBe(false);
  });

  it('el umbral es el de Operaciones: 0.85 exacto es confiable y 0.84 no', async () => {
    escenario();
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('350000', 0.85)));
    txQueCaptura();
    expect((await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-85'), ADMIN)).resultado).toBe('pagado');

    escenario();
    extraerMock.mockResolvedValueOnce(reciboCaja(campo('350000', 0.84)));
    txQueCaptura();
    expect((await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-84'), ADMIN)).resultado).toBe('en_revision');
  });
});

// ═════════════════ AC5 · no confiable → revisión; OCR caído → 503 ═══════════════════════════════

describe('AC5 — no confiable → revisión; OCR no disponible → 503 sin escribir', () => {
  it.each([
    ['confianza 0.5', campo('350000', 0.5)],
    ['ausente', null],
  ])('valor %s → soporte guardado, fila en flito_revisiones ligada al impuesto y al soporte, impuesto intacto (M-B)', async (_n, valorTotal) => {
    escenario();
    extraerMock.mockResolvedValueOnce(reciboCaja(valorTotal));
    const tx = txQueCaptura();

    const r = await cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-dudoso'), ADMIN);

    expect(r).toEqual({ resultado: 'en_revision', soporteId: 'sop-1', revisionId: 'rev-1' });
    expect(tx.en('insert', T_SOPORTES)[0]!.datos).toMatchObject({ tipo: TipoSoporte.RECIBO_CAJA_IMPUESTO, impuestoId: UUID });
    const [rev] = tx.en('insert', T_REVISIONES);
    expect(rev!.datos).toMatchObject({
      modulo: FlujoRevision.IMPUESTOS, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE, registroId: UUID, soporteId: 'sop-1',
      placaSugerida: 'QTQ100', resuelto: false,
    });
    expect(rev!.datos.extraccion).toHaveProperty(CampoImpuesto.FECHA_PAGO);
    expect(tx.en('update', T_IMPUESTOS)).toHaveLength(0);
    expect(tx.escrituras.some((e) => e.datos.estado === EstadoImpuesto.PAGADO)).toBe(false);
    expect(tx.en('insert', T_HISTORIAL)).toHaveLength(0);
  });

  it('OcrNoDisponibleError → rechaza con esa instancia; sin soporte, sin storage, sin tx (reintentable)', async () => {
    escenario();
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'timeout'));
    txQueCaptura();

    await expect(cargarReciboCaja(UUID, pdf('caja.pdf', '%PDF-503'), ADMIN)).rejects.toBeInstanceOf(OcrNoDisponibleError);
    expect(extraerMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ Veredicto puro y catálogos (AC7/AC8) ═════════════════════════════════════════

describe('evaluarReciboCaja — solo el valor decide; la placa no se exige', () => {
  it('valor confiable sin placa → aprobada; valor nulo o bajo el umbral → CONFIANZA_INSUFICIENTE', () => {
    expect(evaluarReciboCaja(reciboCaja(campo('350000', 0.95)), 0.85)).toEqual({ aprobada: true });
    expect(evaluarReciboCaja(reciboCaja(campo(null, 0)), 0.85)).toMatchObject({ aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE });
    expect(evaluarReciboCaja(reciboCaja(campo('350000', 0.6)), 0.85)).toMatchObject({ aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE });
    expect(evaluarReciboCaja({}, 0.85)).toMatchObject({ aprobada: false });
  });
});

describe('AC7/AC8 — el tipo nuevo vive en el catálogo y NO entra en el ZIP masivo', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const fuente = (rel: string) => readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');

  it('TipoSoporte.RECIBO_CAJA_IMPUESTO === "recibo_caja_impuesto" y el servicio usa la constante, no un literal suelto', () => {
    expect(TipoSoporte.RECIBO_CAJA_IMPUESTO).toBe('recibo_caja_impuesto');
    const servicio = fuente('modules/flito-impuestos/flito-recibos.service.ts');
    expect(servicio).not.toMatch(/['"]recibo_caja_impuesto['"]/);
    expect(servicio).toContain('TipoSoporte.RECIBO_CAJA_IMPUESTO');
  });

  it('TipoSoporteZip y ORDEN_TIPOS_SOPORTE_ZIP no lo contienen; soportes-zip.ts no lo referencia', () => {
    expect(Object.values(TipoSoporteZip)).toEqual(['factura_venta', 'recibo_impuesto', 'factura_soat']);
    expect(ORDEN_TIPOS_SOPORTE_ZIP).toHaveLength(3);
    expect(ORDEN_TIPOS_SOPORTE_ZIP as readonly string[]).not.toContain('recibo_caja_impuesto');
    const zip = fuente('shared/soportes/soportes-zip.ts');
    expect(zip).not.toMatch(/RECIBO_CAJA|recibo_caja/);
  });
});
