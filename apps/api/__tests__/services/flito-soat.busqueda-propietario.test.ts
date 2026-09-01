// HU #11914 (Feature #11912) — la búsqueda por propietario de la cola tiene que encontrar TAMBIÉN
// las solicitudes del canal Cliente.
//
// ── El fallo que este archivo existe para impedir ────────────────────────────────────────────────
//
// `flito_compradores` cuelga de DOS padres desde la migración 0167: `tramite_id` (el flujo de
// siempre) y `soat_id` (el canal Cliente). El término de búsqueda de la cola tenía un solo EXISTS,
// el del trámite:
//
//     EXISTS (… FROM flito_tramites ft JOIN flito_compradores fc ON fc.tramite_id = ft.id
//             WHERE ft.soat_id = flito_soat.id AND …)
//
// Una solicitud del canal tiene `tramite_id IS NULL`, así que no entra por ese JOIN y el EXISTS da
// FALSE. Consecuencia: **el admin busca por el nombre del propietario y recibe MENOS FILAS DE LAS QUE
// HAY, en verde** — justo las que tiene que revisar. Es el peor modo de fallo de una pantalla de
// revisión, y la auditoría de esquema lo dejó como carga de esta HU.
//
// ── Por qué se mide el SQL y no las filas devueltas ──────────────────────────────────────────────
//
// El mock de drizzle devuelve lo que el test le registre: un test que pidiera «busca a JUANA y
// comprueba que sale» pasaría con las dos ramas, con una, y hasta con ninguna. Lo que se afirma aquí
// es el WHERE que Postgres recibiría, renderizado con el dialecto real (`PgDialect.sqlToQuery`).
// Quitar la rama nueva del servicio pone rojo este archivo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

/** Los WHERE que el servicio le pasó a Drizzle, en orden. */
const wheres: SQL[] = [];

function chainEspia(rows: unknown[]) {
  const t: Record<string, unknown> = {};
  const paso = () => t;
  for (const m of ['from', 'leftJoin', 'innerJoin', 'limit', 'offset', 'orderBy', 'groupBy', 'having', '$dynamic', 'for']) {
    t[m] = paso;
  }
  t.where = (w: SQL) => { wheres.push(w); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows).catch(rej);
  t.finally = (cb: () => void) => Promise.resolve(rows).finally(cb);
  return t;
}

const dialecto = new PgDialect();
const aSql = (w: SQL) => dialecto.sqlToQuery(w);

beforeEach(() => { selectMock.mockReset(); wheres.length = 0; });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const adminAuth = async () => `Bearer ${await testToken({ sub: 1, username: 'admin@flit.io', role: 'admin' })}`;

/** Conteo + página, las dos consultas de la cola de un admin. */
function colaVacia() {
  selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));
  selectMock.mockImplementationOnce(() => chainEspia([]));
}

describe('cola SOAT — buscar por propietario alcanza a los DOS padres de `flito_compradores`', () => {
  it('**el WHERE lleva la rama `fc.soat_id`, no solo la del trámite**', async () => {
    colaVacia();
    const r = await request(await buildApp()).get('/api/flito/soat?buscar=JUANA').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);

    // Conteo y página: la condición tiene que estar en las DOS. Si solo estuviera en la de filas, el
    // total contaría distinto de lo que se ve y nadie lo notaría.
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      const { sql } = aSql(w);
      // La rama vieja (trámite) sigue ahí: esto NO sustituye, añade.
      expect(sql).toContain('ft.soat_id =');
      expect(sql).toContain('fc.tramite_id = ft.id');
      // Y la rama nueva, la del canal Cliente.
      expect(sql).toContain('fc.soat_id =');
    }
  });

  it('las dos ramas buscan por lo MISMO: nombre y documento, con el mismo término', async () => {
    colaVacia();
    await request(await buildApp()).get('/api/flito/soat?buscar=juana').set('Authorization', await adminAuth());

    const { sql, params } = aSql(wheres[1]);
    // Dos EXISTS, uno por padre. Con uno solo, media cola queda sin buscar.
    expect(sql.match(/EXISTS/g) ?? []).toHaveLength(2);
    // El nombre se compara en MAYÚSCULAS en las dos, y el término va parametrizado (nada de
    // concatenar el texto del usuario dentro del SQL).
    expect(sql.match(/UPPER\(fc\.nombre_completo\) LIKE/g) ?? []).toHaveLength(2);
    expect(sql.match(/fc\.numero_documento LIKE/g) ?? []).toHaveLength(2);
    expect(params).toContain('%JUANA%');
  });

  it('sin término de búsqueda no se añade ningún EXISTS (la cola normal no paga esto)', async () => {
    colaVacia();
    await request(await buildApp()).get('/api/flito/soat').set('Authorization', await adminAuth());

    for (const w of wheres) expect(aSql(w).sql).not.toContain('EXISTS');
  });
});
