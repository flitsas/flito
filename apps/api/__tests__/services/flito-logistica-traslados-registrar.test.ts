// HU #14114 (Feature C2 #14092, Épica #13758, ADR-0030 C3a) — registrar viaje a cliente:
// precio congelado, bloqueo sin precio / sin proveedor, compañías mixtas, LT ajena, idempotencia.
// Doubles de BD; las rutas usan authMiddleware y exigirFuncion de verdad.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain, chainReject } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const tarifaDeMock = vi.fn();
const proveedorDeCompaniaMock = vi.fn();

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
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: (...a: unknown[]) => tarifaDeMock(...a),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js', () => ({
  proveedorDeCompania: (...a: unknown[]) => proveedorDeCompaniaMock(...a),
}));

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { registrarTraslado, precioTrasladoDe } = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const {
  flitoLogisticaTraslados, flitoLogisticaTrasladoLts, flitoLogisticaActas, flitoLogisticaIdempotencia,
} = await import('../../src/db/schema.js');

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const D3 = '33333333-3333-4333-8333-333333333333';
const D_AJENA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TR = '44444444-4444-4444-8444-444444444444';
const ACTA = '55555555-5555-4555-8555-555555555555';
const VIG = '66666666-6666-4666-8666-666666666666';

const ctxAdmin = { userId: 1, username: 'op', role: 'admin', operaAjenas: true };
const ctxMensajero = { userId: 9, username: 'msj', role: 'mensajero', operaAjenas: false };

const lt = (id: string, over: Record<string, unknown> = {}) => ({
  id, estado: 'clasificado', companiaId: 5, actaOrganismoPendiente: true, ...over,
});
const DOCS = [lt(D1), lt(D2), lt(D3)];

type Insercion = { tabla: unknown; valores: unknown };
let inserciones: Insercion[];

function txRegistro(opts: {
  docs?: unknown[];
  pendientes?: unknown[];
  propias?: unknown[];
  vivos?: unknown[];
  compania?: Record<string, unknown>;
  falla23505?: boolean;
} = {}) {
  const docs = opts.docs ?? DOCS;
  selectMock.mockReturnValueOnce(chain(docs));
  selectMock.mockReturnValueOnce(chain(opts.pendientes ?? []));
  if (opts.propias) selectMock.mockReturnValueOnce(chain(opts.propias));
  selectMock.mockReturnValueOnce(chain([{
    id: 5, nombre: 'ACME', autogestionable: false, direccion: 'Calle 1', contactoDoc: '900',
    ...opts.compania,
  }]));
  selectMock.mockReturnValueOnce(chain(opts.vivos ?? []));
  insertMock.mockImplementation((tabla: unknown) => ({
    values: (valores: unknown) => {
      inserciones.push({ tabla, valores });
      if (opts.falla23505 && tabla === flitoLogisticaTrasladoLts) {
        return chainReject(Object.assign(new Error('dup'), { code: '23505' }));
      }
      if (tabla === flitoLogisticaTraslados) return chain([{ id: TR }]);
      if (tabla === flitoLogisticaTrasladoLts) {
        const filas = valores as Array<{ documentoId: string }>;
        return chain(filas.map((f, i) => ({ id: `lin${i + 1}`, documentoId: f.documentoId })));
      }
      if (tabla === flitoLogisticaActas) return chain([{ id: ACTA }]);
      return chain([]);
    },
  }));
}

async function post(ruta: string, body: unknown, token: string, headers: Record<string, string> = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  let r = request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body as object);
}

const cuerpo = (over: Record<string, unknown> = {}) => ({
  companiaId: 5, destino: 'cliente', lts: [{ documentoId: D1 }, { documentoId: D2 }, { documentoId: D3 }], ...over,
});

const admin = () => testToken({ role: 'admin', sub: 1 });
const mensajero = () => testToken({ role: 'mensajero', sub: 9 });

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset().mockReturnValue(chain([]));
  tarifaDeMock.mockReset().mockResolvedValue({ valor: 18500, origen: 'generica', vigenciaId: VIG });
  proveedorDeCompaniaMock.mockReset().mockResolvedValue('prov-1');
  inserciones = [];
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({
    select: selectMock, insert: insertMock, update: updateMock,
  }));
});

describe('precioTrasladoDe — solo habla con tarifaDe (ADR-0030 §6)', () => {
  it('destino cliente pide logistica_cliente; 0 es válido; null si no hay vigencia', async () => {
    tarifaDeMock.mockResolvedValueOnce({ valor: 0, origen: 'generica', vigenciaId: VIG });
    await expect(precioTrasladoDe(5, 'cliente', null)).resolves.toEqual({ valor: 0, vigenciaId: VIG });
    expect(tarifaDeMock).toHaveBeenCalledWith(5, 'logistica_cliente', null, null);

    tarifaDeMock.mockResolvedValueOnce({ valor: 12000, origen: 'generica', vigenciaId: VIG });
    await expect(precioTrasladoDe(5, 'flit', new Date('2026-10-29T12:00:00Z')))
      .resolves.toEqual({ valor: 12000, vigenciaId: VIG });
    expect(tarifaDeMock).toHaveBeenLastCalledWith(5, 'logistica_flit', null, expect.any(Date));

    tarifaDeMock.mockResolvedValueOnce({ valor: null, origen: 'no_configurada', vigenciaId: null });
    await expect(precioTrasladoDe(5, 'cliente', null)).resolves.toBeNull();
  });
});

describe('AC1 — registro válido: 3 LT de UNA compañía, precio congelado, acta de cliente', () => {
  it('crea traslado + líneas con precio y vigencia + acta con el proveedor; LT a en_acta; evento destino_registrado', async () => {
    txRegistro();
    const r = await registrarTraslado(cuerpo() as never, ctxAdmin);
    expect(r).toMatchObject({
      id: TR, companiaId: 5, destino: 'cliente', origen: 'organismo', estado: 'registrado',
      actaId: ACTA, documentos: 3,
    });
    expect(r.lts).toEqual([
      { documentoId: D1, precio: 18500, tarifaVigenciaId: VIG, actaOrganismoPendiente: true },
      { documentoId: D2, precio: 18500, tarifaVigenciaId: VIG, actaOrganismoPendiente: true },
      { documentoId: D3, precio: 18500, tarifaVigenciaId: VIG, actaOrganismoPendiente: true },
    ]);
    const lineas = inserciones.find((i) => i.tabla === flitoLogisticaTrasladoLts)?.valores as Array<Record<string, unknown>>;
    expect(lineas).toHaveLength(3);
    expect(lineas[0]).toMatchObject({ conceptoPrecio: 'logistica_cliente', precio: '18500.00', tarifaVigenciaId: VIG, destino: 'cliente' });
    const acta = inserciones.find((i) => i.tabla === flitoLogisticaActas)?.valores as Record<string, unknown>;
    expect(acta).toMatchObject({ punto: 'cliente', proveedorLogisticaId: 'prov-1', trasladoId: TR, permiteParcial: true });
    const eventosTipo = inserciones.filter((i) => (i.valores as { tipo?: string })?.tipo === 'destino_registrado');
    expect(eventosTipo).toHaveLength(3);
    expect(r).not.toHaveProperty('contactoDocumento');
    expect(JSON.stringify(r.lts)).not.toContain('900');
  });
});

describe('AC2 — sin precio vigente → 422 PRECIO_TRASLADO_NO_CONFIGURADO y no inserta', () => {
  it('compañía sin tarifa de entrega a cliente', async () => {
    tarifaDeMock.mockResolvedValueOnce({ valor: null, origen: 'no_configurada', vigenciaId: null });
    txRegistro();
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 422, codigo: 'PRECIO_TRASLADO_NO_CONFIGURADO' });
    expect(inserciones).toEqual([]);
  });
});

describe('AC3 — sin proveedor → 422 PROVEEDOR_LOGISTICA_REQUERIDO y no inserta', () => {
  it('logística encendida sin proveedor asignado', async () => {
    proveedorDeCompaniaMock.mockResolvedValueOnce(null);
    txRegistro();
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 422, codigo: 'PROVEEDOR_LOGISTICA_REQUERIDO' });
    expect(inserciones).toEqual([]);
  });
});

describe('AC4 — compañías mixtas 422; LT ya en viaje vivo 409 (también ante 23505)', () => {
  it('una LT de otra compañía → 422 TRASLADO_COMPANIA_MIXTA; no inserta', async () => {
    txRegistro({ docs: [lt(D1), lt(D2, { companiaId: 99 }), lt(D3)] });
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 422, codigo: 'TRASLADO_COMPANIA_MIXTA', extra: { documentoIds: [D2] } });
    expect(inserciones).toEqual([]);
  });

  it('LT ya en un viaje vivo al mismo destino → 409 LT_YA_EN_TRASLADO', async () => {
    txRegistro({ vivos: [{ documentoId: D1 }] });
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 409, codigo: 'LT_YA_EN_TRASLADO', extra: { documentoIds: [D1] } });
    expect(inserciones.filter((i) => i.tabla === flitoLogisticaTrasladoLts)).toEqual([]);
  });

  it('carrera 23505 del único vivo → 409 LT_YA_EN_TRASLADO', async () => {
    txRegistro({ falla23505: true });
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 409, codigo: 'LT_YA_EN_TRASLADO' });
  });
});

describe('AC5 — compañía autogestionable → 409', () => {
  it('no inserta nada', async () => {
    txRegistro({ compania: { autogestionable: true } });
    await expect(registrarTraslado(cuerpo() as never, ctxAdmin))
      .rejects.toMatchObject({ status: 409, codigo: 'LOGISTICA_AUTOGESTIONADA' });
    expect(inserciones).toEqual([]);
  });
});

describe('AC6 — mensajero: LT ajena 403; propia o con operar_ajenas, se permite', () => {
  it('mensajero sin operar_ajenas sobre LT que recogió otro → 403 LT_AJENA', async () => {
    txRegistro({ propias: [{ id: D1 }, { id: D2 }] }); // D3 no es suya
    await expect(registrarTraslado(cuerpo() as never, ctxMensajero))
      .rejects.toMatchObject({ status: 403, codigo: 'LT_AJENA' });
    expect(inserciones).toEqual([]);
  });

  it('mensajero sin operar_ajenas sobre SUS LT → registra', async () => {
    txRegistro({ propias: [{ id: D1 }, { id: D2 }, { id: D3 }] });
    const r = await registrarTraslado(cuerpo() as never, ctxMensajero);
    expect(r.actaId).toBe(ACTA);
    expect(r.documentos).toBe(3);
  });

  it('con operar_ajenas registra LT ajenas (no consulta eventos de recogida)', async () => {
    txRegistro(); // sin `propias`: si preguntara eventos, el mock se desfasaría
    const r = await registrarTraslado(cuerpo() as never, { ...ctxMensajero, operaAjenas: true });
    expect(r.documentos).toBe(3);
  });

  it('HTTP: mensajero sin operar_ajenas sobre LT ajena → 403 LT_AJENA', async () => {
    txRegistro({ propias: [{ id: D1 }] });
    const r = await post('/traslados', cuerpo(), await mensajero());
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('LT_AJENA');
  });

  it('HTTP: mensajero con operar_ajenas registra LT ajenas → 200', async () => {
    txRegistro();
    const token = await testToken({ role: 'mensajero', sub: 9, funciones: ['logistica.actas.operar_ajenas'] });
    const r = await post('/traslados', cuerpo(), token);
    expect(r.status).toBe(200);
    expect(r.body.actaId).toBe(ACTA);
  });
});

describe('AC7 — sin acta de organismo se permite; actaOrganismoPendiente queda true', () => {
  it('LT con acta_organismo_pendiente=true entran al viaje', async () => {
    txRegistro({ docs: [lt(D1, { actaOrganismoPendiente: true }), lt(D2, { actaOrganismoPendiente: true }), lt(D3, { actaOrganismoPendiente: false })] });
    const r = await registrarTraslado(cuerpo() as never, ctxAdmin);
    expect(r.lts.map((l) => l.actaOrganismoPendiente)).toEqual([true, true, false]);
  });
});

describe('AC8 — si la tarifa cambia después, la línea conserva valor y vigenciaId', () => {
  it('el INSERT congela 18500/vig; un tarifaDe posterior no se relee', async () => {
    txRegistro();
    const r = await registrarTraslado(cuerpo() as never, ctxAdmin);
    tarifaDeMock.mockResolvedValue({ valor: 99000, origen: 'generica', vigenciaId: 'vig-nueva' });
    const lineas = inserciones.find((i) => i.tabla === flitoLogisticaTrasladoLts)?.valores as Array<Record<string, unknown>>;
    expect(lineas[0]).toMatchObject({ precio: '18500.00', tarifaVigenciaId: VIG });
    expect(r.lts[0]).toMatchObject({ precio: 18500, tarifaVigenciaId: VIG });
    expect(tarifaDeMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC9 — POST /cerrar-lote equivale al viaje cliente; misma Idempotency-Key → misma respuesta', () => {
  it('cerrar-lote de 3 clasificadas de la compañía 5 responde { actaId, documentos: 3 }', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: D1 }, { id: D2 }, { id: D3 }])); // idsClasificadosDe (db.select fuera de tx)
    txRegistro();
    const r = await post('/cerrar-lote', { companiaId: 5 }, await admin());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ actaId: ACTA, documentos: 3 });
  });

  it('misma Idempotency-Key en POST /traslados devuelve la respuesta guardada sin re-ejecutar', async () => {
    selectMock.mockReturnValueOnce(chain([{ status: 200, response: { id: TR, actaId: ACTA, documentos: 3 } }]));
    const token = await admin();
    const r = await post('/traslados', cuerpo(), token, { 'Idempotency-Key': 'k-viaje-1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: TR, actaId: ACTA, documentos: 3 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('el reenvío guarda la clave prefijada usuario:ruta', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no hay previa
    txRegistro();
    let claveGuardada: string | undefined;
    insertMock.mockImplementation((tabla: unknown) => ({
      values: (valores: unknown) => {
        inserciones.push({ tabla, valores });
        if (tabla === flitoLogisticaIdempotencia) {
          claveGuardada = (valores as { idempotencyKey: string }).idempotencyKey;
          return chain([]);
        }
        if (tabla === flitoLogisticaTraslados) return chain([{ id: TR }]);
        if (tabla === flitoLogisticaTrasladoLts) {
          const filas = valores as Array<{ documentoId: string }>;
          return chain(filas.map((f, i) => ({ id: `lin${i + 1}`, documentoId: f.documentoId })));
        }
        if (tabla === flitoLogisticaActas) return chain([{ id: ACTA }]);
        return chain([]);
      },
    }));
    const token = await admin();
    await post('/traslados', cuerpo(), token, { 'Idempotency-Key': 'k-viaje-2' });
    expect(claveGuardada).toMatch(/:traslados:k-viaje-2$/);
  });
});

describe('destino FLIT y autenticación', () => {
  it('destino=flit → 422 DESTINO_FLIT_NO_DISPONIBLE sin abrir transacción', async () => {
    const r = await post('/traslados', cuerpo({ destino: 'flit' }), await admin());
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('DESTINO_FLIT_NO_DISPONIBLE');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('exige logistica.traslado.registrar: un auditor no la tiene → 403', async () => {
    const r = await post('/traslados', cuerpo(), await testToken({ role: 'auditor', sub: 3 }));
    expect(r.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('una LT de otra compañía en el body no se cuela: 422, y D_AJENA queda fuera', async () => {
    txRegistro({ docs: [lt(D1), lt(D_AJENA, { companiaId: 8 }), lt(D3)] });
    await expect(registrarTraslado({
      companiaId: 5, destino: 'cliente',
      lts: [{ documentoId: D1 }, { documentoId: D_AJENA }, { documentoId: D3 }],
    }, ctxAdmin)).rejects.toMatchObject({ codigo: 'TRASLADO_COMPANIA_MIXTA', extra: { documentoIds: [D_AJENA] } });
  });
});
