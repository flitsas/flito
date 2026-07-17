import { describe, it, expect } from 'vitest';
import { deriveImpuestoVehicularCheck } from '../../src/modules/tramites/preflight.js';

describe('deriveImpuestoVehicularCheck', () => {
  it('paz y salvo verificado → ok', () => {
    const c = deriveImpuestoVehicularCheck({ _pazSalvoImpuesto: { verificado: true, metodo: 'consulta' } });
    expect(c.status).toBe('ok');
  });

  it('consulta con deuda → warn', () => {
    const c = deriveImpuestoVehicularCheck({
      _impuestoConsulta: { fuente: 'Gobernación Antioquia', datos: { totalPagar: 500_000, estadoPago: 'Pendiente' } },
    });
    expect(c.status).toBe('warn');
  });

  it('sin datos → unknown', () => {
    const c = deriveImpuestoVehicularCheck({});
    expect(c.status).toBe('unknown');
  });
});
