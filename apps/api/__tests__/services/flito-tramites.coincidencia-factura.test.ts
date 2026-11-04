// HU #14293 AC8 — la «coincidencia» de la factura en la bandeja de Trámites recorre TODAS las claves
// del jsonb y se queda con la confianza mínima. Número, fecha y avalúo se muestran y no deciden: un
// avalúo ausente (confianza 0) no puede bajarla. Valores inventados.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { coincidenciaDe } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

const campo = (confianza: number) => ({ valor: 'x', confianza, confiable: confianza >= 0.85 });
const lectura = { vin: campo(1), marca: campo(1), direccion: campo(0.9), fuente: 'notas_finales' };

describe('coincidenciaDe', () => {
  it('da lo mismo sin los tres datos, con ellos fiables y con ellos ausentes', () => {
    const base = coincidenciaDe(lectura);
    expect(base).toBe(0.9);
    expect(coincidenciaDe({ ...lectura, numeroFactura: campo(1), fechaFactura: campo(1), avaluoComercial: campo(1) })).toBe(base);
    expect(coincidenciaDe({ ...lectura, numeroFactura: campo(0), fechaFactura: campo(0.5), avaluoComercial: campo(0) })).toBe(base);
  });

  it('los campos de siempre siguen mandando', () => {
    expect(coincidenciaDe({ ...lectura, marca: campo(0.3), avaluoComercial: campo(1) })).toBe(0.3);
    expect(coincidenciaDe(null)).toBeNull();
  });
});
