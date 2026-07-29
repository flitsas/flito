// Finanzas — el reporte de costos usa el derecho de trámite REAL del recibo (HU #10953).
//
// Antes, COSTOS_FIJOS.derechoTramite (75.000) se sumaba a todos los trámites por igual. Ahora manda
// el valor leído del recibo del organismo y el fijo queda como respaldo. Lo que se prueba aquí es
// exactamente esa regla de precedencia y que un registro sin valor NO tumbe el total a cero.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { derechoDe, reporteCostos, COSTOS_FIJOS } = await import('../../src/modules/finanzas/finanzas.service.js');

beforeEach(() => { selectMock.mockReset(); });

describe('derechoDe — precedencia del valor real sobre el fijo', () => {
  it('con valor del recibo → ese valor, marcado como real', () => {
    expect(derechoDe('236700.00')).toEqual({ valor: 236700, esReal: true });
  });

  it('sin registro (null) → el fijo, marcado como estimado', () => {
    expect(derechoDe(null)).toEqual({ valor: COSTOS_FIJOS.derechoTramite, esReal: false });
  });

  it('registro sin valor leído (OCR en revisión) → el fijo, no cero', () => {
    // Caer a 0 descuadraría el total hacia abajo: peor que el estimado que ya se tenía.
    expect(derechoDe(undefined)).toEqual({ valor: COSTOS_FIJOS.derechoTramite, esReal: false });
    expect(derechoDe('0')).toEqual({ valor: COSTOS_FIJOS.derechoTramite, esReal: false });
  });

  it('valor no numérico → el fijo, nunca NaN', () => {
    const r = derechoDe('no-es-un-numero');
    expect(Number.isFinite(r.valor)).toBe(true);
    expect(r).toEqual({ valor: COSTOS_FIJOS.derechoTramite, esReal: false });
  });
});

describe('reporteCostos — el total de cada fila usa el derecho que corresponde', () => {
  const fila = (derechoValor: string | null) => ({
    tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'QTP701', estado: 'Asignado', empresa: 'Norte',
    soatPagado: '450000', impuestoPagado: '120000', impuestoLiquidado: null, derechoValor,
  });

  /** El servicio hace dos consultas: primero el count, después la página. */
  function mockConsultas(rows: unknown[]) {
    selectMock
      .mockReturnValueOnce(chain([{ total: rows.length }]))
      .mockReturnValueOnce(chain(rows));
  }

  it('AC1 — con recibo cargado, el valor real entra en la fila y en los totales', async () => {
    mockConsultas([fila('236700.00')]);
    const r = await reporteCostos();

    expect(r.items[0].derechoTramite).toBe(236700);
    expect(r.items[0].derechoTramiteEsReal).toBe(true);
    // 450.000 SOAT + 120.000 impuesto + 236.700 derecho + fijos
    const esperado = 450000 + 120000 + 236700 + COSTOS_FIJOS.logistica + COSTOS_FIJOS.tramiteDigital + COSTOS_FIJOS.gmf;
    expect(r.items[0].total).toBe(esperado);
    expect(r.totales.derechoTramite).toBe(236700);
    expect(r.totales.total).toBe(esperado);
  });

  it('AC2 — sin recibo cargado, cae al fijo y la fila queda marcada como estimada', async () => {
    mockConsultas([fila(null)]);
    const r = await reporteCostos();

    expect(r.items[0].derechoTramite).toBe(COSTOS_FIJOS.derechoTramite);
    expect(r.items[0].derechoTramiteEsReal).toBe(false);
  });

  it('los totales suman fila a fila, mezclando reales y estimados', async () => {
    mockConsultas([fila('236700.00'), { ...fila(null), tramiteId: 't2', idFlit: 'FLIT-1002' }]);
    const r = await reporteCostos();

    expect(r.items).toHaveLength(2);
    expect(r.totales.derechoTramite).toBe(236700 + COSTOS_FIJOS.derechoTramite);
    expect(r.totales.total).toBe(r.items[0].total + r.items[1].total);
  });
});
