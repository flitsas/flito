process.env.TZ = 'UTC';
// HU #13269 (Feature #13267) — `reemplazarComprobantePago`: el orden de decisión y la transacción.
// Se sustituyen las piezas que ya tienen spec propio (validación OCR/placa/sello → carga-por-fase,
// outbox → envio-flit2.reprogramar). Aquí se afirma CÓMO las encadena el reemplazo:
//   · descartar el viejo, insertar el nuevo y reprogramar el envío ocurren en la MISMA tx (identidad);
//   · en ese orden;
//   · un rechazo de validación, la falta de comprobante vigente o la carrera no escriben nada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { EstadoImpuesto, TipoSoporte } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
const imp = vi.hoisted(() => ({ buscarConAcceso: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => imp);
const envio = vi.hoisted(() => ({ reprogramarEnvioFlit2: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.js', () => envio);
const rec = vi.hoisted(() => ({
  archivar: vi.fn(), auditEnTx: vi.fn(), candidatoPorImpuestoId: vi.fn(), hashReciboYaCargado: vi.fn(),
  insertarSoporte: vi.fn(), validarComprobantePorId: vi.fn(),
}));
vi.mock('../../src/modules/flito-impuestos/flito-recibos.service.js', async (orig) => ({ ...(await orig() as object), ...rec }));

const { reemplazarComprobantePago, ReemplazoComprobanteError, MENSAJE_SIN_COMPROBANTE_VIGENTE } =
  await import('../../src/modules/flito-impuestos/flito-recibos.reemplazo.js');
const { DETALLE_CARGA_POR_FASE } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { flitoSoportes } = await import('../../src/db/schema.js');

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const CTX = { userId: 7, username: 'op@flitsas.io', role: 'admin', organismos: [] as string[] };
const PDF = { originalname: 'nuevo.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7 nuevo'), size: 14 };
const CAND = { impuestoId: ID, estado: EstadoImpuesto.PAGADO, tramiteIdFlit: 'FLIT-1', placa: 'QIU744', organismoCodigo: '05001' };
const GUARDADO = { storageKey: 'flito/impuestos/recibos/nuevo.pdf', tamanoBytes: 14 };

/** La `tx` del reemplazo: referencia propia, para compararla por identidad. Registra cada escritura. */
function txDelReemplazo(opts: { estado?: string; vigentes?: string[] } = {}) {
  const sets: unknown[] = [];
  const tx = {
    select: vi.fn()
      .mockReturnValueOnce(chain([{ estado: opts.estado ?? EstadoImpuesto.PAGADO }]))
      .mockReturnValueOnce(chain((opts.vigentes ?? ['sop-viejo']).map((id) => ({ id })))),
    update: vi.fn(() => {
      const c = chain([]) as unknown as { set: (v: unknown) => unknown };
      const set = c.set;
      c.set = (v: unknown) => { sets.push(v); return set(v); };
      return c;
    }),
    insert: vi.fn(() => chain([])),
  };
  transactionMock.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
  return { tx, sets };
}

/** Feliz hasta la transacción: pagado, con un vigente, hash libre y validación limpia. */
function armarFeliz() {
  imp.buscarConAcceso.mockResolvedValue({ id: ID, estado: EstadoImpuesto.PAGADO });
  selectMock.mockReturnValueOnce(chain([{ id: 'sop-viejo' }]));
  rec.hashReciboYaCargado.mockResolvedValue(null);
  rec.candidatoPorImpuestoId.mockResolvedValue(CAND);
  rec.validarComprobantePorId.mockResolvedValue({ rechazo: null, extraccion: {}, umbral: 0.85 });
  rec.archivar.mockResolvedValue(GUARDADO);
  rec.insertarSoporte.mockResolvedValue('sop-nuevo');
  rec.auditEnTx.mockResolvedValue(undefined);
  envio.reprogramarEnvioFlit2.mockResolvedValue({ reenviado: true });
}

function nadaEscrito() {
  expect(transactionMock).not.toHaveBeenCalled();
  expect(rec.archivar).not.toHaveBeenCalled();
  expect(rec.insertarSoporte).not.toHaveBeenCalled();
  expect(envio.reprogramarEnvioFlit2).not.toHaveBeenCalled();
}

beforeEach(() => {
  selectMock.mockReset(); transactionMock.mockReset(); imp.buscarConAcceso.mockReset();
  envio.reprogramarEnvioFlit2.mockReset();
  for (const f of Object.values(rec)) f.mockReset();
});

describe('AC1 — reemplazo: descarta, inserta y reprograma en UNA transacción', () => {
  it('el soporte viejo queda descartado=true con la tx del reemplazo, sobre su id', async () => {
    armarFeliz();
    const { tx, sets } = txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(getTableName(tx.update.mock.calls[0]![0] as never)).toBe(getTableName(flitoSoportes));
    expect(sets).toEqual([{ descartado: true }]);
  });

  it('el nuevo se inserta como recibo de pago con la MISMA tx, el hash del original y lo archivado', async () => {
    armarFeliz();
    const { tx } = txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    expect(rec.insertarSoporte).toHaveBeenCalledTimes(1);
    const [txInsert, impuestoId, archivo, tipo, ctx, guardado, hash] = rec.insertarSoporte.mock.calls[0]!;
    expect(txInsert).toBe(tx);
    expect([impuestoId, archivo, tipo, ctx, guardado]).toEqual([ID, PDF, TipoSoporte.RECIBO_IMPUESTO, CTX, GUARDADO]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.hashReciboYaCargado).toHaveBeenCalledWith(hash);
  });

  it('reprogramarEnvioFlit2 recibe la tx de la transacción (identidad), el impuesto, el soporte NUEVO y el actor', async () => {
    armarFeliz();
    const { tx } = txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    expect(envio.reprogramarEnvioFlit2).toHaveBeenCalledTimes(1);
    const [txEnvio, impuestoId, soporteId, ctx] = envio.reprogramarEnvioFlit2.mock.calls[0]!;
    expect(txEnvio).toBe(tx); // NO `db`: el outbox es atómico con el reemplazo
    expect([impuestoId, soporteId, ctx]).toEqual([ID, 'sop-nuevo', CTX]);
  });

  it('orden: descartar → insertar → auditar → reprogramar', async () => {
    armarFeliz();
    const { tx } = txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    const orden = [
      tx.update.mock.invocationCallOrder[0]!, rec.insertarSoporte.mock.invocationCallOrder[0]!,
      rec.auditEnTx.mock.invocationCallOrder[0]!, envio.reprogramarEnvioFlit2.mock.invocationCallOrder[0]!,
    ];
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it('audita en la tx: usuario (ctx), impuesto e ids de los soportes; sin nombre de archivo ni placa (AC7)', async () => {
    armarFeliz();
    const { tx } = txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    expect(rec.auditEnTx).toHaveBeenCalledTimes(1);
    const [escritor, ctx, resourceId, detail] = rec.auditEnTx.mock.calls[0]! as [unknown, unknown, string, string];
    expect(escritor).toBe(tx);
    expect(ctx).toBe(CTX);
    expect(resourceId).toBe(ID);
    expect(detail).toContain('sop-viejo');
    expect(detail).toContain('sop-nuevo');
    expect(detail).not.toContain('nuevo.pdf');
    expect(detail).not.toContain('QIU744');
  });

  it('responde reemplazado con el soporte nuevo, los descartados y lo que dijo el envío', async () => {
    armarFeliz();
    txDelReemplazo({ vigentes: ['sop-a', 'sop-b'] });
    const r = await reemplazarComprobantePago(ID, PDF, CTX);
    expect(r).toEqual({ resultado: 'reemplazado', soporteId: 'sop-nuevo', soportesDescartados: ['sop-a', 'sop-b'], envioFlit2: { reenviado: true } });
  });

  it('la validación es la de la carga por id, en fase PAGO y con el candidato del impuesto', async () => {
    armarFeliz();
    txDelReemplazo();
    await reemplazarComprobantePago(ID, PDF, CTX);
    expect(rec.validarComprobantePorId).toHaveBeenCalledWith(CAND, 'pago', PDF, CTX);
  });
});

describe('AC5 / AC6 — el reemplazo se hace en FLITO y se informa el envío sin reenviar', () => {
  it.each([
    ['ya_cargado_gestor (AC6)', { reenviado: false, motivo: 'ya_cargado_gestor' }],
    ['trámite que no es de FLIT 2 (AC5)', { reenviado: false, motivo: 'no_flit2' }],
  ])('%s → reemplazado y envioFlit2 tal cual', async (_n, envioFlit2) => {
    armarFeliz();
    envio.reprogramarEnvioFlit2.mockResolvedValue(envioFlit2);
    const { sets } = txDelReemplazo();
    const r = await reemplazarComprobantePago(ID, PDF, CTX);
    expect(sets).toEqual([{ descartado: true }]);
    expect(r).toMatchObject({ resultado: 'reemplazado', envioFlit2 });
  });
});

describe('AC3 — rechazo de validación: nada cambia, nada se envía', () => {
  it.each([
    ['placa_no_coincide', { resultado: 'placa_no_coincide', detalle: DETALLE_CARGA_POR_FASE.PLACA_DISTINTA }],
    ['fase_no_coincide', { resultado: 'fase_no_coincide', detalle: 'Tiene sello…' }],
    ['número repetido', { resultado: 'duplicado', detalle: DETALLE_CARGA_POR_FASE.NUMERO_REPETIDO }],
  ])('%s → devuelve el MISMO rechazo; sin tx, sin archivar, sin reprogramar', async (_n, rechazo) => {
    armarFeliz();
    rec.validarComprobantePorId.mockResolvedValue({ rechazo });
    const r = await reemplazarComprobantePago(ID, PDF, CTX);
    expect(r).toBe(rechazo);
    nadaEscrito();
  });

  it('archivo idéntico a uno ya cargado → duplicado ANTES del OCR; nada escrito', async () => {
    armarFeliz();
    rec.hashReciboYaCargado.mockResolvedValue('otro-impuesto');
    const r = await reemplazarComprobantePago(ID, PDF, CTX);
    expect(r).toEqual({ resultado: 'duplicado', detalle: DETALLE_CARGA_POR_FASE.ARCHIVO_REPETIDO });
    expect(rec.validarComprobantePorId).not.toHaveBeenCalled();
    nadaEscrito();
  });
});

describe('AC4 / estado / frontera — errores claros, sin efectos', () => {
  it('sin comprobante de pago vigente → 409 sin_comprobante_vigente que remite a la carga normal', async () => {
    armarFeliz();
    selectMock.mockReset();
    selectMock.mockReturnValueOnce(chain([]));
    const e = await reemplazarComprobantePago(ID, PDF, CTX).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReemplazoComprobanteError);
    expect(e).toMatchObject({ status: 409, codigo: 'sin_comprobante_vigente', message: MENSAJE_SIN_COMPROBANTE_VIGENTE });
    expect(MENSAJE_SIN_COMPROBANTE_VIGENTE).toMatch(/carga normal/);
    expect(rec.hashReciboYaCargado).not.toHaveBeenCalled();
    expect(rec.validarComprobantePorId).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it('impuesto no pagado → 409 estado_no_permitido; nada consultado de soportes', async () => {
    armarFeliz();
    imp.buscarConAcceso.mockResolvedValue({ id: ID, estado: EstadoImpuesto.SOLICITADO });
    await expect(reemplazarComprobantePago(ID, PDF, CTX)).rejects.toMatchObject({ status: 409, codigo: 'estado_no_permitido' });
    expect(selectMock).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it('fuera de frontera → 404 no_encontrado', async () => {
    armarFeliz();
    imp.buscarConAcceso.mockResolvedValue(null);
    await expect(reemplazarComprobantePago(ID, PDF, CTX)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado' });
    nadaEscrito();
  });

  it.each([
    ['otro reemplazo se llevó los vigentes', { vigentes: [] }],
    ['el impuesto dejó de estar pagado', { estado: EstadoImpuesto.SOLICITADO }],
  ])('carrera dentro de la tx (%s) → 409 sin_comprobante_vigente; ni descarta, ni inserta, ni reprograma', async (_n, opts) => {
    armarFeliz();
    const { tx } = txDelReemplazo(opts);
    await expect(reemplazarComprobantePago(ID, PDF, CTX)).rejects.toMatchObject({ status: 409, codigo: 'sin_comprobante_vigente' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(rec.insertarSoporte).not.toHaveBeenCalled();
    expect(envio.reprogramarEnvioFlit2).not.toHaveBeenCalled();
  });
});
