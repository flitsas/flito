// HU #13091 (Feature #13059, Épica #12736) — lectura incremental de trámites de FLIT 2.
// Matriz: `docs/qa/hu-13091-tcs.md` (AC1-AC10). Datos SINTÉTICOS en todos los fixtures.
//
// Por qué una base en memoria y no `createKeyedDb`/`chain`: esos mocks devuelven la fila configurada
// sin mirar el WHERE, así que no distinguen «buscar por id_flit2» de «buscar por radicado» (mutante
// M4-b) ni la guarda optimista del cursor. Aquí `db` renderiza cada condición con el dialecto real de
// Drizzle (`PgDialect.sqlToQuery`) y la evalúa sobre filas en memoria; `transaction` hace snapshot y
// lo restaura si el callback lanza (página atómica, AC2). Solo entiende ANDs de `=`, `is null` e
// `IS NOT DISTINCT FROM`: cualquier otra cosa lanza, para que el mock no «apruebe» lo que no evalúa.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // HU #13093: solo `flito_compradores` se borra (reemplazo en bloque); cualquier otra tabla es un fallo.
  memDb.delete = (t: PgTable) => {
    const n = getTableName(t);
    if (n !== 'flito_compradores') throw new Error(`delete inesperado en ${n}`);
    let cond: SQL | undefined;
    const c: Record<string, unknown> = {
      where: (w: SQL) => { cond = w; return c; },
      ...thenable(() => {
        const todas = filas(t);
        const quedan = todas.filter((f) => !filtro(t, cond)(f));
        if (quedan.length !== todas.length) mem.escrituras.push({ op: 'delete', tabla: n });
        mem.tablas.set(n, quedan);
      }),
    };
    return c;
  };
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
const modalidadVigenteMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, companiaPorNit: companiaPorNitMock, organismoPorCodigo: organismoPorCodigoMock, modalidadVigente: modalidadVigenteMock };
});
// HU #13093: el bloqueo por vehículo hace un JOIN que la base en memoria no evalúa; su regla se prueba
// en `flito-sync.impuesto-vehiculo.test.ts`. Aquí basta saber que el arranque lo consulta.
const impuestoBloqueanteMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/flito-impuestos/impuesto-por-vehiculo.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, impuestoBloqueantePorVehiculo: impuestoBloqueanteMock };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
// HU #13092: candado en memoria con la misma semántica que el advisory lock (no espera; se suelta en
// finally). El SQL real del candado se prueba en `flito-sync.flit2-candado.test.ts`.
// HU #13188: `enCursoAlPedir` anota el `enCurso` del programa en el instante de pedir el candado (AC4:
// con el candado tomado, nunca pasa a true).
const candado = vi.hoisted(() => ({ tomado: false, tomas: 0, sueltas: 0, enCursoAlPedir: [] as boolean[] }));
vi.mock('../../src/modules/flito-sync/flit2-candado.js', () => ({
  conCandadoLectura: async (fn: () => Promise<unknown>) => {
    const { leerPrograma } = await import('../../src/modules/flito-sync/flit2-programa.js');
    candado.enCursoAlPedir.push(leerPrograma().enCurso);
    if (candado.tomado) return { tomado: false };
    candado.tomado = true; candado.tomas += 1;
    try { return { tomado: true, valor: await fn() }; } finally { candado.tomado = false; candado.sueltas += 1; }
  },
}));

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

interface PaginaProg { items: Fila[]; nextCursor: string; hasMore: boolean; antes?: () => void; conPii?: boolean }
type Paso = PaginaProg | Error;

/** Puerto programado página a página. Registra cada llamada y la fila de lectura que había en ese momento. */
function puerto(pasos: Paso[], acceso: () => Promise<void | { conPii: boolean }> = async () => undefined) {
  const llamadas: { cursor?: string; since?: string; pageSize: number; filaAlLlamar: Fila | null }[] = [];
  const port: Port = {
    verificarAcceso: acceso,
    async obtenerUrlAdjunto() { return null; }, // HU #13095: la lectura no lo usa
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
      return { items, invalidos, nextCursor: paso.nextCursor, hasMore: paso.hasMore, conPii: paso.conPii };
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
  modalidadVigenteMock.mockReset().mockResolvedValue('requiere_gestion');
  impuestoBloqueanteMock.mockReset().mockResolvedValue(undefined);
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

  // HU #13093: un asignado CON comprador ya arranca SOAT e impuesto (ver «HU #13093 · AC4»); aquí va sin
  // comprador, que es el caso que sigue esperando (AC5 de la #13093).
  it('TC-35/TC-38: asignado sin comprador, preasignacion o revocado no crean ni tocan SOAT, impuesto ni logística; soat_id se conserva', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ estado: 'aprobado', flitEstado: 'Aprobado', soatId: '0192b7c4-0000-7000-8000-00000000050a' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([
      crudo({ syncVersion: 11, estado: 'revocado' }),
      crudo({ id: U2, radicado: 'FT1-0000002', estado: 'asignado', compradores: [], vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } }),
      crudo({ id: U3, radicado: 'FT1-0000003', estado: 'preasignacion', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000003' } }),
    ], 'c1')]).port);
    expect(tramite(U1)?.soatId).toBe('0192b7c4-0000-7000-8000-00000000050a');
    const tocadas = new Set(mem.escrituras.map((w) => w.tabla));
    for (const t of ['flito_soat', 'flito_impuestos', 'flito_logistica']) expect(tocadas.has(t), t).toBe(false);
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


// ═══ HU #13092 · lectura programada: candado, topes de tiempo y esperas ═══════════════════════════
const {
  leerConCandado, auditarLecturaProgramada, LIMITE_BOTON_MS, LIMITE_CRON_MS, MAX_PAGINAS_SEGURIDAD, ESPERA_429_MAX_S,
} = await import('../../src/modules/flito-sync/flit2-lectura.service.js');
const { Flit2EsperaFeedError, Flit2LecturaEnCursoError, Flit2RechazadoError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');

/** Reloj que solo avanza cuando el test lo mueve (cada página «tarda» lo que diga su `antes`). */
function relojMovil(inicio: Date = ARRANQUE) {
  let t = inicio.getTime();
  return { ahora: () => new Date(t), avanzar: (ms: number) => () => { t += ms; } };
}
const r429 = (segundos: number | null) => new Flit2RespuestaError(429, 'rate_limited', segundos);

describe('HU #13092 · topes y esperas', () => {
  beforeEach(() => { candado.tomado = false; candado.tomas = 0; candado.sueltas = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('los topes son los del AC: cron 4 min, botón 60 s; las páginas solo como cinturón', () => {
    expect(LIMITE_CRON_MS).toBe(240_000);
    expect(LIMITE_BOTON_MS).toBe(60_000);
    expect(MAX_PAGINAS_SEGURIDAD).toBeGreaterThanOrEqual(100);
    expect(ESPERA_429_MAX_S).toBe(60);
  });

  it('AC3 botón: a los 60 s termina TRAS guardar la página en curso, atrasada=true, y la siguiente sigue del cursor', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const rel = relojMovil();
    const { port, llamadas } = puerto([
      pagina([crudo()], 'c1', true, rel.avanzar(25_000)),
      pagina([], 'c2', true, rel.avanzar(25_000)),
      pagina([crudo({ id: U2, radicado: 'FT1-0000002', vehiculo: { ...(crudo().vehiculo as Fila), vin: '9FKTEST0000000002' } })], 'c3', true, rel.avanzar(25_000)),
    ]);
    const r = await leerConCandado('boton', port, { ahora: rel.ahora });
    expect(llamadas.map((l) => l.cursor)).toEqual(['c0', 'c1', 'c2']);
    // La tercera cruzó los 60 s a mitad: se guardó entera (cursor c3 y su trámite escrito).
    expect(lectura().cursor).toBe('c3');
    expect(tramite(U2)).toBeDefined();
    expect(r).toMatchObject({ paginas: 3, hasMore: true, leidos: 2 });
    expect(lectura().atrasada).toBe(true);
    expect(lectura().ultimaExitosaEn).toEqual(new Date(ARRANQUE.getTime() + 75_000));

    const siguiente = puerto([pagina([], 'c4', false)]);
    await leerConCandado('cron', siguiente.port, { ahora: rel.ahora });
    expect(siguiente.llamadas[0].cursor).toBe('c3');
    expect(lectura().atrasada).toBe(false);
  });

  it('AC3 cron: el mismo ritmo NO corta a los 60 s; corta pasados los 4 min', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const rel = relojMovil();
    const pasos = Array.from({ length: 6 }, (_, i) => pagina([], `c${i + 1}`, true, rel.avanzar(50_000)));
    const { port, llamadas } = puerto(pasos);
    const r = await leerConCandado('cron', port, { ahora: rel.ahora });
    // 50·4 = 200 s < 240 → sigue; 250 s ≥ 240 → corta tras guardar la 5.ª.
    expect(llamadas).toHaveLength(5);
    expect(r).toMatchObject({ paginas: 5, hasMore: true });
    expect(lectura()).toMatchObject({ cursor: 'c5', atrasada: true });
  });

  it('AC3: una corrida que vacía el feed antes del tope queda atrasada=false', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0', atrasada: true });
    const r = await leerConCandado('boton', puerto([pagina([], 'c1', false)]).port, { ahora: reloj() });
    expect(r.hasMore).toBe(false);
    expect(lectura().atrasada).toBe(false);
  });

  it('AC4: 429 con Retry-After 30 → espera 30 s (timers falsos) y repite LA MISMA página con el mismo cursor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: ARRANQUE });
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const { port, llamadas } = puerto([r429(30), pagina([crudo()], 'c1', false)]);
    const promesa = leerConCandado('cron', port);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(llamadas).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await promesa;
    expect(llamadas.map((l) => l.cursor)).toEqual(['c0', 'c0']);
    expect(r).toMatchObject({ paginas: 1, nuevos: 1 });
    expect(lectura()).toMatchObject({ cursor: 'c1', ultimoErrorCodigo: null, atrasada: false });
  });

  it('AC4: 429 sin Retry-After → se asume 60 s y se repite', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const esperar = vi.fn(async () => undefined);
    const { port, llamadas } = puerto([r429(null), pagina([], 'c1', false)]);
    await leerConCandado('cron', port, { ahora: reloj(), esperar });
    expect(esperar).toHaveBeenCalledWith(60_000);
    expect(llamadas.map((l) => l.cursor)).toEqual(['c0', 'c0']);
  });

  it('AC4: 429 que pide más de 60 s → termina SIN avanzar ni esperar; la siguiente retoma del mismo cursor', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const esperar = vi.fn(async () => undefined);
    const { port, llamadas } = puerto([r429(61)]);
    const e = await leerConCandado('cron', port, { ahora: reloj(), esperar }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2EsperaFeedError);
    expect(esperar).not.toHaveBeenCalled();
    expect(llamadas).toHaveLength(1);
    expect(lectura()).toMatchObject({ cursor: 'c0', ultimoErrorCodigo: 'espera', atrasada: true });

    const siguiente = puerto([pagina([], 'c1', false)]);
    await leerConCandado('cron', siguiente.port, { ahora: reloj() });
    expect(siguiente.llamadas[0].cursor).toBe('c0');
  });

  it('AC4+AC3: una espera que no cabe en el tope del botón termina con lo guardado, sin esperar', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const rel = relojMovil();
    const esperar = vi.fn(async () => undefined);
    const { port } = puerto([pagina([crudo()], 'c1', true, rel.avanzar(40_000)), r429(30)]);
    const e = await leerConCandado('boton', port, { ahora: rel.ahora, esperar }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2EsperaFeedError);
    expect(esperar).not.toHaveBeenCalled();
    expect(lectura().cursor).toBe('c1');
    expect(parcialDe(e)).toMatchObject({ paginas: 1, nuevos: 1, hasMore: true });
  });

  it('AC4: 429 tras 429 sobre la misma página → se rinde tras 3 esperas, sin avanzar', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const esperar = vi.fn(async () => undefined);
    const { port, llamadas } = puerto([r429(5), r429(5), r429(5), r429(5)]);
    const e = await leerConCandado('cron', port, { ahora: reloj(), esperar }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2EsperaFeedError);
    expect(esperar).toHaveBeenCalledTimes(3);
    expect(llamadas.map((l) => l.cursor)).toEqual(['c0', 'c0', 'c0', 'c0']);
    expect(lectura().cursor).toBe('c0');
  });

  it.each([
    [400, 'invalid_cursor'],
    [400, 'validation_error'],
    [403, 'insufficient_scope'],
  ])('AC7: %i %s → no avanza, el código queda en ultimo_error_codigo, sin reintento; la siguiente vuelve a intentar', async (status, codigo) => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0', ultimaExitosaEn: new Date('2026-09-28T00:00:00Z') });
    const esperar = vi.fn(async () => undefined);
    const { port, llamadas } = puerto([new Flit2RespuestaError(status, codigo)]);
    await expect(leerConCandado('cron', port, { ahora: reloj(), esperar })).rejects.toBeInstanceOf(Flit2RespuestaError);
    expect(llamadas).toHaveLength(1);
    expect(esperar).not.toHaveBeenCalled();
    // La posición nunca se reinicia sola: ni cursor a null ni since_arranque movido.
    expect(lectura()).toMatchObject({ cursor: 'c0', sinceArranque: ARRANQUE, ultimoErrorCodigo: codigo });
    expect(lectura().ultimaExitosaEn).toEqual(new Date('2026-09-28T00:00:00Z'));

    const siguiente = puerto([pagina([], 'c1', false)]);
    await leerConCandado('cron', siguiente.port, { ahora: reloj() });
    expect(siguiente.llamadas[0].cursor).toBe('c0');
    expect(lectura().ultimoErrorCodigo).toBeNull();
  });

  it('AC6: con el acceso rechazado la corrida no llama al feed ni toca la posición', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const { port, llamadas } = puerto([], async () => { throw new Flit2RechazadoError('secret_rotation_required'); });
    await expect(leerConCandado('cron', port, { ahora: reloj() })).rejects.toBeInstanceOf(Flit2RechazadoError);
    expect(llamadas).toHaveLength(0);
    expect(lectura()).toMatchObject({ cursor: 'c0', ultimoIntentoEn: null });
  });

  it('AC2: con el candado tomado → Flit2LecturaEnCursoError (409) sin verificar acceso ni llamar a FLIT 2', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    candado.tomado = true;
    const acceso = vi.fn(async () => undefined);
    const { port, llamadas } = puerto([pagina([], 'c1')], acceso);
    const e = await leerConCandado('boton', port, { ahora: reloj() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2LecturaEnCursoError);
    expect((e as InstanceType<typeof Flit2LecturaEnCursoError>).status).toBe(409);
    expect(acceso).not.toHaveBeenCalled();
    expect(llamadas).toHaveLength(0);
    expect(lectura().cursor).toBe('c0');
  });

  it('AC2: dos corridas a la vez (cron + botón) → una lee y la otra recibe 409; el candado se suelta aunque la corrida falle', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    let soltar!: () => void;
    const pausa = new Promise<void>((ok) => { soltar = ok; });
    const lenta = puerto([new Error('fallo de red simulado')], () => pausa);
    const primera = leerConCandado('cron', lenta.port, { ahora: reloj() }).catch((x: unknown) => x);
    await Promise.resolve();
    const segunda = await leerConCandado('boton', puerto([pagina([], 'c9')]).port, { ahora: reloj() }).catch((x: unknown) => x);
    expect(segunda).toBeInstanceOf(Flit2LecturaEnCursoError);
    soltar();
    expect(await primera).toBeInstanceOf(Error);
    expect(candado).toMatchObject({ tomado: false, tomas: 1, sueltas: 1 });
  });

  it('AC8: la corrida programada con ítems se audita como «sistema» con totales y sin PII; la vacía no', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const r = await leerConCandado('cron', puerto([pagina([crudo()], 'c1', false)]).port, { ahora: reloj() });
    await auditarLecturaProgramada(r);
    const logs = filas(S.auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: null, userEmail: 'sistema', action: 'update', resource: 'flito_sincronizacion_flit2' });
    expect(logs[0].detail).toMatch(/^Sync FLIT 2 programada \(cursor\): 1 leídos, 1 nuevos/);
    const texto = JSON.stringify(logs[0]);
    for (const pii of ['FT1-0001234', 'ZZZ001', DOC_1, DOC_2, CORREO, CELULAR, '9FKTEST0000000001']) expect(texto).not.toContain(pii);

    const vacia = await leerConCandado('cron', puerto([pagina([], 'c2', false)]).port, { ahora: reloj() });
    await auditarLecturaProgramada(vacia);
    expect(filas(S.auditLogs)).toHaveLength(1);
  });
});

// ── HU #13093 · compradores de FLIT 2 y arranque de SOAT e impuestos ────────────────────────────
// Diseño: `docs/diseno/hu-13093-compradores-soat-flit2.md`. Datos SINTÉTICOS.
const { compradoresDesdeFlit2 } = await import('../../src/modules/flito-sync/flit2-mapeo.js');
const { mapearCompradores } = await import('../../src/modules/flito-sync/mapeo-compradores.js');
describe('HU #13093 · compradores y arranque', () => {
  const DOC_3 = '1100000000'; const DOC_4 = '1200000000';
  const persona = (ordinal: number, doc: string, pct: number | null): Fila => ({
    ordinal, porcentajeParticipacion: pct, rolActor: 'comprador', tipoPersona: 'natural', tipoDocumento: 'CC',
    numeroDocumento: doc, nombreCompleto: `PERSONA ${ordinal}`, direccion: null, ciudad: null, celular: null, correo: null,
  });
  const compradoresDe = (tramiteId: unknown) => filas(S.flitoCompradores)
    .filter((c) => c.tramiteId === tramiteId).sort((a, b) => (a.orden as number) - (b.orden as number));
  const vehiculo = () => filas(S.vehicles).find((v) => v.vin === '9FKTEST0000000001');
  const asignado = (over: Fila = {}) => crudo({ estado: 'asignado', ...over });
  const leer = async (items: Fila[]) => leerIncremental({ ahora: reloj() }, puerto([pagina(items, 'c1')]).port);

  it('AC1: con 4 compradores guarda todos en el orden de FLIT 2 (orden = ordinal - 1), con su porcentaje y titular el principal', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    // Llegan desordenados: manda el ordinal, no la posición en el arreglo.
    await leer([crudo({ compradores: [persona(3, DOC_3, 10), persona(1, DOC_1, 50), persona(4, DOC_4, 5), persona(2, DOC_2, 35)] })]);
    const t = tramite(U1)!;
    const cs = compradoresDe(t.id);
    expect(cs.map((c) => [c.orden, c.numeroDocumento, c.porcentajeParticipacion]))
      .toEqual([[0, DOC_1, '50'], [1, DOC_2, '35'], [2, DOC_3, '10'], [3, DOC_4, '5']]);
    expect(t.tipoPropiedad).toBe('multiple_propietario');
    expect(vehiculo()).toMatchObject({ ownerDocument: DOC_1, ownerName: 'PERSONA 1' });
  });

  it('AC2: un solo comprador sin porcentaje queda como propietario único al 100 %', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([crudo({ compradores: [persona(1, DOC_1, null)] })]);
    const t = tramite(U1)!;
    expect(compradoresDe(t.id).map((c) => [c.orden, c.porcentajeParticipacion])).toEqual([[0, '100']]);
    expect(t.tipoPropiedad).toBe('unico_propietario');
  });

  it('AC3: sin compradores el trámite nuevo se guarda sin comprador y la lectura no falla', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r = await leer([asignado({ compradores: [] })]);
    expect(r).toMatchObject({ nuevos: 1, leidos: 1 });
    expect(compradoresDe(tramite(U1)!.id)).toEqual([]);
    expect(tramite(U1)!.tipoPropiedad).toBeNull();
  });

  it('AC4: asignado con comprador, compañía y organismo → arranca SOAT (por VIN) e impuesto en pendiente, como FLIT 1', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([asignado()]);
    const t = tramite(U1)!;
    const [soat] = filas(S.flitoSoat);
    expect(soat).toMatchObject({ vin: '9FKTEST0000000001', estado: 'pendiente', companiaId: 7, organismoCodigo: '76520', proveedorSoatId: null });
    expect(t.soatId).toBe(soat.id);
    expect(filas(S.flitoImpuestos)).toEqual([expect.objectContaining({ tramiteId: t.id, estado: 'pendiente', modalidadAplicada: 'requiere_gestion' })]);
    expect(impuestoBloqueanteMock).toHaveBeenCalledWith(expect.anything(), t.vehiculoId, expect.any(Number), t.id);
    expect(filas(S.auditLogs).map((a) => a.resource).sort()).toEqual(['flito_impuesto', 'flito_soat']);
  });

  it('AC4: mismas reglas que FLIT 1 — compañía que autogestiona SOAT y organismo autogestionado no crean nada; un SOAT del VIN se enlaza', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    companiaPorNitMock.mockResolvedValue({ id: 7, soatAutogestionable: true, impuestosAutogestionable: false });
    modalidadVigenteMock.mockResolvedValue('autogestionado');
    await leer([asignado()]);
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);

    mem.tablas = new Map(); montarDb();
    sembrarLectura({ sinceArranque: ARRANQUE });
    companiaPorNitMock.mockResolvedValue({ id: 7 });
    const previo = nuevaFila(S.flitoSoat, { vin: '9FKTEST0000000001', estado: 'pendiente' });
    filas(S.flitoSoat).push(previo);
    await leer([asignado()]);
    expect(filas(S.flitoSoat)).toHaveLength(1);
    expect(tramite(U1)!.soatId).toBe(previo.id);
  });

  it('AC4: sin compañía u organismo emparejados, o sin estar asignado, no arranca', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([
      asignado({ companiaGestora: { nit: '999' } }),
      asignado({ id: U2, radicado: 'FT1-0000002', organismo: null, vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000002' } }),
      crudo({ id: U3, radicado: 'FT1-0000003', estado: 'entregado', vehiculo: { ...crudo().vehiculo as Fila, vin: '9FKTEST0000000003' } }),
    ]);
    expect(tramites()).toHaveLength(3);
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);
  });

  it('AC5: asignado sin comprador espera sin fallar; la entrega que trae el comprador arranca', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const r1 = await leer([asignado({ compradores: [] })]);
    expect(r1).toMatchObject({ nuevos: 1 });
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);

    await leerIncremental({ ahora: reloj() }, puerto([pagina([asignado({ syncVersion: 11 })], 'c2')]).port);
    expect(filas(S.flitoSoat)).toHaveLength(1);
    expect(filas(S.flitoImpuestos)).toHaveLength(1);
    expect(compradoresDe(tramite(U1)!.id)).toHaveLength(2);
    expect(vehiculo()).toMatchObject({ ownerDocument: DOC_1 });
  });

  it('AC6: otros compradores en una entrega posterior se reemplazan y el historial guarda un resumen sin PII', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const t = sembrarFlit2();
    for (const [orden, doc, pct] of [[0, DOC_1, '60.00'], [1, DOC_2, '40.00']] as const) {
      filas(S.flitoCompradores).push(nuevaFila(S.flitoCompradores, {
        tramiteId: t.id, orden, numeroDocumento: doc, nombreCompleto: `P ${orden}`, porcentajeParticipacion: pct,
      }));
    }
    const r = await leer([crudo({ syncVersion: 11, compradores: [persona(1, DOC_3, 70), persona(2, DOC_2, 20), persona(3, DOC_4, 10)] })]);
    expect(r).toMatchObject({ actualizados: 1 });
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_3, DOC_2, DOC_4]);
    const h = historial().filter((x) => x.campo === 'compradores');
    expect(h).toEqual([expect.objectContaining({
      origen: 'api', usuarioId: null,
      valorAnterior: '2 compradores: orden 0 60 %, orden 1 40 %',
      valorNuevo: '3 compradores: orden 0 70 %, orden 1 20 %, orden 2 10 %',
    })]);
    const todo = JSON.stringify(historial());
    for (const pii of [DOC_1, DOC_2, DOC_3, DOC_4, 'PERSONA', 'P 0']) expect(todo).not.toContain(pii);
  });

  it('AC6: los mismos compradores no reescriben ni dejan historial; otra persona con el mismo reparto sí, sin decir quién', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const t = sembrarFlit2();
    filas(S.flitoCompradores).push(nuevaFila(S.flitoCompradores, {
      tramiteId: t.id, orden: 0, numeroDocumento: DOC_1, nombreCompleto: 'PERSONA 1', porcentajeParticipacion: '100.00',
    }));
    await leer([crudo({ syncVersion: 11, compradores: [persona(1, DOC_1, null)] })]);
    expect(mem.escrituras.some((w) => w.tabla === 'flito_compradores')).toBe(false);
    expect(historial().filter((x) => x.campo === 'compradores')).toEqual([]);

    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 12, compradores: [persona(1, DOC_2, 100)] })], 'c2')]).port);
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_2]);
    expect(historial().filter((x) => x.campo === 'compradores')).toEqual([expect.objectContaining({
      valorAnterior: '1 comprador: orden 0 100 %', valorNuevo: '1 comprador: orden 0 100 % (cambian datos de persona)',
    })]);
  });

  it('RN-15: un trámite existente que llega con compradores: [] conserva los guardados y sigue arrancando con ellos', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const t = sembrarFlit2();
    filas(S.vehicles)[0].ownerDocument = DOC_1;
    filas(S.flitoCompradores).push(nuevaFila(S.flitoCompradores, {
      tramiteId: t.id, orden: 0, numeroDocumento: DOC_1, nombreCompleto: 'PERSONA 1', porcentajeParticipacion: '100.00',
    }));
    await leer([asignado({ syncVersion: 11, compradores: [], vehiculo: null })]);
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_1]);
    expect(mem.escrituras.some((w) => w.tabla === 'flito_compradores')).toBe(false);
    expect(historial().filter((x) => x.campo === 'compradores')).toEqual([]);
    expect(vehiculo()).toMatchObject({ ownerDocument: DOC_1 });
    // Sin bloque de vehículo, el VIN del arranque sale del vehículo guardado.
    expect(filas(S.flitoSoat)).toEqual([expect.objectContaining({ vin: '9FKTEST0000000001' })]);
  });

  it('#13094 aparte: un comprador sin documento o sin nombre no se escribe y el log solo lleva el conteo', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([asignado({ compradores: [{ ...persona(1, DOC_1, 50), numeroDocumento: null }, { ...persona(2, DOC_2, 50), nombreCompleto: '  ' }] })]);
    const t = tramite(U1)!;
    expect(compradoresDe(t.id)).toEqual([]);
    expect(t.tipoPropiedad).toBe('multiple_propietario');
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(logMock.warn).toHaveBeenCalledWith({ idFlit2: U1, omitidos: 2 }, expect.any(String));
  });

  it('#13094 aparte: si falta el principal, el secundario se guarda con su orden pero no es titular ni arranca SOAT', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([asignado({ compradores: [{ ...persona(1, DOC_1, 60), numeroDocumento: '' }, persona(2, DOC_2, 40)] })]);
    const t = tramite(U1)!;
    expect(compradoresDe(t.id).map((c) => [c.orden, c.numeroDocumento])).toEqual([[1, DOC_2]]);
    expect(vehiculo()?.ownerDocument ?? null).toBeNull();
    expect(filas(S.flitoSoat)).toEqual([]);
  });

  it('AC7: FLIT 1 sigue lanzando con 0 compradores; el mapeo de FLIT 2 no lanza', () => {
    expect(() => mapearCompradores({ idFlit: 'FT1-0000001', tipoPropiedad: 'unico_propietario', compradores: [] } as never)).toThrow(/no trae comprador/);
    expect(compradoresDesdeFlit2([])).toEqual({ compradores: [], omitidos: 0 });
  });
});

// ── HU #13094 · PII enmascarada de FLIT 2 ───────────────────────────────────────────────────────
// Diseño: `docs/diseno/hu-13094-pii-enmascarada-flit2.md` (RN-18…RN-20). Datos SINTÉTICOS; el
// enmascarado imita el del contrato §4 (`"9****0000"`, `"c***@ejemplo.test"`).
describe('HU #13094 · PII enmascarada', () => {
  const sinPii = async () => ({ conPii: false });
  const conPii = async () => ({ conPii: true });
  const enmascarados = () => [
    { ordinal: 1, porcentajeParticipacion: 60, rolActor: 'comprador', tipoPersona: 'juridical', tipoDocumento: 'NIT',
      numeroDocumento: '9****0000', nombreCompleto: 'E***A', direccion: 'C***3', ciudad: 'PALMIRA', celular: '3****0000', correo: 'c***@ejemplo.test' },
    { ordinal: 2, porcentajeParticipacion: 40, rolActor: 'comprador', tipoPersona: 'natural', tipoDocumento: 'CC',
      numeroDocumento: '1****0000', nombreCompleto: 'P***O', direccion: 'C***6', ciudad: 'PALMIRA', celular: '3****0000', correo: 'p***@ejemplo.test' },
  ];
  const compradoresDe = (tramiteId: unknown) => filas(S.flitoCompradores).filter((c) => c.tramiteId === tramiteId);
  /** Trámite FLIT 2 guardado en v11, marcado y con un comprador principal previo (datos SINTÉTICOS). */
  function sembrarMarcado(over: Fila = {}): Fila {
    const t = sembrarFlit2({ syncVersion: 11, flit2PiiEnmascarada: true, ...over });
    filas(S.flitoCompradores).push(nuevaFila(S.flitoCompradores, {
      tramiteId: t.id, orden: 0, numeroDocumento: DOC_1, nombreCompleto: 'PERSONA 1', porcentajeParticipacion: '100.00',
    }));
    return t;
  }

  it('AC1: sin el scope, el trámite nuevo queda marcado y la lectura anota desde cuándo llega enmascarada', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ compradores: enmascarados() })], 'c1')], sinPii).port);
    expect(r).toMatchObject({ leidos: 1, nuevos: 1 });
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);
    expect(lectura()).toMatchObject({ cursor: 'c1', piiEnmascaradaDesde: ARRANQUE, cursorRelectura: null });
  });

  it('AC1: el scope que manda es el de la PÁGINA (pase renovado a mitad); desde cuándo no se reescribe', async () => {
    const ANTES = new Date('2026-09-28T00:00:00Z');
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0', piiEnmascaradaDesde: ANTES });
    const { port } = puerto([{ ...pagina([crudo({ compradores: enmascarados() })], 'c1'), conPii: false }], conPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);
    expect(lectura()!.piiEnmascaradaDesde).toEqual(ANTES);
  });

  it('AC1: con el scope nada se marca ni se anota (control positivo)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo()], 'c1')], conPii).port);
    expect(tramite(U1)!.flit2PiiEnmascarada).not.toBe(true);
    expect(compradoresDe(tramite(U1)!.id)).toHaveLength(2);
    expect(lectura()!.piiEnmascaradaDesde).toBeNull();
  });

  it('AC2: enmascarado no escribe compradores ni titular y conserva los guardados; el resto del trámite sí se aplica', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const t = sembrarMarcado({ syncVersion: 10, flit2PiiEnmascarada: false });
    filas(S.vehicles)[0].ownerDocument = DOC_1;
    const r = await leerIncremental({ ahora: reloj() },
      puerto([pagina([crudo({ syncVersion: 11, estado: 'aprobado', compradores: enmascarados() })], 'c1')], sinPii).port);
    expect(r).toMatchObject({ actualizados: 1 });
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_1]);
    expect(mem.escrituras.some((w) => w.tabla === 'flito_compradores')).toBe(false);
    expect(filas(S.vehicles)[0].ownerDocument).toBe(DOC_1);
    expect(tramite(U1)).toMatchObject({ flitEstado: 'Aprobado', syncVersion: 11, flit2PiiEnmascarada: true });
    expect(historial().filter((x) => x.campo === 'compradores')).toEqual([]);
  });

  it('AC2: un trámite nuevo enmascarado nace sin compradores (nunca con el documento enmascarado)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ compradores: enmascarados() })], 'c1')], sinPii).port);
    expect(filas(S.flitoCompradores)).toEqual([]);
    expect(JSON.stringify(mem.tablas.get('vehicles'))).not.toContain('****');
  });

  it('AC3: asignado y enmascarado con comprador principal guardado → SOAT e impuesto no arrancan, la lectura no falla', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarMarcado({ syncVersion: 10, flit2PiiEnmascarada: false });
    const r = await leerIncremental({ ahora: reloj() },
      puerto([pagina([crudo({ syncVersion: 11, estado: 'asignado', compradores: enmascarados(), vehiculo: null })], 'c1')], sinPii).port);
    expect(r).toMatchObject({ leidos: 1, actualizados: 1 });
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);
    expect(lectura()).toMatchObject({ cursor: 'c1', ultimoErrorCodigo: null });
  });

  it('AC4: con el permiso de vuelta, relee desde el arranque con su cursor, aplica solo el marcado (misma versión), sin mover el cursor normal', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: new Date('2026-09-29T15:10:00Z') });
    const t = sembrarMarcado();
    const { port, llamadas } = puerto([
      pagina([], 'c5'), // la lectura normal: al día
      pagina([crudo({ syncVersion: 11, estado: 'asignado' }), crudo({ id: U2, radicado: 'FT1-0002222', syncVersion: 3 })], 'r1'),
    ], conPii);
    const r = await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas.map((l) => [l.cursor ?? null, l.since ?? null])).toEqual([['c5', null], [null, ARRANQUE.toISOString()]]);
    expect(r).toMatchObject({ leidos: 0, paginas: 1 }); // la relectura no suma al resultado de la normal
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(false);
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento).sort()).toEqual([DOC_2, DOC_1].sort());
    expect(filas(S.flitoSoat)).toEqual([expect.objectContaining({ vin: '9FKTEST0000000001' })]);
    expect(filas(S.flitoImpuestos)).toHaveLength(1);
    expect(tramite(U2)).toBeUndefined(); // la relectura no crea trámites
    expect(lectura()).toMatchObject({ cursor: 'c5', cursorRelectura: null, piiEnmascaradaDesde: null });
  });

  it('AC4: la relectura no aplica una versión MENOR que la guardada (el trámite sigue marcado)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: ARRANQUE });
    const t = sembrarMarcado({ syncVersion: 12 });
    const antes = { ...t };
    const { port } = puerto([pagina([], 'c5'), pagina([crudo({ syncVersion: 11, estado: 'asignado' })], 'r1')], conPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(tramite(U1)).toEqual(antes);
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_1]);
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);
    expect(lectura()).toMatchObject({ cursorRelectura: null, piiEnmascaradaDesde: null });
  });

  it('AC4: la relectura no toca un trámite SIN marca, aunque llegue con la misma versión y asignado', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: ARRANQUE });
    const t = sembrarMarcado({ syncVersion: 11, flit2PiiEnmascarada: false });
    const antes = { ...t };
    const { port } = puerto([pagina([], 'c5'), pagina([crudo({ syncVersion: 11, estado: 'asignado' })], 'r1')], conPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(tramite(U1)).toEqual(antes);
    expect(compradoresDe(t.id).map((c) => c.numeroDocumento)).toEqual([DOC_1]);
    expect(mem.escrituras.some((w) => w.tabla === 'flito_tramites' || w.tabla === 'flito_compradores')).toBe(false);
    expect(filas(S.flitoSoat)).toEqual([]);
    expect(filas(S.flitoImpuestos)).toEqual([]);
    expect(lectura()).toMatchObject({ cursorRelectura: null, piiEnmascaradaDesde: null });
  });

  it('AC4: en la lectura normal, un marcado con la misma versión es «sin cambios» y sigue marcado (solo lo aplica la relectura)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarMarcado();
    const r = await leerIncremental({ ahora: reloj() }, puerto([pagina([crudo({ syncVersion: 11 })], 'c1')], conPii).port);
    expect(r).toMatchObject({ sinCambios: 1 });
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);
  });

  it('AC4: una versión nueva CON el permiso en la lectura normal quita la marca y arranca', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0', piiEnmascaradaDesde: ARRANQUE });
    sembrarMarcado();
    const { port } = puerto([pagina([crudo({ syncVersion: 12, estado: 'asignado' })], 'c1'), pagina([], 'r0')], conPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(false);
    expect(filas(S.flitoSoat)).toHaveLength(1);
  });

  it('AC4: cortada por el tope, la relectura guarda su cursor y la corrida siguiente la retoma desde ahí', async () => {
    const rm = relojMovil();
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: ARRANQUE });
    sembrarMarcado();
    const primera = puerto([
      pagina([], 'c5'),
      pagina([crudo({ id: U3, radicado: 'FT1-0003333' })], 'r1', true, rm.avanzar(LIMITE_BOTON_MS)),
    ], conPii);
    await leerConCandado('boton', primera.port, { ahora: rm.ahora });
    expect(lectura()).toMatchObject({ cursor: 'c5', cursorRelectura: 'r1' });
    expect(lectura()!.piiEnmascaradaDesde).not.toBeNull();
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);

    const segunda = puerto([pagina([], 'c5'), pagina([crudo({ syncVersion: 11, estado: 'asignado' })], 'r2')], conPii);
    await leerConCandado('boton', segunda.port, { ahora: rm.ahora });
    expect(segunda.llamadas.map((l) => l.cursor ?? l.since)).toEqual(['c5', 'r1']);
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(false);
    expect(lectura()).toMatchObject({ cursor: 'c5', cursorRelectura: null, piiEnmascaradaDesde: null });
  });

  it('AC4: un fallo de la relectura no tumba la lectura normal y deja el cursor de relectura donde iba', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: ARRANQUE, cursorRelectura: 'r1' });
    sembrarMarcado();
    const { port } = puerto([pagina([crudo({ id: U3, radicado: 'FT1-0003333' })], 'c6'), new Flit2RespuestaError(503, null)], conPii);
    const r = await leerIncremental({ ahora: reloj() }, port);
    expect(r).toMatchObject({ nuevos: 1 });
    expect(lectura()).toMatchObject({ cursor: 'c6', cursorRelectura: 'r1', ultimoErrorCodigo: null });
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(true);
  });

  it('AC4: sin el permiso la relectura no corre; una página enmascarada reinicia la relectura a medias', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5', piiEnmascaradaDesde: ARRANQUE, cursorRelectura: 'r1' });
    const { port, llamadas } = puerto([pagina([crudo({ compradores: enmascarados() })], 'c6')], sinPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas).toHaveLength(1);
    expect(lectura()).toMatchObject({ cursor: 'c6', cursorRelectura: null, piiEnmascaradaDesde: ARRANQUE });
  });

  it('AC4: sin nada que recuperar no hay relectura (ninguna llamada de más)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c5' });
    const { port, llamadas } = puerto([pagina([], 'c5')], conPii);
    await leerIncremental({ ahora: reloj() }, port);
    expect(llamadas).toHaveLength(1);
  });

  it('AC5: ni los logs ni la auditoría llevan datos personales, enmascarados o no, en la lectura y en la relectura', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const primera = puerto([pagina([crudo({ compradores: enmascarados() })], 'c1')], sinPii);
    const r1 = await leerIncremental({ ahora: reloj() }, primera.port);
    const segunda = puerto([pagina([], 'c1'), pagina([crudo({ estado: 'asignado' })], 'r1')], conPii);
    await leerIncremental({ ahora: reloj() }, segunda.port);
    expect(tramite(U1)!.flit2PiiEnmascarada).toBe(false);
    await auditarLecturaProgramada(r1);
    const todo = JSON.stringify([logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls, filas(S.auditLogs)]);
    for (const x of [DOC_1, DOC_2, CORREO, CELULAR, DIRECCION, 'PERSONA EJEMPLO', 'EMPRESA EJEMPLO', '****', '***@']) {
      expect(todo).not.toContain(x);
    }
    expect(JSON.stringify(tramite(U1)!.flitRaw)).not.toContain('****');
  });
});

describe('HU #13095 · factura de FLIT 2 (RN-21)', () => {
  const ADJ_1 = '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f';
  const ADJ_2 = '0192b7c4-9a1b-7c2d-8e3f-000000000002';
  const leer = async (items: Fila[], cursor = 'c1') => leerIncremental({ ahora: reloj() }, puerto([pagina(items, cursor)]).port);

  it('AC1: alta con factura.adjuntoId → factura_venta_flit_id guardado', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([crudo({ factura: { adjuntoId: ADJ_1 } })]);
    expect(tramite(U1)!.facturaVentaFlitId).toBe(ADJ_1);
  });

  it('AC1: un reemplazo trae otro adjuntoId → se guarda el nuevo (no es identidad estable) y queda en el historial', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const previo = sembrarFlit2({ facturaVentaFlitId: ADJ_1 });
    await leer([crudo({ syncVersion: 11, factura: { adjuntoId: ADJ_2 } })]);
    expect(tramite(U1)!.facturaVentaFlitId).toBe(ADJ_2);
    expect(historial().filter((h) => h.campo === 'factura_venta_flit_id')).toEqual([
      expect.objectContaining({ tramiteId: previo.id, valorAnterior: ADJ_1, valorNuevo: ADJ_2, origen: 'api' }),
    ]);
  });

  it('D2: actualización con factura: null → la referencia se BORRA y el cambio queda en el historial', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    const previo = sembrarFlit2({ facturaVentaFlitId: ADJ_1 });
    const r = await leer([crudo({ syncVersion: 11, factura: null })]);
    expect(tramite(U1)!.facturaVentaFlitId).toBeNull();
    expect(historial().filter((h) => h.campo === 'factura_venta_flit_id')).toEqual([
      expect.objectContaining({ tramiteId: previo.id, valorAnterior: ADJ_1, valorNuevo: null }),
    ]);
    expect(r.actualizados).toBe(1);
  });

  it('un tombstone con factura: null NO borra la referencia (RN-05)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    sembrarFlit2({ facturaVentaFlitId: ADJ_1 });
    await leer([tombstone(U1, 12, 'FT1-0001234')]);
    expect(tramite(U1)!.facturaVentaFlitId).toBe(ADJ_1);
  });

  it('adjuntoId de 121 caracteres → null + warn sin el valor', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    const largo = 'a'.repeat(121);
    await leer([crudo({ factura: { adjuntoId: largo } })]);
    expect(tramite(U1)!.facturaVentaFlitId).toBeNull();
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ idFlit2: U1, campo: 'facturaAdjuntoId', longitud: 121 }), expect.any(String));
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain(largo);
  });

  it('AC4: asignado SIN factura → arranca el impuesto en pendiente y queda sin factura (como FLIT 1)', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([crudo({ estado: 'asignado', factura: null })]);
    const t = tramite(U1)!;
    expect(t.facturaVentaFlitId).toBeNull();
    expect(filas(S.flitoImpuestos)).toEqual([expect.objectContaining({ tramiteId: t.id, estado: 'pendiente' })]);
  });

  it('AC4: asignado CON factura → mismo arranque; la factura no condiciona el impuesto', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE });
    await leer([crudo({ estado: 'asignado', factura: { adjuntoId: ADJ_1 } })]);
    const t = tramite(U1)!;
    expect(t.facturaVentaFlitId).toBe(ADJ_1);
    expect(filas(S.flitoImpuestos)).toEqual([expect.objectContaining({ tramiteId: t.id, estado: 'pendiente' })]);
  });
});

// ═══ HU #13188 · AC4: la lectura con el candado tomado se publica como «en curso» ═════════════════
const { leerPrograma, reiniciarProgramaParaTest } = await import('../../src/modules/flito-sync/flit2-programa.js');

describe('HU #13188 · AC4 · enCurso del estado', () => {
  beforeEach(() => {
    candado.tomado = false; candado.enCursoAlPedir = [];
    reiniciarProgramaParaTest();
  });

  it('AC4: enCurso es true mientras la lectura corre con el candado y false al terminar bien', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    let soltar!: () => void;
    const pausa = new Promise<void>((ok) => { soltar = ok; });
    const { port } = puerto([pagina([], 'c1', false)], () => pausa);
    expect(leerPrograma().enCurso).toBe(false);
    const promesa = leerConCandado('cron', port, { ahora: reloj() });
    await vi.waitFor(() => expect(leerPrograma().enCurso).toBe(true));
    soltar();
    await promesa;
    expect(leerPrograma().enCurso).toBe(false);
  });

  it('AC4: una lectura que termina con error deja enCurso en false', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    let soltar!: () => void;
    const pausa = new Promise<void>((ok) => { soltar = ok; });
    const { port } = puerto([new Flit2RespuestaError(500, null)], () => pausa);
    const promesa = leerConCandado('boton', port, { ahora: reloj() }).catch((x: unknown) => x);
    await vi.waitFor(() => expect(leerPrograma().enCurso).toBe(true));
    soltar();
    expect(await promesa).toBeInstanceOf(Flit2RespuestaError);
    expect(leerPrograma().enCurso).toBe(false);
  });

  it('AC4: con el candado ya tomado la lectura no se publica: enCurso nunca pasa a true', async () => {
    sembrarLectura({ sinceArranque: ARRANQUE, cursor: 'c0' });
    candado.tomado = true;
    const { port } = puerto([pagina([], 'c1')]);
    const e = await leerConCandado('cron', port, { ahora: reloj() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2LecturaEnCursoError);
    expect(candado.enCursoAlPedir).toEqual([false]);
    expect(leerPrograma().enCurso).toBe(false);
    candado.tomado = false;
  });
});
