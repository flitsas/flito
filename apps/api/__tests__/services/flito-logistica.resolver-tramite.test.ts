// HU #14143 (Feature C1 #14091, ADR-0030 §17.3) — resolver el trámite de una LT pendiente: la LT toma el trámite y
// la compañía, entra al acta de organismo DE ESA COMPAÑÍA con la MISMA firma y apaga el indicador; función propia
// (el mensajero no la tiene); cliente/enlace no ven nada; candidato ajeno o con LT → rechazo; reenvío idempotente;
// y una LT pendiente nunca entra a un acta de compañía ni a un traslado (`LT_PENDIENTE_DE_TRAMITE`).
// Doubles de BD; las rutas usan authMiddleware y exigirFuncion reales sobre el double de permisos de `helpers/auth.ts`.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain, chainReject } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const auditMock = vi.fn();
const logLlamadas: unknown[][] = [];
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig<typeof import('../../src/shared/logger.js')>();
  const espia = { info: (...a: unknown[]) => logLlamadas.push(a), warn: (...a: unknown[]) => logLlamadas.push(a), error: (...a: unknown[]) => logLlamadas.push(a), debug: (...a: unknown[]) => logLlamadas.push(a) };
  return { ...real, loggerFor: () => espia };
});

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { exigirTramiteResuelto, LtPendienteDeTramiteError } = await import('../../src/modules/flito-logistica/flito-logistica.base.js');
const { flitoLogisticaActas, flitoLogisticaActaLineas, flitoLogisticaEventos, flitoLogisticaIdempotencia } = await import('../../src/db/schema.js');

const DOC = '11111111-1111-4111-8111-111111111111';
const TRAM = '66666666-6666-4666-8666-666666666666';
const FIRMANTE = '44444444-4444-4444-8444-444444444444';
const ACTA = '33333333-3333-4333-8333-333333333333';
const FUNCION = 'logistica.documento.resolver_tramite';
const PLACA = 'ZZZ999';

const docPendiente = (over: Record<string, unknown> = {}) => ({
  id: DOC, estado: 'recogido', vehiculoId: 7, organismoCodigo: '11001', tramiteId: null, firmanteId: FIRMANTE, ...over,
});
const tramiteOk = (over: Record<string, unknown> = {}) => ({
  id: TRAM, vehiculoId: 7, organismoCodigo: '11001', companiaId: 5, companiaNit: '900', aprobado: true, autogestionable: false, ...over,
});

type Insercion = { tabla: unknown; valores: Record<string, unknown> };
let inserciones: Insercion[];
let sets: Record<string, unknown>[];

/** selects de la tx en orden: documento, trámite, LT del trámite, acta existente, firmante. */
function tx(opts: { doc?: unknown; tramite?: unknown; yaLt?: unknown[]; actaExistente?: unknown[]; falla23505?: boolean } = {}) {
  selectMock.mockReturnValueOnce(chain([opts.doc ?? docPendiente()]));
  selectMock.mockReturnValueOnce(chain(opts.tramite === null ? [] : [opts.tramite ?? tramiteOk()]));
  selectMock.mockReturnValueOnce(chain(opts.yaLt ?? []));
  selectMock.mockReturnValueOnce(chain(opts.actaExistente ?? []));
  selectMock.mockReturnValueOnce(chain([{ por: 3, en: new Date('2026-10-01T00:00:00Z'), lat: null, lng: null }]));
  insertMock.mockImplementation((tabla: unknown) => ({
    values: (valores: Record<string, unknown>) => {
      inserciones.push({ tabla, valores });
      if (tabla === flitoLogisticaActas) return chain([{ id: ACTA }]);
      if (tabla === flitoLogisticaActaLineas && opts.falla23505) return chainReject(Object.assign(new Error('dup'), { code: '23505' }));
      return chain([]);
    },
  }));
}

async function llamar(metodo: 'get' | 'post', ruta: string, token: string, body?: unknown, headers: Record<string, string> = {}, envolver = false) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', envolver ? conAlcance('logistica', logisticaRoutes) : logisticaRoutes);
  let r = request(app)[metodo](`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return body === undefined ? r : r.send(body as object);
}
const operador = () => testToken({ role: 'admin', sub: 1, funciones: [FUNCION] });
const mensajero = () => testToken({ role: 'mensajero', sub: 9 });
const RUTA = `/documentos/${DOC}/resolver-tramite`;

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  logLlamadas.length = 0; inserciones = []; sets = [];
  updateMock.mockReset().mockImplementation(() => ({ set: (v: Record<string, unknown>) => { sets.push(v); return chain([]); } }));
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({ select: selectMock, insert: insertMock, update: updateMock }));
});

describe('AC1 — resolver con firma de organismo ya capturada', () => {
  it('estampa trámite y compañía, crea el acta de organismo de ESA compañía con la MISMA firma, apaga el pendiente y deja el evento', async () => {
    tx();
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ documentoId: DOC, tramiteId: TRAM, companiaId: 5, actaId: ACTA });
    const acta = inserciones.find((i) => i.tabla === flitoLogisticaActas)!.valores;
    expect(acta).toMatchObject({ companiaId: 5, punto: 'organismo', firmanteId: FIRMANTE, estado: 'entregada', organismoCodigo: '11001' });
    expect(inserciones.find((i) => i.tabla === flitoLogisticaActaLineas)!.valores).toMatchObject({ actaId: ACTA, documentoId: DOC, punto: 'organismo', companiaId: 5 });
    expect(sets[0]).toMatchObject({ tramiteId: TRAM, companiaId: 5, companiaNit: '900', actaOrganismoPendiente: false });
    expect(inserciones.find((i) => i.tabla === flitoLogisticaEventos)!.valores).toMatchObject({ documentoId: DOC, tipo: 'tramite_resuelto', actaId: ACTA });
  });

  it('reutiliza el acta de organismo de la compañía+firmante si ya existe (no crea otra)', async () => {
    tx({ actaExistente: [{ id: ACTA }] });
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect(r.status).toBe(200);
    expect(inserciones.some((i) => i.tabla === flitoLogisticaActas)).toBe(false);
    expect(inserciones.find((i) => i.tabla === flitoLogisticaActaLineas)!.valores).toMatchObject({ actaId: ACTA, documentoId: DOC });
  });

  it('sin firma capturada: estampa el trámite, no crea acta y deja el pendiente de organismo encendido', async () => {
    tx({ doc: docPendiente({ firmanteId: null }) });
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect(r.status).toBe(200);
    expect(r.body.actaId).toBeNull();
    expect(inserciones.some((i) => i.tabla === flitoLogisticaActas || i.tabla === flitoLogisticaActaLineas)).toBe(false);
    expect(sets[0]).not.toHaveProperty('actaOrganismoPendiente');
  });

  it('no loguea placa, VIN ni cédula', async () => {
    tx();
    await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect(JSON.stringify(logLlamadas)).not.toContain(PLACA);
    expect(logLlamadas.length).toBeGreaterThan(0);
  });
});

describe('AC2 y AC6 — quién puede', () => {
  it('el mensajero (sin la función) → 403 en resolver, candidatos y bandeja, sin tocar la BD', async () => {
    const t = await mensajero();
    expect((await llamar('post', RUTA, t, { tramiteId: TRAM })).status).toBe(403);
    expect((await llamar('get', `/documentos/${DOC}/candidatos-tramite`, t)).status).toBe(403);
    expect((await llamar('get', '/pendientes-tramite', t)).status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('cliente/enlace, aun con la función → 403 sin consultar la bandeja', async () => {
    selectMock.mockReturnValueOnce(chain([{ c: 42, p: null }]));
    const t = await testToken({ role: 'xyz_renombrado' as never, sub: 8801, tipoEnlace: 'compania', funciones: [FUNCION] });
    for (const [m, ruta] of [['get', '/pendientes-tramite'], ['get', `/documentos/${DOC}/candidatos-tramite`], ['post', RUTA]] as const) {
      const r = await llamar(m, ruta, t, m === 'post' ? { tramiteId: TRAM } : undefined, {}, true);
      expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('cuerpo sin tramiteId uuid → 422', async () => {
    expect((await llamar('post', RUTA, await operador(), { tramiteId: 'x' })).status).toBe(422);
  });
});

describe('AC4 — candidato no válido: se rechaza y la LT sigue pendiente', () => {
  const sinEscribir = () => {
    expect(sets).toEqual([]);
    expect(inserciones.filter((i) => i.tabla !== flitoLogisticaIdempotencia)).toEqual([]);
  };
  it.each([
    ['trámite de otro vehículo', { vehiculoId: 99 }],
    ['trámite no aprobado', { aprobado: false }],
    ['trámite sin compañía', { companiaId: null }],
    ['trámite de otro organismo', { organismoCodigo: '05001' }],
    ['compañía autogestionada', { autogestionable: true }],
  ])('%s → 422 TRAMITE_NO_CANDIDATO', async (_n, over) => {
    tx({ tramite: tramiteOk(over) });
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect([r.status, r.body.codigo]).toEqual([422, 'TRAMITE_NO_CANDIDATO']);
    sinEscribir();
  });
  it('trámite inexistente → 422', async () => {
    tx({ tramite: null });
    expect((await llamar('post', RUTA, await operador(), { tramiteId: TRAM })).status).toBe(422);
    sinEscribir();
  });
  it('trámite que ya tiene LT → 409 TRAMITE_YA_TIENE_LT', async () => {
    tx({ yaLt: [{ id: 'otra' }] });
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect([r.status, r.body.codigo]).toEqual([409, 'TRAMITE_YA_TIENE_LT']);
    sinEscribir();
  });
  it('carrera perdida por el mismo trámite (23505) → 409 TRAMITE_YA_TIENE_LT', async () => {
    tx({ falla23505: true });
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect([r.status, r.body.codigo]).toEqual([409, 'TRAMITE_YA_TIENE_LT']);
  });
  it('LT que ya no es pendiente → 409 LT_NO_PENDIENTE', async () => {
    selectMock.mockReturnValueOnce(chain([docPendiente({ tramiteId: TRAM })]));
    const r = await llamar('post', RUTA, await operador(), { tramiteId: TRAM });
    expect([r.status, r.body.codigo]).toEqual([409, 'LT_NO_PENDIENTE']);
  });
});

describe('AC5 — doble clic', () => {
  it('la misma Idempotency-Key aplica una sola vez, con la clave prefijada usuario:ruta', async () => {
    selectMock.mockReturnValueOnce(chain([])); // búsqueda de idempotencia: primera vez
    tx();
    const t = await operador();
    const primera = await llamar('post', RUTA, t, { tramiteId: TRAM }, { 'Idempotency-Key': 'k-1' });
    expect(primera.status).toBe(200);
    const guardada = inserciones.find((i) => i.tabla === flitoLogisticaIdempotencia)!.valores as { idempotencyKey: string; status: number; response: unknown };
    expect(guardada.idempotencyKey).toBe('1:documentos/resolver-tramite:k-1');
    transactionMock.mockClear(); inserciones.length = 0;
    selectMock.mockReset().mockReturnValueOnce(chain([{ status: guardada.status, response: guardada.response }]));
    const segunda = await llamar('post', RUTA, t, { tramiteId: TRAM }, { 'Idempotency-Key': 'k-1' });
    expect(segunda.body).toEqual(primera.body);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(inserciones).toHaveLength(0);
  });
});

describe('AC6 — bandeja y candidatos', () => {
  const EN = new Date(Date.now() - 3 * 86_400_000);
  const DOC_FILA = { id: DOC, vehiculoId: 7, placa: PLACA, organismoCodigo: '11001', estado: 'recogido', firmanteId: FIRMANTE, createdAt: EN };
  const cand = (over: Record<string, unknown>) => ({ vehiculoId: 7, tramiteId: TRAM, idFlit: 'F-1', companiaId: 5, companiaNombre: 'Cia', organismoCodigo: '11001', ...over });

  it('lista la antigüedad en días y SOLO los candidatos del mismo vehículo y organismo (el ajeno no se lista)', async () => {
    selectMock.mockReturnValueOnce(chain([DOC_FILA]));
    selectMock.mockReturnValueOnce(chain([{ documentoId: DOC, nombre: 'Mensajero Uno', en: EN }]));
    selectMock.mockReturnValueOnce(chain([cand({}), cand({ tramiteId: 'otro-org', idFlit: 'F-2', organismoCodigo: '05001' })]));
    const r = await llamar('get', '/pendientes-tramite', await operador());
    expect(r.status).toBe(200);
    expect(r.body.pendientes).toHaveLength(1);
    expect(r.body.pendientes[0]).toMatchObject({ documentoId: DOC, antiguedadDias: 3, firmada: true, recogidoPorNombre: 'Mensajero Uno' });
    expect(r.body.pendientes[0].candidatos).toEqual([{ tramiteId: TRAM, idFlit: 'F-1', companiaId: 5, companiaNombre: 'Cia', organismoCodigo: '11001' }]);
    expect(JSON.stringify(logLlamadas)).not.toContain(PLACA);
  });

  it('candidatos de una LT ya resuelta → 409; inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ vehiculoId: 7, organismoCodigo: '11001', tramiteId: TRAM }]));
    expect((await llamar('get', `/documentos/${DOC}/candidatos-tramite`, await operador())).status).toBe(409);
    selectMock.mockReturnValueOnce(chain([]));
    expect((await llamar('get', `/documentos/${DOC}/candidatos-tramite`, await operador())).status).toBe(404);
  });
});

describe('AC3 — una LT pendiente no entra a traslado ni a acta de compañía', () => {
  it('exigirTramiteResuelto lanza LT_PENDIENTE_DE_TRAMITE (409) y nombra las LT', async () => {
    const exec = { select: () => chain([{ id: DOC }]) } as never;
    await expect(exigirTramiteResuelto(exec, [DOC])).rejects.toMatchObject({ status: 409, codigo: 'LT_PENDIENTE_DE_TRAMITE', extra: { documentoIds: [DOC] } });
    await expect(exigirTramiteResuelto(exec, [DOC])).rejects.toBeInstanceOf(LtPendienteDeTramiteError);
  });
  it('sin pendientes (o sin ids) no lanza', async () => {
    await expect(exigirTramiteResuelto({ select: () => chain([]) } as never, [DOC])).resolves.toBeUndefined();
    await expect(exigirTramiteResuelto({ select: () => { throw new Error('no debe consultar'); } } as never, [])).resolves.toBeUndefined();
  });
});
