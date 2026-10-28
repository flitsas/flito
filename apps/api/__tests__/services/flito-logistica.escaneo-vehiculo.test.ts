// HU #14142 (C1.7, ADR-0030 §17.2): escaneo de la LT por VEHÍCULO con elección de trámite.
// Secuencia de lecturas de escanearLt: [1] ¿numeroLicencia ya registrado? [2] trámites aprobados del vehículo
// (con el id de su LT si ya la tienen). La ruta escanear es soloSinEnlace: el alcance por compañía lo cierra la
// ruta; aquí se prueba que un tramiteId ajeno al vehículo no se usa ni se lista.

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
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/key'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));

const { audit } = await import('../../src/shared/middleware/audit.js');
const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const ctx = { userId: 1, username: 'op', role: 'admin', operaAjenas: true };
const txObj = { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn() };
const RAW = '10038156339 C.C. 1053786950 MUÑOZ GOMEZ EMMANUEL DAVID CLL 112 N 47A 08 MANIZALES 7 /9j/4AAQSkZJRgABAQEA QOX858 LRWYGCFJ0TC496126 LRWYGCFJ0TC496126 352026000097934 ELECTRICO';

const fila = (over: Record<string, unknown> = {}) => ({
  tramiteId: 't1', idFlit: 'F1', organismoCodigo: '05001', companiaId: 5, companiaNit: '900', companiaNombre: 'ACME',
  vehiculoId: 9, vin: 'LRWYGCFJ0TC496126', autogestionable: false, docId: null, ...over,
});

let insertados: Array<Record<string, unknown>>;
function insertCapturando(rows: unknown[]) {
  const c = chain(rows);
  c.values = ((v: Record<string, unknown>) => { insertados.push(v); return c; }) as never;
  return c;
}

beforeEach(() => {
  insertados = [];
  selectMock.mockReset();
  insertMock.mockReset().mockImplementation(() => insertCapturando([]));
  updateMock.mockReset().mockReturnValue(chain([]));
  transactionMock.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txObj));
});

const lecturas = (numeroRegistrado: unknown[], tramites: unknown[]) => {
  selectMock.mockReturnValueOnce(chain(numeroRegistrado)).mockReturnValueOnce(chain(tramites));
};

describe('escanearLt por vehículo (HU #14142)', () => {
  it('AC1: un solo trámite aprobado sin LT → se crea con ese trámite y su compañía', async () => {
    lecturas([], [fila()]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'd1' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('recogido');
    expect(insertados[0]).toMatchObject({ tramiteId: 't1', companiaId: 5, vehiculoId: 9 });
  });

  it('AC2: varios aprobados sin LT → elegir_tramite con candidatos, NO crea nada', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2', idFlit: 'F2', companiaId: 6, companiaNombre: 'OTRA', autogestionable: true })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('elegir_tramite');
    expect(r.candidatos).toEqual([
      { tramiteId: 't1', idFlit: 'F1', companiaNombre: 'ACME', organismoCodigo: '05001', gestionable: true },
      { tramiteId: 't2', idFlit: 'F2', companiaNombre: 'OTRA', organismoCodigo: '05001', gestionable: false },
    ]);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('AC2: reenvía con tramiteId elegido → se crea con ese', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2', idFlit: 'F2', companiaId: 6, companiaNit: '901' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'd2' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx, { tramiteId: 't2' });
    expect(r.resultado).toBe('recogido');
    expect(insertados[0]).toMatchObject({ tramiteId: 't2', companiaId: 6, companiaNit: '901' });
  });

  it('alcance: tramiteId ajeno al vehículo no se usa → sin_match, no crea', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx, { tramiteId: 'ajeno' });
    expect(r.resultado).toBe('sin_match');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('alcance: placa sin trámites propios (solo existen ajenos, que la consulta no devuelve) → sin_match', async () => {
    lecturas([], []);
    const r = await svc.escanearLt(RAW, null, {}, ctx, { tramiteId: 'ajeno' });
    expect(r.resultado).toBe('sin_match');
    expect(r.candidatos).toBeUndefined();
  });

  it('AC3: varios y dejarPendiente → LT sin trámite ni compañía, con evento pendienteTramite', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'p1' }])).mockReturnValueOnce(insertCapturando([]));
    const r = await svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true });
    expect(r.resultado).toBe('recogido');
    expect(r.pendienteTramite).toBe(true);
    expect(insertados[0]).toMatchObject({ tramiteId: null, companiaId: null, companiaNit: null, vehiculoId: 9, organismoCodigo: '05001', estado: 'recogido' });
    expect(insertados[1]).toMatchObject({ tipo: 'recogida_organismo', payload: { pendienteTramite: true } });
    expect(insertados).toHaveLength(2); // documento + evento de recogida; sin evento de clasificación (no hay compañía)
  });

  it('AC3: pendiente con organismos distintos y sin organismoCodigo → pide el organismo', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2', organismoCodigo: '11001' })]);
    await expect(svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true })).rejects.toThrow(/organismo/i);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC3: pendiente con organismoCodigo del contexto lo usa', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2', organismoCodigo: '11001' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'p1' }])).mockReturnValueOnce(insertCapturando([]));
    await svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true, organismoCodigo: '11001' });
    expect(insertados[0]).toMatchObject({ organismoCodigo: '11001' });
  });

  it('AC3: 23505 de uq_flito_log_doc_vehiculo_pendiente → duplicado controlado, no 500', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    transactionMock.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    selectMock.mockReturnValueOnce(chain([{ id: 'pExistente' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true });
    expect(r).toMatchObject({ resultado: 'duplicado', documentoId: 'pExistente', pendienteTramite: true });
  });

  it('un error distinto de 23505 se propaga', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    transactionMock.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true })).rejects.toThrow('boom');
  });

  it('AC4: placa sin trámite aprobado → sin_match, no crea', async () => {
    lecturas([], []);
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('sin_match');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC5: todos los aprobados ya tienen LT y número nuevo → rechazo «sin trámite pendiente de LT», no duplicado', async () => {
    lecturas([], [fila({ docId: 'x1' }), fila({ tramiteId: 't2', docId: 'x2' })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('sin_match');
    expect(r.motivo).toMatch(/no tiene un trámite aprobado pendiente de LT/i);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC6: duplicado de LT con la LT anterior en otro trámite → crea con el trámite nuevo, sin tocar la anterior', async () => {
    lecturas([], [fila({ tramiteId: 'viejo', docId: 'ltVieja' }), fila({ tramiteId: 'nuevo', idFlit: 'F9' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'dNuevo' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('recogido');
    expect(insertados[0]).toMatchObject({ tramiteId: 'nuevo' });
    expect(insertados.every((v) => v.tramiteId !== 'viejo')).toBe(true); // la LT anterior no se modifica
  });

  it('AC7: mismo numeroLicencia ya registrado → duplicado, sin crear ni ofrecer otro trámite', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'dPrevio' }]));
    const r = await svc.escanearLt(RAW, 'LT-9', {}, ctx);
    expect(r).toMatchObject({ resultado: 'duplicado', documentoId: 'dPrevio' });
    expect(r.candidatos).toBeUndefined();
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC7: el trámite elegido ya tiene LT → duplicado, sin crear', async () => {
    lecturas([], [fila({ docId: 'dX' }), fila({ tramiteId: 't2' })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx, { tramiteId: 't1' });
    expect(r).toMatchObject({ resultado: 'duplicado', documentoId: 'dX' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('autogestionable elegido → no_gestionable, no crea', async () => {
    lecturas([], [fila({ autogestionable: true })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('no_gestionable');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('validarLt por vehículo (HU #14142)', () => {
  it('varios candidatos → elegir_tramite; número ya registrado → ya_registrada', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    expect((await svc.validarLt(RAW)).resultado).toBe('elegir_tramite');
    selectMock.mockReturnValueOnce(chain([{ id: 'd' }]));
    expect((await svc.validarLt(RAW)).resultado).toBe('ya_registrada');
  });
});

describe('POST /escanear — contrato (HU #14142)', () => {
  const app = express(); app.use(express.json()); app.use('/api/flito/logistica', logisticaRoutes);
  const post = async (body: unknown) => request(app).post('/api/flito/logistica/escanear').set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`).send(body as object);

  it('Zod strict: campo desconocido, tramiteId+dejarPendiente o tramiteId no uuid → 400', async () => {
    expect((await post({ rawValue: RAW, extra: 1 })).status).toBe(400);
    expect((await post({ rawValue: RAW, tramiteId: '3f2b1c0e-7a64-4f4e-9d38-1a2b3c4d5e6f', dejarPendiente: true })).status).toBe(400);
    expect((await post({ rawValue: RAW, tramiteId: 'no-uuid' })).status).toBe(400);
  });
});

const MANUAL = { placa: 'qox-858', numeroLicencia: '10038156339', numeroLt: 'lt0012345' };

describe('ingreso manual (placa + n.º de licencia + sustrato LT) — HU #14142', () => {
  it('modo manual feliz: converge en la misma decisión, marca origen manual y guarda el sustrato', async () => {
    lecturas([], [fila()]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'm1' }]));
    const r = await svc.escanearLt(MANUAL, null, {}, ctx);
    expect(r).toMatchObject({ resultado: 'recogido', placa: 'QOX858', vin: 'LRWYGCFJ0TC496126', numeroLicencia: '10038156339' });
    expect(insertados[0]).toMatchObject({ tramiteId: 't1', numeroLt: 'LT0012345', numeroLicencia: '10038156339', estado: 'recogido' });
    expect(insertados[1]).toMatchObject({ tipo: 'recogida_organismo', payload: { origen: 'manual' } });
  });

  it('manual con varios trámites → elegir_tramite; con tramiteId elegido se crea con ese', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    expect((await svc.escanearLt(MANUAL, null, {}, ctx)).resultado).toBe('elegir_tramite');
    lecturas([], [fila(), fila({ tramiteId: 't2', companiaId: 6 })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'm2' }]));
    await svc.escanearLt(MANUAL, null, {}, ctx, { tramiteId: 't2' });
    expect(insertados[0]).toMatchObject({ tramiteId: 't2', companiaId: 6 });
  });

  it('manual: numeroLicencia ya registrado → duplicado; placa sin trámite → sin_match', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'dPrevio' }]));
    expect(await svc.escanearLt(MANUAL, null, {}, ctx)).toMatchObject({ resultado: 'duplicado', documentoId: 'dPrevio' });
    lecturas([], []);
    expect((await svc.escanearLt(MANUAL, null, {}, ctx)).resultado).toBe('sin_match');
  });

  it('sustrato sin prefijo «LT» → 422 con código estable, sin consultar', async () => {
    await expect(svc.escanearLt({ ...MANUAL, numeroLt: '12345' }, null, {}, ctx)).rejects.toMatchObject({ status: 422, extra: { code: 'NUMERO_LT_SIN_PREFIJO' } });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('consultarVehiculo — HU #14142', () => {
  it('devuelve solo los trámites sin LT, con VIN, organismo y vehículo; excluye los que ya tienen LT', async () => {
    selectMock.mockReturnValueOnce(chain([
      fila({ organismoNombre: 'Tránsito Medellín', marca: 'BYD', linea: 'Dolphin', modelo: 2026 }),
      fila({ tramiteId: 'conLt', docId: 'x' }),
    ]));
    const r = await svc.consultarVehiculo('qox-858');
    expect(r).toEqual({ encontrado: true, candidatos: [{
      tramiteId: 't1', idFlit: 'F1', companiaNombre: 'ACME', organismoCodigo: '05001', gestionable: true,
      vin: 'LRWYGCFJ0TC496126', organismoNombre: 'Tránsito Medellín', vehiculo: { marca: 'BYD', linea: 'Dolphin', modelo: 2026 },
    }] });
  });
  it('sin trámites pendientes (o todos con LT) → {encontrado:false}', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await svc.consultarVehiculo('QOX858')).toEqual({ encontrado: false });
    selectMock.mockReturnValueOnce(chain([fila({ docId: 'x' })]));
    expect(await svc.consultarVehiculo('QOX858')).toEqual({ encontrado: false });
  });
});

describe('rutas manual / consultar-vehiculo — HU #14142', () => {
  const app = express(); app.use(express.json()); app.use('/api/flito/logistica', logisticaRoutes);
  const como = async (ruta: string, body: unknown, role = 'mensajero') =>
    request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${await testToken({ role })}`).send(body as object);

  it('XOR rawValue / manual, manual incompleto o con extras → 400', async () => {
    expect((await como('/escanear', { rawValue: RAW, ...MANUAL })).status).toBe(400);
    expect((await como('/escanear', { placa: 'QOX858', numeroLicencia: '1' })).status).toBe(400);
    expect((await como('/escanear', { ...MANUAL, extra: 1 })).status).toBe(400);
    expect((await como('/validar-lt', { rawValue: RAW, placa: 'QOX858' })).status).toBe(400);
    expect((await como('/consultar-vehiculo', { placa: 'QOX858', x: 1 })).status).toBe(400);
  });

  it('sustrato sin «LT» por HTTP → 422 con detalle.code estable y sin la placa en la respuesta', async () => {
    const r = await como('/escanear', { ...MANUAL, numeroLt: '999' });
    expect(r.status).toBe(422);
    expect(r.body.detalle).toEqual({ code: 'NUMERO_LT_SIN_PREFIJO' });
    expect(JSON.stringify(r.body)).not.toMatch(/QOX/i);
  });

  it('consultar-vehiculo sin trámite → 200 {encontrado:false}; auditor (sin función) → 403', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const ok = await como('/consultar-vehiculo', { placa: 'QOX858' });
    expect([ok.status, ok.body]).toEqual([200, { encontrado: false }]);
    expect((await como('/consultar-vehiculo', { placa: 'QOX858' }, 'auditor')).status).toBe(403);
  });

  it('el escaneo manual no deja la placa en la auditoría', async () => {
    vi.mocked(audit).mockClear();
    selectMock.mockReturnValue(chain([]));
    const r = await como('/escanear', MANUAL);
    expect(r.status).toBe(200);
    expect(JSON.stringify(vi.mocked(audit).mock.calls.map((c) => c[1]))).not.toMatch(/QOX/i);
  });

  it('tope de intentos: la consulta 21 en un minuto → 429 sin eco de la placa', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = `Bearer ${await testToken({ role: 'mensajero' })}`;
    let ultimo = 200; let cuerpo = '';
    for (let i = 0; i < 21; i++) {
      const r = await request(app).post('/api/flito/logistica/consultar-vehiculo').set('Authorization', token).send({ placa: 'QOX858' });
      ultimo = r.status; cuerpo = JSON.stringify(r.body);
    }
    expect(ultimo).toBe(429);
    expect(cuerpo).not.toMatch(/QOX/i);
  });
});

describe('HU #14147 — organismo y compañía en la respuesta del escaneo y la validación', () => {
  it('escanear recogido: organismoCodigo y companiaNombre del trámite resuelto', async () => {
    lecturas([], [fila()]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'd1' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r).toMatchObject({ resultado: 'recogido', organismoCodigo: '05001', companiaNombre: 'ACME' });
  });
  it('escanear novedad (VIN distinto): también los trae', async () => {
    lecturas([], [fila({ vin: 'OTROVIN0000000000' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'd1' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r).toMatchObject({ resultado: 'novedad', organismoCodigo: '05001', companiaNombre: 'ACME' });
  });
  it('escanear duplicado por trámite con LT: los trae del trámite', async () => {
    lecturas([], [fila({ docId: 'dX' })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx, { tramiteId: 't1' });
    expect(r).toMatchObject({ resultado: 'duplicado', organismoCodigo: '05001', companiaNombre: 'ACME' });
  });
  it('escanear duplicado por n.º de licencia ya registrado: los trae del documento', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'dY', organismoCodigo: '11001', companiaNombre: 'BETA' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r).toMatchObject({ resultado: 'duplicado', documentoId: 'dY', organismoCodigo: '11001', companiaNombre: 'BETA' });
  });
  it('escanear LT pendiente de trámite: organismo con el que se creó y compañía null', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2' })]);
    insertMock.mockReturnValueOnce(insertCapturando([{ id: 'p1' }])).mockReturnValueOnce(insertCapturando([]));
    const r = await svc.escanearLt(RAW, null, {}, ctx, { dejarPendiente: true });
    expect(r).toMatchObject({ pendienteTramite: true, organismoCodigo: '05001', companiaNombre: null });
  });
  it('validar relacionada y ya_registrada traen organismo y compañía', async () => {
    lecturas([], [fila()]);
    expect(await svc.validarLt(RAW)).toMatchObject({ resultado: 'relacionada', organismoCodigo: '05001', companiaNombre: 'ACME' });
    selectMock.mockReturnValueOnce(chain([{ id: 'dY', organismoCodigo: '11001', companiaNombre: 'BETA' }]));
    expect(await svc.validarLt(RAW)).toMatchObject({ resultado: 'ya_registrada', organismoCodigo: '11001', companiaNombre: 'BETA' });
  });
  it('elegir_tramite: cada candidato ya trae organismo y compañía', async () => {
    lecturas([], [fila(), fila({ tramiteId: 't2', companiaNombre: 'OTRA' })]);
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.candidatos!.map((c) => [c.organismoCodigo, c.companiaNombre])).toEqual([['05001', 'ACME'], ['05001', 'OTRA']]);
  });
});

