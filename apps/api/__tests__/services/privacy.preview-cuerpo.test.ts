// HU #14282: la consulta previa de olvido con el documento en el cuerpo. Limitador real (AC6), a
// diferencia de privacy.routes.test.ts, que lo sustituye.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { piiAccessLog } from '../../src/db/schema.js';

const selectMock = vi.fn();
const executeMock = vi.fn();
const insertMock = vi.fn();
let orden: string[] = [];

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, execute: executeMock, insert: insertMock,
    transaction: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/storage.js', () => ({ deletePhoto: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const lineas: unknown[][] = [];
vi.mock('../../src/shared/logger.js', () => {
  const falso = {
    warn: (...a: unknown[]) => lineas.push(a),
    error: (...a: unknown[]) => lineas.push(a),
    info: (...a: unknown[]) => lineas.push(a),
    debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: () => falso,
  };
  return { logger: falso, loggerFor: () => falso };
});

const DOC = 'DOC-SINT-0001';
let filasPii: Array<Record<string, unknown>> = [];

async function buildApp() {
  const app = express();
  app.use(express.json());
  const ordenDeEstaPrueba = orden;
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = (b: unknown) => { ordenDeEstaPrueba.push('respuesta'); return json(b); };
    next();
  });
  const { default: router } = await import('../../src/modules/privacy/privacy.routes.js');
  app.use('/api/privacy', router);
  return app;
}

/** Cada prueba con su `sub`: el limitador es de módulo y cuenta por usuario. */
let sub = 100;
async function consultar(cuerpo: unknown, rol = 'admin', quien = (sub += 1)) {
  const token = await testToken({ sub: quien, role: rol });
  return request(await buildApp()).post('/api/privacy/preview').set('Authorization', `Bearer ${token}`).send(cuerpo as object);
}

beforeEach(() => {
  lineas.length = 0;
  // Arreglos propios de cada prueba: una escritura tardía no puede caer en los de la siguiente.
  const ordenDeEstaPrueba: string[] = [];
  const filasDeEstaPrueba: Array<Record<string, unknown>> = [];
  orden = ordenDeEstaPrueba;
  filasPii = filasDeEstaPrueba;
  selectMock.mockReset().mockImplementation(() => chain([{ c: 0 }]));
  executeMock.mockReset().mockResolvedValue([{ c: 0 }]);
  insertMock.mockReset().mockImplementation((tabla: unknown) => ({
    values: async (v: Record<string, unknown>) => {
      if (tabla === piiAccessLog) {
        await new Promise((r) => setTimeout(r, 5));
        ordenDeEstaPrueba.push('rastro');
        filasDeEstaPrueba.push(v);
      }
    },
  }));
});

describe('AC1: documento en el cuerpo', { retry: 0 }, () => {
  it('devuelve los conteos por tabla y el documento normalizado; la URL no lo lleva', async () => {
    selectMock.mockImplementation(() => chain([{ c: 3 }]));
    executeMock.mockResolvedValue([{ c: 7 }]);

    const r = await consultar({ docNumber: ' ab-sint-0001 ' });

    expect(r.status).toBe(200);
    expect(r.request.url).not.toContain('sint-0001');
    expect(r.body.docNumber).toBe('AB-SINT-0001');
    expect(Object.keys(r.body.affected).sort()).toEqual([
      'alcohol_tests', 'clients', 'destinatarios_carga', 'driver_profile', 'laft_beneficial_owners',
      'laft_counterparties', 'manifiestos', 'propietarios_carga', 'road_incidents', 'soat_requests',
      'tenedores', 'tramites_digitales', 'tramites_validaciones', 'vehicles',
    ]);
    expect(r.body.affected.clients).toBe(3);
    expect(r.body.affected.soat_requests).toBe(7);
  });
});

describe('AC2: rastro', { retry: 0 }, () => {
  it('con todos los conteos en cero queda una fila, antes de responder y sin el documento', async () => {
    const r = await consultar({ docNumber: DOC }, 'admin', 9001);

    expect(r.status).toBe(200);
    expect(Object.values(r.body.affected as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(filasPii).toHaveLength(1);
    expect(filasPii[0]).toMatchObject({
      userId: 9001,
      resourceTipo: 'privacy_titular',
      accion: 'search',
      camposAccedidos: ['conteos_por_tabla'],
      motivo: 'Consulta previa de olvido',
    });
    expect(orden).toEqual(['rastro', 'respuesta']);
    expect(JSON.stringify(filasPii)).not.toContain(DOC);
    expect(JSON.stringify(lineas)).not.toContain(DOC);
  });

  it('si fallan los conteos, el mensaje con los parámetros de la consulta no llega al log', async () => {
    selectMock.mockImplementation(() => { throw new Error(`Failed query: select params: ${DOC}`); });

    const r = await consultar({ docNumber: DOC });

    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Error interno del servidor' });
    expect(JSON.stringify(lineas)).not.toContain(DOC);
    expect(filasPii).toHaveLength(0);
  });
});

describe('AC3: la ruta antigua', { retry: 0 }, () => {
  it('GET /preview/:doc → 404 sin ninguna consulta de conteo', async () => {
    const token = await testToken({ sub: 2001, role: 'admin' });
    const r = await request(await buildApp()).get(`/api/privacy/preview/${DOC}`).set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(filasPii).toHaveLength(0);
  });
});

describe('AC4: validación', { retry: 0 }, () => {
  it.each([
    ['ausente', {}],
    ['de 2 caracteres', { docNumber: 'AB' }],
    ['de 2 tras recortar espacios', { docNumber: '  AB  ' }],
    ['de 21 caracteres', { docNumber: '1'.repeat(21) }],
    ['que no es texto', { docNumber: 123456 }],
    ['con un campo desconocido', { docNumber: DOC, extra: 'x' }],
  ])('documento %s → 400 sin rastro ni conteos', async (_caso, cuerpo) => {
    const r = await consultar(cuerpo);

    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Documento inválido' });
    expect(filasPii).toHaveLength(0);
    expect(selectMock).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).not.toContain(DOC);
  });

  it.each([3, 20])('%i caracteres es válido', async (largo) => {
    expect((await consultar({ docNumber: '1'.repeat(largo) })).status).toBe(200);
  });
});

describe('AC5: autorización', { retry: 0 }, () => {
  it('sin la función → 403, sin rastro ni conteos', async () => {
    const r = await consultar({ docNumber: DOC }, 'proveedor');

    expect(r.status).toBe(403);
    expect(filasPii).toHaveLength(0);
    expect(selectMock.mock.calls.length).toBeLessThan(10);
  });

  it('sin token → 401', async () => {
    const r = await request(await buildApp()).post('/api/privacy/preview').send({ docNumber: DOC });
    expect(r.status).toBe(401);
    expect(filasPii).toHaveLength(0);
  });
});

describe('AC6: límite', { retry: 0 }, () => {
  it('la consulta 21 del minuto → 429 y no deja rastro', async () => {
    const quien = 7777;
    for (let i = 0; i < 20; i += 1) {
      expect((await consultar({ docNumber: DOC }, 'admin', quien)).status).toBe(200);
    }
    filasPii.length = 0;

    const r = await consultar({ docNumber: DOC }, 'admin', quien);

    expect(r.status).toBe(429);
    expect(filasPii).toHaveLength(0);
  });
});
