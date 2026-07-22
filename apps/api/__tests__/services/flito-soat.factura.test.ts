// FLITO SOAT — carga de factura → Pagado (Fase 3, cierra Fase 2 3/3). Verifica el veredicto (RN-04/
// CA-06), y las fronteras de la ruta (RBAC, dedup CA-08, OCR caído, no-cruce). Las invariantes de BD
// (pago atómico + soporte, RN-03) se cubren además con smoke real contra Postgres (como Fase 1-2):
// aquí drizzle está mockeado. Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §8/Anexo A.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoSoat, MotivoRevision } from '@operaciones/shared-types';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

// Motor OCR y storage mockeados: los tests prueban el FLUJO, no la lectura ni la subida real.
const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerFacturaSoat: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/soat/facturas/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

const { evaluarExtraccionSoat } = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockClear();
});

// Campo confiable/no confiable de ayuda.
const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── evaluarExtraccionSoat (puro) ────────────────────

describe('evaluarExtraccionSoat — veredicto (RN-04/CA-06)', () => {
  const esperado = { vin: '9BWZZZ377VT004251', placa: 'QTQ100' };
  const completa = () => ({
    [CampoSoat.PLACA]: campo('QTQ100', 0.95),
    [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
    [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95),
    [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
    [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
  });

  it('todo confiable y la llave cruza → aprobada', () => {
    expect(evaluarExtraccionSoat(completa(), esperado, 0.85)).toEqual({ aprobada: true });
  });

  it('sin placa ni VIN → SIN_LLAVE_DE_CRUCE', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo(null, 0), [CampoSoat.VIN]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.SIN_LLAVE_DE_CRUCE);
  });

  it('placa y VIN leídos pero ninguno cruza → LLAVE_NO_CRUZA', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo('XYZ999', 0.95), [CampoSoat.VIN]: campo('OTRO', 0.95) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.LLAVE_NO_CRUZA);
  });

  it('cruza por VIN aunque la placa no se haya leído → aprobada', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85)).toEqual({ aprobada: true });
  });

  it('un requerido bajo umbral → CONFIANZA_INSUFICIENTE (no se paga, va a revisión)', () => {
    const e = { ...completa(), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.6) };
    const v = evaluarExtraccionSoat(e, esperado, 0.85);
    expect(v.aprobada).toBe(false);
    expect(v.motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
    expect(v.detalle).toContain(CampoSoat.VALOR_TOTAL);
  });

  it('la llave cruza pero con confianza baja → CONFIANZA_INSUFICIENTE', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo('QTQ100', 0.3), [CampoSoat.VIN]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
  });

  it('vigencia/expedición ausentes NO bloquean (D-7): siguen aprobando', () => {
    // completa() no trae vigencia ni expedición y aun así aprueba.
    expect(evaluarExtraccionSoat(completa(), esperado, 0.85).aprobada).toBe(true);
  });

  it('umbral del proveedor más laxo (0.5) aprueba lo que 0.85 mandaría a revisión', () => {
    const e = { ...completa(), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.6), [CampoSoat.PLACA]: campo('QTQ100', 0.6) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).aprobada).toBe(false);
    expect(evaluarExtraccionSoat(e, esperado, 0.5).aprobada).toBe(true);
  });
});

// ─────────────────────────── Rutas de carga ──────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 7, username: 'gestor@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-000000000001';

const soatEnAdquisicion = { soat: { id: UUID, vin: '9BWZZZ377VT004251', estado: 'en_adquisicion', proveedorSoatId: null, extraccion: null, pagadoEn: null }, soatAutogestionable: false };
const datosCarga = [{ soatId: UUID, vin: '9BWZZZ377VT004251', estado: 'en_adquisicion', placa: 'QTQ100', companiaId: 1, document: '900', carpeta: null, umbralOcr: null }];
const extraccionCruza = {
  [CampoSoat.PLACA]: campo('QTQ100', 0.95), [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
  [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
  [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
};

describe('flito-soat carga factura — RBAC y validación', () => {
  it('auditor (solo lectura) → POST /:id/factura 403', async () => {
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('auditor')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
  it('gestor_impuestos → POST /facturas 403 (no participa en SOAT)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/facturas')
      .set('Authorization', await auth('gestor_impuestos')).attach('archivos', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
  it('sin archivo → 400', async () => {
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });
});

describe('flito-soat carga factura — reglas del flujo', () => {
  it('factura que no cruza → 400 y no se archiva (no se cuelga del registro equivocado)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])); // buscarConAcceso
    selectMock.mockReturnValueOnce(chain(datosCarga));          // datosCargaPorId
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoSoat.PLACA]: campo('XYZ999', 0.95), [CampoSoat.VIN]: campo('OTRO', 0.95) });

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled(); // no se subió nada
  });

  it('factura duplicada (mismo hash) → 409 (CA-08)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    selectMock.mockReturnValueOnce(chain([{ id: 'sop-previo' }])); // facturaDuplicada → existe

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(409);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('OCR no disponible → 503 (degradación)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'Servicio de IA no configurado'));

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(503);
  });

  it('SOAT que no está En adquisición → 400 (no hay factura que cargar)', async () => {
    selectMock.mockReturnValueOnce(chain([{ soat: { ...soatEnAdquisicion.soat, estado: 'pagado' }, soatAutogestionable: false }]));
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
  });

  it('factura válida que cruza y supera umbral → paga (RN-03): update a pagado + soporte, 200', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])); // buscarConAcceso
    selectMock.mockReturnValueOnce(chain(datosCarga));          // datosCargaPorId
    selectMock.mockReturnValueOnce(chain([]));                  // facturaDuplicada → no
    extraerMock.mockResolvedValueOnce(extraccionCruza);

    // Transacción: insert soporte(returning), pagarEnTx{ select count, update, insert audit }.
    const txSelect = vi.fn().mockReturnValueOnce(chain([{ n: 1 }]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn()
      .mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])) // soporte returning
      .mockReturnValueOnce(chain([]));                    // audit
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select: txSelect, update: txUpdate, insert: txInsert }));

    selectMock.mockReturnValueOnce(chain([])); // detalle → buscarConAcceso vacío → null → responde {id}

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF-real'), 'QTQ100.pdf');

    expect(r.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);   // se archivó (CA-11: storage antes de pagar)
    expect(txUpdate).toHaveBeenCalledTimes(1);      // pasó a Pagado
    expect(txInsert).toHaveBeenCalledTimes(2);      // soporte + bitácora de pago
  });

  it('factura que cruza pero con baja confianza → revisión (CA-06), NO paga', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    selectMock.mockReturnValueOnce(chain([])); // no dup
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoSoat.VALOR_TOTAL]: campo('250000', 0.3) });

    const txSelect = vi.fn();
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn()
      .mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])) // soporte
      .mockReturnValueOnce(chain([]))                     // revisión
      .mockReturnValueOnce(chain([]));                    // audit
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select: txSelect, update: txUpdate, insert: txInsert }));
    selectMock.mockReturnValueOnce(chain([])); // detalle vacío

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'QTQ100.pdf');

    expect(r.status).toBe(200);
    expect(txUpdate).not.toHaveBeenCalled();   // NO pasó a Pagado (RN-03: solo con lectura confiable)
    expect(txInsert).toHaveBeenCalledTimes(3); // soporte + revisión + bitácora "ocr a revisión" (sin pago)
  });
});
