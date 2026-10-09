// HU #13426 (Feature #12871) — Gestión Trámites abierta a `compania`: AC1, AC2, AC3, AC4, AC7, AC8.
//
// El router REAL montado como en `app.ts` (`conAlcance('tramites', …)`), con un doble de drizzle que
// CAPTURA los `where` (`alcance-captura.ts`): los asertos van sobre el SQL renderizado del listado,
// del COUNT y de las facetas, no sobre filas que el propio test devuelve.
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
const { enviarSoat } = vi.hoisted(() => ({ enviarSoat: vi.fn() }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: enviarSoat }));
await import('../../src/db/client.js'); // evalúa la factory del doble y deja `h.cap` listo

const FUNCIONES = [
  'tramites.cola.ver', 'tramites.cola.filtrar', 'tramites.tramite.ver_historial', 'tramites.tramite.ver_soportes',
  'tramites.solicitud.pedir_soat', 'tramites.empresa.crear', 'tramites.demo.sembrar',
];
const C = 42;
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T_AJENO = '00000000-0000-0000-0000-0000000000b2';
const PROV = '00000000-0000-0000-0000-0000000000c3';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/tramites', conAlcance('tramites', router));
  a.use(errorHandler);
  return a;
}

let sub = 8100;
/** Un usuario con el enlace y las funciones dadas; el rol es un código cualquiera (AC8/AC9). */
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;

/** La primera lectura de una petición con enlace compañía es `users.compania_id` (`alcanceDeUsuario`). */
const deCompania = (id: number | null = C) => h.cap.responder([{ c: id, p: null }]);

beforeEach(() => { h.cap.reset(); enviarSoat.mockReset().mockResolvedValue({ enviados: [], yaEnviados: [] }); });

describe('AC2 — la compañía solo ve sus trámites: lista, COUNT y facetas', () => {
  it('GET / lleva `flito_tramites.compania_id = C` en el COUNT y en la página', async () => {
    deCompania();
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const wheres = h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
    expect(wheres.length).toBeGreaterThanOrEqual(2);
    for (const w of wheres) {
      expect(w.sql).toMatch(/"flito_tramites"\."compania_id" = \$(\d+)/);
      const n = Number(/"flito_tramites"\."compania_id" = \$(\d+)/.exec(w.sql)![1]);
      expect(w.params[n - 1]).toBe(C);
    }
  });

  it('AC7 — las facetas (listas de apoyo) salen solo del universo de C: las 4 consultas', async () => {
    deCompania();
    const r = await request(await app()).get('/api/flito/tramites/facetas').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const wheres = h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
    expect(wheres).toHaveLength(4);
    for (const w of wheres) expect(w.params).toContain(C);
  });

  it('compañía SIN compañía asignada → cero filas (`false`), nunca todo', async () => {
    deCompania(null);
    h.cap.responder([{ total: 0 }], []);
    await request(await app()).get('/api/flito/tramites').set('Authorization', await como('compania'));
    for (const w of h.cap.sqlDeWheres().filter((x) => !x.sql.includes('"users"'))) expect(w.sql).toContain('false');
  });

  it('AC2 — historial y soportes de un trámite AJENO → 404, igual que uno inexistente', async () => {
    deCompania();
    h.cap.responder([]); // `tramiteEnAlcance`: no aparece con la condición de C
    const r = await request(await app()).get(`/api/flito/tramites/${T_AJENO}/historial`).set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([404, { error: 'El trámite no existe' }]);
    const q = h.cap.sqlDeWheres().find((w) => w.params.includes(T_AJENO))!;
    expect(q.sql).toMatch(/"flito_tramites"\."compania_id" = \$\d/);
    expect(q.params).toContain(C);
  });
});

describe('AC1 / AC8 — sin enlace ve todo; el filtro depende del enlace, no del nombre del rol', () => {
  it('sin enlace (mensajero o admin): el listado NO lleva condición de compañía', async () => {
    for (const rol of ['mensajero', 'admin']) {
      h.cap.reset();
      h.cap.responder([{ total: 0 }], []);
      const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await como('ninguno', rol));
      expect(r.status).toBe(200);
      for (const w of h.cap.sqlDeWheres()) expect(w.sql).not.toContain('compania_id');
    }
  });

  it('un `admin` CON enlace compañía queda acotado a C (el filtro no mira el rol)', async () => {
    deCompania();
    h.cap.responder([{ total: 0 }], []);
    await request(await app()).get('/api/flito/tramites').set('Authorization', await como('compania', 'admin'));
    const wheres = h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
    expect(wheres.every((w) => w.params.includes(C))).toBe(true);
  });
});

describe('AC3 — escribir para otra compañía → 403 sin guardar', () => {
  it('solicitar SOAT con un lote MIXTO (uno ajeno) → 403 y no se envía nada', async () => {
    deCompania();
    h.cap.responder([{ id: T1 }]); // de los dos ids, solo T1 es de C
    const r = await request(await app()).post('/api/flito/tramites/solicitar-soat')
      .set('Authorization', await como('compania')).send({ tramiteIds: [T1, T_AJENO], proveedorSoatId: PROV });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(enviarSoat).not.toHaveBeenCalled();
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
  });

  it('control: el lote SOLO de C pasa la guarda y el ctx que viaja a SOAT lleva su compañía y la proyección', async () => {
    deCompania();
    h.cap.responder([{ id: T1 }], [{ soatId: 'soat-1', soatAutogestionable: false }]);
    const r = await request(await app()).post('/api/flito/tramites/solicitar-soat')
      .set('Authorization', await como('compania')).send({ tramiteIds: [T1], proveedorSoatId: PROV });
    expect(r.status).toBe(200);
    expect(enviarSoat).toHaveBeenCalledTimes(1);
    // Riesgo §7.4: si el alcance no viajara, SOAT recibiría `alcance: 'todo'` por la puerta de atrás.
    expect(enviarSoat.mock.calls[0]![1]).toMatchObject({ alcance: 'compania', companiaId: C, proyeccionCliente: true });
  });
});

describe('AC4 — catálogo y operación interna cerrados a la compañía', () => {
  it.each([['/crear-empresa', { nombre: 'X', nit: '1' }], ['/demo', {}]])('POST %s → 403 de la frontera, sin consultar', async (ruta, cuerpo) => {
    const r = await request(await app()).post(`/api/flito/tramites${ruta}`).set('Authorization', await como('compania')).send(cuerpo);
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
  });

  it('AC5 — proveedor: Gestión Trámites cerrado (403 de la frontera)', async () => {
    const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await como('proveedor'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});

describe('Habeas Data (bloqueante de security) — el historial no nombra a FLIT ante la compañía', () => {
  const FILA = { id: 'h1', campo: 'estado', valorAnterior: 'a', valorNuevo: 'b', origen: 'usuario', usuarioNombre: 'Ana Interna', creadoEn: new Date('2026-10-01T00:00:00Z') };

  it('compañía: `usuarioNombre` llega `null` (la forma del DTO no cambia)', async () => {
    deCompania();
    h.cap.responder([{ id: T1 }], [FILA]); // `tramiteEnAlcance` y luego el historial
    const r = await request(await app()).get(`/api/flito/tramites/${T1}/historial`).set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([expect.objectContaining({ id: 'h1', usuarioNombre: null })]);
    expect(JSON.stringify(r.body)).not.toContain('Ana Interna');
  });

  it('sin enlace: el nombre llega tal cual', async () => {
    h.cap.responder([FILA]);
    const r = await request(await app()).get(`/api/flito/tramites/${T1}/historial`).set('Authorization', await como('ninguno', 'admin'));
    expect(r.status).toBe(200);
    expect(r.body[0].usuarioNombre).toBe('Ana Interna');
  });
});
