// HU #13836 (G1, Feature #13834) — consulta de gestión de Dr. Flit: `POST /api/flito/tramites/buscar`.
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · tarjeta: docs/ux/flito-dr-flit-f6.md §F6.6.
//
// - El valor viaja en el BODY `{ valor }` (trim, 1..100, estricto) → 400 «Datos inválidos» sin tocar la BD
//   y sin rastro PII.
// - Mismo permiso (`tramites.cola.ver`) y alcance que el listado GET; 403 sin la función, sin rastro.
// - Primera página de 5 filas + total real; la tarjeta es el subconjunto de UX (sin comprador ni VIN).
// - Rastro PII `search` con 200 (también con 0 filas), con `filas=N` y SIN el valor en el motivo.
// - Limiter `drflit-gestion`: 40 / min por usuario.
//
// Router REAL montado como en `app.ts` (`conAlcance`) sobre el doble de drizzle que CAPTURA los `where`.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura>, limites: [] as unknown[] }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  // El doble ignora `limit`; aquí se anota para afirmar que la página es de TARJETAS_POR_MODULO filas.
  const select = h.cap.db.select;
  const db = {
    ...h.cap.db,
    select: (...a: unknown[]) => {
      const t = (select as (...x: unknown[]) => Record<string, (...x: unknown[]) => unknown>)(...a);
      const limit = t.limit;
      t.limit = (n: unknown) => { h.limites.push(n); return limit(n); };
      return t;
    },
  };
  return { db, getPoolStats: vi.fn() };
});
const pii = vi.hoisted(() => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => pii);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));
await import('../../src/db/client.js'); // evalúa la factory del doble y deja `h.cap` listo

const URL = '/api/flito/tramites/buscar';
const PLACA = 'QTQ100';
const T1 = '00000000-0000-0000-0000-0000000000b1';
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
let sub = 13836_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;
const deCompania = async () => `Bearer ${await testToken({
  sub: ++sub, role: 'xyz_renombrado' as never, tipoEnlace: 'compania', funciones: ['tramites.cola.ver'],
})}`;

const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));
/** WHERE del COUNT y de la página (el de `flito_compradores` es la subconsulta del filtro `buscar`). */
const wheresTramites = () => wheres().filter((w) => w.sql.includes('"flito_tramites"'));
/** El filtro `buscar` crea primero la subconsulta de compradores: el doble le asigna una respuesta. */
const SUBCONSULTA: unknown[] = [];

/** Fila cruda de la proyección del listado, con PII que la tarjeta NO debe dejar pasar. */
const fila = {
  tramiteId: T1, idFlit: 'FLIT-0132456', fuente: 'flit', estadoTramite: 'activo', flitEstado: 'Asignado',
  placa: PLACA, vin: '9BWZZZ377VT004251', marca: 'MAZDA', linea: 'CX-30', tipoVehiculo: 'AUTOMOVIL',
  companiaId: C, companiaNombre: 'Gestora Uno', companiaNit: '900123456',
  soatAutogestionable: false, impuestosAutogestionable: false,
  tipoTramite: 'Matrícula inicial', ciudad: 'Bogotá', transitoNombreFlit: 'STT Bogotá',
  fechaCreacionFlit: new Date('2026-10-01T10:00:00Z'), creadoEn: new Date('2026-10-02T10:00:00Z'),
  fechaAprobacion: null, derechoValor: null, tipoTitularFlit: 'CC', sincronizadoEn: new Date('2026-10-03T10:00:00Z'),
};
const comprador = {
  tramiteId: T1, nombreCompleto: 'Ana Pérez', numeroDocumento: '1012345678', correo: 'ana@correo.co',
  celular: '3001234567', direccion: 'Cra 1 # 2-3', orden: 1, porcentajeParticipacion: 100,
};

beforeEach(() => { h.cap.reset(); h.limites.length = 0; pii.logPiiAccess.mockClear(); });

describe('HU #13836 · POST /buscar — autenticación y permiso', () => {
  it('401 sin token, sin BD ni rastro', async () => {
    const r = await request(await app()).post(URL).send({ valor: PLACA });
    expect(r.status).toBe(401);
    expect(h.cap.consultas).toHaveLength(0);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 sin la función tramites.cola.ver, sin consultar trámites ni escribir rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: [] });
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ valor: PLACA });
    expect(r.status).toBe(403);
    expect(wheres()).toHaveLength(0);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 no gasta cupo del limiter: 41 intentos sin función siguen en 403, nunca 429', async () => {
    const a = await app();
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: [] })}`;
    const estados = new Set<number>();
    for (let i = 0; i < 41; i++) estados.add((await request(a).post(URL).set('Authorization', t).send({ valor: PLACA })).status);
    expect([...estados]).toEqual([403]);
  });
});

describe('HU #13836 · POST /buscar — body estricto', () => {
  const casos: Array<[string, unknown]> = [
    ['sin valor', {}],
    ['valor vacío', { valor: '' }],
    ['valor solo espacios', { valor: '   ' }],
    ['valor > 100', { valor: 'A'.repeat(101) }],
    ['valor que no es texto', { valor: 123 }],
    ['campo extra', { valor: PLACA, page: 2 }],
  ];
  for (const [nombre, body] of casos) {
    it(`400 ${nombre}, sin BD y sin rastro`, async () => {
      const r = await request(await app()).post(URL).set('Authorization', await admin()).send(body as object);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Datos inválidos' });
      expect(wheres()).toHaveLength(0);
      expect(pii.logPiiAccess).not.toHaveBeenCalled();
    });
  }

  it('100 caracteres exactos sí pasan (borde)', async () => {
    h.cap.responder(SUBCONSULTA, [{ total: 0, marca: 'x' }], []);
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'A'.repeat(100) });
    expect(r.status).toBe(200);
  });
});

describe('HU #13836 · POST /buscar — resultado', () => {
  it('200: busca con el valor recortado, página 1 de 5, total real y tarjeta solo con los campos de UX', async () => {
    h.cap.responder(SUBCONSULTA, [{ total: 7, marca: 'x' }], [fila], [comprador], []);
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: `  ${PLACA}  ` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      total: 7,
      items: [{
        id: T1, placa: PLACA, idFlit: 'FLIT-0132456', estado: 'Asignado', asignado: true,
        tipoTramite: 'Matrícula inicial', empresa: 'Gestora Uno', creado: '2026-10-01T10:00:00.000Z',
      }],
    });
    // Nada del comprador, ni el VIN, ni el NIT de la empresa.
    expect(JSON.stringify(r.body)).not.toMatch(/Ana|1012345678|ana@correo|3001234567|9BWZZZ|900123456|MAZDA/);
    // El valor llega al filtro `buscar` del listado ya recortado, y la página es la primera de 5.
    const [w] = wheresTramites();
    expect(w.sql).toContain('"flito_tramites"."id_flit"');
    expect(w.params).toEqual(expect.arrayContaining([`%${PLACA}%`]));
    expect(w.params).not.toEqual(expect.arrayContaining([expect.stringContaining(' ')]));
    expect(h.limites).toEqual([5]);
  });

  it('rastro PII `search` escrito con 200: motivo con filas=N y SIN el valor buscado', async () => {
    h.cap.responder(SUBCONSULTA, [{ total: 7, marca: 'x' }], [fila], [comprador], []);
    await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const [, opts] = pii.logPiiAccess.mock.calls[0]!;
    expect(opts).toEqual({
      resourceTipo: 'flito_tramites', accion: 'search', camposAccedidos: ['placa', 'id_flit'],
      motivo: 'Dr. Flit gestión — filas=1',
    });
    expect(JSON.stringify(opts)).not.toContain(PLACA);
  });

  it('0 filas: 200 { total: 0, items: [] } y el rastro se escribe igual con filas=0', async () => {
    h.cap.responder(SUBCONSULTA, [{ total: 0, marca: 'x' }], []);
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'FT2-0000180' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    expect(pii.logPiiAccess.mock.calls[0]![1]).toMatchObject({ motivo: 'Dr. Flit gestión — filas=0' });
    expect(JSON.stringify(pii.logPiiAccess.mock.calls[0]![1])).not.toContain('FT2-0000180');
  });

  it('alcance: con enlace compañía, conteo y página llevan compania_id = C (lo de otra empresa no sale)', async () => {
    h.cap.responder([{ c: C, p: null }], SUBCONSULTA, [{ total: 0, marca: 'x' }], []);
    const r = await request(await app()).post(URL).set('Authorization', await deCompania()).send({ valor: PLACA });
    expect(r.status).toBe(200);
    const ws = wheresTramites();
    expect(ws).toHaveLength(2);
    for (const w of ws) {
      const m = /"flito_tramites"\."compania_id" = \$(\d+)/.exec(w.sql);
      expect(m).not.toBeNull();
      expect(w.params[Number(m![1]) - 1]).toBe(C);
    }
  });
});

describe('HU #13836 · POST /buscar — limitador por usuario', () => {
  it('429 a partir de la 41.ª consulta del mismo usuario en el minuto; otro usuario no comparte cupo', async () => {
    const a = await app();
    const tok = await admin();
    const estados: number[] = [];
    for (let i = 0; i < 41; i++) {
      h.cap.responder(SUBCONSULTA, [{ total: 0, marca: 'x' }], []);
      estados.push((await request(a).post(URL).set('Authorization', tok).send({ valor: PLACA })).status);
    }
    expect(estados.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(estados[40]).toBe(429);
    h.cap.reset(); // el 429 no consumió sus respuestas encoladas
    h.cap.responder(SUBCONSULTA, [{ total: 0, marca: 'x' }], []);
    expect((await request(a).post(URL).set('Authorization', await admin()).send({ valor: PLACA })).status).toBe(200);
  });
});
