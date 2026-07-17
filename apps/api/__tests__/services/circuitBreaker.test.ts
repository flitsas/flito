import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// El módulo mantiene un Map global de circuits — usar nombres únicos por test para aislar.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('circuitBreaker — happy path (cerrado)', () => {
  it('fn() exitoso → resuelve con su valor, no abre circuito', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const r = await withCircuitBreaker('cb-ok-1', async () => 42);
    expect(r).toBe(42);
  });

  it('exitoso resetea contador de fallas previas', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    // 3 fallas
    for (let i = 0; i < 3; i++) {
      await expect(withCircuitBreaker('cb-reset-1', async () => { throw new Error('x'); }))
        .rejects.toThrow();
    }
    // 1 éxito → resetea
    await withCircuitBreaker('cb-reset-1', async () => 'ok');
    // Después del reset, deberíamos poder fallar 4 veces más sin abrir (umbral=5)
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('cb-reset-1', async () => { throw new Error('x'); }))
        .rejects.toThrow('x');
    }
  });
});

describe('circuitBreaker — apertura tras THRESHOLD=5 fallas', () => {
  it('abre tras 5 fallas consecutivas; 6ta llamada → "temporalmente no disponible" sin invocar fn', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('SOAP down'));

    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-open-1', fn)).rejects.toThrow('SOAP down');
    }
    // 6ta: circuito abierto, fn no debe ejecutarse
    await expect(withCircuitBreaker('cb-open-1', fn))
      .rejects.toThrow(/cb-open-1.*temporalmente no disponible/);
    expect(fn).toHaveBeenCalledTimes(5); // no se llamó la 6ta vez
  });

  it('4 fallas no abre circuito todavía (umbral=5)', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('x'));
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('cb-under-1', fn)).rejects.toThrow('x');
    }
    // 5ta llamada todavía invoca fn (no abre antes de que la 5ta complete)
    await expect(withCircuitBreaker('cb-under-1', fn)).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('circuitBreaker — half-open tras RESET_MS=60s', () => {
  it('60s después de la última falla → reintenta (half-open)', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('down'));

    // Abrir circuito
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-half-1', fn)).rejects.toThrow('down');
    }
    // Confirmamos cerrado-rechaza-sin-invocar
    await expect(withCircuitBreaker('cb-half-1', fn)).rejects.toThrow(/temporalmente/);
    expect(fn).toHaveBeenCalledTimes(5);

    // Avanzamos 61s. Próxima llamada debe ir a half-open y reinvocar fn.
    vi.setSystemTime(Date.now() + 61_000);
    fn.mockResolvedValueOnce('recovered');
    const r = await withCircuitBreaker('cb-half-1', fn);
    expect(r).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('half-open + nueva falla → vuelve a contar desde cero', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('down'));

    // Abrir
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-halfre-1', fn)).rejects.toThrow();
    }
    // Esperar reset window
    vi.setSystemTime(Date.now() + 61_000);
    // Half-open + falla → fn llamado pero failures vuelve a 1
    await expect(withCircuitBreaker('cb-halfre-1', fn)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(6);

    // Necesitamos otras 4 fallas para abrir de nuevo
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('cb-halfre-1', fn)).rejects.toThrow('down');
    }
    expect(fn).toHaveBeenCalledTimes(10);
    // 11va llamada → cerrado de nuevo
    await expect(withCircuitBreaker('cb-halfre-1', fn)).rejects.toThrow(/temporalmente/);
    expect(fn).toHaveBeenCalledTimes(10); // no se reinvoca
  });
});

describe('circuitBreaker — circuitos independientes por nombre', () => {
  it('falla en circuito A no afecta circuito B', async () => {
    const { withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fnA = vi.fn().mockRejectedValue(new Error('A down'));
    const fnB = vi.fn().mockResolvedValue('B ok');

    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-A', fnA)).rejects.toThrow();
    }
    // A está abierto
    await expect(withCircuitBreaker('cb-A', fnA)).rejects.toThrow(/cb-A.*temporalmente/);
    // B funciona normal
    expect(await withCircuitBreaker('cb-B', fnB)).toBe('B ok');
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
