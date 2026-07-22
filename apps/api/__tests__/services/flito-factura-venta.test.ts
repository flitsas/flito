// FLITO Impuestos — factura de venta (precondición del envío, Fase 4 P1). Verifica el veredicto de
// doble llave (VIN obligatorio + placa) y las fronteras de ruta (RBAC, no-cruce no se guarda, baja
// confianza va a revisión, cruce ambiguo). drizzle + OCR + storage mockeados; las invariantes de BD
// se cubren además con smoke real. Ver docs §6.5 / Anexo A.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoFacturaVenta, MotivoRevision } from '@operaciones/shared-types';

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

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerFacturaVenta: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/impuestos/facturas-venta/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const { verificarFacturaVenta } = await import('../../src/modules/flito-impuestos/flito-factura-venta.service.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockClear();
});

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── verificarFacturaVenta (puro) ────────────────────

describe('verificarFacturaVenta — doble llave (VIN + placa)', () => {
  const esperado = { vin: '9BWZZZ377VT004251', placa: 'QTQ100' };
  const ok = () => ({
    [CampoFacturaVenta.VIN]: campo('9BWZZZ377VT004251', 0.95),
    [CampoFacturaVenta.PLACA]: campo('QTQ100', 0.95),
    [CampoFacturaVenta.NUMERO_FACTURA]: campo('FE-1', 0.95),
    [CampoFacturaVenta.FECHA_FACTURA]: campo('2026-07-01', 0.95),
    [CampoFacturaVenta.VALOR_VEHICULO]: campo('80000000', 0.95),
  });

  it('VIN cruza + placa cruza + campos confiables → aprobada', () => {
    expect(verificarFacturaVenta(ok(), esperado, 0.85, null)).toEqual({ aprobada: true });
  });

  it('sin VIN leído → SIN_LLAVE_DE_CRUCE (aunque la placa esté)', () => {
    const e = { ...ok(), [CampoFacturaVenta.VIN]: campo(null, 0) };
    expect(verificarFacturaVenta(e, esperado, 0.85, null).motivo).toBe(MotivoRevision.SIN_LLAVE_DE_CRUCE);
  });

  it('VIN correcto pero placa del documento contradice → LLAVE_NO_CRUZA', () => {
    const e = { ...ok(), [CampoFacturaVenta.PLACA]: campo('XYZ999', 0.95) };
    expect(verificarFacturaVenta(e, esperado, 0.85, null).motivo).toBe(MotivoRevision.LLAVE_NO_CRUZA);
  });

  it('VIN correcto, sin placa en doc, pero la placa del NOMBRE contradice → LLAVE_NO_CRUZA', () => {
    const e = { ...ok(), [CampoFacturaVenta.PLACA]: campo(null, 0) };
    expect(verificarFacturaVenta(e, esperado, 0.85, 'XYZ999').motivo).toBe(MotivoRevision.LLAVE_NO_CRUZA);
  });

  it('VIN de otro carro → LLAVE_NO_CRUZA', () => {
    const e = { ...ok(), [CampoFacturaVenta.VIN]: campo('OTROVIN0000000000', 0.95) };
    expect(verificarFacturaVenta(e, esperado, 0.85, null).motivo).toBe(MotivoRevision.LLAVE_NO_CRUZA);
  });

  it('cruza pero valorVehiculo bajo umbral → CONFIANZA_INSUFICIENTE', () => {
    const e = { ...ok(), [CampoFacturaVenta.VALOR_VEHICULO]: campo('80000000', 0.3) };
    const v = verificarFacturaVenta(e, esperado, 0.85, null);
    expect(v.aprobada).toBe(false);
    expect(v.motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
    expect(v.detalle).toContain(CampoFacturaVenta.VALOR_VEHICULO);
  });

  it('VIN cruza pero con confianza baja → CONFIANZA_INSUFICIENTE (vin listado)', () => {
    const e = { ...ok(), [CampoFacturaVenta.VIN]: campo('9BWZZZ377VT004251', 0.3) };
    const v = verificarFacturaVenta(e, esperado, 0.85, null);
    expect(v.motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
    expect(v.detalle).toContain('vin');
  });
});

// ─────────────────────────── Rutas ───────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 3, username: 'ops@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-0000000000aa';

// Fila de SELECT_DATOS (join impuesto→tramite→vehicle, clients, organismo).
const datosSinFactura = {
  impuestoId: UUID, estado: 'sin_factura', tramiteIdFlit: 'FLIT-1', vin: '9BWZZZ377VT004251', placa: 'QTQ100',
  companiaId: 1, document: '900', carpeta: null, umbralOcr: null, facturaVentaSoporteId: null,
};
const extraccionCruza = {
  [CampoFacturaVenta.VIN]: campo('9BWZZZ377VT004251', 0.95), [CampoFacturaVenta.PLACA]: campo('QTQ100', 0.95),
  [CampoFacturaVenta.NUMERO_FACTURA]: campo('FE-1', 0.95), [CampoFacturaVenta.FECHA_FACTURA]: campo('2026-07-01', 0.95),
  [CampoFacturaVenta.VALOR_VEHICULO]: campo('80000000', 0.95),
};

describe('factura de venta — RBAC', () => {
  it('gestor_impuestos → POST /:id/factura-venta 403 (no carga preconditiones)', async () => {
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/factura-venta`)
      .set('Authorization', await auth('gestor_impuestos')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
  it('auditor → POST /facturas-venta 403', async () => {
    const r = await request(await buildApp()).post('/api/flito/impuestos/facturas-venta')
      .set('Authorization', await auth('auditor')).attach('archivos', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
});

describe('factura de venta — carga individual', () => {
  it('cruza y confiable → sin_factura→pendiente (200, aceptada)', async () => {
    selectMock.mockReturnValueOnce(chain([datosSinFactura])); // porId
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([])); // soporte + audit
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/factura-venta`)
      .set('Authorization', await auth('operaciones')).attach('archivo', Buffer.from('%PDF'), 'QTQ100-ENVIGADO.pdf');

    expect(r.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1); // aceptar → PENDIENTE
  });

  it('el VIN no corresponde → 400 y NO se guarda', async () => {
    selectMock.mockReturnValueOnce(chain([datosSinFactura]));
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoFacturaVenta.VIN]: campo('OTROVIN0000000000', 0.95) });
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/factura-venta`)
      .set('Authorization', await auth('operaciones')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('impuesto que ya no está SIN_FACTURA → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...datosSinFactura, estado: 'pendiente' }]));
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/factura-venta`)
      .set('Authorization', await auth('operaciones')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
  });

  it('cruza pero baja confianza → se guarda y va a revisión (409, CA-06)', async () => {
    selectMock.mockReturnValueOnce(chain([datosSinFactura]));
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoFacturaVenta.VALOR_VEHICULO]: campo('80000000', 0.3) });
    const txInsert = vi.fn()
      .mockReturnValueOnce(chain([{ id: 'sop1' }])) // soporte
      .mockReturnValueOnce(chain([]))                // revisión
      .mockReturnValueOnce(chain([]));               // audit
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: txUpdate }));

    const r = await request(await buildApp()).post(`/api/flito/impuestos/${UUID}/factura-venta`)
      .set('Authorization', await auth('operaciones')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');

    expect(r.status).toBe(409);           // quedó cargada + en revisión
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(txUpdate).not.toHaveBeenCalled(); // NO pasó a pendiente
  });
});

describe('factura de venta — carga masiva', () => {
  it('dos trámites del mismo vehículo esperando factura → CRUCE_AMBIGUO (revisión)', async () => {
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    // buscarPorLlave → 2 candidatos, ambos sin_factura
    selectMock.mockReturnValueOnce(chain([
      datosSinFactura,
      { ...datosSinFactura, impuestoId: '00000000-0000-0000-0000-0000000000bb', tramiteIdFlit: 'FLIT-2' },
    ]));
    const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop1' }])).mockReturnValueOnce(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ insert: txInsert, update: vi.fn() }));

    const r = await request(await buildApp()).post('/api/flito/impuestos/facturas-venta')
      .set('Authorization', await auth('operaciones')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');

    expect(r.status).toBe(200);
    expect(r.body.enRevision).toHaveLength(1);
    expect(r.body.conciliados).toHaveLength(0);
  });

  it('VIN/placa que no cruza con ningún trámite → noAsociados, no se guarda', async () => {
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    selectMock.mockReturnValueOnce(chain([])); // buscarPorLlave vacío
    const r = await request(await buildApp()).post('/api/flito/impuestos/facturas-venta')
      .set('Authorization', await auth('operaciones')).attach('archivos', Buffer.from('%PDF'), 'QTQ100.pdf');
    expect(r.status).toBe(200);
    expect(r.body.noAsociados).toHaveLength(1);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
