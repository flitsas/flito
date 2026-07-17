import { describe, it, expect } from 'vitest';
import {
  maxPasoTraspasoAlcanzable,
  pasoTraspasoCompleto,
  puedeIrAPasoTraspaso,
  gateFurTraspaso,
  validateTraspasoComercial,
  reconciliarPasoTraspasoBD,
  hintReconciliacionPasoTraspaso,
} from '../src/traspaso-gates.js';

const baseCtx = {
  tramiteId: 21,
  vehiculo: {
    _vendedor: { nombre: 'V', documento: '111', email: 'v@x.co' },
    _runtVendedor: { documento: '111', consultado: true },
    _comprador: { nombre: 'C', documento: '222', email: 'c@x.co' },
    _runtComprador: { documento: '222', consultado: true },
    _simitComprador: { documento: '222', consultado: true, total: 0 },
    _comercial: { valorVenta: 50_000_000 },
  },
  comprador: { documento: '222', nombre: 'C', email: 'c@x.co' },
  preflight: { overall: 'green', checks: [{ key: 'impuesto_vehicular', status: 'ok' }] },
  pazSalvoImpuesto: { verificado: true },
  pasoActual: 1,
};

describe('traspaso-gates', () => {
  it('bloquea paso 2 con preflight red', () => {
    const r = pasoTraspasoCompleto(2, {
      ...baseCtx,
      preflight: { overall: 'red', checks: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('preflight_red');
  });

  it('forzarContinuar bypass preflight red', () => {
    const r = pasoTraspasoCompleto(2, {
      ...baseCtx,
      preflight: { overall: 'red', checks: [] },
      vehiculo: { ...baseCtx.vehiculo, _forzarContinuar: { at: '2026-01-01', userId: 1 } },
    });
    expect(r.ok).toBe(true);
  });

  it('bloquea comercial con valor 0', () => {
    const r = validateTraspasoComercial({ _comercial: { valorVenta: 0 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('comercial_valor');
  });

  it('max paso alcanzable sin comercial = 5', () => {
    const max = maxPasoTraspasoAlcanzable({
      ...baseCtx,
      vehiculo: { ...baseCtx.vehiculo, _comercial: { valorVenta: 0 } },
    });
    expect(max).toBe(5);
  });

  it('sidebar bloquea salto a paso 5 sin completar SIMIT (paso 4)', () => {
    const r = puedeIrAPasoTraspaso({
      ...baseCtx,
      pasoActual: 3,
      targetPaso: 5,
      vehiculo: {
        ...baseCtx.vehiculo,
        _simitComprador: { documento: '222', consultado: false },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('simit_pendiente');
  });

  it('retroceder en sidebar permitido', () => {
    const r = puedeIrAPasoTraspaso({ ...baseCtx, pasoActual: 5, targetPaso: 2 });
    expect(r.ok).toBe(true);
  });

  it('legacy paso 5 comprador → reconciliar a 4', () => {
    const { _comercial: _omit, ...vehSinComercial } = baseCtx.vehiculo as Record<string, unknown>;
    void _omit;
    const paso = reconciliarPasoTraspasoBD({
      tramiteId: 21,
      vehiculo: vehSinComercial,
      comprador: baseCtx.comprador,
      preflight: baseCtx.preflight,
      pazSalvoImpuesto: baseCtx.pazSalvoImpuesto,
    });
    expect(paso).toBe(5);
    const legacy = reconciliarPasoTraspasoBD({
      tramiteId: 21,
      vehiculo: { _vendedor: baseCtx.vehiculo._vendedor, _runtVendedor: baseCtx.vehiculo._runtVendedor },
      comprador: {},
      preflight: baseCtx.preflight,
    });
    expect(legacy).toBe(4);
    expect(hintReconciliacionPasoTraspaso(5, 4, {})).toMatch(/legacy.*comprador/i);
  });

  it('FUR requiere biométrica salvo forzarContinuar', () => {
    expect(gateFurTraspaso(baseCtx.vehiculo, { vendedor: false, comprador: false }).ok).toBe(false);
    expect(gateFurTraspaso(baseCtx.vehiculo, { vendedor: true, comprador: true }).ok).toBe(true);
    expect(gateFurTraspaso(
      { ...baseCtx.vehiculo, _forzarContinuar: { at: '2026-01-01' } },
      { vendedor: false, comprador: false },
    ).ok).toBe(true);
  });
});
