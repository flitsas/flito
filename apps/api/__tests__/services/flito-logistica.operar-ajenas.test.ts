// HU #13425 (AC3, AC7) — La regla de propiedad de flito-logistica (CA-11: «solo tus propias actas»)
// la decide la función `logistica.actas.operar_ajenas`, no el nombre `mensajero`:
//   · entregar / devolver un acta ajena sin la función → 403, se llame el rol como se llame;
//   · con la función → pasa la regla, aunque el rol se llame `mensajero`;
//   · mi ruta: sin la función, el WHERE lleva `mensajero_id = <yo>`; con ella, no;
//   · candidatos a mensajero (facetas): quien entrega y NO opera ajenas, leído de permisos.
// Las rutas usan `authMiddleware` + `exigirFuncion`/`tieneFuncion` de verdad sobre el double de
// permisos de `helpers/auth.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { testToken, registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, selectDistinct: selectDistinctMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/key'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const UUID = '00000000-0000-0000-0000-000000000001';
/** Acta despachada asignada al usuario 9. */
const ACTA_DE_9 = { id: UUID, estado: 'despachada', mensajeroId: 9, companiaId: 5 };
const ENTREGA = { receptorNombre: 'Ana', receptorDocumento: '123', firma: 'data:image/png;base64,AAAA' };

const dialecto = new PgDialect();
const aSql = (c: unknown) => dialecto.sqlToQuery(c as SQL);

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset().mockReturnValue(chain([]));
  updateMock.mockReset().mockReturnValue(chain([]));
  transactionMock.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ select: selectMock, insert: insertMock, update: updateMock }));
});

describe('servicio — la propiedad la decide `operaAjenas`, no `role`', () => {
  it('rol llamado `admin` SIN la función → 403 al entregar un acta ajena', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    await expect(svc.entregar(UUID, ENTREGA, { userId: 1, username: 'a', role: 'admin', operaAjenas: false }))
      .rejects.toMatchObject({ status: 403, message: 'Solo puedes entregar tus propias actas' });
  });

  it('rol llamado `mensajero` CON la función → pasa la regla y entrega', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const r = await svc.entregar(UUID, ENTREGA, { userId: 1, username: 'm', role: 'mensajero', operaAjenas: true });
    expect(r).toHaveProperty('documentos');
  });

  it('devolución: SIN la función y acta ajena → 403; la propia sin la función → pasa', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    await expect(svc.registrarDevolucion(UUID, 'No estaba', { userId: 1, username: 'a', role: 'admin', operaAjenas: false }))
      .rejects.toMatchObject({ status: 403 });
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    await expect(svc.registrarDevolucion(UUID, 'No estaba', { userId: 9, username: 'm', role: 'cualquiera', operaAjenas: false }))
      .resolves.toHaveProperty('documentos');
  });

  it('mi ruta: sin la función el WHERE ata `mensajero_id` al usuario; con ella, no', async () => {
    const wheres: unknown[] = [];
    const espia = () => {
      const c = { from: () => c, leftJoin: () => c, where: (w: unknown) => { wheres.push(w); return Promise.resolve([]); } };
      return c;
    };
    selectMock.mockImplementation(espia);
    await svc.miRuta({ userId: 77, username: 'm', role: 'admin', operaAjenas: false });
    await svc.miRuta({ userId: 77, username: 'm', role: 'mensajero', operaAjenas: true });
    const [propias, todas] = wheres.map(aSql);
    expect(propias!.sql).toMatch(/"mensajero_id" = \$\d/);
    expect(propias!.params).toContain(77);
    expect(todas!.sql).not.toMatch(/mensajero_id/);
  });

  it('facetas: candidatos a mensajero = entregan y NO operan ajenas, sin mirar el nombre del rol', async () => {
    selectDistinctMock.mockReturnValue(chain([])); // empresas y organismos
    selectMock
      .mockReturnValueOnce(chain([])) // compañías cerrables
      .mockReturnValueOnce(chain([ // usuarios activos con su rol
        { id: 9, rol: 'repartidor_norte', tipoEnlace: 'ninguno' },
        { id: 10, rol: 'admin', tipoEnlace: 'ninguno' },
        { id: 11, rol: 'mensajero', tipoEnlace: 'ninguno' },
      ]))
      .mockReturnValueOnce(chain([ // reparto de las dos funciones
        { rol: 'repartidor_norte', codigo: 'logistica.actas.entregar' },
        { rol: 'admin', codigo: 'logistica.actas.entregar' },
        { rol: 'admin', codigo: 'logistica.actas.operar_ajenas' },
        { rol: 'mensajero', codigo: 'logistica.actas.entregar' },
      ]))
      .mockReturnValueOnce(chain([{ userId: 11, codigo: 'logistica.actas.entregar', efecto: 'revocar' }]))
      .mockImplementationOnce(() => {
        const c = { from: () => c, where: (w: unknown) => { nombres.push(w); return Promise.resolve([{ id: 9, nombre: 'Rep' }]); } };
        return c;
      });
    const nombres: unknown[] = [];
    const f = await svc.facetas();
    expect(f.mensajeros).toEqual([{ id: 9, nombre: 'Rep' }]);
    // La consulta de nombres pide SOLO al 9: ni el admin (opera ajenas) ni el mensajero revocado.
    expect(aSql(nombres[0]).params).toEqual([9]);
  });
});

describe('rutas — AC3/AC7: mismo resultado con otro nombre de rol y los mismos permisos', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  const entregar = (token: string) => request(app).post(`/api/flito/logistica/actas/${UUID}/entregar`)
    .set('Authorization', `Bearer ${token}`).send(ENTREGA);

  it('`mensajero` (sin la función) entregando un acta ajena → 403', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const token = await testToken({ sub: 50, role: 'mensajero' });
    const r = await entregar(token);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Solo puedes entregar tus propias actas');
  });

  it('rol RENOMBRADO con las mismas funciones que mensajero → el mismo 403', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const token = await testToken({ sub: 51, role: 'mensajero' });
    await registrarUsuarioDePrueba(51, {
      rol: 'repartidor_norte', tipoEnlace: 'ninguno',
      funcionesDelRol: ['logistica.actas.entregar', 'logistica.actas.devolver', 'logistica.ruta.ver'], excepciones: [],
    });
    const r = await entregar(token);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Solo puedes entregar tus propias actas');
  });

  it('rol llamado `admin` con las funciones de mensajero (sin operar_ajenas) → también 403', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const token = await testToken({ sub: 52, role: 'admin' });
    await registrarUsuarioDePrueba(52, {
      rol: 'admin', tipoEnlace: 'ninguno',
      funcionesDelRol: ['logistica.actas.entregar'], excepciones: [],
    });
    const r = await entregar(token);
    expect(r.status).toBe(403);
  });

  it('`mensajero` con la excepción `conceder logistica.actas.operar_ajenas` → entrega el acta ajena (200)', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const token = await testToken({ sub: 53, role: 'mensajero' });
    await registrarUsuarioDePrueba(53, {
      rol: 'mensajero', tipoEnlace: 'ninguno',
      funcionesDelRol: ['logistica.actas.entregar'], excepciones: [{ codigo: 'logistica.actas.operar_ajenas', efecto: 'conceder' }],
    });
    const r = await entregar(token);
    expect(r.status).toBe(200);
  });

  it('`admin` de partida (la siembra le da operar_ajenas) entrega el acta ajena (200) — paridad con hoy', async () => {
    selectMock.mockReturnValue(chain([ACTA_DE_9]));
    const token = await testToken({ sub: 54, role: 'admin' });
    const r = await entregar(token);
    expect(r.status).toBe(200);
  });
});
