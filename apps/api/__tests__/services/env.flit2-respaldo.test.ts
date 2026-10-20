// HU #13633 AC3 — validación de FLIT2_RESPALDO_MIN en el schema Zod de env.ts.
// Cada caso re-parsea env.ts con vi.resetModules() porque `env` se evalúa al importar (patrón de env.ops08).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const VAR = 'FLIT2_RESPALDO_MIN';
const antes = process.env[VAR];

beforeEach(() => { delete process.env[VAR]; vi.resetModules(); });
afterEach(() => {
  if (antes === undefined) delete process.env[VAR];
  else process.env[VAR] = antes;
});

const cargar = async () => (await import('../../src/config/env.js')).env;

describe('HU #13633 AC3 · FLIT2_RESPALDO_MIN', () => {
  it('ausente → 5 (QA y PDN)', async () => {
    expect((await cargar()).FLIT2_RESPALDO_MIN).toBe(5);
  });

  it('vacía equivale a ausente → 5', async () => {
    process.env[VAR] = '';
    expect((await cargar()).FLIT2_RESPALDO_MIN).toBe(5);
  });

  it.each([['60', 60], ['1', 1], ['120', 120]])('%s → %i', async (valor, esperado) => {
    process.env[VAR] = valor;
    expect((await cargar()).FLIT2_RESPALDO_MIN).toBe(esperado);
  });

  it.each(['abc', '0', '-5', '1.5', '121'])('%s → el arranque falla nombrando la variable', async (valor) => {
    process.env[VAR] = valor;
    await expect(cargar()).rejects.toThrow('FLIT2_RESPALDO_MIN debe ser un entero de 1 a 120 (minutos)');
  });
});
