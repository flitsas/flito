// HU #13426 (Feature #12871, AC6/AC7/AC8/AC9, decisión del PO 2026-10-09) — La página Tránsito antigua
// (`/api/transito`) abierta a `organismos_transito`: TODAS sus secretarías (S1 y S2, `inArray`), no solo
// la primera; el alcance sale del enlace (no de `role === 'transito'`); la configuración, cerrada.
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
vi.mock('../../src/modules/tramites/eventos.js', () => ({ emitEvento: vi.fn() }));
vi.mock('../../src/modules/tramites/notificaciones.js', () => ({ notifyEstado: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/vehicles/vehiculo-historial.js', () => ({ appendEventoSafe: vi.fn().mockResolvedValue(undefined) }));
await import('../../src/db/client.js');

const S1 = '05001';
const S2 = '11001';
const FUNCIONES = ['transito.bandeja.ver_pendientes', 'transito.organismos.listar', 'transito.tramite.tomar', 'transito.traspasos.ver'];

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/transito.routes.js');
  const { default: config } = await import('../../src/modules/tramites/transito-config.routes.js');
  a.use('/api/transito', conAlcance('transito', router));
  a.use('/api/transito', config); // como en app.ts: SIN declarar
  return a;
}
let sub = 8800;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('flito_gestor_organismos') && !w.sql.includes('"users"'));

beforeEach(() => { h.cap.reset(); });

describe('AC6 / AC9 — todas sus secretarías, decida el enlace', () => {
  it('un rol RENOMBRADO con enlace organismos [S1, S2] → pendientes con `organismo_codigo in (S1, S2)`', async () => {
    h.cap.responder([{ c: S1 }, { c: S2 }], []);
    const r = await request(await app()).get('/api/transito/pendientes').set('Authorization', await como('organismos_transito'));
    expect(r.status).toBe(200);
    const [w] = wheres();
    expect(w!.sql).toMatch(/"tramites_digitales"\."organismo_codigo" in \(\$\d+, \$\d+\)/);
    expect(w!.params).toEqual(expect.arrayContaining([S1, S2]));
  });

  it('el detalle de un traspaso de S2 (la SEGUNDA secretaría) se sirve; uno de otra → 404', async () => {
    h.cap.responder([{ c: S1 }, { c: S2 }], [{ id: 9, modalidadEntrada: 'traspaso', organismoCodigo: S2 }]);
    const ok = await request(await app()).get('/api/transito/traspasos/9').set('Authorization', await como('organismos_transito'));
    expect(ok.status).toBe(200);
    h.cap.reset();
    h.cap.responder([{ c: S1 }, { c: S2 }], [{ id: 9, modalidadEntrada: 'traspaso', organismoCodigo: '08001' }]);
    const ajeno = await request(await app()).get('/api/transito/traspasos/9').set('Authorization', await como('organismos_transito'));
    expect([ajeno.status, ajeno.body]).toEqual([404, { error: 'Traspaso no encontrado' }]);
  });

  it('AC3 — tomar un trámite de otra secretaría → 403 y no se actualiza', async () => {
    h.cap.responder([{ c: S1 }], [{ estado: 'enviado_transito', organismoCodigo: S2 }]);
    const r = await request(await app()).post('/api/transito/tomar/5').set('Authorization', await como('organismos_transito'));
    expect(r.status).toBe(403);
    expect(h.cap.consultas.filter((c) => c.tipo === 'update')).toEqual([]);
  });

  it('AC7 — GET /organismos: solo SUS secretarías del catálogo', async () => {
    h.cap.responder([{ c: S1 }, { c: S2 }]);
    const r = await request(await app()).get('/api/transito/organismos').set('Authorization', await como('organismos_transito'));
    expect(r.body.map((o: { codigo: string }) => o.codigo).sort()).toEqual([S1, S2]);
  });

  it('sin secretarías (ni puente ni columna) → 403 con el mensaje de siempre', async () => {
    h.cap.responder([], [{ t: null }]);
    const r = await request(await app()).get('/api/transito/pendientes').set('Authorization', await como('organismos_transito'));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no tiene organismo de tránsito asignado/);
  });
});

describe('AC1 / AC4 — sin enlace ve todo; compañía y configuración cerradas', () => {
  it('sin enlace: pendientes sin condición de organismo; `?organismo=` acota a uno', async () => {
    h.cap.responder([]);
    await request(await app()).get('/api/transito/pendientes').set('Authorization', await como('ninguno', 'mensajero'));
    expect(wheres()[0]!.sql).not.toContain('organismo_codigo');
    h.cap.reset();
    h.cap.responder([]);
    await request(await app()).get(`/api/transito/pendientes?organismo=${S1}`).set('Authorization', await como('ninguno', 'admin'));
    expect(wheres()[0]!.params).toContain(S1);
  });

  it('compañía → 403 de la frontera', async () => {
    const r = await request(await app()).get('/api/transito/pendientes').set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });

  it('la configuración (`transitoConfigRoutes`, sin declarar) → 403 para organismos, sin consultar', async () => {
    const r = await request(await app()).get(`/api/transito/organismos-config/${S1}`).set('Authorization', await como('organismos_transito'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });
});
