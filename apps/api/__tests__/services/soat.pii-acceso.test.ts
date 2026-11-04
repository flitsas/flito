// Feature #14284 (HU #14286 AC2, AC6 y AC7) — lecturas de SOAT legacy en `pii_access_log`.
// `logPiiAccess` no se mockea: se mira lo que llega al INSERT. Fallan abierto.
import 'express-async-errors';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => {
  const logs: unknown[][] = [];
  const rec = (...a: unknown[]) => { logs.push(a); };
  const logger: Record<string, unknown> = { trace: rec, debug: rec, info: rec, warn: rec, error: rec, fatal: rec };
  logger.child = () => logger;
  return { logs, logger, selectMock: vi.fn(), insertMock: vi.fn() };
});

vi.mock('../../src/shared/logger.js', () => ({ logger: m.logger, loggerFor: () => m.logger }));
vi.mock('../../src/db/client.js', () => ({
  db: { select: m.selectMock, insert: m.insertMock, update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { default: router } = await import('../../src/modules/soat/soat.routes.js');

type Fila = Record<string, unknown>;
const filas: Fila[] = [];
const eventos: string[] = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_q: Request, res: Response, next: NextFunction) => {
    const original = res.writeHead.bind(res) as (...a: unknown[]) => Response;
    res.writeHead = ((...a: unknown[]) => { eventos.push('respuesta'); return original(...a); }) as typeof res.writeHead;
    next();
  });
  app.use('/api/soat', router);
  return app;
}

const solicitud = {
  id: 3, vin: 'VIN00000000000001', plate: 'ABC123', ownerName: 'Persona Prueba', ownerDocument: '998877',
  soatHolder: 'Persona Prueba', status: 'pendiente',
};
const LISTADO = ['owner_name', 'owner_document', 'plate', 'vin', 'soat_holder'];
const EXPORT = ['owner_name', 'owner_document', 'plate', 'vin'];

const adminAuth = async () => `Bearer ${await testToken({ sub: 77, role: 'admin' })}`;

function sinValoresPersonales(fila: Fila) {
  const volcado = JSON.stringify(fila);
  for (const valor of ['Persona Prueba', '998877', 'ABC123', 'VIN00000000000001']) expect(volcado).not.toContain(valor);
}

beforeEach(() => {
  filas.length = 0;
  eventos.length = 0;
  m.logs.length = 0;
  m.selectMock.mockReset();
  m.insertMock.mockReset();
  m.insertMock.mockImplementation(() => ({
    values: async (v: Fila) => {
      await new Promise((r) => setTimeout(r, 15));
      eventos.push('insert');
      filas.push(v);
    },
  }));
});

describe('GET /api/soat', () => {
  it('escribe la fila, sin valores, antes de responder', async () => {
    m.selectMock.mockReturnValueOnce(chain([solicitud]));

    const r = await request(buildApp()).get('/api/soat').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      userId: 77, resourceTipo: 'soat_request', resourceId: null, accion: 'search', camposAccedidos: LISTADO, motivo: 'filas=1',
    });
    sinValoresPersonales(filas[0]);
    expect(eventos).toEqual(['insert', 'respuesta']);
  });

  it('registra también al rol proveedor', async () => {
    m.selectMock.mockReturnValueOnce(chain([solicitud]));
    // `tipoEnlace: 'ninguno'`: se mide la función requerida, no la frontera, que cierra este módulo al enlace de fábrica de `proveedor`.
    const auth = `Bearer ${await testToken({ sub: 78, role: 'proveedor', tipoEnlace: 'ninguno' })}`;

    const r = await request(buildApp()).get('/api/soat').set('Authorization', auth);

    expect(r.status).toBe(200);
    expect(filas[0]).toMatchObject({ userId: 78, userRole: 'proveedor', motivo: 'filas=1' });
  });

  it('registra con 0 filas', async () => {
    m.selectMock.mockReturnValueOnce(chain([]));

    await request(buildApp()).get('/api/soat').set('Authorization', await adminAuth());

    expect(filas[0]).toMatchObject({ motivo: 'filas=0' });
  });

  it('si no se puede escribir, la lectura sigue y el fallo queda en el log', async () => {
    m.selectMock.mockReturnValueOnce(chain([solicitud]));
    m.insertMock.mockImplementation(() => ({ values: () => Promise.reject(new Error('caida')) }));

    const r = await request(buildApp()).get('/api/soat').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(JSON.stringify(m.logs)).toContain('fallo escribiendo pii_access_log');
  });
});

describe('GET /api/soat/export', () => {
  it('escribe la fila, sin valores, antes de responder', async () => {
    m.selectMock.mockReturnValueOnce(chain([solicitud]));

    const r = await request(buildApp()).get('/api/soat/export').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      userId: 77, resourceTipo: 'soat_request', resourceId: null, accion: 'export', camposAccedidos: EXPORT, motivo: 'filas=1',
    });
    sinValoresPersonales(filas[0]);
    expect(eventos).toEqual(['insert', 'respuesta']);
  });

  it('si no se puede escribir, el archivo sale y el fallo queda en el log', async () => {
    m.selectMock.mockReturnValueOnce(chain([solicitud]));
    m.insertMock.mockImplementation(() => ({ values: () => Promise.reject(new Error('caida')) }));

    const r = await request(buildApp()).get('/api/soat/export').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(JSON.stringify(m.logs)).toContain('fallo escribiendo pii_access_log');
  });
});
