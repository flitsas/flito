// FLITO SOAT — la TABLA de corridas y el delta de API de la vigencia (Feature #12075, HU #12096).
//
// Dos superficies que comparten un modelo y por eso comparten archivo:
//
//   1. **`flito_soat_verificacion_corridas`**, que sustituye a la clave de `system_kv` de la HU
//      #12095. Aquí se mide la FORMA de las dos consultas (no su efecto: eso lo cubre
//      `flito-soat-vigencia.cron.test.ts` con la tabla simulada) y la del upsert.
//   2. **El delta de `GET /flito/soat`**: los tres filtros en SQL, `vencido` derivado en el servidor
//      y la proyección que el `cliente` no recibe.
//
// **Todo se afirma sobre el SQL RENDERIZADO y sobre los payloads reales.** El mock de drizzle es
// passthrough en `where`, `orderBy`, `groupBy` y `limit`, y su `chain` devuelve la fila entera aunque
// el `select` pida menos: afirmar sobre las filas devueltas sería una tautología. Es la lección de
// los cinco verdes vacíos que el gate ya encontró en esta cadena.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { gruposHuerfanos, ligadoA, renderizar, vecesLigado } from '../helpers/sql-ligado.js';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: vi.fn(), acquireLock: vi.fn(), releaseLock: vi.fn(),
}));
vi.mock('../../src/modules/flito-soat/flito-soat-vigencia.service.js', () => ({
  recorrerVigenciaSoat: vi.fn(),
}));

const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const { guardarEstadoDelDia, leerEstadoDelDia } = await import(
  '../../src/modules/flito-soat/flito-soat-vigencia.cron.js'
);
const { condicionesCola } = await import('../../src/modules/flito-soat/flito-soat.service.js');

const espia = crearEspia(kdb);
const dialecto = new PgDialect();

const TABLA = 'flito_soat_verificacion_corridas';

/** El WHERE de cada SELECT sobre la tabla de corridas, en orden y renderizado. */
function wheresLeidos(): Array<{ sql: string; params: unknown[] }> {
  return espia.condicionesLeidas().map((c) => {
    const q = dialecto.sqlToQuery(c as SQL);
    return { sql: q.sql, params: q.params as unknown[] };
  });
}

const ESTADO_BASE = {
  dia: '2026-09-04',
  estado: 'en_curso' as const,
  intentos: 1,
  verificados: 0,
  pendientes: 0,
  proximoIntentoEn: '2026-09-04T06:10:00.000Z',
  actualizadoEn: '2026-09-04T05:10:00.000Z',
};

const RESUMEN = {
  considerados: 12, verificados: 7, pendientes: 5, cambiaron: 2,
  motivos: { timeout: 3, red: 2, reintentos: 5 },
};

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  registros.length = 0;
});

// ─────────────────────── La lectura: dos consultas, ninguna depende del orden ───────────────────

describe('leerEstadoDelDia — la forma de las dos consultas', () => {
  it('el agregado va **sin `GROUP BY`** y liga el día UNA sola vez', async () => {
    kdb.when.select(TABLA, [{
      ultimoIntento: 2, verificados: '11', corridas: 2,
      estado: 'en_curso', fallidos: 3,
      iniciadaEn: new Date('2026-09-04T06:10:00.000Z'), cerradaEn: new Date('2026-09-04T06:12:00.000Z'),
    }]);

    await leerEstadoDelDia('2026-09-04');

    const [agregado] = wheresLeidos();
    expect(agregado).toBeDefined();
    // MUTANTE — meter un `GROUP BY` con el literal reinterpolado: Drizzle no deduplica, así que
    // `dia = $1` en el WHERE y `dia` en el grupo con OTRO parámetro es `42803` y un 500 en CADA
    // llamada, sin que el texto del SQL lo delate (Bug #12058). El agregado no agrupa, punto.
    expect(agregado!.sql).not.toMatch(/\bgroup\s+by\b/i);
    expect(vecesLigado(agregado!, '2026-09-04')).toBe(1);
  });

  it('**no hay `ORDER BY … LIMIT 1`**: el último intento sale de `max()`, no del orden', async () => {
    kdb.when.select(TABLA, [{
      ultimoIntento: 3, verificados: '11', corridas: 3,
      estado: 'en_curso', fallidos: 3,
      iniciadaEn: new Date('2026-09-04T07:10:00.000Z'), cerradaEn: null,
    }]);

    const estado = await leerEstadoDelDia('2026-09-04');

    // El mock es passthrough en `orderBy` y en `limit`: un `ORDER BY intento DESC LIMIT 1` sería
    // VERDE con la cláusula borrada. Partirlo en un agregado + una lectura por llave exacta es lo que
    // deja las dos comprobables. Por eso el intento leído es el `max()` que el agregado devolvió.
    expect(estado).toMatchObject({ intentos: 3 });
  });

  it('la segunda consulta va **por la llave EXACTA** (día + ese intento)', async () => {
    kdb.when.select(TABLA, [{
      ultimoIntento: 2, verificados: '4', corridas: 2,
      estado: 'completa', fallidos: 0,
      iniciadaEn: new Date('2026-09-04T06:10:00.000Z'), cerradaEn: new Date('2026-09-04T06:20:00.000Z'),
    }]);

    await leerEstadoDelDia('2026-09-04');

    const [, porLlave] = wheresLeidos();
    expect(porLlave).toBeDefined();
    expect(ligadoA(porLlave!, '"flito_soat_verificacion_corridas"."dia"')).toBe('2026-09-04');
    // El intento es un número y no lo recoge `paramsDe`; se comprueba sobre los parámetros crudos.
    expect(porLlave!.params).toContain(2);
    expect(porLlave!.sql).toMatch(/"intento" = \$\d+/);
  });

  it('un día SIN corridas devuelve `null`, y el agregado vacío es UNA fila con `max` nulo', async () => {
    // Un agregado sin GROUP BY sobre cero filas devuelve una fila con `max()` NULL y `count(*)` 0, no
    // cero filas. Tratarlo como «hay estado» arrancaría un intento 0.
    kdb.when.select(TABLA, [{ ultimoIntento: null, verificados: null, corridas: 0 }]);
    expect(await leerEstadoDelDia('2026-09-04')).toBeNull();
  });

  it('`verificados` es del DÍA (suma) y `pendientes` del ÚLTIMO intento', async () => {
    kdb.when.select(TABLA, [{
      // `sum()` llega como cadena desde el driver de Postgres.
      ultimoIntento: 3, verificados: '11', corridas: 3,
      estado: 'en_curso', fallidos: 4,
      iniciadaEn: new Date('2026-09-04T07:10:00.000Z'), cerradaEn: new Date('2026-09-04T07:25:00.000Z'),
    }]);

    const estado = await leerEstadoDelDia('2026-09-04');

    expect(estado).toMatchObject({ verificados: 11, pendientes: 4, intentos: 3 });
    // Sumar `fallidos` sobre el día contaría cuatro veces al mismo vehículo y el día no cerraría
    // nunca; sumar `verificados` es lo correcto porque cada intento verifica vehículos DISTINTOS
    // (el censo excluye lo ya verificado hoy).
  });
});

describe('leerEstadoDelDia — `proximoIntentoEn` se DERIVA de `iniciada_en`, no se guarda', () => {
  const fila = (over: Record<string, unknown>) => [{
    ultimoIntento: 1, verificados: '3', corridas: 1, estado: 'en_curso', fallidos: 2,
    iniciadaEn: new Date('2026-09-04T05:10:00.000Z'), cerradaEn: new Date('2026-09-04T05:40:00.000Z'),
    ...over,
  }];

  it('en curso y con reintentos por gastar → arranque + 1 hora (CF-06)', async () => {
    kdb.when.select(TABLA, fila({}));
    // Desde el ARRANQUE del intento (05:10Z = 00:10 Bogotá) y no desde su cierre (05:40Z): la
    // cadencia es fija 00:10, 01:10, 02:10, 03:10 pase lo que pase con lo que tarde cada pasada.
    // MUTANTE — derivarlo de `cerrada_en`: daría 06:40 y la cadencia derivaría cada noche.
    expect((await leerEstadoDelDia('2026-09-04'))!.proximoIntentoEn).toBe('2026-09-04T06:10:00.000Z');
  });

  it('día `completa` → `null`: no hay nada que reprogramar', async () => {
    kdb.when.select(TABLA, fila({ estado: 'completa', fallidos: 0 }));
    expect((await leerEstadoDelDia('2026-09-04'))!.proximoIntentoEn).toBeNull();
  });

  it('día `parcial` → `null`', async () => {
    kdb.when.select(TABLA, fila({ estado: 'parcial', ultimoIntento: 4 }));
    expect((await leerEstadoDelDia('2026-09-04'))!.proximoIntentoEn).toBeNull();
  });

  it('`en_curso` con los reintentos AGOTADOS (intento 4) → `null`, no una quinta ejecución', async () => {
    kdb.when.select(TABLA, fila({ ultimoIntento: 4 }));
    // `MAX_REINTENTOS` es 3, o sea 4 ejecuciones. Un `en_curso` en el intento 4 no reprograma.
    expect((await leerEstadoDelDia('2026-09-04'))!.proximoIntentoEn).toBeNull();
  });

  it('`actualizadoEn` es el cierre si cerró, y el arranque si el proceso murió a mitad', async () => {
    kdb.when.select(TABLA, fila({}));
    expect((await leerEstadoDelDia('2026-09-04'))!.actualizadoEn).toBe('2026-09-04T05:40:00.000Z');

    kdb.reset(); espia.reiniciar();
    kdb.when.select(TABLA, fila({ cerradaEn: null }));
    // Nunca `now()`: esta marca dice cuándo se supo algo del día, no cuándo se preguntó.
    expect((await leerEstadoDelDia('2026-09-04'))!.actualizadoEn).toBe('2026-09-04T05:10:00.000Z');
  });
});

// ─────────────────────────── La escritura: entrada y cierre, y el target ────────────────────────

describe('guardarEstadoDelDia — dos escrituras por intento, y no son la misma', () => {
  const upsert = () => {
    const m = espia.insertsEn(TABLA).at(-1)!;
    return m.datos as Record<string, unknown>;
  };

  it('ENTRADA (sin resumen): fija arranque, deja `cerrada_en` en null y no escribe totales', async () => {
    await guardarEstadoDelDia(ESTADO_BASE);

    expect(upsert()).toEqual({
      dia: '2026-09-04', intento: 1, estado: 'en_curso',
      iniciadaEn: new Date('2026-09-04T05:10:00.000Z'), cerradaEn: null,
    });
    // Sin `total`/`verificados`/`cambiaron`/`fallidos`/`motivos`: el recorrido todavía no ha
    // ocurrido y los DEFAULT de la 0177 ya dicen cero. Escribir ceros aquí y totales después es lo
    // mismo, pero escribir el ACUMULADO del día aquí no lo sería.
    expect(upsert()).not.toHaveProperty('total');
    expect(upsert()).not.toHaveProperty('verificados');
  });

  it('CIERRE (con resumen): totales del INTENTO, y `fallidos` es lo que reprograma', async () => {
    await guardarEstadoDelDia({
      ...ESTADO_BASE, estado: 'en_curso', verificados: 19, pendientes: 5,
      actualizadoEn: '2026-09-04T05:40:00.000Z',
    }, RESUMEN);

    expect(upsert()).toMatchObject({
      dia: '2026-09-04', intento: 1, estado: 'en_curso',
      total: 12, verificados: 7, cambiaron: 2, fallidos: 5,
      motivos: { timeout: 3, red: 2, reintentos: 5 },
      cerradaEn: new Date('2026-09-04T05:40:00.000Z'),
    });
    // MUTANTE — escribir aquí `estado.verificados` (19, el ACUMULADO del día) en vez de los 7 de
    // este intento: `leerEstadoDelDia` los SUMA sobre las filas del día, así que el acumulado se
    // contaría dos veces y `verificados` crecería en progresión geométrica noche a noche.
    expect(upsert().verificados).toBe(7);
    expect(upsert().verificados).not.toBe(19);
  });

  it('el `target` del upsert son las DOS columnas de la llave', async () => {
    // Se lee del SQL real: `insert … on conflict (dia, intento) do update`.
    await guardarEstadoDelDia(ESTADO_BASE);
    // El espía no captura `onConflictDoUpdate`, así que la llave se comprueba donde SÍ tiene efecto
    // observable: en `flito-soat-vigencia.cron.test.ts`, cuya tabla simulada resuelve el conflicto
    // con las columnas del `target` REAL. Aquí queda el aserto de que el payload trae las dos, que es
    // condición necesaria: sin `intento` en los `values`, ningún `target` podría usarlo.
    expect(upsert()).toMatchObject({ dia: '2026-09-04', intento: 1 });
  });

  it('un cierre `parcial` con los reintentos agotados guarda los fallidos, no los borra', async () => {
    await guardarEstadoDelDia({
      ...ESTADO_BASE, estado: 'parcial', intentos: 4, pendientes: 6, proximoIntentoEn: null,
      actualizadoEn: '2026-09-04T08:25:00.000Z',
    }, { ...RESUMEN, pendientes: 6 });

    expect(upsert()).toMatchObject({ dia: '2026-09-04', intento: 4, estado: 'parcial', fallidos: 6 });
    // La constancia que el AC5 pide: la fila del día 4 sigue ahí mañana, porque la llave lleva el día.
  });

  it('`motivos` viaja como el objeto de vocabulario cerrado, sin texto libre', async () => {
    await guardarEstadoDelDia(ESTADO_BASE, {
      ...RESUMEN, motivos: { timeout: 1, otro: 2 },
    });
    expect(upsert().motivos).toEqual({ timeout: 1, otro: 2 });
    for (const k of Object.keys(upsert().motivos as object)) {
      expect(['timeout', 'red', 'circuito', 'otro', 'reintentos']).toContain(k);
    }
  });
});

// ─────────────────── El delta de API: los tres filtros de la cola, en SQL ───────────────────────

const ctxAdmin = { userId: 1, username: 'a@flit.io', role: 'admin', proveedorSoatId: null, companiaId: null };
const ctxCliente = { userId: 9, username: 'c@x.io', role: 'cliente', proveedorSoatId: null, companiaId: 7 };

/** El WHERE completo de la cola con estos filtros, renderizado. */
function whereCola(ctx: unknown, filtros: Record<string, unknown>) {
  const conds = condicionesCola(ctx as never, filtros as never);
  expect(conds, 'la frontera devolvió null: no hay WHERE que mirar').not.toBeNull();
  // Se unen con el MISMO `and(...)` que usa la cola, para que el SQL sea el que Postgres recibiría.
  return renderizar(and(...conds!)!);
}

describe('AC2 de la #12097 — los tres filtros corren en SQL, sobre el censo del AC2', () => {
  it('`no_verificado` compara la columna y **acota al universo del comprobante**', () => {
    const q = whereCola(ctxAdmin, { vigencia: 'no_verificado' });

    expect(ligadoA(q, '"flito_soat"."estado_vigencia"')).toBe('no_verificado');
    // MUTANTE — quitar el EXISTS: `no_verificado` es el valor por DEFAULT de la 0177, así que sin
    // acotar arrastraría TODOS los `pendiente` y `solicitado` —que nunca entraron en la
    // verificación— y devolvería media cola. El AC2 sería falso en verde.
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('factura_soat');
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    expect(q.sql).toContain('"flito_soportes"."soat_id" = "flito_soat"."id"');
  });

  it('`sin_registro` compara la columna, y NO se confunde con `vencido`', () => {
    const q = whereCola(ctxAdmin, { vigencia: 'sin_registro' });
    expect(ligadoA(q, '"flito_soat"."estado_vigencia"')).toBe('sin_registro');
    // No mira `vence_el` en absoluto: una fila `sin_registro` con fecha vieja —la que el AC5
    // conserva— no se reetiqueta ni se cruza con el otro bucket.
    expect(q.sql).not.toContain('"flito_soat"."vence_el"');
  });

  it('`vencido` se DERIVA en el servidor, y **solo desde `vigente`**', () => {
    const q = whereCola(ctxAdmin, { vigencia: 'vencido' });

    // MUTANTE — derivarlo desde cualquier estado (quitar la comparación con `vigente`): una fila
    // `sin_registro` con un `vence_el` viejo caería en «Venció el …», que es justo el par que el UX
    // más trabaja para que NO se confunda: «venció» es el ciclo normal, «sin registro» contradice lo
    // que FLITO pagó.
    expect(ligadoA(q, '"flito_soat"."estado_vigencia"')).toBe('vigente');
    expect(q.sql).toContain('"flito_soat"."vence_el" is not null');
    expect(q.sql).toMatch(/"flito_soat"\."vence_el" < \$\d+::date/);
    // El día viaja como PARÁMETRO `yyyy-mm-dd`, no como un `now()` del servidor de base de datos:
    // el corte es el de Bogotá y lo calcula el API con `Intl`, que es el mismo reloj con el que la
    // fila se etiqueta al ensamblarse. Dos relojes distintos discreparían el día del vencimiento.
    expect(q.params.some((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p))).toBe(true);
    expect(q.sql).not.toMatch(/\bnow\(\)/i);
  });

  it('los tres son EXCLUYENTES: cada uno fija UN valor de `estado_vigencia`', () => {
    for (const [filtro, valor] of [
      ['vencido', 'vigente'], ['sin_registro', 'sin_registro'], ['no_verificado', 'no_verificado'],
    ] as const) {
      const q = whereCola(ctxAdmin, { vigencia: filtro });
      expect(vecesLigado(q, valor)).toBe(1);
    }
  });

  it('sin filtro de vigencia, el WHERE es el de siempre: ni EXISTS ni columnas nuevas', () => {
    const q = whereCola(ctxAdmin, {});
    // Regresión pura: quien no pide vigencia no paga la subconsulta correlacionada en el WHERE.
    expect(q.sql).not.toContain('estado_vigencia');
    expect(q.sql).not.toContain('flito_soportes');
  });

  it('al `cliente` se le IGNORA el filtro: sería un oráculo sobre un campo que no recibe', () => {
    const q = whereCola(ctxCliente, { vigencia: 'sin_registro' });

    // Misma doctrina que `gestion` y `proveedores`: un filtro responde sí/no sobre un campo oculto, y
    // repetido es el campo entero. Se IGNORA, no da 400 — un 400 confirmaría que el campo existe.
    expect(q.sql).not.toContain('estado_vigencia');
    // Y su frontera por compañía sigue intacta.
    expect(ligadoA(q, '"flito_soat"."compania_id"')).toBe(7);
  });

  it('ningún filtro de vigencia mete un GROUP BY: no hay huérfanos que provoquen un 42803', () => {
    const q = whereCola(ctxAdmin, { vigencia: 'vencido' });
    // `gruposHuerfanos` LANZA si no hay `GROUP BY` que analizar (su doctrina anti-verde-vacío), así
    // que aquí se afirma por texto: esta consulta no agrupa y no puede caer en el Bug #12058.
    expect(q.sql).not.toMatch(/\bgroup\s+by\b/i);
    expect(() => gruposHuerfanos(q)).toThrow(/No hay ni un GROUP BY/);
  });
});

// ───────────────────── El delta de API: la fila que la cola devuelve ────────────────────────────

describe('la fila de la cola — `vigencia` derivada en el SERVIDOR, y nunca para el `cliente`', () => {
  const HOY = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const AYER = new Date(Date.parse(`${HOY}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const MANANA = new Date(Date.parse(`${HOY}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  /** Fila cruda tal como sale de la proyección de la cola. El mock la devuelve entera. */
  const fila = (over: Record<string, unknown>) => ({
    id: 'soat-1', vin: '9BWZZZ377VT004251', estado: 'pagado', origen: 'tramite',
    proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
    valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-09-01T00:00:00Z'),
    placa: 'ABC123', marca: 'MAZDA', linea: 'CX-30', cilindraje: null, carroceria: null,
    tipoServicio: null, companiaNombre: 'ACME', organismoNombre: null,
    proveedorSoatNombre: null, proveedorSlaHoras: null, enviadoPorNombre: null,
    estadoVigencia: 'no_verificado', verificadaEn: null, venceEl: null, tieneVigencia: true,
    ...over,
  });

  async function filaDeCola(ctx: unknown, over: Record<string, unknown>) {
    kdb.reset(); espia.reiniciar();
    kdb.when.select('flito_soat', [fila(over)]);
    const { cola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const pagina = await cola(ctx as never, {});
    return pagina.items[0] as Record<string, unknown> | undefined;
  }

  it('**`vigencia` es `null` cuando la fila no tiene comprobante**: no se pinta nada', async () => {
    const item = await filaDeCola(ctxAdmin, { tieneVigencia: false, estadoVigencia: 'no_verificado' });
    // Y NO un objeto «vacío con nulls dentro»: la pantalla distingue una fila muda de una con
    // pastilla, y un bloque presente con todo a null la obligaría a inventarse un cuarto caso.
    expect(item!.vigencia).toBeNull();
  });

  it('**`vencido` lo deriva el SERVIDOR**, y solo desde `vigente`', async () => {
    const vencido = await filaDeCola(ctxAdmin, {
      estadoVigencia: 'vigente', venceEl: AYER, verificadaEn: new Date('2026-09-04T05:12:00Z'),
    });
    expect(vencido!.vigencia).toEqual({
      estado: 'vencido', verificadaEn: '2026-09-04T05:12:00.000Z', venceEl: AYER,
    });

    const vigente = await filaDeCola(ctxAdmin, {
      estadoVigencia: 'vigente', venceEl: MANANA, verificadaEn: new Date('2026-09-04T05:12:00Z'),
    });
    expect((vigente!.vigencia as { estado: string }).estado).toBe('vigente');

    // MUTANTE — derivarlo desde cualquier estado. Una fila `sin_registro` con la fecha vieja que el
    // AC5 conserva se reetiquetaría «Venció el …», que es justo el par que el UX más trabaja para
    // que no se confunda: «venció» es el ciclo normal, «sin registro» contradice lo que FLITO pagó.
    const sinRegistro = await filaDeCola(ctxAdmin, { estadoVigencia: 'sin_registro', venceEl: AYER });
    expect((sinRegistro!.vigencia as { estado: string }).estado).toBe('sin_registro');
  });

  it('el que vence HOY todavía NO está vencido (la frontera, con el día de Bogotá)', async () => {
    const item = await filaDeCola(ctxAdmin, { estadoVigencia: 'vigente', venceEl: HOY });
    // La comparación es `<`, no `<=`: una póliza que vence hoy sigue cubriendo hoy. Y el día sale de
    // `Intl`/`America/Bogota`: en UTC, a las 19:00 de Colombia ya sería mañana y esta fila se
    // etiquetaría vencida cinco horas antes de estarlo, en el turno de la tarde.
    expect((item!.vigencia as { estado: string }).estado).toBe('vigente');
  });

  it('**`verificadaEn` viaja como `null`** cuando el RUNT nunca ha respondido', async () => {
    const item = await filaDeCola(ctxAdmin, { estadoVigencia: 'no_verificado', verificadaEn: null });
    // El caso real: un comprobante cargado hoy, cuya primera corrida es a las 00:10 de mañana. El
    // bloque VIAJA —la fila está en el censo— y la fecha es null, que significa «de este SOAT no
    // consta ninguna respuesta». No se fabrica un valor para rellenarlo.
    expect(item!.vigencia).toEqual({ estado: 'no_verificado', verificadaEn: null, venceEl: null });
  });

  it('**el `cliente` no recibe el bloque**, y la clave se BORRA (no viaja con `null`)', async () => {
    const item = await filaDeCola(ctxCliente, {
      estadoVigencia: 'sin_registro', verificadaEn: new Date('2026-09-04T05:12:00Z'),
    });
    // «Sin SOAT en el RUNT» y «no se pudo consultar» son el estado de un proceso interno de FLITO:
    // a un Cliente le dirían que su póliza está en duda sin que pueda hacer nada. La clave se quita
    // entera, como el resto de `CAMPOS_SOLO_INTERNOS` — no se emite con `null`, que sería publicar
    // que el campo existe.
    expect(item).not.toHaveProperty('vigencia');
    // Control positivo del recorte: los otros campos internos también se fueron, y los suyos están.
    expect(item).not.toHaveProperty('valorPagado');
    expect(item).toHaveProperty('placa');
  });

  it('**el universo del bloque es el `EXISTS` del comprobante**, medido sobre la expresión SQL', async () => {
    // ── El hueco que este test cierra (gate B, M3) ───────────────────────────────────────────────
    //
    // Los tests de arriba afirman sobre el `vigencia` que sale del DTO, y para eso el fixture trae
    // `tieneVigencia` puesto a mano. Pero la EXPRESIÓN que decide ese booleano en producción es SQL,
    // y el mock nunca la evalúa: sirve el valor del fixture. Así que este mutante sobrevivía a los
    // 126 tests de este WI y a los 752 de los 33 specs `flito-soat*`:
    //
    //     - tieneVigencia: sql<boolean>`${EXISTS_COMPROBANTE_SOAT}`
    //     + tieneVigencia: sql<boolean>`${isNotNull(flitoSoat.verificadaEn)}`
    //
    // Y es la decisión que este Feature discutió DOS veces: `verificada_en IS NOT NULL` significa «el
    // RUNT respondió alguna vez», así que dejaría muda la fila que se intentó, falló y nunca tuvo
    // respuesta — la que hay que ver justo durante la avería. Aquí SÍ basta con la constante, porque
    // se esparce con `...PROYECCION_VIGENCIA` en las DOS lecturas (la cola y el detalle).
    const { PROYECCION_VIGENCIA } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const q = renderizar(PROYECCION_VIGENCIA.tieneVigencia);

    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('factura_soat');
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    expect(q.sql).toContain('"flito_soportes"."soat_id" = "flito_soat"."id"');
    expect(q.sql).toMatch(/^exists \(select/i);
    // Y NO el predicado que se descartó: si alguien lo vuelve a proponer, que sea con este rojo
    // delante y no en silencio.
    expect(q.sql).not.toMatch(/"flito_soat"\."verificada_en"/);
  });

  it('el bloque proyecta las TRES columnas persistidas, y ninguna más', async () => {
    const { PROYECCION_VIGENCIA } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    // El censo de la proyección. `poliza_runt` no está, y añadirla pondría esto rojo ANTES de que
    // llegue al DTO: es cuasi-PII y colisiona de nombre con `numero_poliza`, que es otro número.
    expect(Object.keys(PROYECCION_VIGENCIA).sort())
      .toEqual(['estadoVigencia', 'tieneVigencia', 'venceEl', 'verificadaEn']);
  });

  it('la póliza del RUNT **no se proyecta** hacia la cola', async () => {
    const item = await filaDeCola(ctxAdmin, {
      estadoVigencia: 'vigente', venceEl: MANANA, polizaRunt: 'RUNT777',
    });
    // El mock devuelve la fila ENTERA aunque el `select` pida menos, así que si la proyección la
    // pidiera acabaría en el DTO. No lo pide: es cuasi-PII y colisiona visualmente con
    // `numero_poliza`, que es otro número (el que el OCR sacó de la factura de FLITO).
    expect(JSON.stringify(item)).not.toContain('RUNT777');
    expect(item!.vigencia).not.toHaveProperty('polizaRunt');
  });
});

describe('regresión — el GROUP BY del filtro de vigencia', () => {
  it('no introduce huérfanos que provoquen un 42803', () => {
    const q = whereCola(ctxAdmin, { vigencia: 'vencido' });
    // `gruposHuerfanos` LANZA si no hay `GROUP BY` que analizar (su doctrina anti-verde-vacío), así
    // que aquí se afirma por texto: esta consulta no agrupa y no puede caer en el Bug #12058.
    expect(q.sql).not.toMatch(/\bgroup\s+by\b/i);
    expect(() => gruposHuerfanos(q)).toThrow(/No hay ni un GROUP BY/);
  });
});
