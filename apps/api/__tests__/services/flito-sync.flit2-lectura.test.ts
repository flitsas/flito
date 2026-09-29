// HU #13091 (Feature #13059, Épica #12736) — lectura incremental de trámites de FLIT 2.
// Matriz: `docs/qa/hu-13091-tcs.md` (AC1-AC10). Datos SINTÉTICOS en todos los fixtures.
//
// Por qué una base en memoria y no `createKeyedDb`/`chain`: esos mocks devuelven la fila configurada
// sin mirar el WHERE, así que no distinguen «buscar por id_flit2» de «buscar por radicado» (mutante
// M4-b) ni la guarda optimista del cursor. Aquí `db` renderiza cada condición con el dialecto real de
// Drizzle (`PgDialect.sqlToQuery`) y la evalúa sobre filas en memoria; `transaction` hace snapshot y
// lo restaura si el callback lanza (página atómica, AC2). Solo entiende ANDs de `=`, `is null` e
// `IS NOT DISTINCT FROM`: cualquier otra cosa lanza, para que el mock no «apruebe» lo que no evalúa.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';

// ── Base en memoria ─────────────────────────────────────────────────────────────────────────────
type Fila = Record<string, unknown>;
const mem = vi.hoisted(() => ({
  tablas: new Map<string, Record<string, unknown>[]>(),
  secuencia: 1,
  fallarInsertDe: new Set<string>(),
  escrituras: [] as { op: 'insert' | 'update' | 'delete'; tabla: string }[],
}));

const dialecto = new PgDialect();
const columnas = (t: PgTable) => getTableColumns(t) as Record<string, { name: string }>;

function filtro(t: PgTable, cond: SQL | undefined): (f: Fila) => boolean {
  if (!cond) return () => true;
  const { sql: q, params } = dialecto.sqlToQuery(cond);
  const porNombre = Object.fromEntries(Object.entries(columnas(t)).map(([k, c]) => [c.name, k]));
  const preds: ((f: Fila) => boolean)[] = [];
  let reconocidos = 0;
  for (const m of q.matchAll(/"(\w+)" = \$(\d+)/g)) {
    const k = porNombre[m[1]]; const v = params[Number(m[2]) - 1]; reconocidos++;
    preds.push((f) => f[k] === v);
  }
  for (const m of q.matchAll(/"(\w+)" is null/gi)) {
    const k = porNombre[m[1]]; reconocidos++;
    preds.push((f) => f[k] == null);
  }
  for (const m of q.matchAll(/"(\w+)" IS NOT DISTINCT FROM \$(\d+)/g)) {
    const k = porNombre[m[1]]; const v = params[Number(m[2]) - 1] ?? null; reconocidos++;
    preds.push((f) => (f[k] ?? null) === v);
  }
  const ands = (q.match(/ and /gi) ?? []).length;
  if (reconocidos === 0 || / or /i.test(q) || reconocidos !== ands + 1) throw new Error(`condición no soportada por el mock: ${q}`);
  return (f) => preds.every((p) => p(f));
}

function proyectar(t: PgTable, campos: Record<string, unknown> | undefined, f: Fila): Fila {
  if (!campos) return { ...f };
  const cols = columnas(t);
  const out: Fila = {};
  for (const [alias, col] of Object.entries(campos)) {
    const k = Object.keys(cols).find((c) => cols[c] === col);
    if (!k) throw new Error(`columna no reconocida en la proyección: ${alias}`);
    out[alias] = f[k];
  }
  return out;
}

const filas = (t: PgTable) => {
  const n = getTableName(t);
  if (!mem.tablas.has(n)) mem.tablas.set(n, []);
  return mem.tablas.get(n)!;
};

function nuevaFila(t: PgTable, v: Fila): Fila {
  const base: Fila = Object.fromEntries(Object.keys(columnas(t)).map((k) => [k, null]));
  const n = getTableName(t);
  if (n === 'flito_tramites') Object.assign(base, { id: `00000000-0000-4000-a000-${String(mem.secuencia++).padStart(12, '0')}`, fuente: 'flit' });
  else if ('id' in base) base.id = mem.secuencia++;
  return { ...base, ...v };
}

function validar(n: string, f: Fila, todas: Fila[]): void {
  if (n !== 'flito_tramites') return;
  if ((f.fuente === 'flit2') !== (f.idFlit2 != null)) throw Object.assign(new Error('ck_flito_tramites_fuente_id_flit2'), { code: '23514' });
  if (f.idFlit2 != null && f.syncVersion == null) throw Object.assign(new Error('ck_flito_tramites_flit2_sync_version'), { code: '23514' });
  for (const k of ['idFlit', 'idFlit2']) {
    if (f[k] != null && todas.some((o) => o !== f && o[k] === f[k])) throw Object.assign(new Error(`unique ${k}`), { code: '23505' });
  }
}

function thenable<T>(run: () => T): Record<string, unknown> {
  const p = () => Promise.resolve().then(run);
  return { then: (a: (v: T) => unknown, b?: (e: unknown) => unknown) => p().then(a, b), catch: (b: (e: unknown) => unknown) => p().catch(b) };
}

const memDb = vi.hoisted(() => ({}) as Record<string, unknown>);
function montarDb(): void {
  memDb.select = (campos?: Record<string, unknown>) => {
    let t: PgTable; let cond: SQL | undefined; let lim = Infinity;
    const c: Record<string, unknown> = {
      from: (tb: PgTable) => { t = tb; return c; },
      where: (w: SQL) => { cond = w; return c; },
      limit: (n: number) => { lim = n; return c; },
      orderBy: () => { throw new Error('orderBy no soportado por el mock'); },
      ...thenable(() => filas(t).filter(filtro(t, cond)).slice(0, lim).map((f) => proyectar(t, campos, f))),
    };
    return c;
  };
  memDb.insert = (t: PgTable) => {
    let vals: Fila[] = []; let ignorarConflicto = false; let ret: Record<string, unknown> | undefined; let conRet = false;
    const c: Record<string, unknown> = {
      values: (v: Fila | Fila[]) => { vals = Array.isArray(v) ? v : [v]; return c; },
      onConflictDoNothing: () => { ignorarConflicto = true; return c; },
      returning: (f?: Record<string, unknown>) => { conRet = true; ret = f; return c; },
      ...thenable(() => {
        const n = getTableName(t);
        const out: Fila[] = [];
        for (const v of vals) {
          if (n === 'flito_tramites' && mem.fallarInsertDe.has(String(v.idFlit))) throw new Error('fallo simulado de BD');
          const f = nuevaFila(t, v);
          const todas = filas(t);
          if (ignorarConflicto && 'id' in f && todas.some((o) => o.id === f.id)) continue;
          todas.push(f);
          try { validar(n, f, todas); } catch (e) { todas.pop(); throw e; }
          mem.escrituras.push({ op: 'insert', tabla: n });
          out.push(f);
        }
        return conRet ? out.map((f) => proyectar(t, ret, f)) : undefined;
      }),
    };
    return c;
  };
  memDb.update = (t: PgTable) => {
    let set: Fila = {}; let cond: SQL | undefined; let ret: Record<string, unknown> | undefined; let conRet = false;
    const c: Record<string, unknown> = {
      set: (v: Fila) => { set = v; return c; },
      where: (w: SQL) => { cond = w; return c; },
      returning: (f?: Record<string, unknown>) => { conRet = true; ret = f; return c; },
      ...thenable(() => {
        const n = getTableName(t);
        const todas = filas(t);
        const tocadas = todas.filter(filtro(t, cond));
        for (const f of tocadas) {
          const antes = { ...f };
          Object.assign(f, set);
          try { validar(n, f, todas); } catch (e) { Object.assign(f, antes); throw e; }
        }
        if (tocadas.length) mem.escrituras.push({ op: 'update', tabla: n });
        return conRet ? tocadas.map((f) => proyectar(t, ret, f)) : undefined;
      }),
    };
    return c;
  };
  memDb.delete = (t: PgTable) => { throw new Error(`delete inesperado en ${getTableName(t)}`); };
  memDb.transaction = async (cb: (tx: unknown) => Promise<unknown>) => {
    const copia = structuredClone({ tablas: mem.tablas, escrituras: mem.escrituras });
    try {
      return await cb(memDb);
    } catch (e) {
      mem.tablas = copia.tablas; mem.escrituras = copia.escrituras;
      throw e;
    }
  };
}

vi.mock('../../src/db/client.js', () => ({ db: memDb, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const companiaPorNitMock = vi.fn();
const organismoPorCodigoMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, companiaPorNit: companiaPorNitMock, organismoPorCodigo: organismoPorCodigoMock };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { leerIncremental, parcialDe } = await import('../../src/modules/flito-sync/flit2-lectura.service.js');
const { aItemFlit2 } = await import('../../src/modules/flito-sync/flit2-sync-http.adapter.js');
const { estadoEnumDesdeFlit } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { Flit2Error, Flit2SinAccesoError, Flit2RespuestaError, Flit2LecturaConcurrenteError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');
const S = await import('../../src/db/schema.js');
type Port = import('../../src/modules/flito-sync/flit2-sync.port.js').Flit2SyncPort;
type Pos = import('../../src/modules/flito-sync/flit2-sync.port.js').PosicionLectura;

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
const U1 = '0192b7c4-5e6a-7d10-9f21-000000000001';
const U2 = '0192b7c4-5e6a-7d10-9f21-000000000002';
const U3 = '0192b7c4-5e6a-7d10-9f21-000000000003';
const ARRANQUE = new Date('2026-09-29T15:00:00Z');
const DOC_1 = '900000000'; const DOC_2 = '1000000000';
const CORREO = 'persona@ejemplo.test'; const CELULAR = '3100000000'; const DIRECCION = 'CARRERA 4 # 5-6';

const compradores = () => [
  { ordinal: 1, porcentajeParticipacion: 60, rolActor: 'comprador', tipoPersona: 'juridical', tipoDocumento: 'NIT',
    numeroDocumento: DOC_1, nombreCompleto: 'EMPRESA EJEMPLO SAS', direccion: 'CALLE 1 # 2-3', ciudad: 'PALMIRA',
    celular: '3000000000', correo: 'contacto@ejemplo.test' },
  { ordinal: 2, porcentajeParticipacion: 40, rolActor: 'comprador', tipoPersona: 'natural', tipoDocumento: 'CC',
    numeroDocumento: DOC_2, nombreCompleto: 'PERSONA EJEMPLO', direccion: DIRECCION, ciudad: 'PALMIRA',
    celular: CELULAR, correo: CORREO },
];

function crudo(over: Fila = {}): Fila {
  return {
    id: U1, radicado: 'FT1-0001234', consecutivo: 1234, syncVersion: 10, fechaUltimoCambio: '2026-09-21T10:14:55-05:00',
    eliminado: false, estado: 'entregado',
    tramite: { codigo: 'MATRICULA_NUEVA', nombre: 'Matrícula inicial', familia: 'MATRICULAS' },
    fechaCreacion: '2026-09-01T08:00:00-05:00', fechaRadicacion: '2026-09-01T09:30:00-05:00', fechaAprobacion: null,
    vehiculo: {
      vin: '9FKTEST0000000001', placa: 'ZZZ001', clase: 'CAMIONETA', marca: 'MARCA EJEMPLO', linea: 'LINEA EJEMPLO',
      modeloAno: 2026, carroceria: 'SUV', cilindraje: 2000, cilindrajeTexto: null, capacidad: 5,
      numeroMotor: 'MTR000000', numeroSerie: 'SER000000', tipoServicio: { codigo: 'PARTICULAR', nombre: 'Particular' },
    },
    organismo: { codigoTransito: '76520000', nombre: 'SECRETARIA DE TRANSITO EJEMPLO', codigoSecretaria: '76520', ciudad: 'PALMIRA', departamento: 'VALLE' },
    compradores: compradores(),
    factura: null,
    companiaGestora: { tenantId: '0189a0b1-c2d3-7e4f-a5b6-c7d8e9f0a1b2', nit: '901000000', nombre: 'TRAMITADORA EJEMPLO SAS' },
    ...over,
  };
}
const tombstone = (id: string, syncVersion: number, radicado = 'FT1-0009999'): Fila => ({
  id, radicado, syncVersion, eliminado: true, estado: 'anulado', vehiculo: null, organismo: null, factura: null, compradores: [],
});

interface PaginaProg { items: Fila[]; nextCursor: string; hasMore: boolean; antes?: () => void }
type Paso = PaginaProg | Error;

/** Puerto programado página a página. Registra cada llamada y la fila de lectura que había en ese momento. */
function puerto(pasos: Paso[], acceso: () => Promise<void> = async () => undefined) {
  const llamadas: { cursor?: string; since?: string; pageSize: number; filaAlLlamar: Fila | null }[] = [];
  const port: Port = {
    verificarAcceso: acceso,
    async leerPagina(pos: Pos, pageSize: number) {
      const fila = filas(S.flitoSyncFlit2Lectura)[0];
      llamadas.push({
        ...('cursor' in pos ? { cursor: pos.cursor } : {}),
        ...('since' in pos ? { since: pos.since.toISOString() } : {}),
        pageSize, filaAlLlamar: fila ? { ...fila } : null,
      });
      const paso = pasos.shift();
      if (!paso) throw new Error('el test no programó más páginas');
      if (paso instanceof Error) throw paso;
      paso.antes?.();
      const items = []; let invalidos = 0;
      for (const c of paso.items) { const it = aItemFlit2(c); if (it) items.push(it); else invalidos++; }
      return { items, invalidos, nextCursor: paso.nextCursor, hasMore: paso.hasMore };
    },
  };
  return { port, llamadas };
}
const pagina = (items: Fila[], nextCursor: string, hasMore = false, antes?: () => void): PaginaProg => ({ items, nextCursor, hasMore, antes });

const lectura = () => filas(S.flitoSyncFlit2Lectura)[0];
const tramites = () => filas(S.flitoTramites);
const tramite = (idFlit2: string) => tramites().find((t) => t.idFlit2 === idFlit2);
const historial = () => filas(S.flitoTramiteHistorial);
const reloj = (d: Date = ARRANQUE) => () => new Date(d);

function sembrarLectura(over: Fila = {}): void {
  filas(S.flitoSyncFlit2Lectura).push(nuevaFila(S.flitoSyncFlit2Lectura, { id: 1, atrasada: false, ...over }));
}
function sembrarVehiculo(over: Fila = {}): Fila {
  const v = nuevaFila(S.vehicles, { vin: '9FKTEST0000000001', plate: 'ZZZ001', ...over });
  filas(S.vehicles).push(v);
  return v;
}
function sembrarTramite(over: Fila): Fila {
  const t = nuevaFila(S.flitoTramites, { sincronizadoEn: new Date('2026-09-20T00:00:00Z'), ...over });
  filas(S.flitoTramites).push(t);
  return t;
}
/** Trámite FLIT 2 ya guardado en v10 (entregado) con vehículo propio. */
function sembrarFlit2(over: Fila = {}): Fila {
  const v = sembrarVehiculo();
  return sembrarTramite({
    idFlit: 'FT1-0001234', idFlit2: U1, fuente: 'flit2', syncVersion: 10, estado: 'entregado', flitEstado: 'Entregado',
    tipoTramite: 'Matricula', ciudad: 'PALMIRA', companiaId: 7, organismoCodigo: '76520', vehiculoId: v.id,
    plateComplete: 'ZZZ001', ...over,
  });
}

const cuadra = (r: Record<string, unknown>) => {
  const n = (k: string) => r[k] as number;
  expect(n('leidos')).toBe(n('nuevos') + n('actualizados') + n('sinCambios') + n('conflictos') + n('sinVehiculo') + n('eliminadosIgnorados') + n('invalidos'));
};

beforeEach(() => {
  mem.tablas = new Map(); mem.secuencia = 1; mem.fallarInsertDe = new Set(); mem.escrituras = [];
  montarDb();
  for (const m of Object.values(logMock)) m.mockClear();
  companiaPorNitMock.mockReset().mockImplementation(async (nit: string) => (nit === '901000000' ? { id: 7, document: nit } : null));
  organismoPorCodigoMock.mockReset().mockImplementation(async (c: string) => (c === '76520' ? { codigo: '76520' } : null));
});

// ── El propio mock: si no filtrara por el WHERE, los asertos de identidad serían verdes vacíos ──
describe('harness · la base en memoria evalúa el WHERE', () => {
  it('distingue id_flit2 de id_flit y rechaza condiciones que no sabe evaluar', async () => {
    sembrarTramite({ idFlit: 'FT1-0000001', idFlit2: U1, fuente: 'flit2', syncVersion: 1, vehiculoId: 1 });
    sembrarTramite({ idFlit: 'FT1-0000002', fuente: 'flit', vehiculoId: 1 });
    const { eq, or } = await import('drizzle-orm');
    const db = memDb as unknown as { select: (c?: unknown) => { from: (t: unknown) => { where: (w: unknown) => Promise<Fila[]> } } };
    expect((await db.select().from(S.flitoTramites).where(eq(S.flitoTramites.idFlit2, U1))).map((f) => f.idFlit)).toEqual(['FT1-0000001']);
    expect((await db.select().from(S.flitoTramites).where(eq(S.flitoTramites.idFlit, 'FT1-0000002'))).map((f) => f.idFlit)).toEqual(['FT1-0000002']);
    expect(await db.select().from(S.flitoTramites).where(eq(S.flitoTramites.idFlit2, U2))).toEqual([]);
    await expect(db.select().from(S.flitoTramites).where(or(eq(S.flitoTramites.idFlit, 'a'), eq(S.flitoTramites.idFlit, 'b')))).rejects.toThrow(/no soportada/);
  });
});

// ── AC1 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC1 · arranque sin histórico', () => {
  it('TC-01: fija since_arranque ANTES de la primera llamada y llama con since = ese instante, sin cursor', async () => {
    sembrarLectura();
    const { port, llamadas } = puerto([pagina([], 'c1')]);
    const r = await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].filaAlLlamar?.sinceArranque).toEqual(ARRANQUE);
    expect(llamadas[0]).toMatchObject({ since: ARRANQUE.toISOString() });
    expect(llamadas[0].cursor).toBeUndefined();
    expect(r.modo).toBe('since');
    expect(lectura().cursor).toBe('c1');
  });

  it('TC-01 (sin fila): si la fila no existe se recrea y se sigue igual', async () => {
    const { port, llamadas } = puerto([pagina([], 'c1')]);
    await leerIncremental({ ahora: reloj() }, port);
    expect(filas(S.flitoSyncFlit2Lectura)).toHaveLength(1);
    expect(llamadas[0].filaAlLlamar?.sinceArranque).toEqual(ARRANQUE);
  });

  it('TC-02: ninguna llamada lleva cursor y since juntos', async () => {
    sembrarLectura();
    const { port, llamadas } = puerto([pagina([], 'c1', true), pagina([], 'c2', true), pagina([], 'c3')]);
    await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas).toHaveLength(3);
    for (const l of llamadas) expect(Number(l.cursor !== undefined) + Number(l.since !== undefined)).toBe(1);
  });

  it('TC-03: con since_arranque guardado y sin cursor, reutiliza ese since (no la hora actual) y no lo reescribe', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const { port, llamadas } = puerto([pagina([], 'c1')]);
    await leerIncremental({ ahora: reloj(new Date('2026-09-29T16:00:00Z')) }, port);
    expect(llamadas[0].since).toBe(ARRANQUE.toISOString());
    expect(lectura().sinceArranque).toEqual(ARRANQUE);
  });

  it('TC-04: con cursor, llama por cursor y since_arranque no cambia', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c7' });
    const { port, llamadas } = puerto([pagina([], 'c8')]);
    const r = await leerIncremental({ ahora: reloj(new Date('2026-10-01T00:00:00Z')) }, port);
    expect(llamadas[0]).toMatchObject({ cursor: 'c7' });
    expect(llamadas[0].since).toBeUndefined();
    expect(r.modo).toBe('cursor');
    expect(lectura().sinceArranque).toEqual(ARRANQUE);
  });

  it('TC-05: «Probar conexión» no toca la posición de lectura (ni el pase ni su ruta la nombran)', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/modules/flito-sync');
    for (const f of ['flit2-pase.service.ts', 'flit2-probar.routes.ts', 'flit2-acceso.service.ts']) {
      const fuente = readFileSync(path.join(dir, f), 'utf8');
      expect(fuente, f).not.toMatch(/flitoSyncFlit2Lectura|flito_sync_flit2_lectura|leerIncremental/);
    }
  });

  it('TC-06: sin acceso → error tipado; no fija since_arranque ni llama al feed', async () => {
    sembrarLectura();
    const { port, llamadas } = puerto([], async () => { throw new Flit2SinAccesoError(); });
    const e = await leerIncremental({ ahora: reloj() }, port).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2Error);
    expect((e as InstanceType<typeof Flit2Error>).codigo).toBe('sin_acceso');
    expect(llamadas).toHaveLength(0);
    expect(lectura().sinceArranque).toBeNull();
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC2 · avance por página', () => {
  it('TC-10: pide c0, c1, c2 en orden y deja guardado c3 aunque hasMore=false', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const { port, llamadas } = puerto([pagina([], 'c1', true), pagina([], 'c2', true), pagina([], 'c3', false)]);
    const r = await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas.map((l) => l.cursor)).toEqual(['c0', 'c1', 'c2']);
    expect(lectura().cursor).toBe('c3');
    expect(r.paginas).toBe(3);
    expect(r.hasMore).toBe(false);
  });

  it('TC-11: p1 bien y p2 lanza → cursor en c1, p1 guardada, error anotado, ultima_exitosa_en no avanza; la siguiente corrida sale de c1', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0', ultimaExitosaEn: new Date('2026-09-28T00:00:00Z') });
    const { port } = puerto([pagina([crudo()], 'c1', true), new Flit2RespuestaError(500, null)]);
    const e = await leerIncremental({ ahora: reloj() }, port).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2RespuestaError);
    expect(lectura().cursor).toBe('c1');
    expect(tramites().filter((t) => t.idFlit2 === U1)).toHaveLength(1);
    expect(lectura().ultimoErrorCodigo).toBe('flit2_respuesta');
    expect(lectura().ultimaExitosaEn).toEqual(new Date('2026-09-28T00:00:00Z'));
    expect(parcialDe(e)).toMatchObject({ paginas: 1, nuevos: 1, leidos: 1, hasMore: true });

    const siguiente = puerto([pagina([], 'c2')]);
    await leerIncremental({ ahora: reloj() }, siguiente.port);
    expect(siguiente.llamadas[0].cursor).toBe('c1');
  });

  it('TC-12: si falla el guardado del 2.º ítem de p2, el cursor sigue en c1 y el 1.º ítem de p2 no queda a medias', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    mem.fallarInsertDe.add('FT1-0000003');
    const { port } = puerto([
      pagina([crudo()], 'c1', true),
      pagina([crudo({ id: U2, radicado: 'FT1-0000002', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } }),
        crudo({ id: U3, radicado: 'FT1-0000003', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000003' } })], 'c2'),
    ]);
    await expect(leerIncremental({ ahora: reloj() }, port)).rejects.toThrow('fallo simulado de BD');
    expect(lectura().cursor).toBe('c1');
    expect(tramite(U2)).toBeUndefined();
    expect(tramite(U3)).toBeUndefined();
    expect(lectura().ultimoErrorCodigo).toBe('error_interno');
  });

  it('TC-13: re-entregar p2 completa tras el fallo no duplica y no reescribe p1', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c1' });
    const v2 = crudo({ id: U2, radicado: 'FT1-0000002', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([v2], 'c2')]).port);
    const escriturasAntes = mem.escrituras.filter((w) => w.tabla === 'flito_tramites').length;
    // Reentrega (otra corrida, mismo contenido) con cursor ya en c2: idempotente por syncVersion.
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([v2], 'c2')]).port);
    expect(tramites().filter((t) => t.idFlit2 === U2)).toHaveLength(1);
    expect(r.sinCambios).toBe(1);
    expect(mem.escrituras.filter((w) => w.tabla === 'flito_tramites').length).toBe(escriturasAntes);
  });

  it('TC-14: página vacía con el mismo cursor → sin error, cursor igual, ultima_exitosa_en actualizada', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5' });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([], 'c5')]).port);
    expect(r.leidos).toBe(0);
    expect(lectura().cursor).toBe('c5');
    expect(lectura().ultimaExitosaEn).toEqual(ARRANQUE);
    expect(lectura().ultimoErrorCodigo).toBeNull();
  });

  it('si otra corrida movió el cursor mientras se leía la página → 409 lectura_concurrente y la página se revierte', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const { port } = puerto([pagina([crudo()], 'c1', false, () => { lectura().cursor = 'otro'; })]);
    const e = await leerIncremental({ ahora: reloj() }, port).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2LecturaConcurrenteError);
    expect(tramite(U1)).toBeUndefined();
    expect(lectura().cursor).toBe('otro');
  });

  it('tope de páginas por pulsación: corta en maxPaginas con hasMore=true', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const { port, llamadas } = puerto([pagina([], 'c1', true), pagina([], 'c2', true), pagina([], 'c3', true)]);
    const r = await leerIncremental({ ahora: reloj(), maxPaginas: 2 }, port);
    expect(llamadas).toHaveLength(2);
    expect(r).toMatchObject({ paginas: 2, hasMore: true });
    expect(lectura().cursor).toBe('c2');
  });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC3 · identidad y versión', () => {
  it('TC-15: ítem nuevo → fila con id_flit2, id_flit = radicado, fuente flit2 y sync_version', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo()], 'c1')]).port);
    expect(tramite(U1)).toMatchObject({ idFlit: 'FT1-0001234', fuente: 'flit2', syncVersion: 10, flitEstado: 'Entregado', estado: 'entregado' });
    expect(r.nuevos).toBe(1);
  });

  it('TC-16: misma id con versión mayor y otro estado → actualiza LA MISMA fila, historial y audit del estado', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const previo = sembrarFlit2();
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11, estado: 'aprobado' })], 'c1')]).port);
    expect(tramites()).toHaveLength(1);
    expect(tramite(U1)).toMatchObject({ id: previo.id, syncVersion: 11, flitEstado: 'Aprobado', estado: 'aprobado' });
    expect(historial().filter((h) => h.campo === 'flit_estado')).toEqual([
      expect.objectContaining({ tramiteId: previo.id, valorAnterior: 'Entregado', valorNuevo: 'Aprobado', origen: 'api' }),
    ]);
    expect(filas(S.auditLogs)).toHaveLength(1);
    expect(r.actualizados).toBe(1);
  });

  it.each([11, 9])('TC-17/TC-18: versión recibida %i ≤ guardada (11) → ni UPDATE ni historial', async (v) => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ syncVersion: 11, flitEstado: 'Aprobado', estado: 'aprobado' });
    const antes = structuredClone(tramite(U1));
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: v, estado: 'rechazado' })], 'c1')]).port);
    expect(tramite(U1)).toEqual(antes);
    expect(historial()).toHaveLength(0);
    expect(mem.escrituras.filter((w) => w.tabla === 'flito_tramites' || w.tabla === 'vehicles')).toEqual([]);
    expect(r.sinCambios).toBe(1);
  });

  it('TC-19: compañía por NIT y organismo por codigoSecretaria (no codigoTransito), con las funciones de FLIT 1', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo()], 'c1')]).port);
    expect(companiaPorNitMock).toHaveBeenCalledWith('901000000');
    expect(organismoPorCodigoMock).toHaveBeenCalledWith('76520');
    expect(organismoPorCodigoMock).not.toHaveBeenCalledWith('76520000');
    expect(tramite(U1)).toMatchObject({ companiaId: 7, organismoCodigo: '76520', companiaNit: '901000000' });
  });

  it('TC-20: NIT y organismo desconocidos → se guarda con ids null, crudos guardados y contadores', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const it0 = crudo({
      companiaGestora: { nit: '800000000' },
      organismo: { codigoSecretaria: '99999', ciudad: 'CIUDAD INVENTADA', nombre: 'TRANSITO INVENTADO' },
    });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([it0], 'c1')]).port);
    expect(tramite(U1)).toMatchObject({ companiaId: null, organismoCodigo: null, companiaNit: '800000000', transitoNombreFlit: 'TRANSITO INVENTADO' });
    expect(r).toMatchObject({ companiasFaltantes: 1, organismosSinEmparejar: 1, nuevos: 1 });
  });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC4 · radicado que ya existe', () => {
  it('TC-21: radicado de FLIT 1 → la fila queda idéntica, conflictos=1 y el cursor avanza', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const v = sembrarVehiculo();
    sembrarTramite({ idFlit: 'FT1-0005555', fuente: 'flit', flitEstado: 'Asignado', estado: 'asignado', vehiculoId: v.id });
    const antes = structuredClone(tramites());
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ radicado: 'FT1-0005555' })], 'c1')]).port);
    expect(tramites()).toEqual(antes);
    expect(r.conflictos).toBe(1);
    expect(lectura().cursor).toBe('c1');
    expect(logMock.warn).toHaveBeenCalledWith({ idFlit2: U1, radicado: 'FT1-0005555' }, expect.any(String));
  });

  it('TC-22: conflicto + ítem normal en la misma página → el normal se guarda', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const v = sembrarVehiculo({ vin: '9FKTEST0000000009' });
    sembrarTramite({ idFlit: 'FT1-0005555', fuente: 'flit', vehiculoId: v.id });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([
      crudo({ radicado: 'FT1-0005555' }),
      crudo({ id: U2, radicado: 'FT1-0000002', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } }),
    ], 'c1')]).port);
    expect(r).toMatchObject({ conflictos: 1, nuevos: 1 });
    expect(tramite(U2)).toBeDefined();
  });

  it('TC-25: radicado que existe con fuente flit2 y OTRO id_flit2 → conflicto, la otra fila no cambia', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    sembrarFlit2({ idFlit2: U2 });
    const antes = structuredClone(tramites());
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 50 })], 'c1')]).port);
    expect(tramites()).toEqual(antes);
    expect(r.conflictos).toBe(1);
  });
});

// ── AC5 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC5 · trámite sin vehículo', () => {
  it.each([
    ['vehiculo null', { vehiculo: null }],
    ['vin null', { vehiculo: { ...crudo().vehiculo as Fila, vin: null } }],
    ['vin vacío', { vehiculo: { ...crudo().vehiculo as Fila, vin: '' } }],
  ])('TC-26/TC-27 (%s): trámite existente conserva su vehículo; estado y versión sí se actualizan', async (_n, over) => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const previo = sembrarFlit2();
    const vehiculosAntes = structuredClone(filas(S.vehicles));
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11, estado: 'aprobado', ...over })], 'c1')]).port);
    expect(tramite(U1)).toMatchObject({ vehiculoId: previo.vehiculoId, syncVersion: 11, flitEstado: 'Aprobado', plateComplete: 'ZZZ001' });
    expect(filas(S.vehicles)).toEqual(vehiculosAntes);
  });

  it.each([
    ['TC-28 vehiculo null', { vehiculo: null }],
    ['TC-29 vin null', { vehiculo: { ...crudo().vehiculo as Fila, vin: null } }],
    ['TC-29 vin vacío', { vehiculo: { ...crudo().vehiculo as Fila, vin: '' } }],
  ])('%s: trámite nuevo no se guarda, sinVehiculo=1 y el cursor avanza', async (_n, over) => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo(over)], 'c1')]).port);
    expect(tramites()).toHaveLength(0);
    expect(filas(S.vehicles)).toHaveLength(0);
    expect(r.sinVehiculo).toBe(1);
    expect(lectura().cursor).toBe('c1');
  });

  it('TC-30: tras un «sin vehículo», la versión siguiente con vehículo se inserta', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ vehiculo: null })], 'c1')]).port);
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11 })], 'c2')]).port);
    expect(r.nuevos).toBe(1);
    expect(tramite(U1)).toMatchObject({ syncVersion: 11 });
  });

  it('una placa null no borra la placa conocida del vehículo', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2();
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11, vehiculo: { ...crudo().vehiculo as Fila, placa: null } })], 'c1')]).port);
    expect(filas(S.vehicles)[0].plate).toBe('ZZZ001');
    expect(tramite(U1)?.plateComplete).toBe('ZZZ001');
  });
});

// ── AC6 / AC7 ───────────────────────────────────────────────────────────────────────────────────
describe('AC6 · estados homologados', () => {
  it.each(['asignado', 'entregado', 'aprobado', 'rechazado', 'anulado'])('TC-31: %s → texto de FLIT 1 y el estado FLITO que da la función de FLIT 1', async (estado) => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ estado })], 'c1')]).port);
    const t = tramite(U1)!;
    expect(t.flitEstado).toBe(estado.charAt(0).toUpperCase() + estado.slice(1));
    expect(t.estado).toBe(estadoEnumDesdeFlit(t.flitEstado as string));
    expect(t.estado).not.toBeNull();
  });

  it.each([
    ['borrador', 'Borrador'], ['preparado', 'Preparado'], ['preasignacion', 'Preasignacion'],
    ['estado_inventado', 'Estado_inventado'], ['APROBADO', 'APROBADO'], [null, 'Desconocido'],
  ])('TC-32/TC-33: %s (nuevo) → se guarda con estado FLITO null y flit_estado %s', async (estado, texto) => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ estado })], 'c1')]).port);
    expect(r.nuevos).toBe(1);
    expect(tramite(U1)).toMatchObject({ estado: null, flitEstado: texto });
  });

  it.each(['borrador', 'preparado', 'preasignacion', 'estado_inventado'])('TC-34: retroceso de aprobado a %s → flit_estado cambia, el estado FLITO se conserva', async (estado) => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ estado: 'aprobado', flitEstado: 'Aprobado' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11, estado })], 'c1')]).port);
    expect(tramite(U1)?.estado).toBe('aprobado');
    expect(tramite(U1)?.flitEstado).not.toBe('Aprobado');
    expect(historial().some((h) => h.campo === 'flit_estado' && h.valorAnterior === 'Aprobado')).toBe(true);
  });
});

describe('AC7 · revocado', () => {
  it('TC-36: revocado → estado FLITO anulado y flit_estado Revocado', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ estado: 'revocado' })], 'c1')]).port);
    expect(tramite(U1)).toMatchObject({ estado: 'anulado', flitEstado: 'Revocado' });
  });

  it('TC-35/TC-38: asignado, preasignacion o revocado no crean ni tocan SOAT, impuesto ni logística; soat_id se conserva', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ estado: 'aprobado', flitEstado: 'Aprobado', soatId: '0192b7c4-0000-7000-8000-00000000050a' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([
      crudo({ syncVersion: 11, estado: 'revocado' }),
      crudo({ id: U2, radicado: 'FT1-0000002', estado: 'asignado', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } }),
      crudo({ id: U3, radicado: 'FT1-0000003', estado: 'preasignacion', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000003' } }),
    ], 'c1')]).port);
    expect(tramite(U1)?.soatId).toBe('0192b7c4-0000-7000-8000-00000000050a');
    const tocadas = new Set(mem.escrituras.map((w) => w.tabla));
    for (const t of ['flito_soat', 'flito_impuestos', 'flito_compradores', 'flito_logistica']) expect(tocadas.has(t), t).toBe(false);
  });
});

// ── AC8 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC8 · eliminados en FLIT 2', () => {
  it('TC-39: tombstone de un id nuevo → sin fila, eliminadosIgnorados=1, sinVehiculo=0, cursor avanza', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([tombstone(U2, 99)], 'c1')]).port);
    expect(tramites()).toHaveLength(0);
    expect(r).toMatchObject({ eliminadosIgnorados: 1, sinVehiculo: 0, leidos: 1 });
    expect(lectura().cursor).toBe('c1');
  });

  it('TC-40: tombstone de un id guardado con versión mayor → la fila queda idéntica (incluida sync_version), sin historial', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2();
    const antes = structuredClone(tramites());
    await leerIncremental({ ahora: reloj() }, puerto([pagina([tombstone(U1, 99, 'FT1-0001234')], 'c1')]).port);
    expect(tramites()).toEqual(antes);
    expect(historial()).toHaveLength(0);
  });

  it('TC-41: página mixta tombstone + normal → el normal se guarda', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([tombstone(U2, 5), crudo()], 'c1')]).port);
    expect(r).toMatchObject({ eliminadosIgnorados: 1, nuevos: 1 });
    expect(tramite(U1)).toBeDefined();
  });
});

// ── AC9 ─────────────────────────────────────────────────────────────────────────────────────────
describe('AC9 · tipo de trámite por familia', () => {
  /** La regla de finanzas (`finanzas.service.ts`): UPPER(TRIM(COALESCE(tipo_tramite,''))). */
  const claseFinanzas = (v: unknown) => String(v ?? '').trim().toUpperCase();

  it.each([['MATRICULAS', 'Matricula', 'MATRICULA'], ['TRASPASO', 'Traspaso', 'TRASPASO'], ['OTROS', 'Otros', 'OTROS']])(
    'TC-42/TC-43: %s → %s (y finanzas lo clasifica %s)', async (familia, tipo, clase) => {
      sembrarLectura({ sinceArranque: ARRANQUE });
      await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ tramite: { codigo: 'X', nombre: 'X', familia } })], 'c1')]).port);
      expect(tramite(U1)?.tipoTramite).toBe(tipo);
      expect(claseFinanzas(tramite(U1)?.tipoTramite)).toBe(clase);
    });

  it.each(['MATRICULA', 'RADICACION', '', null])('TC-44: familia %j → tipo_tramite null y el trámite se guarda', async (familia) => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ tramite: { codigo: 'X', nombre: 'X', familia } })], 'c1')]).port);
    expect(r.nuevos).toBe(1);
    expect(tramite(U1)?.tipoTramite).toBeNull();
  });

  it('TC-45: codigo MATRICULA_NUEVA con familia desconocida → null (no se deduce del código)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ tramite: { codigo: 'MATRICULA_NUEVA', nombre: 'Matrícula inicial', familia: 'NUEVA' } })], 'c1')]).port);
    expect(tramite(U1)?.tipoTramite).toBeNull();
  });
});

// ── AC10 y contadores ───────────────────────────────────────────────────────────────────────────
describe('AC10 · sin datos personales de más, FLIT 1 intacto', () => {
  it('TC-46: flit_raw no lleva documento, nombre, dirección, celular ni correo de los compradores', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo()], 'c1')]).port);
    const raw = JSON.stringify(tramite(U1)?.flitRaw);
    for (const v of [DOC_1, DOC_2, CORREO, CELULAR, DIRECCION, 'PERSONA EJEMPLO', 'EMPRESA EJEMPLO SAS']) expect(raw).not.toContain(v);
    for (const k of ['numeroDocumento', 'nombreCompleto', 'direccion', 'celular', 'correo']) expect(raw).not.toContain(`"${k}"`);
    expect((tramite(U1)?.flitRaw as { compradores: unknown[] }).compradores).toEqual([
      { ordinal: 1, porcentajeParticipacion: 60, rolActor: 'comprador', tipoPersona: 'juridical', tipoDocumento: 'NIT' },
      { ordinal: 2, porcentajeParticipacion: 40, rolActor: 'comprador', tipoPersona: 'natural', tipoDocumento: 'CC' },
    ]);
    expect(tramite(U1)?.tipoPropiedad).toBe('multiple_propietario');
  });

  it('TC-47: ningún log (info/warn/error) lleva PII, tampoco en la ruta de error', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const v = sembrarVehiculo({ vin: '9FKTEST0000000009' });
    sembrarTramite({ idFlit: 'FT1-0005555', fuente: 'flit', vehiculoId: v.id });
    const { port } = puerto([pagina([crudo(), crudo({ id: U2, radicado: 'FT1-0005555' })], 'c1', true), new Flit2RespuestaError(503, null)]);
    await leerIncremental({ ahora: reloj() }, port).catch(() => undefined);
    const todo = JSON.stringify([logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls]);
    for (const x of [DOC_1, DOC_2, CORREO, CELULAR, DIRECCION, 'PERSONA EJEMPLO']) expect(todo).not.toContain(x);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('TC-49: la lectura de FLIT 2 no escribe en system_kv (estado del sync de FLIT 1)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo()], 'c1')]).port);
    expect(mem.escrituras.some((w) => w.tabla === getTableName(S.systemKv))).toBe(false);
  });

  it('contadores: cada ítem en una clase, cuadran con leidos; ítem inválido contado y saltado', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ idFlit: 'FT1-0000077', idFlit2: U3, syncVersion: 100 });
    const v = sembrarVehiculo({ vin: '9FKTEST0000000009' });
    sembrarTramite({ idFlit: 'FT1-0005555', fuente: 'flit', vehiculoId: v.id });
    const r = await leerIncremental({ ahora: reloj() }, puerto([
      pagina([crudo(), { id: 'no-es-uuid', radicado: 'X', syncVersion: 1 }, tombstone(U2, 3)], 'c1', true),
      pagina([crudo({ id: U3, syncVersion: 5 }), crudo({ id: '0192b7c4-5e6a-7d10-9f21-000000000004', radicado: 'FT1-0005555' }),
        crudo({ id: '0192b7c4-5e6a-7d10-9f21-000000000005', radicado: 'FT1-0000005', vehiculo: null })], 'c2'),
    ]).port);
    expect(r).toMatchObject({
      leidos: 6, nuevos: 1, actualizados: 0, sinCambios: 1, conflictos: 1, sinVehiculo: 1, eliminadosIgnorados: 1, invalidos: 1, paginas: 2,
    });
    cuadra(r as unknown as Record<string, unknown>);
  });
});
