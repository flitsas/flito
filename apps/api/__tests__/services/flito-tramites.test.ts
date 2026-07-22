// FLITO Trámites unificado (Fase 5 P3). Verifica que NO duplica lógica: delega el envío en
// SOAT/Impuestos y la entrega en Compuerta. Prueba la dedup por SOAT (RN-01), la clasificación de
// impuestos por estado, la captura de no-habilitados en la entrega en lote, y las fronteras de rol.
// decidir() (compuerta) se mantiene REAL; el resto de lo delegado se mockea.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { EstadoImpuesto } from '@operaciones/shared-types';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const enviarSoatMock = vi.fn().mockResolvedValue({ enviados: [], yaEnviados: [] });
const enviarImpuestosMock = vi.fn().mockResolvedValue({ enviados: [], yaEnviados: [] });
const entregarCompuertaMock = vi.fn().mockResolvedValue({});
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: enviarSoatMock }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: enviarImpuestosMock }));
// Mantener decidir() real; override solo entregar().
vi.mock('../../src/modules/flito-compuerta/flito-compuerta.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, entregar: entregarCompuertaMock };
});

const { listar, solicitarSoat, solicitarImpuestos, entregar } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');
const { default: tramitesRoutes } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');

const ctx = { userId: 1, username: 'op', role: 'operaciones' };

beforeEach(() => {
  selectMock.mockReset();
  enviarSoatMock.mockClear().mockResolvedValue({ enviados: [], yaEnviados: [] });
  enviarImpuestosMock.mockClear().mockResolvedValue({ enviados: [], yaEnviados: [] });
  entregarCompuertaMock.mockClear().mockResolvedValue({});
});

// ───────────────────────────── solicitarSoat — dedup + clasificación ─────────

describe('solicitarSoat — deduplica por SOAT (RN-01) y clasifica', () => {
  it('dos trámites del mismo VIN comparten soatId → se envía una vez', async () => {
    selectMock.mockReturnValueOnce(chain([
      { soatId: 'soat-A', soatAutogestionable: false },
      { soatId: 'soat-A', soatAutogestionable: false },
      { soatId: 'soat-B', soatAutogestionable: false },
    ]));
    enviarSoatMock.mockResolvedValueOnce({ enviados: ['soat-A', 'soat-B'], yaEnviados: [] });
    const r = await solicitarSoat(['t1', 't2', 't3'], 'prov1', ctx);
    const idsEnviados = enviarSoatMock.mock.calls[0][0] as string[];
    expect(idsEnviados.sort()).toEqual(['soat-A', 'soat-B']);
    expect(r.enviados).toBe(2);
  });

  it('cuenta autogestionados y sin registro sin mandarlos al gestor', async () => {
    selectMock.mockReturnValueOnce(chain([
      { soatId: null, soatAutogestionable: true },
      { soatId: null, soatAutogestionable: false },
      { soatId: 'soat-C', soatAutogestionable: false },
    ]));
    enviarSoatMock.mockResolvedValueOnce({ enviados: ['soat-C'], yaEnviados: [] });
    const r = await solicitarSoat(['t1', 't2', 't3'], 'prov1', ctx);
    expect(r).toMatchObject({ autogestionados: 1, sinRegistro: 1, enviados: 1 });
    expect(enviarSoatMock.mock.calls[0][0]).toEqual(['soat-C']);
    expect(enviarSoatMock.mock.calls[0][2]).toBe('prov1'); // proveedor fijado
  });
});

// ───────────────────────────── solicitarImpuestos — clasificación ───────────

describe('solicitarImpuestos — solo los Pendientes van al gestor; el resto se reporta', () => {
  it('clasifica por estado del impuesto', async () => {
    selectMock.mockReturnValueOnce(chain([
      { tramiteId: 't1', idFlit: 'F1', placa: 'AAA111', impuestoId: 'i1', impuestoEstado: EstadoImpuesto.PENDIENTE },
      { tramiteId: 't2', idFlit: 'F2', placa: 'BBB222', impuestoId: 'i2', impuestoEstado: EstadoImpuesto.SIN_FACTURA },
      { tramiteId: 't3', idFlit: 'F3', placa: 'CCC333', impuestoId: 'i3', impuestoEstado: EstadoImpuesto.RETENIDO },
      { tramiteId: 't4', idFlit: 'F4', placa: 'DDD444', impuestoId: 'i4', impuestoEstado: EstadoImpuesto.NO_APLICA },
      { tramiteId: 't5', idFlit: 'F5', placa: 'EEE555', impuestoId: null, impuestoEstado: null },
    ]));
    enviarImpuestosMock.mockResolvedValueOnce({ enviados: ['i1'], yaEnviados: [] });
    const r = await solicitarImpuestos(['t1', 't2', 't3', 't4', 't5'], ctx);
    expect(enviarImpuestosMock.mock.calls[0][0]).toEqual(['i1']);
    expect(r.enviados).toBe(1);
    expect(r.requierenFactura).toHaveLength(1);
    expect(r.retenidos).toHaveLength(1);
    expect(r.noAplica).toBe(1);
  });
});

// ───────────────────────────── entregar — lote resiliente ───────────────────

describe('entregar — un fallo no aborta el lote; se reporta con motivo', () => {
  it('entrega los habilitados y captura los no habilitados', async () => {
    entregarCompuertaMock
      .mockResolvedValueOnce({})                                   // t1 ok
      .mockRejectedValueOnce(new Error('El trámite no está habilitado para entrega. ...')); // t2 falla
    selectMock.mockReturnValueOnce(chain([{ idFlit: 'F2', placa: 'BBB222' }])); // recarga para el reporte
    const r = await entregar(['t1', 't2'], ctx);
    expect(r.entregados).toBe(1);
    expect(r.noHabilitados).toHaveLength(1);
    expect(r.noHabilitados[0]).toMatchObject({ tramiteId: 't2', idFlit: 'F2', placa: 'BBB222' });
    expect(r.noHabilitados[0].motivo).toMatch(/no está habilitado/i);
  });
});

// ───────────────────────────── listar — mapeo ───────────────────────────────

describe('listar — arma la fila con veredicto real y compradores', () => {
  it('mapea vehículo, organismo (alias) y ordena compradores por orden', async () => {
    const fila = {
      tramiteId: 't1', idFlit: 'F1', estadoTramite: 'asignado', placa: 'QTQ100', companiaNombre: 'ACME',
      soatAutogestionable: true, impuestosAutogestionable: false,
      soatEstado: null, soatValorPagado: null, soatExtraccion: null,
      impuestoEstado: 'no_aplica', impuestoValorPagado: null, impuestoMarcadoPorDiferencia: false, impuestoExtraccion: null,
      sincronizadoEn: new Date('2026-07-01T00:00:00Z'), organismoAlias: 'Tránsito X', organismoCodigo: '11001',
      vin: 'VIN123', marca: 'Renault', linea: 'Logan', tipoVehiculo: 'automovil',
      soatId: null, soatProveedorId: null, soatProveedorNombre: null, soatSlaHoras: null, soatEnviadoEn: null, soatMotivoRechazo: null,
      impuestoId: 'i1', impuestoFacturaVentaSoporteId: null, impuestoExtraccionFacturaVenta: null,
      impuestoValorLiquidado: null, impuestoEnviadoEn: null, impuestoMotivoRechazo: null,
    };
    selectMock
      .mockReturnValueOnce(chain([fila]))  // proyeccion
      .mockReturnValueOnce(chain([         // compradores
        { tramiteId: 't1', nombreCompleto: 'B', numeroDocumento: '2', correo: null, celular: null, direccion: null, orden: 1, porcentajeParticipacion: null },
        { tramiteId: 't1', nombreCompleto: 'A', numeroDocumento: '1', correo: null, celular: null, direccion: null, orden: 0, porcentajeParticipacion: null },
      ]));
    const [f] = await listar();
    expect(f.organismoNombre).toBe('Tránsito X');
    expect(f.vehiculo).toMatchObject({ marca: 'Renault', linea: 'Logan' });
    expect(f.compradorPrincipal?.numeroDocumento).toBe('1'); // orden 0 primero
    expect(f.soatAutogestionado).toBe(true);
    // compañía autogestiona SOAT + impuesto no_aplica + asignado ⇒ listo para entregar (decidir real)
    expect(f.listoParaEntregar).toBe(true);
  });
});

// ───────────────────────────── rutas — fronteras de rol ─────────────────────

describe('rutas — lectura Operaciones/Auditoría; acciones solo Operaciones; gestores fuera', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/tramites', tramitesRoutes);

  it('un gestor SOAT no ve la tabla (403)', async () => {
    const token = await testToken({ role: 'proveedor' });
    const res = await request(app).get('/api/flito/tramites').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('Auditoría lee (200) pero no solicita SOAT (403)', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'auditor' });
    const lee = await request(app).get('/api/flito/tramites').set('Authorization', `Bearer ${token}`);
    expect(lee.status).toBe(200);
    const solicita = await request(app).post('/api/flito/tramites/solicitar-soat')
      .set('Authorization', `Bearer ${token}`)
      .send({ tramiteIds: ['00000000-0000-0000-0000-000000000001'], proveedorSoatId: '00000000-0000-0000-0000-000000000002' });
    expect(solicita.status).toBe(403);
  });

  it('Operaciones con body inválido → 400', async () => {
    const token = await testToken({ role: 'operaciones' });
    const res = await request(app).post('/api/flito/tramites/entregar')
      .set('Authorization', `Bearer ${token}`).send({ tramiteIds: [] });
    expect(res.status).toBe(400);
  });
});
