// Regla de cobro de la logística (validación de la Épica #13758, HU #14118).
//   «Directo al cliente: se cobra la tarifa de cliente. Si va a FLIT y luego al cliente, solo se
//    cobra la tarifa de FLIT. Aparte se suman los viajes adicionales.»
// `conceptoLogistica` y `desgloseDe` son puras: aquí solo se mockea lo que sus imports arrastran.
import { describe, it, expect, vi } from 'vitest';
import type { ConceptoLogistica, LineaTrasladoLogistica } from '@operaciones/shared-types';

vi.mock('../../src/db/client.js', () => ({ db: { select: vi.fn() }, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { conceptoLogistica, baseDeLogistica } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');
const { desgloseDe } = await import('../../src/modules/finanzas/finanzas.viajes-logistica.js');

const BASE = { valor: 85000, origen: 'Tarifa de la compañía', bloquea: false, origenValor: 'tarifa' as const, diferencia: null };
const adicional = (valor = '12000') => ({
  id: 'v-2', numero: 2, modo: 'manual', valor, tarifaVigente: valor, motivo: 'devolucion', motivoDetalle: null,
  registradoPorId: 4, registradoPorNombre: 'Luis', registradoEn: new Date('2026-09-10T14:00:00Z'),
});
const linea = (destino: 'flit' | 'cliente', precio: number): LineaTrasladoLogistica => ({
  id: `l-${destino}-${precio}`, documentoId: 'd1', trasladoId: 't1', destino,
  conceptoPrecio: destino === 'cliente' ? 'logistica_cliente' : 'logistica_flit', precio, tarifaVigenciaId: null,
});
const TRAMITE = { tramiteId: 't', idFlit: 'WVP302', placa: 'WVP302' };

describe('conceptoLogistica — regla de cobro con líneas de traslado', () => {
  it('directo a cliente: $85.000 + adicional $12.000 = $97.000 (la tarifa base no se suma encima)', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, [linea('cliente', 85000)]);
    expect(c.valor).toBe(97000);
  });

  it('FLIT: llegada a FLIT (tarifa FLIT) + tramo FLIT→cliente sin cobro + adicional', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, [linea('flit', 30000), linea('cliente', 0)]);
    expect(c.valor).toBe(42000);
  });

  it('sin líneas (modelo antiguo): tarifa base + adicionales', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, []);
    expect(c.valor).toBe(97000);
    expect(c.tarifa).toBe(85000);
  });

  it('sin líneas cobrables (devuelto/anulado no llegan de trasladosDe): legado', () => {
    expect(conceptoLogistica(BASE, [], undefined).valor).toBe(85000);
  });

  it('la base se recompone igual: la tarifa y el origen sobreviven a baseDeLogistica', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, [linea('cliente', 85000)]);
    expect(baseDeLogistica(c)).toMatchObject({ valor: 85000, origen: 'Tarifa de la compañía' });
  });
});

describe('desgloseDe — lo mostrado suma el total', () => {
  it('vigente con líneas: sin tarifa base, totalViajes cuenta solo adicionales', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, [linea('cliente', 85000)]);
    const d = desgloseDe(TRAMITE, c, null);
    expect(d).toMatchObject({ tarifa: null, totalViajes: 1, totalLogistica: 97000, totalTraslados: 85000 });
  });

  it('sello anterior a la regla (valor = tarifa + líneas): conserva tarifa y total', () => {
    const c: ConceptoLogistica = {
      ...conceptoLogistica(BASE, [adicional()] as never, [linea('cliente', 85000)]), valor: 182000,
    };
    const d = desgloseDe(TRAMITE, c, '2026-10-01T00:00:00Z');
    expect(d).toMatchObject({ tarifa: 85000, totalViajes: 2, totalLogistica: 182000 });
  });

  it('sin líneas: desglose legado (tarifa + viajes)', () => {
    const c = conceptoLogistica(BASE, [adicional()] as never, []);
    expect(desgloseDe(TRAMITE, c, null)).toMatchObject({ tarifa: 85000, totalViajes: 2, totalLogistica: 97000 });
  });
});
