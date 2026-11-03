// HU #14122 — viaje a FLIT y salida de FLIT al cliente. AC1–AC9.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, soloEstas, testToken } from '../helpers/auth.js';

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
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/firma-llegada.png'),
  presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn(),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: (...a: unknown[]) => tarifaDeMock(...a),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js', () => ({
  proveedorDeCompania: (...a: unknown[]) => proveedorDeCompaniaMock(...a),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js', () => ({
  generarActaPdf: vi.fn().mockResolvedValue('pdf-key'),
}));

const { registrarTraslado } = await import('../../src/modules/flito-logistica/flito-logistica-traslados.service.js');
const { firmarLlegadaFlit } = await import('../../src/modules/flito-logistica/flito-logistica-traslados-ciclo.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const {
  flitoLogisticaActas, flitoLogisticaActaFirmas, flitoLogisticaDocumentos, flitoLogisticaEventos,
  flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} = await import('../../src/db/schema.js');

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const MOT_OTRO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOT_EXT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MOT_OFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACTA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VIG = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FIRMA = 'iVBORw0KGgo=';

const ctxAdmin = { userId: 1, username: 'op.secreto', role: 'admin', operaAjenas: true };
const compania = { id: 5, nombre: 'ACME', autogestionable: false, direccion: 'Calle 1', contactoDoc: '900' };

type Insercion = { tabla: unknown; valores: unknown };
type SetOp = { tabla: unknown; valores: Record<string, unknown> };
let inserciones: Insercion[];
let sets: SetOp[];
let nTras: number;

function lt(n: number, estado = 'clasificado') {
  return { id: id(n), estado, companiaId: 5, actaOrganismoPendiente: false };
}

function cola(...filas: unknown[][]) {
  for (const f of filas) selectMock.mockReturnValueOnce(chain(f));
}

/** Selects de un alta a FLIT (admin): docs, trámite, vivos, compañía, motivos activos. */
function colaFlit(docs: unknown[], opts: { vivos?: unknown[]; motivos?: unknown[] } = {}) {
  cola(docs, [], opts.vivos ?? [], [compania], opts.motivos ?? [{ id: MOT_OTRO, activo: true }, { id: MOT_EXT, activo: true }]);
}

/** Selects de un alta a cliente (admin): docs, trámite, compañía, vivos. */
function colaCliente(docs: unknown[], vivos: unknown[] = []) {
  cola(docs, [], [compania], vivos);
}

beforeEach(() => {
  inserciones = [];
  sets = [];
  nTras = 0;
  selectMock.mockReset();
  updateMock.mockReset().mockImplementation((tabla: unknown) => ({
    set: (valores: Record<string, unknown>) => {
      sets.push({ tabla, valores });
      return chain([]);
    },
  }));
  insertMock.mockReset().mockImplementation((tabla: unknown) => ({
    values: (valores: unknown) => {
      inserciones.push({ tabla, valores });
      if (tabla === flitoLogisticaTraslados) return chain([{ id: nTras++ === 0 ? TR : id(90 + nTras) }]);
      if (tabla === flitoLogisticaTrasladoLts) {
        const filas = valores as Array<{ documentoId: string }>;
        return chain(filas.map((f, i) => ({ id: `lin-${i}`, documentoId: f.documentoId })));
      }
      if (tabla === flitoLogisticaActas) return chain([{ id: ACTA }]);
      return chain([]);
    },
  }));
  tarifaDeMock.mockReset().mockResolvedValue({ valor: 18500, origen: 'generica', vigenciaId: VIG });
  proveedorDeCompaniaMock.mockReset().mockResolvedValue('prov-1');
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({
    select: selectMock, insert: insertMock, update: updateMock,
  }));
});

function lineasInsertadas(): Array<Record<string, unknown>> {
  const v = inserciones.find((i) => i.tabla === flitoLogisticaTrasladoLts)?.valores;
  return (Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
}
function eventos(tipo: string) {
  return inserciones.filter((i) => i.tabla === flitoLogisticaEventos && (i.valores as { tipo?: string }).tipo === tipo);
}
const PII_PAYLOAD = /cedula|firma|op\.secreto|receptorNombre|receptorDocumento/i;

async function post(ruta: string, body: unknown, token: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  return request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`).send(body as object);
}

describe('AC1 — destino flit congela logistica_flit y guarda el motivo', () => {
  it('motivo de cabecera, quién y cuándo, acta flit y eventos sin PII', async () => {
    colaFlit([lt(1), lt(2)]);
    const r = await registrarTraslado({
      companiaId: 5, destino: 'flit', motivoLlegadaId: MOT_OTRO,
      lts: [{ documentoId: id(1), nota: 'sin portería' }, { documentoId: id(2) }],
    }, ctxAdmin);
    expect(r.origen).toBe('organismo');
    expect(r.lts.map((l) => l.motivoLlegadaId)).toEqual([MOT_OTRO, MOT_OTRO]);
    expect(r.lts[0]).toMatchObject({ motivoPorId: 1, precio: 18500, tarifaVigenciaId: VIG });
    expect(r.lts[0]!.motivoEn).toBeInstanceOf(Date);
    expect(r.lts[1]!.motivoEn).toEqual(r.lts[0]!.motivoEn);
    const lineas = lineasInsertadas();
    expect(lineas[0]).toMatchObject({
      conceptoPrecio: 'logistica_flit', precio: '18500.00', tarifaVigenciaId: VIG,
      motivoLlegadaId: MOT_OTRO, motivoPorId: 1, motivoNota: 'sin portería',
    });
    expect(lineas[1]).toMatchObject({ motivoLlegadaId: MOT_OTRO, motivoNota: null });
    expect(inserciones.find((i) => i.tabla === flitoLogisticaActas)?.valores).toMatchObject({ punto: 'flit' });
    expect(inserciones.find((i) => i.tabla === flitoLogisticaTraslados)?.valores).toMatchObject({
      destino: 'flit', origen: 'organismo',
    });
    expect(eventos('destino_registrado')).toHaveLength(2);
    expect(eventos('acta_flit')).toHaveLength(2);
    for (const e of [...eventos('destino_registrado'), ...eventos('acta_flit')]) {
      const payload = (e.valores as { payload: unknown }).payload;
      expect(JSON.stringify(payload)).not.toMatch(PII_PAYLOAD);
      expect(payload).toMatchObject({ destino: 'flit', actaId: ACTA });
    }
    expect(tarifaDeMock).toHaveBeenCalledWith(5, 'logistica_flit', null, expect.any(Date));
  });
});

describe('AC2 — sin motivo, inexistente o inactivo: 422 y cero INSERT', () => {
  it('sin motivo', async () => {
    colaFlit([lt(1)], { motivos: [{ id: MOT_OTRO, activo: true }] });
    await expect(registrarTraslado({ companiaId: 5, destino: 'flit', lts: [{ documentoId: id(1) }] }, ctxAdmin))
      .rejects.toMatchObject({ status: 422, codigo: 'MOTIVO_LLEGADA_REQUERIDO' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('motivo inexistente', async () => {
    colaFlit([lt(1)], { motivos: [{ id: MOT_OTRO, activo: true }] });
    await expect(registrarTraslado({
      companiaId: 5, destino: 'flit', lts: [{ documentoId: id(1), motivoLlegadaId: MOT_EXT }],
    }, ctxAdmin)).rejects.toMatchObject({ status: 422, codigo: 'MOTIVO_LLEGADA_REQUERIDO' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('motivo inactivo (no está entre los activos)', async () => {
    colaFlit([lt(1)], { motivos: [{ id: MOT_OTRO, activo: true }] });
    await expect(registrarTraslado({
      companiaId: 5, destino: 'flit', lts: [{ documentoId: id(1), motivoLlegadaId: MOT_OFF }],
    }, ctxAdmin)).rejects.toMatchObject({ status: 422, codigo: 'MOTIVO_LLEGADA_REQUERIDO' });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('AC3 — sin precio FLIT: 422 y cero INSERT', () => {
  it('tarifa null no inserta', async () => {
    tarifaDeMock.mockResolvedValue({ valor: null, origen: 'generica', vigenciaId: null });
    colaFlit([lt(1)]);
    await expect(registrarTraslado({
      companiaId: 5, destino: 'flit', lts: [{ documentoId: id(1), motivoLlegadaId: MOT_OTRO }],
    }, ctxAdmin)).rejects.toMatchObject({ status: 422, codigo: 'PRECIO_TRASLADO_NO_CONFIGURADO' });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — llegada firmada: LT en_flit, evento llegada, firma de la sesión sin cédula', () => {
  it('rol recibe, usuario de la sesión, documento_cifrado null, motivo de esa línea', async () => {
    const motivo = MOT_OTRO;
    cola(
      [{ id: TR, destino: 'flit', origen: 'organismo', estado: 'en_ruta', mensajeroId: 1 }],
      [{ id: ACTA, estado: 'despachada', mensajeroId: 1 }],
      [{ id: 'lin-1', documentoId: id(1), estado: 'en_ruta', precio: '18500.00', motivoLlegadaId: motivo }],
      [{ id: id(1), estado: 'despachado' }],
    );
    const r = await firmarLlegadaFlit(TR, { firma: FIRMA, lat: '4.6', lng: '-74.1' }, ctxAdmin);
    expect(r).toMatchObject({ estado: 'entregado', entregados: 1 });
    expect(sets.find((s) => s.tabla === flitoLogisticaDocumentos)?.valores.estado).toBe('en_flit');
    expect(sets.find((s) => s.tabla === flitoLogisticaActas)?.valores).not.toHaveProperty('receptorNombre');
    const llegada = eventos('llegada')[0]!.valores as { tipo: string; payload: Record<string, unknown> };
    expect(llegada.tipo).toBe('llegada');
    expect(llegada.payload).toEqual({ trasladoId: TR, actaId: ACTA, motivoLlegadaId: motivo });
    expect(JSON.stringify(llegada.payload)).not.toMatch(PII_PAYLOAD);
    const firma = inserciones.find((i) => i.tabla === flitoLogisticaActaFirmas)!.valores as Record<string, unknown>;
    expect(firma).toMatchObject({
      rol: 'recibe', usuarioId: 1, nombre: 'op.secreto', documentoCifrado: null, documentoUltimos: null,
    });
  });

  it('HTTP: receptorDocumento, receptorNombre o firmante → 422 DATOS_INVALIDOS', async () => {
    const token = await testToken({ role: 'admin', sub: 1 });
    for (const extra of [{ receptorDocumento: '1036640908' }, { receptorNombre: 'Ana' }, { firmante: 'Ana' }]) {
      selectMock.mockReturnValueOnce(chain([{ destino: 'flit' }]));
      const res = await post(`/traslados/${TR}/entregar`, { firma: FIRMA, ...extra }, token);
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.codigo).toBe('DATOS_INVALIDOS');
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('HTTP: sin firma → 422 FIRMA_LLEGADA_REQUERIDA', async () => {
    selectMock.mockReturnValueOnce(chain([{ destino: 'flit' }]));
    const res = await post(`/traslados/${TR}/entregar`, { lat: '4.6' }, await testToken({ role: 'admin', sub: 1 }));
    expect(res.status).toBe(422);
    expect(res.body.codigo).toBe('FIRMA_LLEGADA_REQUERIDA');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — firmar_flit, no entregar', () => {
  it('mensajero (tiene entregar, no firmar_flit) → 403', async () => {
    selectMock.mockReturnValueOnce(chain([{ destino: 'flit' }]));
    const res = await post(`/traslados/${TR}/entregar`, { firma: FIRMA }, await testToken({ role: 'mensajero', sub: 9 }));
    expect(res.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('quien solo tiene firmar_flit firma la llegada', async () => {
    const token = await testToken({ role: 'auditor', sub: 42, username: 'op.flit' });
    await registrarUsuarioDePrueba(42, { rol: 'auditor', tipoEnlace: 'ninguno', ...soloEstas(['logistica.actas.firmar_flit']) });
    cola(
      [{ destino: 'flit' }],
      [{ id: TR, destino: 'flit', origen: 'organismo', estado: 'en_ruta', mensajeroId: 42 }],
      [{ id: ACTA, estado: 'despachada', mensajeroId: 42 }],
      [{ id: 'lin-1', documentoId: id(1), estado: 'en_ruta', precio: '18500.00', motivoLlegadaId: MOT_OTRO }],
      [{ id: id(1), estado: 'despachado' }],
    );
    const res = await post(`/traslados/${TR}/entregar`, { firma: FIRMA }, token);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('entregado');
    const firma = inserciones.find((i) => i.tabla === flitoLogisticaActaFirmas)!.valores as Record<string, unknown>;
    expect(firma).toMatchObject({ rol: 'recibe', usuarioId: 42, documentoCifrado: null, nombre: 'op.flit' });
  });

  it('el viaje no está → 404 antes del 403', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const res = await post(`/traslados/${TR}/entregar`, { firma: FIRMA }, await testToken({ role: 'mensajero', sub: 9 }));
    expect(res.status).toBe(404);
    expect(res.body.codigo).toBe('TRASLADO_NO_ENCONTRADO');
  });
});

describe('AC6 — salida de FLIT vs viaje directo', () => {
  it('origen flit + LT en_flit congela logistica_cliente', async () => {
    colaCliente([lt(1, 'en_flit')]);
    const r = await registrarTraslado({
      companiaId: 5, destino: 'cliente', origen: 'flit', lts: [{ documentoId: id(1) }],
    }, ctxAdmin);
    expect(r).toMatchObject({ origen: 'flit', destino: 'cliente' });
    expect(r.lts[0]).toMatchObject({ motivoLlegadaId: null, motivoPorId: null, motivoEn: null });
    expect(lineasInsertadas()[0]).toMatchObject({ conceptoPrecio: 'logistica_cliente' });
    expect(lineasInsertadas()[0]).not.toHaveProperty('motivoLlegadaId');
    expect(tarifaDeMock).toHaveBeenCalledWith(5, 'logistica_cliente', null, expect.any(Date));
  });

  it('origen flit + LT clasificado → 409 LT_NO_EN_FLIT y cero filas', async () => {
    cola([lt(1, 'clasificado')], []);
    await expect(registrarTraslado({
      companiaId: 5, destino: 'cliente', origen: 'flit', lts: [{ documentoId: id(1) }],
    }, ctxAdmin)).rejects.toMatchObject({ status: 409, codigo: 'LT_NO_EN_FLIT' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('el mismo LT clasificado sin origen sigue siendo el viaje directo', async () => {
    colaCliente([lt(1, 'clasificado')]);
    const r = await registrarTraslado({
      companiaId: 5, destino: 'cliente', lts: [{ documentoId: id(1) }],
    }, ctxAdmin);
    expect(r).toMatchObject({ origen: 'organismo', destino: 'cliente' });
    expect(lineasInsertadas()[0]).toMatchObject({ conceptoPrecio: 'logistica_cliente' });
  });
});

describe('AC7 — dos POST de la misma compañía: cinco a FLIT y cinco a cliente', () => {
  it('dejan dos traslados', async () => {
    const aFlit = [1, 2, 3, 4, 5].map((n) => lt(n));
    const aCliente = [6, 7, 8, 9, 10].map((n) => lt(n));
    colaFlit(aFlit);
    colaCliente(aCliente);
    const uno = await registrarTraslado({
      companiaId: 5, destino: 'flit', motivoLlegadaId: MOT_OTRO,
      lts: aFlit.map((d) => ({ documentoId: d.id })),
    }, ctxAdmin);
    const dos = await registrarTraslado({
      companiaId: 5, destino: 'cliente',
      lts: aCliente.map((d) => ({ documentoId: d.id })),
    }, ctxAdmin);
    expect(uno.id).not.toBe(dos.id);
    expect(uno.documentos).toBe(5);
    expect(dos.documentos).toBe(5);
    expect(inserciones.filter((i) => i.tabla === flitoLogisticaTraslados)).toHaveLength(2);
    expect(uno.destino).toBe('flit');
    expect(dos.destino).toBe('cliente');
    expect(dos.origen).toBe('organismo');
  });
});

describe('AC8 — segunda ida a FLIT con línea viva', () => {
  it('entregado cuenta: 409 LT_YA_EN_TRASLADO, no LT_ESTADO_NO_ADMISIBLE', async () => {
    colaFlit([lt(1, 'en_flit')], { vivos: [{ documentoId: id(1) }] });
    await expect(registrarTraslado({
      companiaId: 5, destino: 'flit', motivoLlegadaId: MOT_OTRO, lts: [{ documentoId: id(1) }],
    }, ctxAdmin)).rejects.toMatchObject({ status: 409, codigo: 'LT_YA_EN_TRASLADO' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('tras devolver (línea no viva, LT clasificado) otra vez 201', async () => {
    colaFlit([lt(1, 'clasificado')], { vivos: [] });
    const r = await registrarTraslado({
      companiaId: 5, destino: 'flit', motivoLlegadaId: MOT_OTRO, lts: [{ documentoId: id(1) }],
    }, ctxAdmin);
    expect(r.estado).toBe('registrado');
    expect(lineasInsertadas()[0]).toMatchObject({ conceptoPrecio: 'logistica_flit', motivoLlegadaId: MOT_OTRO });
  });
});

describe('AC9 — transportadora externa no agrega guía, proveedor ni precio', () => {
  it('la línea queda con la misma forma que Otro', async () => {
    colaFlit([lt(1)], { motivos: [{ id: MOT_EXT, activo: true }] });
    await registrarTraslado({
      companiaId: 5, destino: 'flit', lts: [{ documentoId: id(1), motivoLlegadaId: MOT_EXT }],
    }, ctxAdmin);
    const externa = lineasInsertadas()[0]!;
    inserciones = [];
    colaFlit([lt(2)], { motivos: [{ id: MOT_OTRO, activo: true }] });
    await registrarTraslado({
      companiaId: 5, destino: 'flit', lts: [{ documentoId: id(2), motivoLlegadaId: MOT_OTRO }],
    }, ctxAdmin);
    const otro = lineasInsertadas()[0]!;
    expect(Object.keys(externa).sort()).toEqual(Object.keys(otro).sort());
    expect(externa).toMatchObject({ conceptoPrecio: 'logistica_flit', precio: '18500.00', motivoLlegadaId: MOT_EXT });
    expect(otro).toMatchObject({ conceptoPrecio: 'logistica_flit', precio: '18500.00', motivoLlegadaId: MOT_OTRO });
    expect(externa).not.toHaveProperty('guia');
    expect(otro).not.toHaveProperty('guia');
    expect(proveedorDeCompaniaMock).toHaveBeenCalledTimes(2);
    expect(proveedorDeCompaniaMock).toHaveBeenNthCalledWith(1, expect.anything(), 5);
    expect(proveedorDeCompaniaMock).toHaveBeenNthCalledWith(2, expect.anything(), 5);
  });
});
