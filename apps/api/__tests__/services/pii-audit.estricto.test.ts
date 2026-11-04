// Feature #14284 (HU #14285 AC2 y AC3) — la vía cerrada de `pii_access_log`. `logPiiAccess` conserva
// su contrato: nunca lanza. Se ejerce el helper real; solo la base está mockeada.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const m = vi.hoisted(() => {
  const errores: unknown[][] = [];
  const nada = () => undefined;
  const logger: Record<string, unknown> = {
    trace: nada, debug: nada, info: nada, warn: nada, fatal: nada,
    error: (...a: unknown[]) => { errores.push(a); },
  };
  logger.child = () => logger;
  return { errores, logger, insertMock: vi.fn(), valuesMock: vi.fn() };
});

vi.mock('../../src/shared/logger.js', () => ({ logger: m.logger, loggerFor: () => m.logger }));
vi.mock('../../src/db/client.js', () => ({ db: { insert: m.insertMock } }));

const { logPiiAccess, logPiiAccessOrThrow, PiiAccessLogError } = await import('../../src/shared/pii-audit.js');

const req = { headers: {}, ip: '203.0.113.7', user: { sub: 7, role: 'admin' } } as unknown as Request;
const OPTS = { resourceTipo: 'validacion_identidad', resourceId: 5, accion: 'decrypt', camposAccedidos: ['nombre'], motivo: 'filas=1' } as const;
const COPIA = { ...OPTS, camposAccedidos: [...OPTS.camposAccedidos] };

beforeEach(() => {
  m.errores.length = 0;
  m.valuesMock.mockReset().mockResolvedValue(undefined);
  m.insertMock.mockReset().mockImplementation(() => ({ values: m.valuesMock }));
});

describe('logPiiAccessOrThrow', () => {
  it('escribe la misma fila que logPiiAccess', async () => {
    await logPiiAccessOrThrow(req, COPIA);
    await logPiiAccess(req, COPIA);

    expect(m.valuesMock).toHaveBeenCalledTimes(2);
    expect(m.valuesMock.mock.calls[0][0]).toEqual(m.valuesMock.mock.calls[1][0]);
    expect(m.valuesMock.mock.calls[0][0]).toMatchObject({
      userId: 7, userRole: 'admin', resourceTipo: 'validacion_identidad', resourceId: 5,
      accion: 'decrypt', camposAccedidos: ['nombre'], motivo: 'filas=1', ipOrigen: '203.0.113.7',
    });
  });

  it('si el INSERT falla lanza PiiAccessLogError con mensaje fijo, la causa y la línea de log', async () => {
    const causa = new Error('valor-sensible-del-driver');
    m.valuesMock.mockRejectedValue(causa);

    const error = await logPiiAccessOrThrow(req, COPIA).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PiiAccessLogError);
    expect((error as Error).message).not.toContain('valor-sensible-del-driver');
    expect((error as Error).cause).toBe(causa);
    expect(m.errores).toHaveLength(1);
    expect(m.errores[0][1]).toBe('fallo escribiendo pii_access_log');
  });
});

describe('logPiiAccess', () => {
  it('si el INSERT falla no lanza y deja la misma línea de log', async () => {
    m.valuesMock.mockRejectedValue(new Error('caida'));

    await expect(logPiiAccess(req, COPIA)).resolves.toBeUndefined();

    expect(m.errores[0][0]).toEqual({ err: 'caida', resource: 'validacion_identidad' });
    expect(m.errores[0][1]).toBe('fallo escribiendo pii_access_log');
  });
});
