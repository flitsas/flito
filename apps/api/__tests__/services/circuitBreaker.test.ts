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

// HU #11327 — preguntar por el circuito ANTES de empezar un trabajo que se sabe que va a rebotar.
//
// El caso que lo motiva es caro: `emitirFactura` reserva la clave de idempotencia y solo entonces
// llama a Siigo. Con el circuito abierto, la llamada muere con `CircuitoAbiertoError` —que NO es un
// `SiigoApiError`—, así que el emisor no puede afirmar que Siigo la rechazara y deja la fila
// `en_proceso`. Correctamente, pero el POST no salió nunca: una clave reservada ocupando su trámite
// ~45 minutos por una petición que no se hizo.
describe('circuitoAbierto — consulta pura del estado', () => {
  it('un circuito que nunca falló no está abierto', async () => {
    const { circuitoAbierto } = await import('../../src/services/circuitBreaker.js');
    expect(circuitoAbierto('cb-consulta-virgen')).toBe(false);
  });

  it('dice que sí en cuanto el circuito se abre', async () => {
    const { circuitoAbierto, withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-consulta-1', fn)).rejects.toThrow();
    }
    expect(circuitoAbierto('cb-consulta-1')).toBe(true);
  });

  it('respeta el medio abierto: pasado RESET_MS deja probar otra vez', async () => {
    // Decir «abierto» aquí impediría la llamada de prueba con la que el circuito se cierra, y el
    // circuito no volvería a cerrarse nunca.
    const { circuitoAbierto, withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-consulta-2', fn)).rejects.toThrow();
    }
    expect(circuitoAbierto('cb-consulta-2')).toBe(true);

    vi.setSystemTime(Date.now() + 61_000);
    expect(circuitoAbierto('cb-consulta-2')).toBe(false);
  });

  it('NO muta el estado: preguntar no reabre ni cierra nada', async () => {
    // Quien decide reabrir es la llamada real. Si la consulta tocara el estado, un diagnóstico que
    // preguntara por el circuito estaría cambiando lo que mide.
    const { circuitoAbierto, withCircuitBreaker } = await import('../../src/services/circuitBreaker.js');
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('cb-consulta-3', fn)).rejects.toThrow();
    }
    for (let i = 0; i < 10; i++) expect(circuitoAbierto('cb-consulta-3')).toBe(true);
    // Sigue rechazando sin invocar: las diez consultas no le devolvieron ningún crédito.
    await expect(withCircuitBreaker('cb-consulta-3', fn)).rejects.toThrow(/temporalmente/);
    expect(fn).toHaveBeenCalledTimes(5);
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
