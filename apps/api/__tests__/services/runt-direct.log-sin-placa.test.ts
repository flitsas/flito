// HU #14017 (AC9) — la vía directa del RUNT ya no escribe la placa en claro en el log.
// RUNT simulado: `httpsJson` y el captcha se responden en memoria; solo se observa el logger.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const httpsJsonMock = vi.fn();
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);

vi.mock('../../src/modules/integraciones/http.js', () => ({ httpsJson: httpsJsonMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>();
  return { ...real, env: { ...real.env, ANTHROPIC_API_KEY: 'test-key' } };
});

const PLACA = 'JNH38H';

beforeEach(() => {
  httpsJsonMock.mockReset();
  logMock.info.mockClear();
  httpsJsonMock.mockImplementation(async (metodo: string, url: string) => {
    if (url.includes('configuracion-sesion')) return { status: 200, data: {}, headers: {} };
    if (url.includes('libre-captcha/generar')) return { status: 200, data: { imagen: 'data:image/png;base64,AAAA', id: 'c1' }, headers: {} };
    if (url.includes('anthropic.com')) return { status: 200, data: { content: [{ text: 'ABCD' }] }, headers: {} };
    if (metodo === 'POST' && url.endsWith('/auth')) {
      return { status: 200, data: { codigoResultado: 'OK', infoVehiculo: { placa: PLACA }, token: null }, headers: {} };
    }
    return { status: 200, data: null, headers: {} };
  });
});

describe('consultarVehiculoRuntDirect — log sin PII', () => {
  it('por placa: el log dice la modalidad y NO la placa', async () => {
    const { consultarVehiculoRuntDirect } = await import('../../src/modules/runt/runt-direct.service.js');
    const r = await consultarVehiculoRuntDirect(PLACA.toLowerCase(), undefined, '1020304050');
    expect(r.ok).toBe(true);
    expect(logMock.info).toHaveBeenCalledWith({ modalidad: 'placa', via: 'direct' }, 'runt vehiculo');
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(PLACA);
  });

  it('por VIN: modalidad vin', async () => {
    const { consultarVehiculoRuntDirect } = await import('../../src/modules/runt/runt-direct.service.js');
    await consultarVehiculoRuntDirect(undefined, '9FKRG2222T2042405');
    expect(logMock.info).toHaveBeenCalledWith({ modalidad: 'vin', via: 'direct' }, 'runt vehiculo');
  });
});
