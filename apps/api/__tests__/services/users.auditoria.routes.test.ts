// HU #12171 — `GET /api/users/auditoria` y `GET /api/users/auditoria/titulares` (AC2, AC4).
//
//   · 200 para `admin` y `auditor` (las dos funciones vienen de la foto: `inventario.generado.ts`);
//     403 para quien no tiene `usuarios.auditoria.ver` / `.filtrar` (`proveedor`, `cliente`): es la
//     mutación 2 del AC6 — quitar `exigirFuncion` del montaje pone esto en rojo;
//   · los filtros llegan de verdad al `.where()` de la consulta (por usuario, por recurso, por rango
//     de fechas) y la paginación al `.limit()`/`.offset()`: se afirma sobre el SQL renderizado, no sobre
//     el predicado exportado (el mock `chain` ignora `orderBy`, así que el orden se lee del SQL);
//   · el DTO no lleva correo, nombre ni documento del TITULAR: solo id, `username` (del JOIN) y rol.
//     El correo que sí viaja es el del ACTOR (mutación 3 del AC6);
//   · `/titulares` devuelve exactamente `{ userId, username }` y nada más (mutación 2c).
//
// TZ=UTC en `vitest.config`/`setup`: el rango de fechas se construye en UTC y se compara como Date.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const dbMock = {
  select: selectMock,
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
};

vi.mock('../../src/db/client.js', () => ({
  db: dbMock,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const render = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = new PgDialect().sqlToQuery(cond as never);
  return { sql: q.sql, params: q.params as unknown[] };
};

/** Lo que cada consulta recibió: el `where`, el `limit`, el `offset` y el `orderBy`. */
interface Consulta { where?: unknown; limit?: number; offset?: number; orderBy?: unknown[]; groupBy?: unknown[] }
const consultas: Consulta[] = [];

/** Un `chain` que además espía lo que se le pasa. Resuelve a `rows` haga lo que haga. */
function chainEspia(rows: unknown[]) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const registro: Consulta = {};
  consultas.push(registro);
  c.where = (cond: unknown) => { registro.where = cond; return c; };
  c.limit = (n: unknown) => { registro.limit = n as number; return c; };
  c.offset = (n: unknown) => { registro.offset = n as number; return c; };
  c.orderBy = (...args: unknown[]) => { registro.orderBy = args; return c; };
  c.groupBy = (...args: unknown[]) => { registro.groupBy = args; return c; };
  return c;
}

const FILA = {
  id: 10, loteId: '11111111-2222-3333-4444-555555555555', entidad: 'usuario', accion: 'editar', campo: 'allowed_pages',
  valorAntes: { conjunto: ['soat'] }, valorDespues: { conjunto: ['soat', 'clients'], concedidas: ['clients'], revocadas: [] },
  usuarioAfectadoId: 47, usuarioAfectadoRol: 'proveedor', titularUsername: 'pgomez', rolAfectadoCodigo: null,
  actorUserId: 1, actorEmail: 'admin@flit.test', actorRol: 'admin', origen: 'usuario', motivo: null,
  createdAt: new Date('2026-09-10T15:00:00.000Z'),
};

/** Las tres consultas de `listarAuditoria`: la página, el conteo y el mínimo. */
function mockListado(filas: unknown[] = [FILA], total = filas.length, desde: Date | null = new Date('2026-09-01T00:00:00.000Z')) {
  selectMock.mockReturnValueOnce(chainEspia(filas));
  selectMock.mockReturnValueOnce(chainEspia([{ total }]));
  selectMock.mockReturnValueOnce(chainEspia([{ desde }]));
}

beforeEach(() => {
  selectMock.mockReset();
  consultas.length = 0;
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', router);
  return app;
}

const auth = async (role: 'admin' | 'auditor' | 'proveedor' | 'cliente', sub = 1) => `Bearer ${await testToken({ sub, role })}`;

describe('GET /api/users/auditoria — quién puede (AC2; mutación 2 del AC6)', () => {
  it('sin token → 401', async () => {
    const r = await request(await buildApp()).get('/api/users/auditoria');
    expect(r.status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['proveedor', 'cliente'] as const)('%s (sin usuarios.auditoria.ver) → 403 y no consulta nada', async (role) => {
    // Con la base «lista» a propósito: si la guarda desaparece (mutación 2), esto responde 200 y cae
    // aquí por el código, no por un timeout del handler sin mocks.
    mockListado();
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth(role, 5));
    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'auditor'] as const)('%s → 200 con items, total, limite, offset y desdeCuando', async (role) => {
    mockListado();
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth(role));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, limite: 50, offset: 0, desdeCuando: '2026-09-01T00:00:00.000Z' });
    expect(r.body.items).toHaveLength(1);
  });

  it('un auditor NO recibe con esto el listado de usuarios: GET /users sigue siendo 403 para él (AC4)', async () => {
    const r = await request(await buildApp()).get('/api/users').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(403);
    const r2 = await request(await buildApp()).get('/api/users/resumen').set('Authorization', await auth('auditor'));
    expect(r2.status).toBe(403);
  });
});

describe('GET /api/users/auditoria — el DTO (AC2 + AC4; mutación 3 del AC6)', () => {
  it('cada item trae autor, fecha, acción, recurso, identificador y los dos valores; del titular solo id, username y rol', async () => {
    mockListado();
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
    const [item] = r.body.items;
    expect(item).toEqual({
      id: 10,
      loteId: '11111111-2222-3333-4444-555555555555',
      entidad: 'usuario',
      accion: 'editar',
      campo: 'allowed_pages',
      valorAntes: { conjunto: ['soat'] },
      valorDespues: { conjunto: ['soat', 'clients'], concedidas: ['clients'], revocadas: [] },
      titular: { userId: 47, username: 'pgomez', rol: 'proveedor' },
      rolAfectado: null,
      actor: { userId: 1, email: 'admin@flit.test', rol: 'admin' },
      origen: 'usuario',
      motivo: null,
      creadoEn: '2026-09-10T15:00:00.000Z',
    });
    // El correo del item es el del ACTOR. Del titular: ni correo, ni nombre, ni documento.
    expect(Object.keys(item.titular).sort()).toEqual(['rol', 'userId', 'username']);
    expect(Object.keys(item).sort()).toEqual(['accion', 'actor', 'campo', 'creadoEn', 'entidad', 'id', 'loteId', 'motivo', 'origen', 'rolAfectado', 'titular', 'valorAntes', 'valorDespues']);
    expect(JSON.stringify(item.titular)).not.toMatch(/"(email|name|document|documento|telefono|phone)":/i);
    expect(item.actor.email).toBe('admin@flit.test');
  });

  it('si el JOIN trae más columnas de la cuenta (mock que devuelve la fila entera), el DTO las deja fuera igual', async () => {
    mockListado([{ ...FILA, email: 'titular@ejemplo.test', name: 'Pedro Gómez', document: '123', passwordHash: 'x' }]);
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    const texto = JSON.stringify(r.body.items[0]);
    expect(texto).not.toContain('titular@ejemplo.test');
    expect(texto).not.toContain('Pedro');
    expect(texto).not.toContain('123');
    expect(texto).not.toContain('passwordHash');
  });

  it('un cambio de rol (rol afectado, sin titular) sale con titular null y rolAfectado', async () => {
    mockListado([{ ...FILA, entidad: 'rol', campo: 'nombre', valorAntes: 'Gestor', valorDespues: 'Gestor de impuestos', usuarioAfectadoId: null, usuarioAfectadoRol: null, titularUsername: null, rolAfectadoCodigo: 'gestor_impuestos' }]);
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth('admin'));
    expect(r.body.items[0]).toMatchObject({ titular: null, rolAfectado: 'gestor_impuestos', entidad: 'rol' });
  });
});

describe('GET /api/users/auditoria — filtros y paginación (AC2), afirmados sobre el SQL que se ejecuta', () => {
  it('sin filtros: ningún WHERE, orden created_at DESC, id DESC; limite 50 y offset 0 por defecto', async () => {
    mockListado();
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    const [pagina, conteo] = consultas;
    expect(pagina!.where).toBeUndefined();
    expect(conteo!.where).toBeUndefined();
    expect(pagina!.limit).toBe(50);
    expect(pagina!.offset).toBe(0);
    const orden = pagina!.orderBy!.map((o) => render(o).sql.toLowerCase());
    expect(orden[0]).toContain('"created_at" desc');
    expect(orden[1]).toContain('"id" desc');
  });

  it('por usuario (titularUserId) y por recurso (entidad, rolCodigo): las tres condiciones llegan al WHERE de la página Y del conteo', async () => {
    mockListado([], 0);
    const r = await request(await buildApp()).get('/api/users/auditoria?titularUserId=47&entidad=usuario&rolCodigo=gestor_impuestos')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    for (const c of consultas.slice(0, 2)) {
      const { sql, params } = render(c.where);
      expect(sql).toContain('"usuario_afectado_id" = $');
      expect(sql).toContain('"entidad" = $');
      expect(sql).toContain('"rol_afectado_codigo" = $');
      expect(params).toEqual([47, 'usuario', 'gestor_impuestos']);
    }
  });

  it('por rango de fechas: [desde, hasta) en UTC — `>=` la medianoche de desde y `<` la medianoche de hasta', async () => {
    mockListado([], 0);
    const r = await request(await buildApp()).get('/api/users/auditoria?desde=2026-09-01&hasta=2026-09-10')
      .set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
    const { sql, params } = render(consultas[0]!.where);
    expect(sql).toMatch(/"created_at" >= \$\d+/);
    expect(sql).toMatch(/"created_at" < \$\d+/);
    // `PgDialect` serializa las Date a ISO: lo que se compara es el instante exacto, en UTC.
    expect(params).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z']);
  });

  it('pagina: limite y offset del query llegan a la consulta; la respuesta los devuelve', async () => {
    mockListado([FILA], 120);
    const r = await request(await buildApp()).get('/api/users/auditoria?limite=20&offset=40').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(consultas[0]!.limit).toBe(20);
    expect(consultas[0]!.offset).toBe(40);
    expect(r.body).toMatchObject({ total: 120, limite: 20, offset: 40 });
  });

  it.each([
    ['limite=0', 'limite'], ['limite=201', 'limite'], ['offset=-1', 'offset'], ['entidad=persona', 'entidad'],
    ['rolCodigo=Admin!', 'rolCodigo'], ['desde=10/09/2026', 'desde'], ['titularUserId=abc', 'titularUserId'],
    ['desde=2026-09-10&hasta=2026-09-01', 'hasta'], // rango invertido (TC-09a): pasa Zod y lo para el handler
  ])('%s → 400 con details y sin consultar', async (query, campo) => {
    // Con la base «lista»: si la guarda desaparece, el rango invertido responde 200 con `items: []`
    // y el caso cae por el código, no por un timeout del handler sin mocks.
    mockListado([], 0);
    const r = await request(await buildApp()).get(`/api/users/auditoria?${query}`).set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors).toHaveProperty(campo);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('una fecha imposible (2026-02-31) → 400 (no se convierte en silencio a marzo)', async () => {
    const r = await request(await buildApp()).get('/api/users/auditoria?desde=2026-02-31').set('Authorization', await auth('admin'));
    // V8 convierte «2026-02-31» en el 3 de marzo sin quejarse: el handler exige que la fecha vuelva
    // a escribirse igual, y si no, 400 con el campo nombrado.
    expect(r.status).toBe(400);
    expect(r.body.details.fieldErrors).toHaveProperty('desde');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('historial vacío: total 0, items [] y desdeCuando null', async () => {
    mockListado([], 0, null);
    const r = await request(await buildApp()).get('/api/users/auditoria').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, limite: 50, offset: 0, desdeCuando: null });
  });
});

describe('GET /api/users/auditoria/titulares — la fuente del filtro «Usuario» (mutación 2c)', () => {
  it.each(['proveedor', 'cliente'] as const)('%s (sin usuarios.auditoria.filtrar) → 403', async (role) => {
    selectMock.mockReturnValueOnce(chainEspia([{ userId: 47, username: 'pgomez' }]));
    const r = await request(await buildApp()).get('/api/users/auditoria/titulares').set('Authorization', await auth(role, 5));
    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'auditor'] as const)('%s → 200 con EXACTAMENTE { userId, username } por titular, aunque el JOIN trajera más', async (role) => {
    selectMock.mockReturnValueOnce(chainEspia([
      { userId: 47, username: 'pgomez', email: 'p@ejemplo.test', name: 'Pedro', role: 'proveedor', active: true },
      { userId: 3, username: null },
    ]));
    const r = await request(await buildApp()).get('/api/users/auditoria/titulares').set('Authorization', await auth(role));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ userId: 47, username: 'pgomez' }, { userId: 3, username: null }]);
    for (const t of r.body) expect(Object.keys(t).sort()).toEqual(['userId', 'username']);
    // La consulta: solo filas con titular, agrupadas por (id, username), ordenadas por username.
    const [c] = consultas;
    expect(render(c!.where).sql).toContain('"usuario_afectado_id" is not null');
    expect(c!.groupBy).toHaveLength(2);
    expect(render(c!.orderBy![0]).sql.toLowerCase()).toContain('"username" nulls last');
  });

  it('no es una ruta paramétrica: /auditoria/titulares no cae en PATCH /:id ni en /:id/…', async () => {
    selectMock.mockReturnValueOnce(chainEspia([]));
    const r = await request(await buildApp()).get('/api/users/auditoria/titulares').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});
