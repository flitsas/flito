// HU #13426 (Feature #12871, AC4, decisión P-5 del PO) — Tablero abierto a `compania`: solo los bloques
// con filas de SU compañía (SOAT, Impuestos, alertas de Trámites), filtrados; los indicadores globales
// de operación se omiten (0, SIN consultarse) para no cambiar la forma del DTO.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ALERTAS_OPERATIVAS } from '@operaciones/shared-types';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura>, compuerta: vi.fn() }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-compuerta/flito-compuerta.service.js', () => ({ listar: h.compuerta, decidir: vi.fn(), entregar: vi.fn() }));
await import('../../src/db/client.js');

const C = 42;

async function app() {
  const a = express();
  const { default: router } = await import('../../src/modules/flito-tablero/flito-tablero.routes.js');
  a.use('/api/flito/tablero', conAlcance('tablero', router));
  return a;
}
let sub = 8700;
// HU #13428 (AC4): sin `soat.cola.ver` / `impuestos.cola.ver` el bloque de ese módulo no sale; por defecto, los dos.
const VE_LOS_DOS = ['tablero.tablero.ver', 'soat.cola.ver', 'impuestos.cola.ver'];
const como = async (tipoEnlace: string, role = 'xyz_renombrado', funciones = VE_LOS_DOS) =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones })}`;
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));

beforeEach(() => { h.cap.reset(); h.compuerta.mockReset().mockResolvedValue([{}, {}]); });

describe('AC4 / P-5 — la compañía ve solo los bloques de SU compañía', () => {
  it('SOAT, Impuestos y cada alerta de Trámites llevan `compania_id = C`; los globales no se consultan', async () => {
    h.cap.responder([{ c: C, p: null }]);
    const r = await request(await app()).get('/api/flito/tablero').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const w = wheres();
    // 1 SOAT + 1 Impuestos + una por alerta operativa; nada más (ni revisiones, ni estancados, ni diferencias).
    expect(w).toHaveLength(2 + ALERTAS_OPERATIVAS.length);
    expect(w[0]!.sql).toContain('"flito_soat"."compania_id" = $');
    expect(w[1]!.sql).toContain('"flito_impuestos"."compania_id" = $');
    for (const x of w.slice(2)) expect(x.sql).toContain('"flito_tramites"."compania_id" = $');
    for (const x of w) expect(x.params).toContain(C);
    expect(h.compuerta).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({
      revisionesPendientes: { soat: 0, impuestos: 0 }, estancados: { soat: 0, impuestos: 0 },
      diferenciasDeValor: 0, compuertaHabilitados: 0,
    });
  });

  it('AC1 — sin enlace: el tablero global de siempre (sin condición de compañía; consulta la compuerta)', async () => {
    h.cap.responder(...Array.from({ length: 20 }, () => [{ n: 0 }])); // los conteos globales leen `[r].n`
    const r = await request(await app()).get('/api/flito/tablero').set('Authorization', await como('ninguno', 'mensajero'));
    expect(r.status).toBe(200);
    for (const x of wheres()) expect(x.sql).not.toContain('compania_id" = $');
    expect(h.compuerta).toHaveBeenCalledTimes(1);
    expect(r.body.compuertaHabilitados).toBe(2);
  });

  it('organismos y proveedor: Tablero cerrado (403 de la frontera)', async () => {
    for (const e of ['organismos_transito', 'proveedor']) {
      const r = await request(await app()).get('/api/flito/tablero').set('Authorization', await como(e));
      expect([r.status, r.body], e).toEqual([403, { error: 'Sin permisos' }]);
    }
  });
});

describe('HU #13428 AC4 — tablero por bloques: el de cada módulo solo con su «Ver el listado»', () => {
  it('compañía con SOAT y sin Impuestos: sale el bloque de SOAT y no el de Impuestos (ni su parte de los indicadores)', async () => {
    h.cap.responder([{ c: C, p: null }]);
    const r = await request(await app()).get('/api/flito/tablero')
      .set('Authorization', await como('compania', 'xyz_renombrado', ['tablero.tablero.ver', 'soat.cola.ver']));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('soat');
    expect(r.body).not.toHaveProperty('impuestos');
    expect(r.body.revisionesPendientes).toEqual({ soat: 0 });
    expect(r.body.estancados).toEqual({ soat: 0 });
    expect(r.body).toHaveProperty('alertas');
  });

  it('sin enlace y sin ninguno de los dos: ni SOAT ni Impuestos; el resto del tablero sí', async () => {
    h.cap.responder(...Array.from({ length: 20 }, () => [{ n: 0 }]));
    const r = await request(await app()).get('/api/flito/tablero')
      .set('Authorization', await como('ninguno', 'mensajero', ['tablero.tablero.ver']));
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('soat');
    expect(r.body).not.toHaveProperty('impuestos');
    expect(r.body.revisionesPendientes).toEqual({});
    expect(r.body.estancados).toEqual({});
    expect(r.body.compuertaHabilitados).toBe(2);
  });

  it('con «Ver el tablero» por la ACCIÓN y los listados por sus acciones: salen los dos bloques (expansión)', async () => {
    h.cap.responder(...Array.from({ length: 20 }, () => [{ n: 0 }]));
    const r = await request(await app()).get('/api/flito/tablero')
      .set('Authorization', await como('ninguno', 'mensajero', ['accion.dashboard.ver', 'accion.soat.ver_listado', 'accion.impuestos.ver_listado']));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('soat');
    expect(r.body).toHaveProperty('impuestos');
    expect(Object.keys(r.body.revisionesPendientes).sort()).toEqual(['impuestos', 'soat']);
  });
});
