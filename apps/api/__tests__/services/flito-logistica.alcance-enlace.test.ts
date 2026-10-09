// HU #13426 (Feature #12871) — Logística abierta a `compania`: ve SOLO lo suyo (AC2), opera SUS actas
// si su rol tiene la función y las ajenas → 403 sin oráculo (P-2, AC3); escaneo/validación por placa y
// la ruta del mensajero cerrados a todo enlace.
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
await import('../../src/db/client.js');

const FUNCIONES = ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.actas.ver',
  'logistica.actas.despachar', 'logistica.lote.cerrar', 'logistica.lt.validar', 'logistica.documento.escanear',
  'logistica.ruta.ver', 'logistica.viajes.quitar', 'logistica.documento.ver'];
const C = 42;
const ACTA = '00000000-0000-0000-0000-0000000000a8';
const TRAMITE = '00000000-0000-0000-0000-0000000000b9';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
  const { default: viajes } = await import('../../src/modules/flito-logistica/flito-logistica-viajes.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/logistica', conAlcance('logistica', router));
  a.use('/api/flito/logistica', conAlcance('logistica', viajes));
  a.use(errorHandler);
  return a;
}
let sub = 8600;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;
const deC = () => h.cap.responder([{ c: C, p: null }]);
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
const escrituras = () => h.cap.consultas.filter((c) => c.tipo !== 'select' && c.tipo !== 'selectDistinct');

beforeEach(() => { h.cap.reset(); });

describe('AC2 — la compañía solo ve lo suyo', () => {
  it('GET / → `flito_tramites.compania_id = C` en el COUNT y en la página', async () => {
    deC();
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/logistica').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.sql).toMatch(/"flito_tramites"\."compania_id" = \$\d/);
    for (const x of w) expect(x.params).toContain(C);
  });

  it('AC7 — facetas acotadas a C y sin mensajeros (personal de FLIT)', async () => {
    deC();
    const r = await request(await app()).get('/api/flito/logistica/facetas').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(r.body.mensajeros).toEqual([]);
    const w = wheres();
    expect(w).toHaveLength(3);
    for (const x of w) expect(x.params).toContain(C);
  });

  it('GET /actas → `flito_logistica_actas.compania_id = C`', async () => {
    deC();
    const r = await request(await app()).get('/api/flito/logistica/actas').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(wheres()).toEqual([{ sql: '"flito_logistica_actas"."compania_id" = $1', params: [C] }]);
  });

  it('GET /actas/:id ajena → 404 con la condición EN EL WHERE', async () => {
    deC();
    h.cap.responder([]);
    const r = await request(await app()).get(`/api/flito/logistica/actas/${ACTA}`).set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([404, { error: 'El acta no existe' }]);
    expect(wheres()[0]).toEqual({ sql: '("flito_logistica_actas"."id" = $1 and "flito_logistica_actas"."compania_id" = $2)', params: [ACTA, C] });
  });
});

describe('AC3 / P-2 — escritura ajena 403 sin oráculo; la propia pasa la guarda', () => {
  it('despachar un acta ajena → 403; no se escribe nada', async () => {
    deC();
    h.cap.responder([]);
    const r = await request(await app()).post(`/api/flito/logistica/actas/${ACTA}/despachar`).set('Authorization', await como('compania'))
      .send({ mensajeroId: 1, firmaEntrega: 'data:image/png;base64,AAAA' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(escrituras()).toEqual([]);
  });

  it('cerrar el lote de OTRA compañía → 403 sin comprobar si existe (ni una consulta más que el alcance)', async () => {
    deC();
    const r = await request(await app()).post('/api/flito/logistica/cerrar-lote').set('Authorization', await como('compania')).send({ companiaId: 43 });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toHaveLength(1);
  });

  it('quitar un viaje de un trámite ajeno → 403 (la condición de C va en el WHERE de la guarda)', async () => {
    deC();
    h.cap.responder([]);
    const r = await request(await app()).delete(`/api/flito/logistica/tramites/${TRAMITE}/viajes/${ACTA}`)
      .set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(wheres()[0]?.params).toEqual([TRAMITE, C]);
    expect(escrituras()).toEqual([]);
  });
});

describe('P-2 — escaneo, validación por placa y ruta del mensajero cerrados a todo enlace', () => {
  it.each([['post', '/validar-lt'], ['post', '/escanear'], ['get', '/mi-ruta']] as const)('%s %s → 403, sin consultar', async (m, ruta) => {
    const r = await request(await app())[m](`/api/flito/logistica${ruta}`).set('Authorization', await como('compania')).send({ rawValue: 'X' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });

  it('AC1 — sin enlace (mensajero): el listado no lleva condición de compañía', async () => {
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/logistica').set('Authorization', await como('ninguno', 'mensajero'));
    expect(r.status).toBe(200);
    for (const x of wheres()) expect(x.sql).not.toContain('compania_id" =');
  });
});

describe('Habeas Data (bloqueante de security) — la compañía no recibe nombres de empleados de FLIT', () => {
  const VER = [...FUNCIONES, 'logistica.viajes.ver'];
  const conVer = async (tipoEnlace: string, role = 'xyz_renombrado') =>
    `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: VER })}`;
  const EN = new Date('2026-10-01T00:00:00Z');
  const CAB = { id: ACTA, companiaId: C, companiaNombre: 'Cia', estado: 'abierta', mensajeroId: 3, mensajeroNombre: 'Mensajero', receptorNombre: null, entregadoEn: null, creadoEn: EN, pdfStorageKey: null, firmaEntregaKey: null, entregaNombre: null, firmaRecibeKey: null };
  const EV = { id: 'e1', documentoId: 'd1', placa: 'ABC123', estadoAnterior: null, estadoNuevo: 'escaneado', actorNombre: 'Ana Interna', lat: null, lng: null, motivo: null, origen: 'usuario', creadoEn: EN };
  const TRAM = { id: TRAMITE, docId: 'd1', idFlit: 'F-1', createdAt: EN, fechaAprobacion: EN };
  const VIAJE = { id: 'v1', numero: 2, modo: 'moto', valor: '1000', tarifaVigente: null, motivo: 'otro', motivoDetalle: null, registradoPorId: 7, registradoPorNombre: 'Ana Interna', registradoEn: EN };

  it('compañía: la bitácora del acta sale con `actorNombre` null', async () => {
    deC();
    h.cap.responder([{ id: ACTA }], [CAB], [], [EV]);
    const r = await request(await app()).get(`/api/flito/logistica/actas/${ACTA}`).set('Authorization', await conVer('compania'));
    expect(r.status).toBe(200);
    expect(r.body.bitacora).toEqual([expect.objectContaining({ id: 'e1', actorNombre: null })]);
    expect(JSON.stringify(r.body)).not.toContain('Ana Interna');
  });

  it('sin enlace: la bitácora del acta nombra al actor', async () => {
    h.cap.responder([CAB], [], [EV]);
    const r = await request(await app()).get(`/api/flito/logistica/actas/${ACTA}`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(r.status).toBe(200);
    expect(r.body.bitacora[0].actorNombre).toBe('Ana Interna');
  });

  it('compañía / sin enlace: la bitácora del trámite (`eventos`) sin nombre / con nombre', async () => {
    deC();
    h.cap.responder([{ id: TRAMITE }], [TRAM], [{ propietarioDocumento: null, combustible: null, fotoStorageKey: null }], [EV]);
    const c = await request(await app()).get(`/api/flito/logistica/${TRAMITE}`).set('Authorization', await conVer('compania'));
    expect(c.status).toBe(200);
    expect(c.body.eventos).toEqual([expect.objectContaining({ id: 'e1', actorNombre: null })]);
    h.cap.responder([TRAM], [{ propietarioDocumento: null, combustible: null, fotoStorageKey: null }], [EV]);
    const n = await request(await app()).get(`/api/flito/logistica/${TRAMITE}`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(n.body.eventos[0].actorNombre).toBe('Ana Interna');
  });

  it('compañía / sin enlace: los viajes adicionales sin / con `registradoPorNombre`', async () => {
    const CTX = { id: TRAMITE, idFlit: 'F-1', companiaId: C, logisticaAutogestionable: false, excepcionViva: false };
    // Cuántas lecturas hay entre el contexto y los viajes (liquidación, tarifa): se miden, no se suponen.
    h.cap.reset();
    h.cap.responder([CTX]);
    await request(await app()).get(`/api/flito/logistica/tramites/${TRAMITE}/viajes`).set('Authorization', await conVer('ninguno', 'admin'));
    const medio = Array.from({ length: h.cap.consultas.length - 2 }, () => []);
    h.cap.reset();
    deC();
    h.cap.responder([{ id: TRAMITE }], [CTX], ...medio, [VIAJE]);
    const c = await request(await app()).get(`/api/flito/logistica/tramites/${TRAMITE}/viajes`).set('Authorization', await conVer('compania'));
    expect(c.status).toBe(200);
    expect(c.body.items).toEqual([expect.objectContaining({ id: 'v1', registradoPorNombre: null })]);
    expect(JSON.stringify(c.body)).not.toContain('Ana Interna');
    h.cap.reset();
    h.cap.responder([CTX], ...medio, [VIAJE]);
    const n = await request(await app()).get(`/api/flito/logistica/tramites/${TRAMITE}/viajes`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(n.body.items[0].registradoPorNombre).toBe('Ana Interna');
  });
});
