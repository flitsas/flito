// HU #13409 (Feature #13408) — purga por retención de los archivos de las solicitudes de SOAT por
// validar DESCARTADAS: `flito-soat-retencion.service.ts`. AC1–AC6.
//
// La base es un FAKE LOCAL y no el `chain`/`keyed-db` de la suite: este no registra DELETE, y lo que
// aquí se certifica es justamente qué filas se borran y cuáles se conservan. El fake no filtra nada:
// devuelve lo que el test le dio. Por eso los asertos van sobre lo que el código ESCRIBIÓ —el SQL
// renderizado de cada WHERE (`PgDialect.sqlToQuery`), los valores del `set`/`values`, las claves con
// las que llamó al almacenamiento y el ORDEN entre borrar el objeto y borrar la fila—, nunca sobre
// las filas que el propio test registró.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

interface Leido { tabla: string; cond: unknown; limite?: number }
interface Escrito { tabla: string; datos?: Record<string, unknown>; cond?: unknown }

const f = vi.hoisted(() => ({
  selects: [] as Leido[],
  deletes: [] as Escrito[],
  updates: [] as Escrito[],
  inserts: [] as Escrito[],
  orden: [] as string[],
  candidatas: [] as unknown[],
  adicionales: new Map<string, unknown[]>(),
  /** Lo que devuelve el `returning` del UPDATE de la marca (vacío = otra mano ya la marcó). */
  marcaDevuelve: null as unknown[] | null,
  transacciones: 0,
}));

const storage = vi.hoisted(() => ({
  fallos: new Map<string, unknown>(),
  remove: vi.fn(),
  del: vi.fn(),
}));

const logs = vi.hoisted(() => ({ lineas: [] as unknown[][] }));

vi.mock('../../src/services/storage.js', () => ({
  removeEntityDocument: storage.remove,
  deleteEntityDocument: storage.del,
}));

vi.mock('../../src/shared/logger.js', () => {
  const l = {
    info: (...a: unknown[]) => { logs.lineas.push(a); },
    warn: (...a: unknown[]) => { logs.lineas.push(a); },
    error: (...a: unknown[]) => { logs.lineas.push(a); },
    debug: () => {},
    child: () => l,
  };
  return { loggerFor: () => l, logger: l };
});

vi.mock('../../src/db/client.js', () => {
  const nombre = (t: unknown) => { try { return getTableName(t as never); } catch { return '?'; } };
  const db = {
    select: () => ({
      from: (t: unknown) => ({
        where: (cond: unknown) => {
          const tabla = nombre(t);
          const leido: Leido = { tabla, cond };
          f.selects.push(leido);
          const ejecutar = () => {
            if (tabla === 'flito_soat_incompletas') return f.candidatas;
            // Adicionales: por el id que liga el WHERE (lo resuelve el test con su mapa).
            const sqlTxt = JSON.stringify(new PgDialect().sqlToQuery(cond as never).params);
            for (const [id, filas] of f.adicionales) if (sqlTxt.includes(id)) return filas;
            return [];
          };
          const q: Record<string, unknown> = {
            orderBy: () => q,
            limit: (n: number) => { leido.limite = n; return q; },
            then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(ejecutar()).then(ok, ko),
          };
          return q;
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: async (cond: unknown) => {
        f.deletes.push({ tabla: nombre(t), cond });
        f.orden.push(`delete:${new PgDialect().sqlToQuery(cond as never).params[0]}`);
      },
    }),
    update: (t: unknown) => ({
      set: (datos: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            f.updates.push({ tabla: nombre(t), datos, cond });
            return f.marcaDevuelve ?? [{ id: 'marcada' }];
          },
        }),
      }),
    }),
    insert: (t: unknown) => ({
      values: async (datos: Record<string, unknown>) => { f.inserts.push({ tabla: nombre(t), datos }); },
    }),
    transaction: async (cb: (tx: unknown) => unknown) => { f.transacciones += 1; return cb(db); },
  };
  return { db, getPoolStats: vi.fn() };
});

const svc = await import('../../src/modules/flito-soat/flito-soat-retencion.service.js');

const dialecto = new PgDialect();
const render = (cond: unknown) => {
  const q = dialecto.sqlToQuery(cond as never);
  return { sql: q.sql.replace(/\s+/g, ' '), params: q.params };
};

const AHORA = new Date('2026-10-07T10:10:00Z');
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const ID_A = '13409000-0000-4000-8000-00000000000a';
const ID_E = '13409000-0000-4000-8000-00000000000e';
const ADIC1 = '13409000-0000-4000-8000-0000000000a1';
const ADIC2 = '13409000-0000-4000-8000-0000000000a2';
const VIN = '9BWZZZ377VT004251';
const NIT = '900123456';
const CLAVE_FACTURA = `soat/incompletas/${NIT}/factura-${NIT}-Persona-Sintetica.pdf`;
const CLAVE_ADIC1 = `soat/incompletas/${NIT}/adicionales/cedula-Persona-Sintetica.pdf`;
const CLAVE_ADIC2 = `soat/incompletas/${NIT}/adicionales/tarjeta-${VIN}.jpg`;

const candidata = (id: string) => ({ id, facturaStorageKey: CLAVE_FACTURA, facturaTamanoBytes: 1000 });
const adic = (id: string, storageKey: string, tamanoBytes: number) => ({ id, storageKey, tamanoBytes });

function errorS3(code: string): Error {
  return Object.assign(new Error(`S3 ${code}: ${CLAVE_FACTURA}`), { name: 'S3Error', code });
}

beforeEach(() => {
  f.selects = []; f.deletes = []; f.updates = []; f.inserts = []; f.orden = [];
  f.candidatas = []; f.adicionales = new Map(); f.marcaDevuelve = null; f.transacciones = 0;
  storage.fallos = new Map();
  storage.remove.mockReset().mockImplementation(async (key: string) => {
    f.orden.push(`remove:${key}`);
    if (storage.fallos.has(key)) throw storage.fallos.get(key);
  });
  storage.del.mockReset();
  logs.lineas = [];
});

const bitacora = () => f.inserts.filter((i) => i.tabla === 'audit_logs');
const marcas = () => f.updates.filter((u) => u.tabla === 'flito_soat_incompletas');
const deletesSoportes = () => f.deletes.filter((d) => d.tabla === 'flito_soportes');

describe('AC1/AC2/AC3/AC4 — la consulta de candidatas (SQL leído)', () => {
  it('TC1.1 frontera inclusiva: estado = descartada, archivos_purgados_en IS NULL, resuelta_en <= ahora − 30×24 h exactas, con lote', async () => {
    await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    const leida = f.selects.find((s) => s.tabla === 'flito_soat_incompletas')!;
    const { sql, params } = render(leida.cond);
    expect(sql).toMatch(/"flito_soat_incompletas"\."estado" = \$1/);
    expect(params[0]).toBe('descartada');
    expect(sql).toMatch(/"flito_soat_incompletas"\."archivos_purgados_en" is null/);
    expect(sql).toMatch(/"flito_soat_incompletas"\."resuelta_en" <= \$2/);
    expect(params[1]).toBe(new Date(AHORA.getTime() - MS_30D).toISOString());
    expect(sql).not.toMatch(/now\(\)|interval/i);
    expect(leida.limite).toBe(svc.LOTE_RETENCION);
    expect(svc.LOTE_RETENCION).toBeGreaterThan(0);
  });

  it('TC1.2 / TC2.1 predicado puro: −30 d y −30 d −1 s purgables; −30 d +1 s no', () => {
    expect(svc.esPurgable(new Date(AHORA.getTime() - MS_30D), AHORA)).toBe(true);
    expect(svc.esPurgable(new Date(AHORA.getTime() - MS_30D - 1000), AHORA)).toBe(true);
    expect(svc.esPurgable(new Date(AHORA.getTime() - MS_30D + 1000), AHORA)).toBe(false);
  });

  it('TC2.1 / TC4.1 sin candidatas (la −30 d +1 s, o ya purgadas): ni almacenamiento, ni borrados, ni marca, ni Bitácora', async () => {
    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(r).toEqual({ consideradas: 0, purgadas: 0, conPendientes: 0, archivos: 0, bytes: 0 });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(f.deletes).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.inserts).toEqual([]);
  });

  it('TC3.1 solo descartadas (igualdad, no IN/<>); adicionales ligados a la incompleta, soat_id IS NULL y tipo documento_adicional_soat', async () => {
    f.candidatas = [candidata(ID_A)];
    f.adicionales.set(ID_A, [adic(ADIC1, CLAVE_ADIC1, 10)]);
    await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    const cand = render(f.selects.find((s) => s.tabla === 'flito_soat_incompletas')!.cond).sql;
    expect(cand).not.toMatch(/"estado" (in|<>|!=)/i);
    const sel = render(f.selects.find((s) => s.tabla === 'flito_soportes')!.cond);
    expect(sel.sql).toMatch(/"flito_soportes"\."soat_incompleta_id" = \$1/);
    expect(sel.sql).toMatch(/"flito_soportes"\."soat_id" is null/);
    expect(sel.sql).toMatch(/"flito_soportes"\."tipo" = \$2/);
    expect(sel.params).toEqual([ID_A, 'documento_adicional_soat']);
    for (const d of deletesSoportes()) {
      expect(render(d.cond).sql).toMatch(/"flito_soportes"\."soat_id" is null/);
    }
  });
});

describe('AC1 — purga completa', () => {
  it('TC1.3 borra 3 objetos con su clave exacta, 2 filas de adicionales DESPUÉS de su objeto, marca SOLO archivos_purgados_en = ahora', async () => {
    f.candidatas = [candidata(ID_A)];
    f.adicionales.set(ID_A, [adic(ADIC1, CLAVE_ADIC1, 200), adic(ADIC2, CLAVE_ADIC2, 300)]);

    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });

    expect(storage.remove.mock.calls.map((c) => c[0]).sort()).toEqual([CLAVE_ADIC1, CLAVE_ADIC2, CLAVE_FACTURA].sort());
    expect(storage.del).not.toHaveBeenCalled();

    const borrados = deletesSoportes().map((d) => render(d.cond));
    expect(borrados).toHaveLength(2);
    expect(borrados.map((b) => b.params[0])).toEqual([ADIC1, ADIC2]);
    for (const b of borrados) {
      expect(b.sql).toMatch(/"flito_soportes"\."id" = \$1/);
      expect(b.params).toContain(ID_A);
      expect(b.params).toContain('documento_adicional_soat');
    }
    // Cada fila se borra después de que su objeto se borró.
    expect(f.orden.indexOf(`delete:${ADIC1}`)).toBeGreaterThan(f.orden.indexOf(`remove:${CLAVE_ADIC1}`));
    expect(f.orden.indexOf(`delete:${ADIC2}`)).toBeGreaterThan(f.orden.indexOf(`remove:${CLAVE_ADIC2}`));
    // La fila de la incompleta NO se borra.
    expect(f.deletes.filter((d) => d.tabla === 'flito_soat_incompletas')).toEqual([]);

    expect(marcas()).toHaveLength(1);
    expect(marcas()[0].datos).toEqual({ archivosPurgadosEn: AHORA });
    const w = render(marcas()[0].cond);
    expect(w.params).toEqual([ID_A, 'descartada']);
    expect(w.sql).toMatch(/"archivos_purgados_en" is null/);
    expect(f.transacciones).toBe(1);

    expect(r).toEqual({ consideradas: 1, purgadas: 1, conPendientes: 0, archivos: 3, bytes: 1500 });
  });
});

describe('AC4 — idempotencia y «no existe»', () => {
  it('TC4.2 NoSuchKey / NotFound de la factura o de un adicional = borrado: marca y Bitácora', async () => {
    f.candidatas = [candidata(ID_A)];
    f.adicionales.set(ID_A, [adic(ADIC1, CLAVE_ADIC1, 200)]);
    storage.fallos.set(CLAVE_FACTURA, errorS3('NoSuchKey'));
    storage.fallos.set(CLAVE_ADIC1, errorS3('NotFound'));
    await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(deletesSoportes()).toHaveLength(1);
    expect(marcas()).toHaveLength(1);
    expect(bitacora()).toHaveLength(1);
  });

  it('esObjetoInexistente: NoSuchKey, NotFound y 404 sí; AccessDenied, error de red y vacío no', () => {
    expect(svc.esObjetoInexistente(errorS3('NoSuchKey'))).toBe(true);
    expect(svc.esObjetoInexistente(errorS3('NotFound'))).toBe(true);
    expect(svc.esObjetoInexistente({ statusCode: 404 })).toBe(true);
    expect(svc.esObjetoInexistente(errorS3('AccessDenied'))).toBe(false);
    expect(svc.esObjetoInexistente(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
    expect(svc.esObjetoInexistente(undefined)).toBe(false);
  });

  it('si el UPDATE condicionado no marca nada (otra mano ya la marcó), no hay segunda Bitácora', async () => {
    f.candidatas = [candidata(ID_A)];
    f.marcaDevuelve = [];
    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(marcas()).toHaveLength(1);
    expect(bitacora()).toEqual([]);
    expect(r.purgadas).toBe(0);
  });
});

describe('AC5 — fallo del almacenamiento', () => {
  it('TC5.1 falla la factura (AccessDenied) y un adicional: solo se borra la fila del que sí se borró; sin marca ni Bitácora', async () => {
    f.candidatas = [candidata(ID_E)];
    f.adicionales.set(ID_E, [adic(ADIC1, CLAVE_ADIC1, 200), adic(ADIC2, CLAVE_ADIC2, 300)]);
    storage.fallos.set(CLAVE_FACTURA, errorS3('AccessDenied'));
    storage.fallos.set(CLAVE_ADIC1, errorS3('InternalError'));

    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });

    expect(deletesSoportes().map((d) => render(d.cond).params[0])).toEqual([ADIC2]);
    expect(marcas()).toEqual([]);
    expect(bitacora()).toEqual([]);
    expect(storage.del).not.toHaveBeenCalled();
    expect(r).toEqual({ consideradas: 1, purgadas: 0, conPendientes: 1, archivos: 1, bytes: 300 });
  });

  it('TC5.2 la corrida siguiente reintenta solo lo que falta y completa', async () => {
    f.candidatas = [candidata(ID_E)];
    f.adicionales.set(ID_E, [adic(ADIC1, CLAVE_ADIC1, 200)]); // adic2 ya perdió su fila
    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(storage.remove.mock.calls.map((c) => c[0]).sort()).toEqual([CLAVE_ADIC1, CLAVE_FACTURA].sort());
    expect(storage.remove).not.toHaveBeenCalledWith(CLAVE_ADIC2);
    expect(marcas()).toHaveLength(1);
    expect(bitacora()).toHaveLength(1);
    expect(r.purgadas).toBe(1);
  });

  it('un fallo del almacenamiento en una solicitud no detiene a las demás', async () => {
    f.candidatas = [candidata(ID_E), candidata(ID_A)];
    storage.remove.mockImplementationOnce(async () => { throw new TypeError('boom'); });
    // El primer remove (factura de ID_E) lanza un error que NO es «no existe» → pendiente, no excepción.
    const r = await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(r.consideradas).toBe(2);
    expect(r.conPendientes).toBe(1);
    expect(r.purgadas).toBe(1);
  });
});

describe('AC6 — Bitácora sin PII', () => {
  it('TC6.1 una entrada: resource soat.incompleta.archivos_purgados, id, archivos y bytes, usuario sistema', async () => {
    f.candidatas = [candidata(ID_A)];
    f.adicionales.set(ID_A, [adic(ADIC1, CLAVE_ADIC1, 200), adic(ADIC2, CLAVE_ADIC2, 300)]);
    await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(bitacora()).toHaveLength(1);
    const e = bitacora()[0].datos!;
    expect(e).toMatchObject({
      userId: null, userEmail: 'sistema', action: 'delete',
      resource: 'soat.incompleta.archivos_purgados', resourceId: ID_A,
    });
    expect(String(e.detail)).toContain('soat.incompleta.archivos_purgados');
    expect(String(e.detail)).toContain('Archivos eliminados: 3.');
    expect(String(e.detail)).toContain('Bytes eliminados: 1500.');
    expect((e.resource as string).length).toBeLessThanOrEqual(50);
  });

  it('TC6.2 ni la Bitácora ni ninguna línea de log (incluido el camino de error) llevan VIN, nombre, archivo, clave ni NIT', async () => {
    f.candidatas = [candidata(ID_A), candidata(ID_E)];
    f.adicionales.set(ID_A, [adic(ADIC1, CLAVE_ADIC1, 200)]);
    f.adicionales.set(ID_E, [adic(ADIC2, CLAVE_ADIC2, 300)]);
    storage.fallos.set(CLAVE_ADIC2, errorS3('AccessDenied'));
    await svc.ejecutarPurgaRetencion({ ahora: AHORA });
    expect(logs.lineas.length).toBeGreaterThan(0); // el camino de error sí logueó
    const texto = JSON.stringify([bitacora(), logs.lineas]);
    for (const prohibido of [VIN, 'Persona', 'Sintetica', NIT, CLAVE_FACTURA, CLAVE_ADIC1, CLAVE_ADIC2, '.pdf', '.jpg']) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
    // Para correlacionar: la huella de la clave, no la clave.
    expect(texto).toContain(svc.huellaClave(CLAVE_ADIC2));
    expect(svc.huellaClave(CLAVE_ADIC2)).toMatch(/^[0-9a-f]{16}$/);
  });
});
