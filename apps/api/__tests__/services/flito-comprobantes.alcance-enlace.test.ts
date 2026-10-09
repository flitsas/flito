// HU #13426 (Feature #12871) — Comprobantes abierto a `compania` para LEER lo suyo (AC2); toda la
// escritura y el buscador de trámites, cerrados a todo enlace (decisión P-2 del PO).
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

const FUNCIONES = ['comprobantes.cola.ver', 'comprobantes.comprobante.ver', 'comprobantes.archivo.descargar',
  'comprobantes.lote.cargar', 'comprobantes.tramites.buscar', 'comprobantes.comprobante.releer', 'comprobantes.comprobante.aplicar',
  'comprobantes.comprobante.descartar', 'comprobantes.diferencia.aceptar'];
const C = 42;
const ID = '00000000-0000-0000-0000-0000000000a7';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/comprobantes', conAlcance('comprobantes', router));
  a.use(errorHandler);
  return a;
}
let sub = 8500;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
/** La asociación al trámite de C: `tramite_id in (select id from flito_tramites where compania_id = C)`. */
const ASOCIADO_A_C = /"flito_comprobantes"\."tramite_id" in \(select "flito_tramites"\."id" from "flito_tramites" where "flito_tramites"\."compania_id" = \$(\d+)\)/;

beforeEach(() => { h.cap.reset(); });

describe('AC2 — la compañía solo ve comprobantes asociados a SUS trámites', () => {
  it('GET / → la asociación a C va en el COUNT y en la página', async () => {
    h.cap.responder([{ c: C, p: null }], [{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/comprobantes').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) {
      const m = ASOCIADO_A_C.exec(x.sql);
      expect(m, x.sql).not.toBeNull();
      expect(x.params[Number(m![1]) - 1]).toBe(C);
    }
  });

  it('GET /:id ajeno → 404 (la asociación va EN EL WHERE del detalle)', async () => {
    h.cap.responder([{ c: C, p: null }], []);
    const r = await request(await app()).get(`/api/flito/comprobantes/${ID}`).set('Authorization', await como('compania'));
    expect(r.status).toBe(404);
    const [w] = wheres();
    expect(w!.sql).toMatch(ASOCIADO_A_C);
    expect(w!.params).toEqual([ID, C]);
  });

  it('AC1 — sin enlace: el listado no lleva la asociación', async () => {
    h.cap.responder([{ total: 0 }], []);
    await request(await app()).get('/api/flito/comprobantes').set('Authorization', await como('ninguno', 'mensajero'));
    for (const x of wheres()) expect(x.sql).not.toContain('flito_tramites');
  });
});

describe('P-2 — la escritura y el buscador por placa son internos de FLIT: 403 a todo enlace, sin consultar', () => {
  it.each([
    ['/tramites/buscar', { buscar: 'ABC123' }], [`/${ID}/releer`, {}], [`/${ID}/aplicar`, {}],
    [`/${ID}/descartar`, { motivo: 'no aplica aquí' }], [`/${ID}/diferencia/aceptar`, { motivo: 'aceptada' }], ['', {}],
  ])('POST %s → 403', async (ruta, cuerpo) => {
    const r = await request(await app()).post(`/api/flito/comprobantes${ruta}`).set('Authorization', await como('compania')).send(cuerpo);
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });
});

describe('Habeas Data (bloqueante de security) — la compañía no recibe nombres de empleados de FLIT', () => {
  const FILA = {
    id: ID, loteId: 'l1', estado: 'aplicado', tramiteId: null, tramiteIdFlit: null, createdAt: new Date('2026-10-01T00:00:00Z'),
    aplicadoEn: new Date('2026-10-02T00:00:00Z'), descartadoEn: null, aplicadoAutomaticamente: false, diferenciaAceptadaEn: null,
    subidoPorNombre: 'Ana Interna', aplicadoPorNombre: 'beto.interno', descartadoPorNombre: 'caro.interna',
  };
  const LECTURA = { extraccion: {}, extraccionDestino: null, aplicadoMotivo: null, descartadoMotivo: null, soporteAplicadoId: null, diferenciaAceptadaEn: null, diferenciaAceptadaMotivo: null, diferenciaAceptadaPorNombre: 'dani.interno' };
  const NOMBRES = /Ana Interna|beto\.interno|caro\.interna|dani\.interno/;

  it('compañía: listado sin `subidoPorNombre` / `aplicadoPorNombre` / `descartadoPorNombre`', async () => {
    h.cap.responder([{ c: C, p: null }], [{ total: 1 }], [FILA]);
    const r = await request(await app()).get('/api/flito/comprobantes').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toEqual(expect.objectContaining({ subidoPorNombre: '', aplicadoPorNombre: null, descartadoPorNombre: null }));
    expect(JSON.stringify(r.body)).not.toMatch(NOMBRES);
  });

  it('compañía: detalle sin esos nombres ni `diferenciaAceptadaPorNombre`', async () => {
    h.cap.responder([{ c: C, p: null }], [FILA], [LECTURA]);
    const r = await request(await app()).get(`/api/flito/comprobantes/${ID}`).set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ subidoPorNombre: '', aplicadoPorNombre: null, descartadoPorNombre: null, diferenciaAceptadaPorNombre: null }));
    expect(JSON.stringify(r.body)).not.toMatch(NOMBRES);
  });

  it('sin enlace: listado y detalle nombran a cada actor', async () => {
    h.cap.responder([{ total: 1 }], [FILA]);
    const l = await request(await app()).get('/api/flito/comprobantes').set('Authorization', await como('ninguno', 'admin'));
    expect(l.body.items[0]).toEqual(expect.objectContaining({ subidoPorNombre: 'Ana Interna', aplicadoPorNombre: 'beto.interno', descartadoPorNombre: 'caro.interna' }));
    h.cap.responder([FILA], [LECTURA]);
    const d = await request(await app()).get(`/api/flito/comprobantes/${ID}`).set('Authorization', await como('ninguno', 'admin'));
    expect(d.status).toBe(200);
    expect(d.body.diferenciaAceptadaPorNombre).toBe('dani.interno');
  });
});
