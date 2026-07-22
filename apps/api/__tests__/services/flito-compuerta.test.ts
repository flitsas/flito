// FLITO Compuerta (Fase 5 P2). Verifica la tabla de verdad del §10 en decidir() (puro): SOAT resuelto
// = pagado o compañía autogestiona; Impuestos resuelto = pagado o no_aplica; RETENIDO NO resuelve
// (CA-13); habilitado exige estado Asignado; valores null-vs-cero. Y entregar() revalida antes de
// escribir. drizzle + FLIT mockeados.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { EstadoImpuesto, EstadoSoat, EstadoTramiteFlito } from '@operaciones/shared-types';

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
const marcarEntregadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({ getFlitAdapter: () => ({ marcarEntregado: marcarEntregadoMock }) }));

const { decidir, entregar, registrarHabilitaciones, CompuertaError } = await import('../../src/modules/flito-compuerta/flito-compuerta.service.js');
const { default: compuertaRoutes } = await import('../../src/modules/flito-compuerta/flito-compuerta.routes.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  marcarEntregadoMock.mockClear();
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  }));
});

// Fila base: SOAT pagado + impuesto pagado + trámite asignado ⇒ habilitado.
const filaOk = () => ({
  tramiteId: 't1', idFlit: 'F1', estadoTramite: EstadoTramiteFlito.ASIGNADO, placa: 'QTQ100', companiaNombre: 'ACME',
  soatAutogestionable: false, impuestosAutogestionable: false,
  soatEstado: EstadoSoat.PAGADO, soatValorPagado: '250000', soatExtraccion: null,
  impuestoEstado: EstadoImpuesto.PAGADO, impuestoValorPagado: '634900', impuestoMarcadoPorDiferencia: false, impuestoExtraccion: null,
});

// ───────────────────────────── decidir — tabla del §10 ──────────────────────

describe('decidir — SOAT resuelto', () => {
  it('SOAT pagado resuelve', () => {
    expect(decidir(filaOk()).soatResuelto).toBe(true);
  });
  it('compañía que autogestiona SOAT resuelve aunque no haya registro', () => {
    const v = decidir({ ...filaOk(), soatAutogestionable: true, soatEstado: null, soatValorPagado: null });
    expect(v.soatResuelto).toBe(true);
    expect(v.soatDetalle).toMatch(/autogestiona/i);
  });
  it('sin registro de SOAT y sin autogestión → no resuelve', () => {
    expect(decidir({ ...filaOk(), soatEstado: null, soatValorPagado: null }).soatResuelto).toBe(false);
  });
  it('SOAT en adquisición (no pagado) → no resuelve', () => {
    expect(decidir({ ...filaOk(), soatEstado: EstadoSoat.EN_ADQUISICION }).soatResuelto).toBe(false);
  });
});

describe('decidir — Impuestos resueltos', () => {
  it('impuesto pagado resuelve', () => {
    expect(decidir(filaOk()).impuestosResueltos).toBe(true);
  });
  it('no_aplica resuelve (exención)', () => {
    expect(decidir({ ...filaOk(), impuestoEstado: EstadoImpuesto.NO_APLICA, impuestoValorPagado: null }).impuestosResueltos).toBe(true);
  });
  it('RETENIDO NO resuelve (CA-13, el peor de los dos errores)', () => {
    const v = decidir({ ...filaOk(), impuestoEstado: EstadoImpuesto.RETENIDO, impuestoValorPagado: null });
    expect(v.impuestosResueltos).toBe(false);
    expect(v.impuestosDetalle).toMatch(/retenido/i);
  });
  it('sin registro de impuesto → no resuelve', () => {
    expect(decidir({ ...filaOk(), impuestoEstado: null, impuestoValorPagado: null }).impuestosResueltos).toBe(false);
  });
  it('pagado marcado por diferencia igual resuelve, con detalle', () => {
    const v = decidir({ ...filaOk(), impuestoMarcadoPorDiferencia: true });
    expect(v.impuestosResueltos).toBe(true);
    expect(v.impuestosDetalle).toMatch(/diferencia/i);
  });
});

describe('decidir — habilitado y valores', () => {
  it('resuelto+resuelto+asignado ⇒ habilitado', () => {
    expect(decidir(filaOk()).habilitado).toBe(true);
  });
  it('trámite ya entregado nunca habilita, aunque todo esté resuelto', () => {
    expect(decidir({ ...filaOk(), estadoTramite: EstadoTramiteFlito.ENTREGADO }).habilitado).toBe(false);
  });
  it('valores solo si hubo pago; null (no cero) para exento/no pagado', () => {
    const v = decidir({ ...filaOk(), soatAutogestionable: true, soatEstado: null, soatValorPagado: null, impuestoEstado: EstadoImpuesto.NO_APLICA, impuestoValorPagado: null });
    expect(v.valorSoat).toBeNull();
    expect(v.valorImpuesto).toBeNull();
  });
  it('valores numéricos cuando se pagó', () => {
    const v = decidir(filaOk());
    expect(v.valorSoat).toBe(250000);
    expect(v.valorImpuesto).toBe(634900);
  });
});

// ───────────────────────────── entregar — revalida ──────────────────────────

describe('entregar — revalida antes de escribir', () => {
  const ctx = { userId: 1, username: 'op', role: 'operaciones' };

  it('habilitado: marca en FLIT y persiste Entregado', async () => {
    selectMock.mockReturnValueOnce(chain([filaOk()]))   // carga para entregar
      .mockReturnValueOnce(chain([{ ...filaOk(), estadoTramite: EstadoTramiteFlito.ENTREGADO }])); // evaluar de vuelta
    const dto = await entregar('t1', ctx);
    expect(marcarEntregadoMock).toHaveBeenCalledWith('F1');
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(dto.estadoTramite).toBe(EstadoTramiteFlito.ENTREGADO);
  });

  it('no habilitado (SOAT sin pagar): 400 y NO toca FLIT ni BD', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...filaOk(), soatEstado: EstadoSoat.EN_ADQUISICION }]));
    await expect(entregar('t1', ctx)).rejects.toBeInstanceOf(CompuertaError);
    expect(marcarEntregadoMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('trámite inexistente: 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(entregar('nope', ctx)).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────── registrarHabilitaciones — llamada directa (§4.4) ───────

describe('registrarHabilitaciones — deja constancia solo de los habilitados (actor sistema)', () => {
  it('escribe audit para el trámite habilitado', async () => {
    selectMock.mockReturnValueOnce(chain([filaOk()]));
    const insertValues = vi.fn().mockResolvedValue([]);
    const exec = { insert: () => ({ values: insertValues }) } as never;
    await registrarHabilitaciones({ tramiteId: 't1' }, exec);
    expect(insertValues).toHaveBeenCalledOnce();
    expect(insertValues.mock.calls[0][0]).toMatchObject({ userId: null, userEmail: 'sistema', resource: 'flito_tramite' });
  });

  it('no escribe nada si el trámite no queda habilitado', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...filaOk(), impuestoEstado: EstadoImpuesto.RETENIDO }]));
    const insertValues = vi.fn().mockResolvedValue([]);
    const exec = { insert: () => ({ values: insertValues }) } as never;
    await registrarHabilitaciones({ tramiteId: 't1' }, exec);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('carga vacía no consulta ni escribe', async () => {
    await registrarHabilitaciones({});
    expect(selectMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── rutas — fronteras de rol ─────────────────────

describe('rutas — lectura Operaciones/Auditoría; entregar solo Operaciones', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/compuerta', compuertaRoutes);

  it('Auditoría lista (200) pero no entrega (403)', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'auditor' });
    const list = await request(app).get('/api/flito/compuerta').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const entrega = await request(app).post('/api/flito/compuerta/t1/entregar').set('Authorization', `Bearer ${token}`);
    expect(entrega.status).toBe(403);
  });

  it('un gestor no ve la compuerta (403)', async () => {
    const token = await testToken({ role: 'proveedor' });
    const res = await request(app).get('/api/flito/compuerta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
