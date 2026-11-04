// Feature #14284 (HU #14285 AC4 y AC6; HU #14286 AC3, AC4, AC6 y AC7) — lecturas de trámites legacy y
// de la bandeja de tránsito en `pii_access_log`. `logPiiAccess` no se mockea: se mira lo que llega al
// INSERT. Todas fallan abierto.
import 'express-async-errors';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => {
  const logs: unknown[][] = [];
  const rec = (...a: unknown[]) => { logs.push(a); };
  const logger: Record<string, unknown> = { trace: rec, debug: rec, info: rec, warn: rec, error: rec, fatal: rec };
  logger.child = () => logger;
  return { logs, logger, selectMock: vi.fn(), insertMock: vi.fn(), listMock: vi.fn(), detalleMock: vi.fn() };
});

vi.mock('../../src/shared/logger.js', () => ({ logger: m.logger, loggerFor: () => m.logger }));
vi.mock('../../src/db/client.js', () => ({
  db: { select: m.selectMock, insert: m.insertMock, update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/tramites/tramites.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/tramites/tramites.service.js')>()),
  listTramites: m.listMock,
  getTramiteWithDocs: m.detalleMock,
}));
vi.mock('../../src/modules/tramites/transito-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/tramites/transito-scope.js')>()),
  resolveTransitoScope: vi.fn().mockResolvedValue({ ok: true, codigos: null }),
  organismoEnAlcance: () => true,
}));

const { default: tramitesRouter } = await import('../../src/modules/tramites/tramites.routes.js');
const { default: transitoRouter } = await import('../../src/modules/tramites/transito.routes.js');

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
  app.use('/api/tramites', tramitesRouter);
  app.use('/api/transito', transitoRouter);
  return app;
}

const DIRECTORIO = 'uploads/__pii_acceso_test__';
const ARCHIVO = `${DIRECTORIO}/doc.pdf`;
const tramite = {
  id: 9, vin: 'VIN00000000000001', placa: 'ABC123', estado: 'enviado_transito', modalidadEntrada: 'traspaso',
  organismoCodigo: '11001', vehiculo: { _vendedor: { nombre: 'Vendedora Prueba' } }, comprador: { nombre: 'Persona Prueba' },
};
const FILA = ['vin', 'placa', 'vehiculo', 'comprador', 'documentos', 'validacion_identidad', 'notas', 'workflow'];
const TRASPASOS = ['vin', 'placa', 'vehiculo', 'comprador'];

const adminAuth = async () => `Bearer ${await testToken({ sub: 77, role: 'admin' })}`;

function sinValoresPersonales(fila: Fila) {
  const volcado = JSON.stringify(fila);
  for (const valor of ['Persona Prueba', 'Vendedora Prueba', 'ABC123', 'VIN00000000000001']) expect(volcado).not.toContain(valor);
}

beforeAll(() => {
  mkdirSync(path.resolve(process.cwd(), DIRECTORIO), { recursive: true });
  writeFileSync(path.resolve(process.cwd(), ARCHIVO), 'contenido');
});
afterAll(() => {
  rmSync(path.resolve(process.cwd(), DIRECTORIO), { recursive: true, force: true });
});

beforeEach(() => {
  filas.length = 0;
  eventos.length = 0;
  m.logs.length = 0;
  m.selectMock.mockReset();
  m.listMock.mockReset();
  m.detalleMock.mockReset();
  m.insertMock.mockReset();
  m.insertMock.mockImplementation(() => ({
    values: async (v: Fila) => {
      await new Promise((r) => setTimeout(r, 15));
      eventos.push('insert');
      filas.push(v);
    },
  }));
});

interface Caso {
  nombre: string;
  url: string;
  preparar: () => void;
  fila: Fila;
}

const CASOS: Caso[] = [
  {
    nombre: 'GET /api/tramites',
    url: '/api/tramites',
    preparar: () => { m.listMock.mockResolvedValueOnce({ items: [tramite], total: 1 }); },
    fila: { resourceTipo: 'tramite', resourceId: null, accion: 'search', camposAccedidos: FILA, motivo: 'filas=1' },
  },
  {
    nombre: 'GET /api/tramites/:id',
    url: '/api/tramites/9',
    preparar: () => { m.detalleMock.mockResolvedValueOnce({ ...tramite, archivos: [] }); },
    fila: { resourceTipo: 'tramite', resourceId: 9, accion: 'read', camposAccedidos: [...FILA, 'original_name'], motivo: null },
  },
  {
    nombre: 'GET /api/transito/pendientes',
    url: '/api/transito/pendientes',
    preparar: () => { m.selectMock.mockReturnValueOnce(chain([tramite])); },
    fila: { resourceTipo: 'tramite', resourceId: null, accion: 'search', camposAccedidos: FILA, motivo: 'origen=pendientes · filas=1' },
  },
  {
    nombre: 'GET /api/transito/mis-tramites',
    url: '/api/transito/mis-tramites',
    preparar: () => { m.selectMock.mockReturnValueOnce(chain([tramite])); },
    fila: { resourceTipo: 'tramite', resourceId: null, accion: 'search', camposAccedidos: FILA, motivo: 'origen=mis-tramites · filas=1' },
  },
  {
    nombre: 'GET /api/transito/traspasos',
    url: '/api/transito/traspasos',
    preparar: () => { m.selectMock.mockReturnValueOnce(chain([tramite])); },
    fila: { resourceTipo: 'tramite', resourceId: null, accion: 'search', camposAccedidos: TRASPASOS, motivo: 'origen=traspasos · filas=1' },
  },
  {
    nombre: 'GET /api/transito/traspasos/:id',
    url: '/api/transito/traspasos/9',
    preparar: () => { m.selectMock.mockReturnValueOnce(chain([tramite])); },
    fila: { resourceTipo: 'tramite', resourceId: 9, accion: 'read', camposAccedidos: [...TRASPASOS, 'notas', 'workflow'], motivo: 'origen=traspasos' },
  },
  {
    nombre: 'GET /api/tramites/:tramiteId/documentos/:docId/archivo',
    url: '/api/tramites/9/documentos/31/archivo',
    preparar: () => {
      m.selectMock.mockReturnValueOnce(chain([{ id: 31, tramiteId: 9, tipo: 'factura', filename: ARCHIVO, originalName: 'cedula-persona-prueba.pdf', mimetype: 'application/pdf' }]));
    },
    fila: { resourceTipo: 'tramite_doc', resourceId: 31, accion: 'read', camposAccedidos: ['contenido_archivo', 'original_name'], motivo: 'tramite 9 · tipo=factura' },
  },
];

// `retry: 0` en los describe de orden: el reintento del config global vería entrar en `eventos` y `filas`
// el INSERT pendiente del intento que acaba de fallar, y una ruta que responde antes de registrar
// quedaría en verde.
const SIN_REINTENTO = { retry: 0 };

describe.each(CASOS)('$nombre', SIN_REINTENTO, ({ url, preparar, fila }) => {
  it('escribe la fila esperada, sin valores, antes de responder', async () => {
    preparar();

    const r = await request(buildApp()).get(url).set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ userId: 77, ...fila });
    sinValoresPersonales(filas[0]);
    expect(eventos).toEqual(['insert', 'respuesta']);
  });

  it('si no se puede escribir, la lectura sigue y el fallo queda en el log', async () => {
    preparar();
    m.insertMock.mockImplementation(() => ({ values: () => Promise.reject(new Error('caida')) }));

    const r = await request(buildApp()).get(url).set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(JSON.stringify(m.logs)).toContain('fallo escribiendo pii_access_log');
  });
});

describe('los listados', () => {
  it.each([
    ['/api/transito/pendientes', 'origen=pendientes · filas=0'],
    ['/api/transito/mis-tramites', 'origen=mis-tramites · filas=0'],
    ['/api/transito/traspasos', 'origen=traspasos · filas=0'],
  ])('%s registra también con 0 filas', async (url, motivo) => {
    m.selectMock.mockReturnValueOnce(chain([]));

    const r = await request(buildApp()).get(url).set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(filas[0]).toMatchObject({ motivo });
  });

  it('GET /api/tramites registra con 0 filas y el motivo no guarda lo buscado', async () => {
    m.listMock.mockResolvedValueOnce({ items: [], total: 0 });

    const r = await request(buildApp()).get('/api/tramites').query({ search: 'BUSCADO99' }).set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(m.listMock.mock.calls[0][0]).toMatchObject({ search: 'BUSCADO99' });
    expect(filas[0]).toMatchObject({ motivo: 'filas=0' });
    expect(JSON.stringify(filas[0])).not.toContain('BUSCADO99');
  });
});

describe('sin registro no hay fila', () => {
  it('GET /api/tramites/:id inexistente responde 404 y no registra', async () => {
    m.detalleMock.mockResolvedValueOnce(null);

    const r = await request(buildApp()).get('/api/tramites/9').set('Authorization', await adminAuth());

    expect(r.status).toBe(404);
    expect(m.insertMock).not.toHaveBeenCalled();
  });

  it('GET …/archivo sin la función responde 403 y no registra lectura', async () => {
    // `tipoEnlace: 'ninguno'`: se mide la función requerida, no la frontera, que cierra este módulo al enlace de fábrica de `proveedor`.
    const auth = `Bearer ${await testToken({ sub: 78, role: 'proveedor', tipoEnlace: 'ninguno' })}`;

    const r = await request(buildApp()).get('/api/tramites/9/documentos/31/archivo').set('Authorization', auth);

    expect(r.status).toBe(403);
    expect(m.selectMock).not.toHaveBeenCalled();
    expect(m.insertMock).not.toHaveBeenCalled();
  });
});
