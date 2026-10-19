// HU #13684 — aviso de trámites nuevos o actualizados: `POST /api/flito/tramites/novedades` y la
// `marca` del listado.
//
// AC1: el conteo de nuevos usa el MISMO filtro del listado y no depende de página ni orden.
// AC2: los actualizados salen solo de los ids visibles y excluyen lo que ya cuenta como nuevo.
// AC4: la respuesta son dos números (sin ids ni PII), `no-store`; los errores son códigos manejables.
//
// Router REAL montado como en `app.ts` (`conAlcance`) sobre el doble de drizzle que CAPTURA los
// `where` (`alcance-captura.ts`): los asertos van sobre el SQL renderizado, no sobre filas del test.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura> }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));
await import('../../src/db/client.js'); // evalúa la factory del doble y deja `h.cap` listo

const URL = '/api/flito/tramites/novedades';
const MARCA = '2026-10-19T15:04:05.123456Z';
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000a2';
const C = 42;

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/tramites', conAlcance('tramites', router));
  a.use(errorHandler);
  return a;
}

// Cada test con su propio `sub`: el limitador cuenta por usuario y no debe contaminar a los demás.
let sub = 13684_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;
const deCompania = async () => `Bearer ${await testToken({
  sub: ++sub, role: 'xyz_renombrado' as never, tipoEnlace: 'compania', funciones: ['tramites.cola.ver'],
})}`;

const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));

beforeEach(() => { h.cap.reset(); });

describe('HU #13684 · POST /novedades — autenticación y permiso (AC4)', () => {
  it('401 sin token y sin tocar la BD', async () => {
    const r = await request(await app()).post(URL).send({ marca: MARCA });
    expect(r.status).toBe(401);
    expect(h.cap.consultas).toHaveLength(0);
  });

  it('403 sin la función tramites.cola.ver', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: [] });
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ marca: MARCA });
    expect(r.status).toBe(403);
    expect(wheres()).toHaveLength(0);
  });
});

describe('HU #13684 · POST /novedades — body estricto (AC4)', () => {
  const casos: Array<[string, unknown]> = [
    ['marca no ISO', { marca: 'ayer' }],
    ['marca sin zona horaria válida', { marca: '2026-10-19 10:00' }],
    ['sin marca', { filtros: {} }],
    ['visibles > 200', { marca: MARCA, visibles: Array.from({ length: 201 }, () => T1) }],
    ['uuid inválido en visibles', { marca: MARCA, visibles: ['no-es-uuid'] }],
    ['clave extra', { marca: MARCA, ids: [T1] }],
    ['filtro que no es texto', { marca: MARCA, filtros: { estados: ['Asignado'] } }],
  ];
  for (const [nombre, body] of casos) {
    it(`400 ${nombre}`, async () => {
      const r = await request(await app()).post(URL).set('Authorization', await admin()).send(body as object);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Datos inválidos' });
      expect(wheres()).toHaveLength(0);
    });
  }
});

describe('HU #13684 · POST /novedades — conteos', () => {
  it('AC1: nuevos = COUNT con el filtro del listado y created_at > marca; sin página ni orden', async () => {
    h.cap.responder([{ total: 3, marca: 'x' }]);
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({
      marca: MARCA,
      // page/orden de una página 3 «más antiguos primero»: el nuevo caería en otra página, y aun así cuenta.
      filtros: { estados: 'Asignado', fuente: 'flit2', orden: 'antiguos', page: '3', pageSize: '50' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ nuevos: 3, actualizados: 0 });
    // Sin visibles: UNA sola consulta, el COUNT. No hay proyección paginada.
    expect(h.cap.consultas).toHaveLength(1);
    const [w] = wheres();
    expect(w.sql).toContain('"flito_tramites"."flit_estado" in');
    expect(w.sql).toContain('"flito_tramites"."fuente" = $');
    expect(w.sql).toMatch(/"flito_tramites"\."created_at" > \$\d+::timestamptz/);
    expect(w.params).toEqual(expect.arrayContaining(['Asignado', 'flit2', MARCA]));
    expect(w.params).not.toContain('3');
  });

  it('AC1: un valor de filtro desconocido se ignora igual que en el GET (no filtra, no falla)', async () => {
    h.cap.responder([{ total: 0 }]);
    const r = await request(await app()).post(URL).set('Authorization', await admin())
      .send({ marca: MARCA, filtros: { fuente: 'otra', alerta: 'inventada', creadoDesde: 'ayer' } });
    expect(r.status).toBe(200);
    const [w] = wheres();
    expect(w.sql).not.toContain('"fuente"');
    expect(w.params).not.toContain('ayer');
  });

  it('AC2: actualizados solo sobre los visibles, con updated_at > marca y excluyendo nuevos (created_at <= marca)', async () => {
    h.cap.responder([{ total: 1 }], [{ total: 2 }]);
    const r = await request(await app()).post(URL).set('Authorization', await admin())
      .send({ marca: MARCA, visibles: [T1, T2] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ nuevos: 1, actualizados: 2 });
    const ws = wheres();
    expect(ws).toHaveLength(2);
    const act = ws[1];
    expect(act.sql).toMatch(/"flito_tramites"\."id" in \(\$\d+, \$\d+\)/);
    expect(act.sql).toMatch(/"flito_tramites"\."updated_at" > \$\d+::timestamptz/);
    expect(act.sql).toMatch(/"flito_tramites"\."created_at" <= \$\d+::timestamptz/);
    expect(act.params).toEqual(expect.arrayContaining([T1, T2, MARCA]));
  });

  it('AC2: sin visibles no hay consulta de actualizados y da 0 (lectura sin cambios = 0 y 0)', async () => {
    h.cap.responder([{ total: 0 }]);
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ marca: MARCA });
    expect(r.body).toEqual({ nuevos: 0, actualizados: 0 });
    expect(h.cap.consultas).toHaveLength(1);
  });

  it('alcance: con enlace compañía, nuevos Y actualizados llevan compania_id = C (un id ajeno no cuenta)', async () => {
    h.cap.responder([{ c: C, p: null }], [{ total: 0 }], [{ total: 0 }]);
    const r = await request(await app()).post(URL).set('Authorization', await deCompania())
      .send({ marca: MARCA, visibles: [T1] });
    expect(r.status).toBe(200);
    const ws = wheres();
    expect(ws).toHaveLength(2);
    for (const w of ws) {
      const m = /"flito_tramites"\."compania_id" = \$(\d+)/.exec(w.sql);
      expect(m).not.toBeNull();
      expect(w.params[Number(m![1]) - 1]).toBe(C);
    }
  });

  it('AC4: la respuesta trae SOLO los dos contadores, sin PII, y con Cache-Control: no-store', async () => {
    h.cap.responder([{ total: 1, idFlit: 'FLIT-9', placa: 'QTQ100' }], [{ total: 1 }]);
    const r = await request(await app()).post(URL).set('Authorization', await admin())
      .send({ marca: MARCA, filtros: { buscar: 'QTQ100' }, visibles: [T1] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['actualizados', 'nuevos']);
    expect(JSON.stringify(r.body)).not.toMatch(/QTQ100|FLIT-9|0000000000a1/);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('HU #13684 · GET / — la marca del listado', () => {
  it('el listado devuelve `marca`, tomada en el mismo SELECT del COUNT (sin consulta extra)', async () => {
    h.cap.responder([{ total: 0, marca: MARCA }], []);
    const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await admin());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: [], total: 0, marca: MARCA });
    // COUNT + página: la marca no añadió un viaje a la BD.
    expect(h.cap.consultas).toHaveLength(2);
  });
});

describe('HU #13684 · POST /novedades — limitador por usuario', () => {
  it('429 a partir de la 7.ª consulta del mismo usuario en el minuto', async () => {
    const a = await app();
    const tok = await admin();
    const estados: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.cap.responder([{ total: 0 }]);
      estados.push((await request(a).post(URL).set('Authorization', tok).send({ marca: MARCA })).status);
    }
    expect(estados.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(estados[6]).toBe(429);
    // Otro usuario no comparte cupo.
    h.cap.responder([{ total: 0 }]);
    expect((await request(a).post(URL).set('Authorization', await admin()).send({ marca: MARCA })).status).toBe(200);
  });
});
