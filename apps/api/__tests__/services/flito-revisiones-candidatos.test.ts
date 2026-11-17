// Bug #14569 (punto 8) — Buscador de trámite de la cola de revisión OCR:
// `POST /api/flito/revisiones/:id/candidatos/buscar`.
//
// Doble de drizzle que CAPTURA tabla, columnas, where, orderBy y limit de cada consulta y responde
// por una función del test: las aserciones son sobre el SQL que Postgres recibiría (estado por
// módulo, igualdad vs LIKE, orden, ausencia de PII), no sobre las filas que el propio test devuelve.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

interface Q { tabla: string; cols: string[]; wheres: SQL[]; orders: SQL[]; limite?: number }

const h = vi.hoisted(() => ({
  consultas: [] as Q[],
  resp: ((_q: Q): unknown[] => []) as (q: Q) => unknown[],
}));

vi.mock('../../src/db/client.js', async () => {
  const { getTableName } = await import('drizzle-orm');
  const mk = (cols: Record<string, unknown> | undefined) => {
    const q: Q = { tabla: '', cols: Object.keys(cols ?? {}), wheres: [], orders: [] };
    h.consultas.push(q);
    const t: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'innerJoin', '$dynamic', 'offset', 'groupBy']) t[m] = () => t;
    t.from = (tb: Parameters<typeof getTableName>[0]) => { q.tabla = getTableName(tb); return t; };
    t.where = (w: SQL | undefined) => { if (w) q.wheres.push(w); return t; };
    t.orderBy = (...o: SQL[]) => { q.orders.push(...o); return t; };
    t.limit = (n: number) => { q.limite = n; return t; };
    t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => h.resp(q)).then(res, rej);
    return t;
  };
  const db = { select: mk, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() };
  return { db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ presignedGetEntityDocument: vi.fn() }));

const { PgDialect } = await import('drizzle-orm/pg-core');
const { and, sql } = await import('drizzle-orm');
const { default: revisionesRoutes } = await import('../../src/modules/flito-revisiones/flito-revisiones.routes.js');

const dialecto = new PgDialect();
const render = (s: SQL[]): { sql: string; params: unknown[] } => {
  if (s.length === 0) return { sql: '', params: [] };
  const q = dialecto.sqlToQuery(and(...s)!);
  return { sql: q.sql, params: q.params as unknown[] };
};
const renderOrden = (s: SQL[]): string => dialecto.sqlToQuery(sql.join(s, sql`, `)).sql;
/** Valor ligado al marcador que sigue a `prefijo` en el SQL (posición, no «está en algún sitio»). */
const ligado = (r: { sql: string; params: unknown[] }, prefijo: string): unknown => {
  const i = r.sql.indexOf(prefijo);
  if (i < 0) return undefined;
  const m = /\$(\d+)/.exec(r.sql.slice(i + prefijo.length));
  return m ? r.params[Number(m[1]) - 1] : undefined;
};

const app = express();
app.use(express.json());
app.use('/api/flito/revisiones', revisionesRoutes);

const REV = '00000000-0000-0000-0000-0000000000a1';
const REG = '00000000-0000-0000-0000-0000000000b2';
const URL = `/api/flito/revisiones/${REV}/candidatos/buscar`;

let admin = '';
let auditor = '';
let conEnlace = '';

interface Escenario { modulo: string; registroId?: string | null; resuelto?: boolean; filas?: unknown[]; total?: number; registro?: unknown[] }
function escenario(e: Escenario): void {
  h.resp = (q) => {
    if (q.tabla === 'flito_revisiones') return [{ modulo: e.modulo, registroId: e.registroId ?? null, resuelto: e.resuelto ?? false }];
    if (q.cols.includes('n')) return [{ n: e.total ?? (e.filas ?? []).length }];
    if (q.limite === 1) return e.registro ?? [];
    return e.filas ?? [];
  };
}
const candidatas = () => h.consultas.filter((q) => q.tabla !== 'flito_revisiones' && !q.cols.includes('n') && q.limite !== 1);
const conteos = () => h.consultas.filter((q) => q.cols.includes('n'));
const post = (body: unknown, token = admin) => request(app).post(URL).set('Authorization', `Bearer ${token}`).send(body as object);

beforeEach(async () => {
  h.consultas.length = 0;
  h.resp = () => [];
  admin ||= await testToken({ sub: 9101, role: 'admin' });
  auditor ||= await testToken({ sub: 9102, role: 'auditor' });
  conEnlace ||= await testToken({ sub: 9103, role: 'admin', tipoEnlace: 'compania', funciones: ['revisiones.revision.resolver'] });
});

describe('fronteras: auth, función y enlace', () => {
  it('sin token → 401', async () => {
    const r = await request(app).post(URL).send({});
    expect(r.status).toBe(401);
  });

  it('sin la función revisiones.revision.resolver (auditor) → 403, sin consultar', async () => {
    const r = await post({}, auditor);
    expect(r.status).toBe(403);
    expect(h.consultas.filter((q) => q.tabla.startsWith('flito_'))).toEqual([]);
  });

  it('con enlace (compañía) → 403 aunque tenga la función', async () => {
    const r = await post({}, conEnlace);
    expect(r.status).toBe(403);
    expect(h.consultas.filter((q) => q.tabla.startsWith('flito_'))).toEqual([]);
  });
});

describe('validación del body (.strict) y del id', () => {
  it.each([
    ['texto de 2 caracteres', { texto: 'ab' }],
    ['texto de 61 caracteres', { texto: 'x'.repeat(61) }],
    ['placa de 11', { placa: 'ABC12345678' }],
    ['vin de 21', { vin: 'V'.repeat(21) }],
    ['limite 51', { limite: 51 }],
    ['limite 0', { limite: 0 }],
    ['clave extra', { buscar: 'ABC123' }],
  ])('%s → 400 sin consultar', async (_n, body) => {
    escenario({ modulo: 'soat' });
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(h.consultas.filter((q) => q.tabla === 'flito_revisiones')).toEqual([]);
  });

  it('texto vacío o de espacios cuenta como ausente (200)', async () => {
    escenario({ modulo: 'soat' });
    expect((await post({ texto: '   ' })).status).toBe(200);
    expect(render(candidatas()[0]!.wheres).sql).not.toContain('LIKE');
  });

  it('id sin forma de uuid → 404 sin consultar', async () => {
    const r = await request(app).post('/api/flito/revisiones/no-es-uuid/candidatos/buscar').set('Authorization', `Bearer ${admin}`).send({});
    expect([r.status, r.body]).toEqual([404, { error: 'La revisión no existe' }]);
    expect(h.consultas.filter((q) => q.tabla.startsWith('flito_'))).toEqual([]);
  });

  it('revisión inexistente → 404', async () => {
    h.resp = () => [];
    const r = await post({});
    expect([r.status, r.body]).toEqual([404, { error: 'La revisión no existe' }]);
  });
});

describe('200: forma, no-store y límite', () => {
  it('responde { items, total, truncado, registroActual } con Cache-Control: no-store y limite 20 por defecto', async () => {
    escenario({ modulo: 'soat', filas: [{ id: 's1', idFlit: 'F-1, F-2', placa: 'ABC123', vin: null, marca: 'MAZDA', linea: 'CX-30' }] });
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      items: [{
        id: 's1', idFlit: 'F-1, F-2', placa: 'ABC123', vin: null, etiqueta: 'F-1, F-2 · ABC123', detalle: 'MAZDA CX-30',
        coincide: { placa: false, vin: false }, seleccionable: true, motivoNoSeleccionable: null,
      }],
      total: 1, truncado: false, registroActual: null,
    });
    expect(candidatas()[0]!.limite).toBe(20);
  });

  it('etiqueta sin N.º FLIT ni placa (canal Cliente)', async () => {
    escenario({ modulo: 'soat', filas: [{ id: 's1', idFlit: null, placa: null, vin: 'V1', marca: null, linea: null }] });
    const r = await post({});
    expect(r.body.items[0]).toMatchObject({ etiqueta: 'Sin N.º FLIT · sin placa', detalle: null });
  });

  it('truncado = total > items.length, y el conteo usa el MISMO where que la página', async () => {
    escenario({ modulo: 'impuestos', filas: [{ id: 'i1', idFlit: 'F9', placa: 'XYZ', vin: null, organismoCodigo: '11001' }], total: 35 });
    const r = await post({ texto: 'XYZ', limite: 2 });
    expect(r.body).toMatchObject({ total: 35, truncado: true });
    expect(r.body.items[0].detalle).toBe('11001');
    expect(render(conteos()[0]!.wheres)).toEqual(render(candidatas()[0]!.wheres));
  });
});

describe('cada módulo busca en SU tabla y en el estado que el resolver acepta', () => {
  it('soat → flito_soat en solicitado', async () => {
    escenario({ modulo: 'soat' });
    await post({});
    const q = candidatas()[0]!;
    expect(q.tabla).toBe('flito_soat');
    expect(ligado(render(q.wheres), '"flito_soat"."estado" in (')).toBe('solicitado');
  });

  it('impuestos → flito_impuestos en solicitado', async () => {
    escenario({ modulo: 'impuestos' });
    await post({});
    const q = candidatas()[0]!;
    expect(q.tabla).toBe('flito_impuestos');
    expect(ligado(render(q.wheres), '"flito_impuestos"."estado" in (')).toBe('solicitado');
  });

  it('factura_venta → flito_impuestos en pendiente', async () => {
    escenario({ modulo: 'factura_venta' });
    await post({});
    const q = candidatas()[0]!;
    expect(q.tabla).toBe('flito_impuestos');
    expect(ligado(render(q.wheres), '"flito_impuestos"."estado" in (')).toBe('pendiente');
  });

  it('derechos → flito_tramites aprobados en FLIT', async () => {
    escenario({ modulo: 'derechos' });
    await post({});
    const q = candidatas()[0]!;
    expect(q.tabla).toBe('flito_tramites');
    expect(ligado(render(q.wheres), `LOWER(COALESCE("flito_tramites"."flit_estado", '')) IN (`)).toBe('aprobado');
  });
});

describe('derechos: el trámite que ya tiene derecho se ve, pero no se elige', () => {
  it('ya-tiene-derecho → seleccionable=false + motivo; el resto seleccionable', async () => {
    escenario({
      modulo: 'derechos',
      filas: [
        { id: 't1', idFlit: 'F1', placa: 'ABC123', vin: null, tipoTramite: 'TRASPASO', organismoCodigo: '05001', createdAt: new Date(), yaTieneDerecho: true },
        { id: 't2', idFlit: 'F2', placa: 'ABC123', vin: null, tipoTramite: null, organismoCodigo: '05001', createdAt: new Date(), yaTieneDerecho: false },
      ],
    });
    const r = await post({ placa: 'ABC123' });
    expect(r.body.items.map((i: { id: string; seleccionable: boolean; motivoNoSeleccionable: string | null; detalle: string | null }) =>
      [i.id, i.seleccionable, i.motivoNoSeleccionable, i.detalle])).toEqual([
      ['t1', false, 'Ya tiene derecho', 'TRASPASO · 05001'],
      ['t2', true, null, '05001'],
    ]);
  });
});

describe('predicado de llaves', () => {
  it('placa / VIN sin texto → igualdad exacta normalizada (placa OR vin), sin LIKE', async () => {
    escenario({ modulo: 'impuestos' });
    await post({ placa: 'abc-123', vin: ' 9bw zzz ' });
    const w = render(candidatas()[0]!.wheres);
    expect(w.sql).not.toContain('LIKE');
    expect(ligado(w, `UPPER(REPLACE(REPLACE(COALESCE("vehicles"."plate", ''), '-', ''), ' ', '')) = `)).toBe('ABC123');
    expect(ligado(w, `UPPER(REPLACE(REPLACE(COALESCE("vehicles"."vin", ''), '-', ''), ' ', '')) = `)).toBe('9BWZZZ');
    expect(w.sql).toMatch(/= \$\d+ or UPPER/);
  });

  it('con texto → LIKE %n% en placa, VIN y N.º FLIT (impuestos)', async () => {
    escenario({ modulo: 'impuestos' });
    await post({ texto: 'f-12_3' });
    const w = render(candidatas()[0]!.wheres);
    expect(ligado(w, `COALESCE("vehicles"."plate", ''), '-', ''), ' ', '')) LIKE `)).toBe('%F12\\_3%');
    expect(ligado(w, `COALESCE("vehicles"."vin", ''), '-', ''), ' ', '')) LIKE `)).toBe('%F12\\_3%');
    expect(ligado(w, `COALESCE("flito_tramites"."id_flit", ''), '-', ''), ' ', '')) LIKE `)).toBe('%F12\\_3%');
  });

  it('con texto en SOAT → el N.º FLIT se busca por EXISTS sobre los trámites del SOAT', async () => {
    escenario({ modulo: 'soat' });
    await post({ texto: 'F123' });
    const w = render(candidatas()[0]!.wheres);
    expect(ligado(w, `ft.soat_id = "flito_soat"."id" AND UPPER(REPLACE(REPLACE(ft.id_flit, '-', ''), ' ', '')) LIKE `)).toBe('%F123%');
  });

  it.each(['soat', 'impuestos', 'factura_venta', 'derechos'])('%s: ninguna consulta menciona compradores ni documento', async (modulo) => {
    escenario({ modulo, registroId: REG });
    await post({ texto: 'JUAN PEREZ', placa: 'ABC123', vin: 'VIN1' });
    for (const q of h.consultas) {
      const s = render(q.wheres).sql + renderOrden(q.orders.length ? q.orders : [sql`1`]);
      expect(s).not.toContain('flito_compradores');
      expect(s).not.toContain('numero_documento');
      expect(s).not.toContain('nombre_completo');
    }
  });

  it('orden: coincidencia exacta primero, luego created_at desc, id desc; coincide marca placa y VIN', async () => {
    escenario({ modulo: 'soat', filas: [{ id: 's1', idFlit: 'F1', placa: 'ABC-123', vin: 'VIN1', marca: null, linea: null }] });
    const r = await post({ placa: 'ABC123', vin: 'VIN1' });
    const o = renderOrden(candidatas()[0]!.orders);
    expect(o).toMatch(/^CASE WHEN .* THEN 0 ELSE 1 END, "flito_soat"\."created_at" desc, "flito_soat"\."id" desc$/);
    expect(r.body.items[0].coincide).toEqual({ placa: true, vin: true });
  });

  it('coincide solo VIN cuando la placa no casa', async () => {
    escenario({ modulo: 'impuestos', filas: [{ id: 'i1', idFlit: 'F1', placa: 'OTR999', vin: 'VIN1', organismoCodigo: null }] });
    const r = await post({ placa: 'ABC123', vin: 'vin1' });
    expect(r.body.items[0].coincide).toEqual({ placa: false, vin: true });
  });
});

describe('registroActual y revisión resuelta', () => {
  it('registroActual se lee por id SIN filtro de estado', async () => {
    escenario({
      modulo: 'impuestos', registroId: REG,
      registro: [{ id: REG, idFlit: 'F7', placa: 'PAG777', vin: null, organismoCodigo: '11001' }],
    });
    const r = await post({});
    expect(r.body.registroActual).toMatchObject({ id: REG, etiqueta: 'F7 · PAG777', seleccionable: true });
    const q = h.consultas.find((c) => c.limite === 1 && c.tabla === 'flito_impuestos')!;
    const w = render(q.wheres);
    expect(w.sql).not.toContain('"estado"');
    expect(ligado(w, '"flito_impuestos"."id" = ')).toBe(REG);
  });

  it('derechos: registroActual sin la lista blanca de estados de FLIT', async () => {
    escenario({ modulo: 'derechos', registroId: REG, registro: [{ id: REG, idFlit: 'F1', placa: 'A', vin: null, tipoTramite: null, organismoCodigo: null, yaTieneDerecho: true }] });
    const r = await post({});
    expect(r.body.registroActual).toMatchObject({ id: REG, seleccionable: false, motivoNoSeleccionable: 'Ya tiene derecho' });
    const q = h.consultas.find((c) => c.limite === 1 && c.tabla === 'flito_tramites')!;
    expect(render(q.wheres).sql).not.toContain('flit_estado');
  });

  it('revisión resuelta → items [] (sin consultar candidatos) y registroActual', async () => {
    escenario({
      modulo: 'soat', registroId: REG, resuelto: true,
      filas: [{ id: 'nunca', idFlit: null, placa: null, vin: null, marca: null, linea: null }],
      registro: [{ id: REG, idFlit: 'F1', placa: 'ABC123', vin: null, marca: null, linea: null }],
    });
    const r = await post({});
    expect(r.body).toMatchObject({ items: [], total: 0, truncado: false, registroActual: { id: REG } });
    expect(candidatas()).toEqual([]);
  });
});
