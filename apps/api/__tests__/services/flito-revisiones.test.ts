// FLITO Revisiones — cola de resolución del OCR (Fase 5 P1). Verifica confirmar() (puro: firma de
// campos, RN-04/RN-05), las guardas de resolver()/descartar(), y el enrutamiento por módulo con las
// transiciones de estado. drizzle + storage + SOAT mockeados.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoImpuesto, EstadoImpuesto, EstadoSoat, FlujoRevision } from '@operaciones/shared-types';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ presignedGetEntityDocument: vi.fn().mockResolvedValue('https://s3.example/signed') }));

const marcarPagadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ marcarPagado: marcarPagadoMock }));

const {
  confirmar, camposEsperados, listar, resolver, descartar,
} = await import('../../src/modules/flito-revisiones/flito-revisiones.service.js');
const { default: revisionesRoutes } = await import('../../src/modules/flito-revisiones/flito-revisiones.routes.js');

// Ejecuta el callback de tx con un stub que registra las llamadas update/insert.
function txStub() {
  const calls: { table: string; set?: unknown }[] = [];
  const tx = {
    update: (_t: unknown) => ({ set: (v: unknown) => ({ where: () => { calls.push({ table: 'update', set: v }); return Promise.resolve([]); } }) }),
    insert: (_t: unknown) => ({ values: (v: unknown) => { calls.push({ table: 'insert', set: v }); return Promise.resolve([]); } }),
  };
  return { tx, calls };
}

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); transactionMock.mockReset();
  marcarPagadoMock.mockClear();
  updateMock.mockReturnValue(chain([]));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub().tx));
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ───────────────────────────── confirmar (puro, RN-04/RN-05) ─────────────────

describe('confirmar — un dato solo se vuelve confiable si una persona lo escribió', () => {
  it('firma el campo escrito con confianza 1 y confirmadoPor', () => {
    const original = { [CampoImpuesto.VALOR_TOTAL]: campo('100', 0.3) };
    const r = confirmar(original, { [CampoImpuesto.VALOR_TOTAL]: '634900' }, 7) as Record<string, { valor: string | null; confianza: number; confiable: boolean; confirmadoPor?: string | null }>;
    expect(r[CampoImpuesto.VALOR_TOTAL]).toMatchObject({ valor: '634900', confianza: 1, confiable: true, confirmadoPor: '7' });
    expect(r[CampoImpuesto.VALOR_TOTAL].confirmadoEn).toBeTypeOf('string');
  });

  it('un campo NO tocado conserva su confianza original (no se da por válido en bloque)', () => {
    const original = { [CampoImpuesto.PLACA]: campo('QTQ100', 0.3), [CampoImpuesto.VALOR_TOTAL]: campo('100', 0.4) };
    const r = confirmar(original, { [CampoImpuesto.VALOR_TOTAL]: '634900' }, 7) as Record<string, { confianza: number; confiable: boolean }>;
    expect(r[CampoImpuesto.PLACA]).toMatchObject({ confianza: 0.3, confiable: false });
  });

  it('vaciar un campo lo deja null y NO confiable', () => {
    const r = confirmar({}, { [CampoImpuesto.NUMERO_RECIBO]: '' }, 1) as Record<string, { valor: string | null; confiable: boolean }>;
    expect(r[CampoImpuesto.NUMERO_RECIBO]).toMatchObject({ valor: null, confiable: false });
  });
});

describe('camposEsperados', () => {
  it('impuestos pide los campos de impuesto', () => {
    expect(camposEsperados(FlujoRevision.IMPUESTOS)).toContain(CampoImpuesto.VALOR_TOTAL);
  });
  it('soat pide placa/vin', () => {
    expect(camposEsperados(FlujoRevision.SOAT)).toContain('placa');
  });
});

// ───────────────────────────── resolver — enrutamiento y guardas ─────────────

describe('resolver — guardas', () => {
  const ctx = { userId: 1, username: 'op', role: 'admin' };

  it('404 si la revisión no existe', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(resolver('r1', 's1', {}, 'motivo', ctx)).rejects.toMatchObject({ status: 404 });
  });

  it('400 si ya está resuelta', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'r1', resuelto: true, modulo: FlujoRevision.SOAT, extraccion: {}, soporteId: 's1', motivo: 'x' }]));
    await expect(resolver('r1', 'x', {}, 'm', ctx)).rejects.toMatchObject({ status: 400 });
  });

  it('400 si falta el motivo', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.SOAT, extraccion: {}, soporteId: 's1', motivo: 'x' }]));
    await expect(resolver('r1', 'x', {}, '   ', ctx)).rejects.toMatchObject({ status: 400 });
  });
});

describe('resolver — SOAT delega en marcarPagado tras atar el soporte', () => {
  const ctx = { userId: 1, username: 'op', role: 'admin' };
  it('con SOAT en adquisición: ata soporte y llama marcarPagado', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.SOAT, extraccion: {}, soporteId: 's1', motivo: 'sin_llave' }]))
      .mockReturnValueOnce(chain([{ id: 'soat1', estado: EstadoSoat.SOLICITADO }]));
    await resolver('r1', 'soat1', { placa: 'QTQ100' }, 'valida', ctx);
    expect(marcarPagadoMock).toHaveBeenCalledOnce();
    expect(marcarPagadoMock.mock.calls[0][0]).toBe('soat1');
  });

  it('400 si el SOAT no está en adquisición', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.SOAT, extraccion: {}, soporteId: 's1', motivo: 'x' }]))
      .mockReturnValueOnce(chain([{ id: 'soat1', estado: EstadoSoat.PAGADO }]));
    await expect(resolver('r1', 'soat1', {}, 'm', ctx)).rejects.toMatchObject({ status: 400 });
    expect(marcarPagadoMock).not.toHaveBeenCalled();
  });
});

describe('resolver — impuesto en gestión pasa a pagado; factura de venta reactiva a pendiente', () => {
  const ctx = { userId: 1, username: 'op', role: 'admin' };

  it('impuesto EN_GESTION → no lanza (transición a pagado en tx)', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.IMPUESTOS, extraccion: {}, soporteId: 's1', motivo: 'x' }]))
      .mockReturnValueOnce(chain([{ id: 'imp1', estado: EstadoImpuesto.SOLICITADO, valorLiquidado: '100' }]));
    await expect(resolver('r1', 'imp1', { [CampoImpuesto.VALOR_TOTAL]: '634900' }, 'valida', ctx)).resolves.toBeUndefined();
    expect(transactionMock).toHaveBeenCalled();
  });

  it('impuesto que no está en gestión ni pagado → 400', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.IMPUESTOS, extraccion: {}, soporteId: 's1', motivo: 'x' }]))
      .mockReturnValueOnce(chain([{ id: 'imp1', estado: EstadoImpuesto.PENDIENTE, valorLiquidado: null }]));
    await expect(resolver('r1', 'imp1', {}, 'm', ctx)).rejects.toMatchObject({ status: 400 });
  });

  it('factura de venta contra impuesto que ya no espera factura (ya solicitado) → 400', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.FACTURA_VENTA, extraccion: {}, soporteId: 's1', motivo: 'cruce_ambiguo' }]))
      .mockReturnValueOnce(chain([{ id: 'imp1', estado: EstadoImpuesto.SOLICITADO }]));
    await expect(resolver('r1', 'imp1', {}, 'm', ctx)).rejects.toMatchObject({ status: 400 });
  });
});

describe('descartar — exige motivo ≥5 y marca el soporte descartado (libera el hash)', () => {
  const ctx = { userId: 1, username: 'op', role: 'admin' };
  it('400 si el motivo es corto', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.SOAT, soporteId: 's1', motivo: 'x' }]));
    await expect(descartar('r1', 'no', ctx)).rejects.toMatchObject({ status: 400 });
  });
  it('con motivo válido: marca la revisión resuelta y el soporte descartado', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'r1', resuelto: false, modulo: FlujoRevision.SOAT, soporteId: 's1', motivo: 'x' }]));
    const stub = txStub();
    transactionMock.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => cb(stub.tx));
    await expect(descartar('r1', 'documento equivocado', ctx)).resolves.toBeUndefined();
    const sets = stub.calls.filter((c) => c.table === 'update').map((c) => c.set as Record<string, unknown>);
    expect(sets.some((s) => s.resuelto === true)).toBe(true);   // revisión resuelta
    expect(sets.some((s) => s.descartado === true)).toBe(true); // soporte liberado (recargable)
  });
});

// ───────────────────────────── HTTP: fronteras de rol ────────────────────────

describe('rutas — la cola es de Operaciones; los gestores no entran', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/revisiones', revisionesRoutes);

  it('un gestor de impuestos no puede leer la cola (403)', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'gestor_impuestos' });
    const res = await request(app).get('/api/flito/revisiones').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('Operaciones lista la cola (200)', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/revisiones').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('Auditoría puede leer pero no resolver (403 en resolver)', async () => {
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).post('/api/flito/revisiones/r1/resolver')
      .set('Authorization', `Bearer ${token}`)
      .send({ registroId: '00000000-0000-0000-0000-000000000001', campos: {}, motivo: 'x' });
    expect(res.status).toBe(403);
  });
});
