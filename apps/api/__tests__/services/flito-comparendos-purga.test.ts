// FLITO comparendos — purga por retención (HU #11511, AC2).
//
// `COMPARENDOS_RETENTION_MONTHS` estaba declarada desde la HU #11496 y no se consumía en ningún
// punto del repositorio: una política de retención que no borraba nada. Esto prueba que ahora sí.
//
// Lo que se demuestra, por orden de importancia:
//
//   1. **Se borra por ANTIGÜEDAD y por el umbral CONFIGURADO**, no por una constante escondida. El
//      corte se afirma sobre el WHERE real serializado a SQL, no sobre lo que el mock devolvió.
//   2. **El reloj es `ultimo_visto_en`** (RN-26): un comparendo que las fuentes siguen reportando no
//      se borra por viejo que sea el hecho. Borrar una deuda viva deja al operador ciego.
//   3. **El timeline se va con su registro por CASCADE** (RN-27): no hay ni un DELETE dirigido a
//      `flito_comparendos_eventos`, que es lo que la 0151 deliberadamente NO permite.
//   4. **Queda rastro de cuántas filas se purgaron** (RN-29): un borrado sin log es indistinguible
//      de una pérdida de datos.
//   5. **La puerta por env** (RN-28): un cron que borra no arranca por el hecho de desplegarse.
//   6. **El FRENO** (RN-30, hallazgo del gate de seguridad): el troceado en lotes limita el ritmo,
//      no el daño. Si el sync deja de correr, `ultimo_visto_en` deja de avanzar en toda la tabla y
//      la purga acabaría borrando datos VIGENTES a 10 000 filas por día, en silencio. Se aborta la
//      pasada entera por porcentaje o por reloj parado.
//   7. **El `dryRun` cuenta de verdad** (hallazgo del gate de base de datos): contaba un lote y
//      salía, así que sobre 200 000 candidatos reportaba 500 — y es la cifra que la documentación
//      manda mirar ANTES de encender el cron.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** El lock se mockea para ejercer las dos ramas: la pasada normal y la de «ya hay otra». */
const withLockMock = vi.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: (n: string, t: number, fn: () => Promise<unknown>) => withLockMock(n, t, fn),
  acquireLock: vi.fn(), releaseLock: vi.fn(),
}));

/** Todo lo logueado: el rastro de RN-29 es parte del AC, así que se afirma sobre él. */
const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const {
  corteDeRetencion,
  runComparendosPurgaOnce,
  startComparendosPurgaCron,
  stopComparendosPurgaCron,
} = await import('../../src/modules/flito-comparendos/flito-comparendos-purga.cron.js');
const { env } = await import('../../src/config/env.js');

type EnvMutable = {
  COMPARENDOS_RETENTION_MONTHS: number;
  COMPARENDOS_PURGA_CRON_ENABLED: boolean;
  COMPARENDOS_PURGA_MAX_RATIO: number;
  COMPARENDOS_PURGA_SYNC_MAX_DIAS: number;
};
const entorno = env as unknown as EnvMutable;
const original = { ...entorno };

// ─────────────────────────────── Espía de consultas y borrados ──────────────────────────────────
//
// El espía compartido (`espia-drizzle`) cubre INSERT y UPDATE; aquí lo que hay que mirar es el
// SELECT que elige a los candidatos y el DELETE que los borra. Y sobre todo sus WHERE: sin
// serializarlos a SQL real, un barrido acotado por el corte y uno que se lleva la tabla entera son
// indistinguibles para el mock, que devuelve lo registrado pase lo que pase en el filtro.

const dialecto = new PgDialect();

interface Consulta { tabla: string; condiciones: unknown[] }

const lecturas: Consulta[] = [];
const borrados: Consulta[] = [];

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

function instalarEspia(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const registro: Consulta = { tabla: '__sin_from__', condiciones: [] };
    const desdeOriginal = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { registro.tabla = nombre(tbl); lecturas.push(registro); return desdeOriginal(tbl); };
    const whereOriginal = chain.where as (v: unknown) => unknown;
    chain.where = (cond: unknown) => { registro.condiciones.push(cond); return whereOriginal(cond); };
    return chain;
  });

  const deleteBase = kdb.delete.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.delete.mockImplementation((tbl: unknown) => {
    const chain = deleteBase(tbl);
    const registro: Consulta = { tabla: nombre(tbl), condiciones: [] };
    borrados.push(registro);
    const whereOriginal = chain.where as (v: unknown) => unknown;
    chain.where = (cond: unknown) => { registro.condiciones.push(cond); return whereOriginal(cond); };
    return chain;
  });
}

const sqlDe = (c: Consulta) => dialecto.sqlToQuery(c.condiciones[0] as never);
const borradosEn = (tabla: string) => borrados.filter((b) => b.tabla === tabla);
/** Lecturas con `.where()`. La medición del freno no lo lleva (su filtro va en el `count(*) filter`). */
const lecturasEn = (tabla: string) => lecturas.filter((l) => l.tabla === tabla && l.condiciones.length > 0);
/** La lectura cuyo WHERE menciona la columna pedida: hay varias por tabla y cada una filtra por lo suyo. */
const lecturaPor = (tabla: string, columna: string) =>
  lecturasEn(tabla).find((l) => sqlDe(l).sql.includes(columna));

// El orden de registro IMPORTA: el mock es una cola FIFO por tabla y la pasada consulta, en este
// orden, la medición del freno (registros), el heartbeat (sync_runs) y luego los candidatos de cada
// una. Por eso `conPasadaViva` va SIEMPRE antes que `conCandidatos`.

/**
 * Deja la pasada en condiciones de purgar: hay algo que caducó, la tabla es lo bastante grande para
 * que el porcentaje no salte, y el sync corrió ayer (RN-30).
 */
function conPasadaViva(opts: { candidatos?: number; total?: number; diasDesdeSync?: number } = {}): void {
  const candidatos = opts.candidatos ?? 2;
  kdb.when.selectOnce('flito_comparendos_registros', [{ candidatos, total: opts.total ?? candidatos * 100 }]);
  kdb.when.selectOnce('flito_comparendos_sync_runs', [{
    iniciadoEn: new Date(Date.now() - (opts.diasDesdeSync ?? 1) * 24 * 60 * 60 * 1000),
  }]);
}

/** Filas que el SELECT de candidatos devuelve, y luego nada: un lote y se acabó. */
function conCandidatos(tabla: string, ids: string[]): void {
  kdb.when.selectOnce(tabla, ids.map((id) => ({ id })));
  kdb.when.select(tabla, []);
  kdb.when.delete(tabla, ids.map((id) => ({ id })));
}

beforeEach(() => {
  kdb.reset();
  borrados.length = 0;
  lecturas.length = 0;
  registros.length = 0;
  instalarEspia();
  Object.assign(entorno, original);
  withLockMock.mockClear();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
});

afterEach(() => { Object.assign(entorno, original); stopComparendosPurgaCron(); });

// ─────────────────────────── El corte sale del umbral configurado ───────────────────────────────

describe('corteDeRetencion — el umbral es el configurado (AC2)', () => {
  it('resta MESES de calendario, no «30 días × N»', () => {
    // La aproximación en días desplaza el corte casi un mes en dos años, y esa diferencia son datos
    // personales conservados de más sin que nadie lo haya decidido.
    expect(corteDeRetencion(new Date('2026-08-13T10:00:00.000Z'), 24).toISOString())
      .toBe('2024-08-13T10:00:00.000Z');
    expect(corteDeRetencion(new Date('2026-08-13T10:00:00.000Z'), 6).toISOString())
      .toBe('2026-02-13T10:00:00.000Z');
  });

  it('el default de 24 meses y un umbral corto dan cortes distintos', () => {
    const ahora = new Date('2026-08-13T00:00:00.000Z');
    expect(corteDeRetencion(ahora, 24) < corteDeRetencion(ahora, 1)).toBe(true);
  });
});

describe('runComparendosPurgaOnce — borra por antigüedad (AC2)', () => {
  it('**el WHERE acota por `ultimo_visto_en` y por el corte configurado**', async () => {
    entorno.COMPARENDOS_RETENTION_MONTHS = 12;
    conPasadaViva({ candidatos: 2 });
    conCandidatos('flito_comparendos_registros', ['reg-1', 'reg-2']);

    const r = await runComparendosPurgaOnce();

    // La consulta de candidatos es lo que decide qué se borra. Se afirma sobre el SQL real: sin
    // esto, un barrido sin condición y uno correcto son iguales para el mock.
    const candidatos = sqlDe(lecturasEn('flito_comparendos_registros')[0]);
    expect(candidatos.sql).toContain('"ultimo_visto_en" <');
    // Y el parámetro es el corte de VERDAD: 12 meses atrás, no una constante del módulo (RN-26).
    // Drizzle serializa el `Date` del filtro a ISO al construir la consulta, así que se compara con
    // el corte que la propia pasada reporta.
    expect(candidatos.params[0]).toBe(r.corte);
    expect(new Date(r.corte).getTime())
      .toBeCloseTo(corteDeRetencion(new Date(), 12).getTime(), -4);

    expect(r.registros).toBe(2);

    const delRegistros = borradosEn('flito_comparendos_registros');
    expect(delRegistros).toHaveLength(1);
    // El DELETE va por id (PK) sobre el lote leído, nunca por una condición de fecha suelta: es lo
    // que mantiene el borrado acotado en vez de un statement que bloquea la tabla entera.
    expect(sqlDe(delRegistros[0]).params).toEqual(['reg-1', 'reg-2']);
  });

  it('las corridas de sync se acotan por `iniciado_en`, no por el reloj de los registros', async () => {
    conCandidatos('flito_comparendos_sync_runs', ['run-1']);

    await runComparendosPurgaOnce();

    expect(lecturaPor('flito_comparendos_sync_runs', '"iniciado_en" <')).toBeDefined();
  });

  it('el corte se mueve con `COMPARENDOS_RETENTION_MONTHS`: 1 mes borra lo que 24 conserva', async () => {
    entorno.COMPARENDOS_RETENTION_MONTHS = 1;
    const corto = (await runComparendosPurgaOnce()).corte;
    entorno.COMPARENDOS_RETENTION_MONTHS = 24;
    const largo = (await runComparendosPurgaOnce()).corte;

    // No es una constante escondida en el módulo: la variable de entorno la mueve de verdad.
    expect(new Date(largo).getTime()).toBeLessThan(new Date(corto).getTime());
  });

  it('sin nada que purgar no ejecuta ni un DELETE', async () => {
    kdb.when.select('flito_comparendos_registros', []);
    kdb.when.select('flito_comparendos_sync_runs', []);

    const r = await runComparendosPurgaOnce();

    expect(borrados).toHaveLength(0);
    expect(r).toMatchObject({ registros: 0, eventos: 0, syncRuns: 0, truncado: false });
  });

  it('purga también las corridas de sync, cuyos pasos llevan el NIT', async () => {
    conCandidatos('flito_comparendos_sync_runs', ['run-1']);

    const r = await runComparendosPurgaOnce();

    expect(r.syncRuns).toBe(1);
    expect(borradosEn('flito_comparendos_sync_runs')).toHaveLength(1);
  });

  it('**el timeline se va por CASCADE: no hay un solo DELETE sobre `eventos`** (RN-27)', async () => {
    conPasadaViva({ candidatos: 1 });
    conCandidatos('flito_comparendos_registros', ['reg-1']);
    kdb.when.select('flito_comparendos_eventos', [{ n: 3 }]);

    const r = await runComparendosPurgaOnce();

    // La 0151 concede DELETE solo sobre los dos PADRES a propósito: borrar eventos sueltos —sin su
    // registro— sería borrar la prueba dejando el dato que la contradice.
    expect(borradosEn('flito_comparendos_eventos')).toHaveLength(0);
    // Y aun así se cuentan, porque el rastro tiene que decir cuánto timeline se fue con ellos.
    expect(r.eventos).toBe(3);
  });

  it('deja rastro de cuántas filas purgó, con el corte y los meses de retención (RN-29)', async () => {
    entorno.COMPARENDOS_RETENTION_MONTHS = 18;
    conPasadaViva({ candidatos: 3 });
    conCandidatos('flito_comparendos_registros', ['reg-1', 'reg-2', 'reg-3']);
    kdb.when.select('flito_comparendos_eventos', [{ n: 7 }]);

    await runComparendosPurgaOnce();

    const linea = registros.find((a) => typeof a[1] === 'string' && a[1].includes('retención'));
    expect(linea).toBeDefined();
    expect(linea![0]).toMatchObject({ registros: 3, eventos: 7, retentionMonths: 18, dryRun: false });
  });

  it('si otra instancia tiene el lock, la pasada es un no-op y no un error', async () => {
    withLockMock.mockImplementation(async () => null);
    conCandidatos('flito_comparendos_registros', ['reg-1']);

    const r = await runComparendosPurgaOnce();

    expect(r).toMatchObject({ registros: 0, syncRuns: 0 });
    expect(borrados).toHaveLength(0);
  });

  it('el lock es el SUYO y no el del sync: purgar no puede devolverle 409 a un operador', async () => {
    await runComparendosPurgaOnce();

    // Compartir el lock con `POST /sync` serializaría las dos cosas, y el operador vería
    // `sync_en_curso` porque un cron está purgando, sin forma de saber por qué.
    expect(withLockMock.mock.calls[0][0]).toBe('flito-comparendos-purga');
  });
});

// ─────────────────────────── `truncado` = queda trabajo ─────────────────────────────────────────

describe('runComparendosPurgaOnce — `truncado` dice si quedó trabajo, no si se agotó el bucle', () => {
  /** 500 ids: un lote LLENO, que es la señal de que puede quedar más detrás. */
  const LOTE_LLENO = Array.from({ length: 500 }, (_, i) => ({ id: `reg-${i}` }));

  function conLotes(secuencia: (n: number) => { id: string }[]): void {
    let llamada = 0;
    let ultimo: { id: string }[] = [];
    kdb.when.select('flito_comparendos_registros', () => { llamada++; ultimo = secuencia(llamada); return ultimo; });
    kdb.when.delete('flito_comparendos_registros', () => ultimo);
  }

  it('**el último lote incompleto NO deja `truncado`: el trabajo terminó**', async () => {
    conPasadaViva({ candidatos: 9_620, total: 1_000_000 });
    conLotes((n) => (n < 20 ? LOTE_LLENO : LOTE_LLENO.slice(0, 120)));

    const r = await runComparendosPurgaOnce();

    // Marcarlo igual contamina justo el log que alguien mira para saber si la purga se puso al
    // corriente: diría «queda trabajo» sobre una pasada que se llevó lo último que había.
    expect(r.registros).toBe(19 * 500 + 120);
    expect(r.truncado).toBe(false);
  });

  it('veinte lotes llenos sí dejan `truncado`: el tope de la pasada cortó de verdad', async () => {
    conPasadaViva({ candidatos: 200_000, total: 1_000_000 });
    conLotes(() => LOTE_LLENO);

    const r = await runComparendosPurgaOnce();

    expect(r.registros).toBe(20 * 500);
    expect(r.truncado).toBe(true);
  });
});

// ─────────────────────────── El `dryRun` responde su propia pregunta ────────────────────────────

describe('runComparendosPurgaOnce — `dryRun` cuenta de verdad', () => {
  it('**cuenta TODOS los candidatos con un `count(*)`, no los 500 del primer lote**', async () => {
    conPasadaViva({ candidatos: 200_000, total: 1_000_000 });
    kdb.when.select('flito_comparendos_registros', [{ n: 200_000 }]);
    kdb.when.select('flito_comparendos_eventos', [{ n: 640_000 }]);
    kdb.when.select('flito_comparendos_sync_runs', [{ n: 12 }]);

    const r = await runComparendosPurgaOnce({ dryRun: true });

    // La versión anterior contaba un lote y salía —en seco no se borra, así que el siguiente SELECT
    // devolvería los mismos ids para siempre—, y reportaba 500 sobre 200 000: subestimaba hasta 20×
    // su propio tope. Y es la cifra que la documentación manda mirar ANTES de encender el cron.
    expect(r).toMatchObject({ registros: 200_000, eventos: 640_000, syncRuns: 12, dryRun: true });
    expect(borrados).toHaveLength(0);
    // `truncado` en seco significa «no cabe en una pasada» (LOTE × MAX_LOTES = 10 000), que es otra
    // cosa que el operador necesita saber y que el conteo de un lote no podía responder.
    expect(r.truncado).toBe(true);
  });

  it('el conteo usa el MISMO `WHERE` que el borrado, o contaría otra cosa', async () => {
    conPasadaViva({ candidatos: 10, total: 1_000 });
    kdb.when.select('flito_comparendos_registros', [{ n: 10 }]);
    kdb.when.select('flito_comparendos_sync_runs', [{ n: 0 }]);

    await runComparendosPurgaOnce({ dryRun: true });

    const conteo = lecturaPor('flito_comparendos_registros', '"ultimo_visto_en" <');
    expect(conteo).toBeDefined();
    expect(lecturaPor('flito_comparendos_sync_runs', '"iniciado_en" <')).toBeDefined();
  });

  it('lo que cabe en una pasada no sale marcado como truncado', async () => {
    conPasadaViva({ candidatos: 40, total: 1_000 });
    kdb.when.select('flito_comparendos_registros', [{ n: 40 }]);
    kdb.when.select('flito_comparendos_sync_runs', [{ n: 0 }]);

    expect((await runComparendosPurgaOnce({ dryRun: true })).truncado).toBe(false);
  });
});

// ─────────────────────────── El freno (RN-30) ───────────────────────────────────────────────────
//
// El hallazgo del gate: `LOTE × MAX_LOTES` limita el RITMO (10 000 filas/día), no el daño. Una purga
// equivocada vacía la tabla igual, solo que despacio y en silencio. Y la asimetría que lo hacía
// grave: el barrido de inactivación, que es REVERSIBLE, sí tenía freno; el borrado, que no lo es, no
// tenía ninguno.

describe('runComparendosPurgaOnce — freno por porcentaje y por reloj parado (RN-30)', () => {
  it('**aborta la pasada entera si los candidatos superan el porcentaje de la tabla**', async () => {
    entorno.COMPARENDOS_PURGA_MAX_RATIO = 0.25;
    kdb.when.selectOnce('flito_comparendos_registros', [{ candidatos: 600, total: 1_000 }]);
    conCandidatos('flito_comparendos_registros', ['reg-1']);
    conCandidatos('flito_comparendos_sync_runs', ['run-1']);

    const r = await runComparendosPurgaOnce();

    expect(r.abortadoPor).toBe('ratio');
    expect(r).toMatchObject({ registros: 0, syncRuns: 0 });
    // Ni una fila: también se para la purga de corridas, que es el rastro de cuándo dejó de
    // sincronizarse — borrarlo mientras se investiga por qué saltó el freno sería tirar la prueba.
    expect(borrados).toHaveLength(0);

    const linea = registros.find((a) => typeof a[1] === 'string' && a[1].includes('ABORTADA'));
    expect(linea).toBeDefined();
    expect(linea![0]).toMatchObject({ motivo: 'ratio', candidatos: 600, total: 1_000, maxRatio: 0.25 });
  });

  it('el porcentaje no manda en tablas pequeñas: 2 de 3 filas no es un vaciado', async () => {
    kdb.when.selectOnce('flito_comparendos_registros', [{ candidatos: 2, total: 3 }]);
    kdb.when.selectOnce('flito_comparendos_sync_runs', [{ iniciadoEn: new Date() }]);
    conCandidatos('flito_comparendos_registros', ['reg-1', 'reg-2']);

    const r = await runComparendosPurgaOnce();

    // Con 3 filas, dos que caducan son el 66 % y dispararían el freno en una purga correcta. Mismo
    // criterio que `MIN_ACTIVOS_PARA_FRENO_RATIO` en el barrido de inactivación.
    expect(r.abortadoPor).toBeNull();
    expect(r.registros).toBe(2);
  });

  it('**aborta si nadie ha sincronizado en `COMPARENDOS_PURGA_SYNC_MAX_DIAS`**', async () => {
    entorno.COMPARENDOS_PURGA_SYNC_MAX_DIAS = 7;
    // Poco porcentaje: el freno del ratio no salta. Lo que salta es el reloj.
    conPasadaViva({ candidatos: 5, total: 1_000, diasDesdeSync: 30 });
    conCandidatos('flito_comparendos_registros', ['reg-1']);

    const r = await runComparendosPurgaOnce();

    // Es el escenario que ningún otro control ve: `ultimo_visto_en` solo avanza cuando el sync corre,
    // así que con el sync parado la tabla envejece ENTERA y a los 24 meses la purga empieza a borrar
    // comparendos vigentes a 10 000 filas por día, sin que nada lo diga.
    expect(r.abortadoPor).toBe('sync_inactivo');
    expect(borrados).toHaveLength(0);
    const linea = registros.find((a) => typeof a[1] === 'string' && a[1].includes('ABORTADA'));
    expect(linea![0]).toMatchObject({ motivo: 'sync_inactivo', maxDias: 7 });
  });

  it('aborta también si NUNCA hubo una corrida terminada', async () => {
    kdb.when.selectOnce('flito_comparendos_registros', [{ candidatos: 5, total: 1_000 }]);
    kdb.when.selectOnce('flito_comparendos_sync_runs', []);
    conCandidatos('flito_comparendos_registros', ['reg-1']);

    const r = await runComparendosPurgaOnce();

    expect(r.abortadoPor).toBe('sync_inactivo');
    expect(borrados).toHaveLength(0);
  });

  it('el heartbeat solo mira corridas TERMINADAS: `running` y `failed` no prueban nada', async () => {
    conPasadaViva({ candidatos: 5, total: 1_000 });
    conCandidatos('flito_comparendos_registros', ['reg-1']);

    await runComparendosPurgaOnce();

    // `running` puede llevar colgada semanas y `failed` no escribió `ultimo_visto_en` de nada.
    const heartbeat = lecturaPor('flito_comparendos_sync_runs', '"estado" in');
    expect(heartbeat).toBeDefined();
    expect(sqlDe(heartbeat!).params).toEqual(['completed', 'partial']);
  });

  it('con el reloj vivo y un porcentaje razonable, la purga procede', async () => {
    conPasadaViva({ candidatos: 5, total: 1_000, diasDesdeSync: 2 });
    conCandidatos('flito_comparendos_registros', ['reg-1', 'reg-2']);

    const r = await runComparendosPurgaOnce();

    expect(r.abortadoPor).toBeNull();
    expect(r.registros).toBe(2);
  });

  it('en `dryRun` el freno NO impide contar: informa el motivo y sigue', async () => {
    conPasadaViva({ candidatos: 5, total: 1_000, diasDesdeSync: 90 });
    kdb.when.select('flito_comparendos_registros', [{ n: 5 }]);
    kdb.when.select('flito_comparendos_sync_runs', [{ n: 0 }]);

    const r = await runComparendosPurgaOnce({ dryRun: true });

    // La pasada en seco existe para responder «¿cuánto se llevaría?». Contestar «nada, porque el
    // freno saltaría» dejaría al operador sin la única cifra que la decisión necesita.
    expect(r).toMatchObject({ registros: 5, dryRun: true, abortadoPor: 'sync_inactivo' });
    expect(borrados).toHaveLength(0);
  });
});

// ─────────────────────────── La puerta por env (RN-28) ──────────────────────────────────────────

describe('startComparendosPurgaCron — puerta positiva (RN-28)', () => {
  it('con la puerta cerrada no programa nada y lo dice', () => {
    entorno.COMPARENDOS_PURGA_CRON_ENABLED = false;
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    startComparendosPurgaCron();

    expect(setInterval).not.toHaveBeenCalled();
    expect(registros.some((a) => typeof a[1] === 'string' && a[1].includes('DESHABILITADA'))).toBe(true);
    setInterval.mockRestore();
  });

  it('con `COMPARENDOS_PURGA_CRON_ENABLED=1` se programa la pasada periódica', () => {
    entorno.COMPARENDOS_PURGA_CRON_ENABLED = true;
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    startComparendosPurgaCron();

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 24 * 60 * 60 * 1000);
    setInterval.mockRestore();
  });
});
