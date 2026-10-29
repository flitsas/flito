// HU #14115 (Feature C2 #14092, Épica #13758, ADR-0030 C2.2) — ciclo del viaje a cliente:
// despachar, entregar (parcial), devolver, anular, reversa. Alias de actas (AC8).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/firma.png'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js', () => ({
  generarActaPdf: vi.fn().mockResolvedValue('pdf-key'),
}));

const {
  despachar, despacharTraslado, entregarTraslado, devolverTraslado, anularTraslado, reversar,
} = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const {
  flitoLogisticaActaFirmas, flitoLogisticaActas, flitoLogisticaDocumentos,
  flitoLogisticaEventos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} = await import('../../src/db/schema.js');

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const D3 = '33333333-3333-4333-8333-333333333333';
const D4 = '44444444-4444-4444-8444-444444444444';
const D5 = '55555555-5555-4555-8555-555555555555';
const TR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRMA = 'iVBORw0KGgo=';
const CEDULA = '1036640908';

const ctxAdmin = { userId: 1, username: 'op', role: 'admin', operaAjenas: true };
const ctxMensajero = { userId: 9, username: 'msj', role: 'mensajero', operaAjenas: false };

type Insercion = { tabla: unknown; valores: unknown };
type SetOp = { tabla: unknown; valores: Record<string, unknown> };
let inserciones: Insercion[];
let sets: SetOp[];

function linea(documentoId: string, over: Record<string, unknown> = {}) {
  return { id: `lin-${documentoId.slice(0, 8)}`, documentoId, estado: 'registrado', precio: '18500.00', ...over };
}

function txCiclo(opts: {
  traslado?: Record<string, unknown>;
  acta?: Record<string, unknown>;
  lineas?: Array<Record<string, unknown>>;
  docs?: Array<Record<string, unknown>>;
  extraSelects?: unknown[][];
} = {}) {
  const lineas = opts.lineas ?? [linea(D1), linea(D2), linea(D3)];
  selectMock.mockReturnValueOnce(chain([{
    id: TR, destino: 'cliente', origen: 'organismo', estado: 'registrado', mensajeroId: 9, ...opts.traslado,
  }]));
  selectMock.mockReturnValueOnce(chain([{ id: ACTA, estado: 'generada', mensajeroId: 9, ...opts.acta }]));
  selectMock.mockReturnValueOnce(chain(lineas));
  selectMock.mockReturnValueOnce(chain(opts.docs ?? lineas.map((l) => ({ id: l.documentoId as string, estado: 'en_acta' }))));
  for (const filas of opts.extraSelects ?? []) selectMock.mockReturnValueOnce(chain(filas));
}

async function post(ruta: string, body: unknown, token: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  return request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`).send(body as object);
}

const admin = () => testToken({ role: 'admin', sub: 1 });
const mensajero = () => testToken({ role: 'mensajero', sub: 9 });

beforeEach(() => {
  selectMock.mockReset();
  inserciones = [];
  sets = [];
  insertMock.mockReset().mockImplementation((tabla: unknown) => ({
    values: (valores: unknown) => {
      inserciones.push({ tabla, valores });
      return chain([]);
    },
  }));
  updateMock.mockReset().mockImplementation((tabla: unknown) => ({
    set: (valores: Record<string, unknown>) => {
      sets.push({ tabla, valores });
      return chain([]);
    },
  }));
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({
    select: selectMock, insert: insertMock, update: updateMock,
  }));
});

function eventosDe(tipo: string) {
  return inserciones.filter((i) => i.tabla === flitoLogisticaEventos && (i.valores as { tipo?: string }).tipo === tipo);
}
function firmasDe(rol: string) {
  return inserciones.filter((i) => {
    const v = i.valores as { rol?: string };
    return i.tabla === flitoLogisticaActaFirmas && v.rol === rol;
  });
}

describe('AC1 — despachar viaje registrado: LT despachado, líneas y traslado en_ruta', () => {
  it('con mensajero y firma opcional de Operaciones (sin cédula)', async () => {
    txCiclo();
    const r = await despacharTraslado(TR, { mensajeroId: 9, firmaEntrega: FIRMA, entregaNombre: 'Operaciones' }, ctxAdmin);
    expect(r).toMatchObject({ documentos: 3, trasladoId: TR, estado: 'en_ruta' });
    expect(sets.find((s) => s.tabla === flitoLogisticaTraslados)?.valores).toMatchObject({ estado: 'en_ruta', mensajeroId: 9 });
    expect(sets.find((s) => s.tabla === flitoLogisticaTrasladoLts)?.valores).toMatchObject({ estado: 'en_ruta' });
    expect(sets.filter((s) => s.tabla === flitoLogisticaDocumentos && s.valores.estado === 'despachado')).toHaveLength(3);
    expect(eventosDe('despachado')).toHaveLength(3);
    const entrega = firmasDe('entrega')[0]?.valores as Record<string, unknown>;
    expect(entrega).toMatchObject({ rol: 'entrega', nombre: 'Operaciones', usuarioId: 1, documentoCifrado: null });
  });

  it('admite despacho sin imagen de firma', async () => {
    txCiclo();
    const r = await despacharTraslado(TR, { mensajeroId: 9 }, ctxAdmin);
    expect(r.estado).toBe('en_ruta');
    expect(firmasDe('entrega')).toHaveLength(0);
  });
});

describe('AC2 — entregar con nombre, cédula y firma: acta firmada, LT entregado; cédula NO en claro', () => {
  it('cifra la cédula en acta_firmas rol recibe y no escribe receptorDocumento en el acta', async () => {
    txCiclo({
      traslado: { estado: 'en_ruta' },
      acta: { estado: 'despachada' },
      lineas: [linea(D1, { estado: 'en_ruta' }), linea(D2, { estado: 'en_ruta' }), linea(D3, { estado: 'en_ruta' })],
      docs: [D1, D2, D3].map((id) => ({ id, estado: 'despachado' })),
    });
    const r = await entregarTraslado(TR, {
      receptorNombre: 'Ana Pérez', receptorDocumento: CEDULA, firma: FIRMA,
    }, ctxAdmin);
    expect(r).toMatchObject({ documentos: 3, estado: 'entregado', entregados: 3, devueltos: 0 });
    expect(r.firmaId).toMatch(/^[0-9a-f-]{36}$/i);
    const recibe = firmasDe('recibe')[0]?.valores as Record<string, unknown>;
    expect(recibe.nombre).toBe('Ana Pérez');
    expect(recibe.documentoCifrado).toEqual(expect.stringMatching(/^v1:/));
    expect(String(recibe.documentoCifrado)).not.toContain(CEDULA);
    expect(recibe.documentoUltimos).toBe('0908');
    expect(recibe.firmaStorageKey).toBe('storage/firma.png');
    const actaSet = sets.find((s) => s.tabla === flitoLogisticaActas)?.valores;
    expect(actaSet).toMatchObject({ estado: 'entregada', receptorNombre: 'Ana Pérez' });
    expect(actaSet).not.toHaveProperty('receptorDocumento');
    expect(sets.filter((s) => s.tabla === flitoLogisticaDocumentos && s.valores.estado === 'entregado')).toHaveLength(3);
  });
});

describe('AC3 — entrega parcial: 5 LT, 3 entregan (cobran), 2 devuelven (no cobran)', () => {
  it('líneas entregado vs devuelto; traslado entregado porque hay ≥1 entregada', async () => {
    const lineas = [D1, D2, D3, D4, D5].map((id) => linea(id, { estado: 'en_ruta' }));
    txCiclo({
      traslado: { estado: 'en_ruta' },
      acta: { estado: 'despachada' },
      lineas,
      docs: [D1, D2, D3, D4, D5].map((id) => ({ id, estado: 'despachado' })),
    });
    const r = await entregarTraslado(TR, {
      receptorNombre: 'Ana', receptorDocumento: CEDULA, firma: FIRMA, ltsDevueltas: [D4, D5],
    }, ctxAdmin);
    expect(r).toMatchObject({ entregados: 3, devueltos: 2, estado: 'entregado' });
    const lineSets = sets.filter((s) => s.tabla === flitoLogisticaTrasladoLts);
    expect(lineSets.some((s) => s.valores.estado === 'entregado')).toBe(true);
    expect(lineSets.some((s) => s.valores.estado === 'devuelto')).toBe(true);
    expect(sets.find((s) => s.tabla === flitoLogisticaTraslados)?.valores.estado).toBe('entregado');
    expect(eventosDe('entregado')).toHaveLength(3);
    expect(eventosDe('devuelto')).toHaveLength(2);
  });
});

describe('AC4 — LT devuelta: clasificado si origen organismo; en_flit si venía de FLIT', () => {
  it('origen organismo → clasificado', async () => {
    txCiclo({
      traslado: { estado: 'en_ruta', origen: 'organismo' },
      acta: { estado: 'despachada' },
      lineas: [linea(D1, { estado: 'en_ruta' })],
      docs: [{ id: D1, estado: 'despachado' }],
    });
    await devolverTraslado(TR, 'nadie en casa', ctxAdmin);
    expect(sets.find((s) => s.tabla === flitoLogisticaDocumentos && s.valores.estado)?.valores.estado).toBe('clasificado');
    expect(sets.find((s) => s.tabla === flitoLogisticaTraslados)?.valores.estado).toBe('devuelto');
  });

  it('origen FLIT → en_flit', async () => {
    txCiclo({
      traslado: { estado: 'en_ruta', origen: 'flit' },
      acta: { estado: 'despachada' },
      lineas: [linea(D1, { estado: 'en_ruta' })],
      docs: [{ id: D1, estado: 'despachado' }],
    });
    await devolverTraslado(TR, 'rechazó', ctxAdmin);
    expect(sets.find((s) => s.tabla === flitoLogisticaDocumentos && s.valores.estado)?.valores.estado).toBe('en_flit');
  });
});

describe('AC5 — anular en registrado: línea anulado, LT clasificado, precio intacto', () => {
  it('no toca precio; LT a clasificado; traslado anulado', async () => {
    txCiclo();
    const r = await anularTraslado(TR, 'viaje cancelado', ctxAdmin);
    expect(r).toMatchObject({ estado: 'anulado', documentos: 3 });
    const lineaSet = sets.find((s) => s.tabla === flitoLogisticaTrasladoLts)?.valores;
    expect(lineaSet).toEqual({ estado: 'anulado' });
    expect(lineaSet).not.toHaveProperty('precio');
    expect(sets.find((s) => s.tabla === flitoLogisticaTraslados)?.valores.estado).toBe('anulado');
    expect(sets.filter((s) => s.tabla === flitoLogisticaDocumentos && s.valores.estado === 'clasificado')).toHaveLength(3);
    expect(eventosDe('anulado')).toHaveLength(3);
  });
});

describe('AC6 — anular tras despachar → 409', () => {
  it('estado en_ruta no se anula', async () => {
    txCiclo({ traslado: { estado: 'en_ruta' } });
    await expect(anularTraslado(TR, 'tarde', ctxAdmin))
      .rejects.toMatchObject({ status: 409, codigo: 'TRASLADO_ESTADO_NO_ADMISIBLE' });
    expect(sets.filter((s) => s.tabla === flitoLogisticaTrasladoLts)).toHaveLength(0);
  });
});

describe('AC7 — reversa de LT entregada: línea anulado + evento tipificado', () => {
  it('marca la línea anulado, conserva precio y deja tipo reversa', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: D1, estado: 'entregado' }]));
    selectMock.mockReturnValueOnce(chain([{ id: 'lin-1', trasladoId: TR, estado: 'entregado', precio: '18500.00' }]));
    selectMock.mockReturnValueOnce(chain([{ id: D1, estado: 'entregado' }]));
    await reversar(D1, 'clasificado', 'error de entrega', ctxAdmin);
    expect(sets.some((s) => s.tabla === flitoLogisticaTrasladoLts && s.valores.estado === 'anulado')).toBe(true);
    expect(sets.find((s) => s.tabla === flitoLogisticaTrasladoLts)?.valores).not.toHaveProperty('precio');
    expect(eventosDe('reversa')).toHaveLength(1);
    expect((eventosDe('reversa')[0]!.valores as { trasladoId: string; tipo: string })).toMatchObject({
      tipo: 'reversa', trasladoId: TR,
    });
  });
});

describe('AC8 — alias /actas/:id/despachar|entregar|devolucion sobre acta de cliente', () => {
  it('POST /actas/:id/despachar con firma resuelve el traslado y deja el viaje en_ruta', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: ACTA, punto: 'cliente', trasladoId: TR }]));
    txCiclo();
    const r = await despachar(ACTA, { mensajeroId: 9, firmaEntrega: FIRMA }, ctxAdmin);
    expect(r.documentos).toBe(3);
    expect(sets.find((s) => s.tabla === flitoLogisticaTraslados)?.valores.estado).toBe('en_ruta');
  });

  it('HTTP: alias despachar sin firma sigue 400 (contrato vigente de la web)', async () => {
    const res = await post(`/actas/${ACTA}/despachar`, { mensajeroId: 9 }, await admin());
    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('HTTP: POST /traslados/:id/despachar sin firma sí despacha', async () => {
    txCiclo();
    const res = await post(`/traslados/${TR}/despachar`, { mensajeroId: 9 }, await admin());
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('en_ruta');
  });
});

describe('destino FLIT, permisos y propiedad', () => {
  it('despachar un viaje a FLIT → 422 DESTINO_FLIT_NO_DISPONIBLE', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: TR, destino: 'flit', origen: 'organismo', estado: 'registrado', mensajeroId: 9,
    }]));
    await expect(despacharTraslado(TR, { mensajeroId: 9 }, ctxAdmin))
      .rejects.toMatchObject({ status: 422, codigo: 'DESTINO_FLIT_NO_DISPONIBLE' });
  });

  it('mensajero no entrega el viaje de otro → 403', async () => {
    txCiclo({
      traslado: { estado: 'en_ruta', mensajeroId: 1 },
      acta: { estado: 'despachada', mensajeroId: 1 },
      lineas: [linea(D1, { estado: 'en_ruta' })],
      docs: [{ id: D1, estado: 'despachado' }],
    });
    await expect(entregarTraslado(TR, {
      receptorNombre: 'Ana', receptorDocumento: CEDULA, firma: FIRMA,
    }, ctxMensajero)).rejects.toMatchObject({ status: 403 });
  });

  it('HTTP: mensajero no tiene logistica.traslado.anular → 403', async () => {
    const res = await post(`/traslados/${TR}/anular`, { motivo: 'no' }, await mensajero());
    expect(res.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
