import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from '../../src/config/env.js';
import { RndcMockClient } from '../../src/modules/rndc/client/RndcMockClient.js';
import {
  isTransientError, isBusinessError, isDuplicate,
  type RndcCredentials,
} from '../../src/modules/rndc/client/types.js';

const VALID_CREDS: RndcCredentials = {
  empresaNit: '900123456',
  habilitadorNit: '900654321',
  numNit: '900123456-1',
  claveQR: 'super-secret-clave-qr',
  ambiente: 'sandbox',
};

const VALID_REMESA_PAYLOAD = {
  municipioOrigen: 'A', municipioDestino: 'B', productoCodigo: 'P1',
};
const VALID_MANIFIESTO_PAYLOAD = {
  placaPrincipal: 'ABC123', conductorDoc: '900',
};

// Consecutivos pre-calculados (sha1 inicio determinístico) — ver scripts en sesión.
// REM-202605-0003 hash[0]∈[0..c] → OK. REM-202605-0002 → ER05. REM-202605-0044 → ER99. REM-202605-0001 → TIMEOUT.
// MAN-202605-0001 → OK.

// Stub setTimeout para que la latencia simulada del mock sea instantánea (tests rápidos).
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  // Restaurar rates default (0 / 0.02) tras cualquier test que los modifique.
  env.RNDC_MOCK_ERROR_RATE = 0;
  env.RNDC_MOCK_TIMEOUT_RATE = 0;
});

describe('RndcMockClient — modo()', () => {
  it('siempre devuelve "mock"', () => {
    const c = new RndcMockClient();
    expect(c.modo()).toBe('mock');
  });
});

describe('RndcMockClient — validación credenciales (sin latencia, ER01)', () => {
  it('numNit vacío → ER01 inmediato', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      { ...VALID_CREDS, numNit: '' },
    );
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('ER01');
    expect(r.mensaje).toMatch(/credenciales/i);
    expect(r.rawXml).toContain('<processCode>ER01</processCode>');
  });

  it('claveQR < 6 chars → ER01 inmediato', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      { ...VALID_CREDS, claveQR: '12345' },
    );
    expect(r.codigo).toBe('ER01');
  });

  it('credenciales válidas pasan validación', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).not.toBe('ER01');
  });
});

describe('RndcMockClient — validaciones contextuales por método', () => {
  it('ingresarRemesa sin productoCodigo → ER05', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarRemesa(
      { consecutivoLocal: 'X-1', remesaId: 1, payload: { municipioOrigen: 'A', municipioDestino: 'B' } },
      VALID_CREDS,
    );
    expect(r.codigo).toBe('ER05');
    expect(r.ok).toBe(false);
  });

  it('ingresarRemesa sin municipioOrigen ni municipioOrigenDane → ER06', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarRemesa(
      { consecutivoLocal: 'X-1', remesaId: 1, payload: { municipioDestino: 'B', productoCodigo: 'P1' } },
      VALID_CREDS,
    );
    expect(r.codigo).toBe('ER06');
  });

  it('ingresarRemesa con municipioOrigenDane (sin nombre) pasa', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: { municipioOrigenDane: '11001', municipioDestinoDane: '05001', productoCodigo: 'P1' } },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).not.toBe('ER06');
  });

  it('ingresarManifiesto sin placa ni vehiculoPrincipalId → ER03', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarManifiesto(
      { consecutivoLocal: 'X-1', manifiestoId: 1, payload: { conductorDoc: '900' } },
      VALID_CREDS,
    );
    expect(r.codigo).toBe('ER03');
  });

  it('ingresarManifiesto sin conductor → ER04', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarManifiesto(
      { consecutivoLocal: 'X-1', manifiestoId: 1, payload: { placaPrincipal: 'ABC123' } },
      VALID_CREDS,
    );
    expect(r.codigo).toBe('ER04');
  });

  it('ingresarManifiesto con vehiculoPrincipalId + conductorId pasa', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarManifiesto(
      { consecutivoLocal: 'MAN-202605-0001', manifiestoId: 1, payload: { vehiculoPrincipalId: 5, conductorId: 7 } },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(['ER03', 'ER04']).not.toContain(r.codigo);
  });

  it('anularRemesa sin consecutivoRndc → ER08', async () => {
    const c = new RndcMockClient();
    const r = await c.anularRemesa({ consecutivoRndc: '', motivo: 'm' }, VALID_CREDS);
    expect(r.codigo).toBe('ER08');
  });

  it('anularManifiesto sin consecutivoRndc → ER08', async () => {
    const c = new RndcMockClient();
    const r = await c.anularManifiesto({ consecutivoRndc: '', motivo: 'm' }, VALID_CREDS);
    expect(r.codigo).toBe('ER08');
  });
});

describe('RndcMockClient — códigos forzados por env (testing helper)', () => {
  it('TIMEOUT_RATE=1 → siempre TIMEOUT (no ok)', async () => {
    env.RNDC_MOCK_TIMEOUT_RATE = 1;
    env.RNDC_MOCK_ERROR_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('TIMEOUT');
    expect(r.mensaje).toMatch(/timeout/i);
  });

  it('ERROR_RATE=1 (TIMEOUT_RATE=0) → siempre ER99', async () => {
    env.RNDC_MOCK_TIMEOUT_RATE = 0;
    env.RNDC_MOCK_ERROR_RATE = 1;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).toBe('ER99');
    expect(r.ok).toBe(false);
  });
});

describe('RndcMockClient — código determinístico por payload (mismo input → misma respuesta)', () => {
  it('REM-202605-0003 → "00" + consecutivoRndc generado', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.codigo).toBe('00');
    expect(r.consecutivoRndc).toMatch(/^900123456-\d+-\d{4}$/);
    expect(r.rawXml).toContain('<consec>');
    expect(r.rawXml).toContain('<processCode>00</processCode>');
  });

  it('REM-202605-0002 → ER05 (determinístico, payload válido contextualmente)', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0002', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).toBe('ER05');
    expect(r.consecutivoRndc).toBeUndefined();
  });

  it('REM-202605-0044 → ER99 (transitorio)', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0044', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).toBe('ER99');
  });

  it('REM-202605-0001 → TIMEOUT (determinístico)', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0001', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).toBe('TIMEOUT');
  });

  it('mismo payload → mismo código en 3 corridas (idempotencia visual)', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = c.ingresarRemesa(
        { consecutivoLocal: 'REM-202605-0002', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
        VALID_CREDS,
      );
      await vi.runAllTimersAsync();
      const r = await p;
      codes.push(r.codigo);
    }
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toBe('ER05');
  });
});

describe('RndcMockClient — ingresarManifiesto OK + anular/consultar', () => {
  it('MAN-202605-0001 → "00"', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarManifiesto(
      { consecutivoLocal: 'MAN-202605-0001', manifiestoId: 1, payload: VALID_MANIFIESTO_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.codigo).toBe('00');
    expect(r.consecutivoRndc).toBeTruthy();
  });

  it('anularRemesa con consecutivo válido pasa simulate', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.anularRemesa({ consecutivoRndc: 'CR-001', motivo: 'test' }, VALID_CREDS);
    await vi.runAllTimersAsync();
    const r = await p;
    // hash[0]='5' → '00'
    expect(r.ok).toBe(true);
    expect(r.codigo).toBe('00');
  });

  it('anularManifiesto con consecutivo válido pasa simulate', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.anularManifiesto({ consecutivoRndc: 'CR-002', motivo: 'test' }, VALID_CREDS);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.codigo).toBe('00');
  });

  it('consultarEstadoIngreso usa hash directo del consecutivo', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.consultarEstadoIngreso({ consecutivoLocal: 'REM-202605-0001' }, VALID_CREDS);
    await vi.runAllTimersAsync();
    const r = await p;
    // hash[0]='5' → '00'
    expect(r.ok).toBe(true);
  });
});

describe('RndcMockClient — durationMs y rawXml', () => {
  it('durationMs siempre ≥ 0', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rawXml OK contiene generated_by=mock', async () => {
    env.RNDC_MOCK_ERROR_RATE = 0; env.RNDC_MOCK_TIMEOUT_RATE = 0;
    const c = new RndcMockClient();
    const p = c.ingresarRemesa(
      { consecutivoLocal: 'REM-202605-0003', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      VALID_CREDS,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.rawXml).toContain('<generated_by>mock</generated_by>');
  });

  it('rawXml ER01 también marcado como mock', async () => {
    const c = new RndcMockClient();
    const r = await c.ingresarRemesa(
      { consecutivoLocal: 'X', remesaId: 1, payload: VALID_REMESA_PAYLOAD },
      { ...VALID_CREDS, claveQR: '' },
    );
    expect(r.rawXml).toContain('<generated_by>mock</generated_by>');
  });
});

describe('types.ts — clasificación de errores (decisión de retry)', () => {
  it('isTransientError: ER99/TIMEOUT/NETWORK → true; resto → false', () => {
    expect(isTransientError('ER99')).toBe(true);
    expect(isTransientError('TIMEOUT')).toBe(true);
    expect(isTransientError('NETWORK')).toBe(true);
    expect(isTransientError('00')).toBe(false);
    expect(isTransientError('ER01')).toBe(false);
    expect(isTransientError('ER07')).toBe(false);
  });

  it('isBusinessError: ER01-ER06/ER08 → true; ER07/ER99/TIMEOUT/00 → false', () => {
    ['ER01', 'ER02', 'ER03', 'ER04', 'ER05', 'ER06', 'ER08'].forEach((c) => {
      expect(isBusinessError(c as any)).toBe(true);
    });
    expect(isBusinessError('ER07')).toBe(false); // duplicado, no es business error
    expect(isBusinessError('ER99')).toBe(false);
    expect(isBusinessError('TIMEOUT')).toBe(false);
    expect(isBusinessError('00')).toBe(false);
  });

  it('isDuplicate: solo ER07', () => {
    expect(isDuplicate('ER07')).toBe(true);
    expect(isDuplicate('ER01')).toBe(false);
    expect(isDuplicate('00')).toBe(false);
  });
});

describe('factory — getRndcClient + _setRndcClientForTesting', () => {
  beforeEach(() => {
    // Reset singleton entre tests vía helper de test.
  });

  it('en modo mock devuelve RndcMockClient (singleton)', async () => {
    const { getRndcClient, _setRndcClientForTesting } = await import('../../src/modules/rndc/client/factory.js');
    _setRndcClientForTesting(null); // reset
    env.RNDC_MODE = 'mock';
    const c1 = getRndcClient();
    const c2 = getRndcClient();
    expect(c1).toBeInstanceOf(RndcMockClient);
    expect(c1).toBe(c2); // mismo singleton
    _setRndcClientForTesting(null);
  });

  it('en modo real lanza error (Fase 4.3 no implementada)', async () => {
    const { getRndcClient, _setRndcClientForTesting } = await import('../../src/modules/rndc/client/factory.js');
    _setRndcClientForTesting(null);
    const prev = env.RNDC_MODE;
    env.RNDC_MODE = 'real';
    expect(() => getRndcClient()).toThrow(/no implementado.*4\.3/i);
    env.RNDC_MODE = prev;
    _setRndcClientForTesting(null);
  });

  it('_setRndcClientForTesting permite inyectar mock custom', async () => {
    const { getRndcClient, _setRndcClientForTesting } = await import('../../src/modules/rndc/client/factory.js');
    const fake = {
      modo: () => 'mock' as const,
      ingresarRemesa: vi.fn(),
      ingresarManifiesto: vi.fn(),
      anularRemesa: vi.fn(),
      anularManifiesto: vi.fn(),
      consultarEstadoIngreso: vi.fn(),
    };
    _setRndcClientForTesting(fake);
    expect(getRndcClient()).toBe(fake);
    _setRndcClientForTesting(null);
  });
});
