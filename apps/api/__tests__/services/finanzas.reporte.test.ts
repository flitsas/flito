// HU #10966 — reporte de costos con valores reales (Feature #10941).
//
// El módulo `finanzas` no tenía NINGÚN test pese a ser el que alimenta la conciliación con
// contabilidad. Aquí se cubre lo que es puro; el SQL —que es casi todo el servicio— se verifica
// contra Postgres real, porque el helper `chain()` descarta los argumentos de `where()` y no
// distingue un CASE bien escrito de uno que devuelve siempre NULL.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { aCsv } = await import('../../src/modules/finanzas/finanzas.service.js');

type Fila = Parameters<typeof aCsv>[0][number];

function fila(over: Partial<Fila> = {}): Fila {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME',
    tipoTramite: 'Traspaso', soat: 450000, impuesto: 120000, derechoTramite: 80000,
    logistica: 15000, tramiteDigital: 200000, gmf: 2600, total: 867600,
    sellada: true, estadoLiquidacion: 'liquidado', noConfigurados: [],
    ...over,
  };
}

describe('aCsv — el archivo que abre contabilidad', () => {
  it('usa punto y coma y BOM, que es lo que Excel en español abre sin asistente', () => {
    const csv = aCsv([fila()]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')[0]).toContain('Trámite;Placa');
  });

  it('distingue sellado, facturado y estimado', () => {
    const csv = aCsv([
      fila({ estadoLiquidacion: 'liquidado' }),
      fila({ estadoLiquidacion: 'facturado' }),
      fila({ sellada: false, estadoLiquidacion: null }),
    ]);
    const filas = csv.trim().split('\r\n').slice(1);
    expect(filas[0]).toContain('Liquidado');
    expect(filas[1]).toContain('Facturado');
    expect(filas[2]).toContain('Estimado');
  });

  it('un concepto no configurado sale vacío, no como cero', () => {
    // Un cero en el CSV se sumaría en la hoja de cálculo y cuadraría un total que no existe.
    const csv = aCsv([fila({ tramiteDigital: null, noConfigurados: ['Trámite digital'] })]);
    const celdas = csv.trim().split('\r\n')[1].split(';');
    expect(celdas).toContain('');
    expect(csv).toContain('Trámite digital');
    expect(celdas.filter((c) => c === '0')).toHaveLength(0);
  });

  it('escapa las comillas y entrecomilla lo que lleva el separador', () => {
    // Una empresa llamada «GÓMEZ; HIJOS» partiría la fila en dos columnas sin esto.
    const csv = aCsv([fila({ empresa: 'GÓMEZ; HIJOS', placa: 'A"B' })]);
    expect(csv).toContain('"GÓMEZ; HIJOS"');
    expect(csv).toContain('"A""B"');
  });

  it('lista los conceptos sin configurar en su propia columna', () => {
    const csv = aCsv([fila({ sellada: false, estadoLiquidacion: null, noConfigurados: ['Derecho de tránsito', 'Logística'] })]);
    expect(csv).toContain('Derecho de tránsito | Logística');
  });

  it('sin filas devuelve solo la cabecera', () => {
    expect(aCsv([]).trim().split('\r\n')).toHaveLength(1);
  });
});
