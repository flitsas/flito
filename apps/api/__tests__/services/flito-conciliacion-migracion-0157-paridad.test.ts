// FLITO Conciliación — paridad entre la 0157 y `schema.ts` / `shared-types` (HU #11673).
//
// La migración `0157_flito_conciliacion_boletas.sql` es la capa de datos entera del Feature #11623:
// dos tablas nuevas, dos columnas en tablas existentes, un backfill y —lo que no se ve— dos CHECK
// ensanchados en los libros de bolsa. Ese mismo hecho está escrito hasta TRES veces y en tres
// lenguajes: el `.sql`, que es lo que corre en `db:apply`; `schema.ts`, que es lo que lee quien
// escribe una consulta; y `packages/shared-types`, que es lo que compila el frontend. Nada, hasta
// este archivo, vigilaba que las tres dijeran lo mismo.
//
// Qué mutaciones se están cazando. No las obvias —quitar una tabla se nota al primer test del
// módulo— sino las que dejan el esquema VÁLIDO y la promesa ROTA:
//
//   · **el índice de póliza convertido en UNIQUE.** Es una línea de diferencia y no rompe ningún
//     test de servicio. Lo que rompe es el DESPLIEGUE: el índice lo crea esta migración, y dos SOAT
//     con la póliza colisionada —una reexpedición, un `0` leído como `O`— abortan el archivo entero
//     y paran la cadena de migraciones, por un dato viejo y a deshora (ADR-0006 §8).
//
//   · **el backfill sin su `numero_poliza IS NULL`.** Sigue produciendo el mismo resultado la
//     primera vez, así que ningún ojo lo nota. Deja de ser idempotente y, peor, PISA las
//     correcciones manuales de la columna en cualquier ambiente que vaya por detrás.
//
//   · **la normalización que se separa de `normalizarPoliza()`.** El síntoma no es un error: es una
//     póliza que «no aparece» al cruzar una boleta, sin nada en ningún log.
//
//   · **uno de los dos CHECK de `origen` sin ensanchar.** `schema.ts` no los declara —son
//     invisibles desde TypeScript—, y el que falta muere con un `23514` DENTRO de la transacción
//     que mueve el dinero (HU #11677). El de tránsito es el que más fácil se olvida: conserva el
//     nombre `flito_org_mov_origen_valido` que le dejó la 0120, anterior al rename de la 0124.
//
//   · **`idx_flito_concil_linea_soat_unica` desaparecido.** Es la ÚNICA barrera de la base contra
//     conciliar el mismo SOAT en dos boletas, es decir, contra descontarlo dos veces.
//
// La 0157 no se reescribe una vez aplicada (regla del repo): si este test se pone rojo, lo que toca
// es una migración NUEVA o corregir el otro lado, según de qué lado esté el error.
//
// El test es análisis estático puro: NO toca la base. El `.sql` se lee de disco y de `schema.ts` se
// importan los objetos de drizzle. Copiar aquí las definiciones crearía una copia más y movería el
// problema una casilla.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  ConceptoBoleta,
  EstadoBoleta,
  normalizarPoliza,
  OrigenMovimientoBolsa,
  OrigenMovimientoTransito,
  polizaParaColumna,
  POLIZA_MAX_LONGITUD,
  ResultadoCruce,
} from '@operaciones/shared-types';
import {
  flitoConciliacionBoletas,
  flitoConciliacionLineas,
  flitoSoat,
  flitoSoportes,
} from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: así lo que este
// test comprueba es LITERALMENTE lo que abortaría el `db:apply`. Importar `db-apply.ts` no conecta
// a nada — el cliente de postgres se abre en `main()`, y `main()` solo corre como entrypoint.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0157_flito_conciliacion_boletas.sql';
const ruta = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));
const SQL_CRUDO = readFileSync(ruta(`../../src/db/migrations/${ARCHIVO}`), 'utf8');

// ─────────────────────────── Lectura del `.sql` ─────────────────────────────────────────────────

/**
 * Quita los comentarios `--` conservando los saltos de línea.
 *
 * Imprescindible y no cosmético: la cabecera de la 0157 explica en prosa por qué el índice de
 * póliza NO es único y qué pasaría si lo fuera. Sin esta poda, la explicación de cómo NO es el
 * archivo alimentaría la comprobación de cómo ES.
 *
 * Recorre el texto sabiendo cuándo está DENTRO de una cadena: los cuerpos de los `COMMENT ON` son
 * literales SQL y ahí un `--` es texto, no el principio de un comentario.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (!enCadena && c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    if (c === "'") enCadena = !enCadena;
    salida += c;
  }
  return salida;
}

const CUERPO = podarComentarios(SQL_CRUDO);

/**
 * El único bloque `DO` del archivo (los GRANT), apartado ANTES de trocear por `;`.
 *
 * Va aparte porque sus `;` interiores partirían las sentencias en trozos sin sentido. Que sea UNO y
 * que contenga solo GRANTs se afirma abajo: un `DO` con DDL dentro sería DDL que este extractor no
 * estaría mirando.
 */
const BLOQUES_DO = [...CUERPO.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)].map((m) => m[0]);
const CUERPO_SIN_DO = CUERPO.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');

/** Sentencias del archivo, normalizadas a una línea. El separador es el `;` fuera de cadena. */
function sentenciasDe(texto: string): string[] {
  const trozos: string[] = [];
  let actual = '';
  let enCadena = false;
  for (const c of texto) {
    if (c === "'") enCadena = !enCadena;
    if (c === ';' && !enCadena) { trozos.push(actual); actual = ''; continue; }
    actual += c;
  }
  trozos.push(actual);
  return trozos.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

const SENTENCIAS = sentenciasDe(CUERPO_SIN_DO);

type AccionFk = 'restrict' | 'cascade' | 'set null' | 'set default' | 'no action';

interface Columna {
  nombre: string;
  tipo: string;
  nullable: boolean;
  tieneDefault: boolean;
  pk: boolean;
  unica: boolean;
  fk: { tabla: string; columna: string; onDelete: AccionFk } | null;
}

/**
 * Traducción de tipos entre los dos lenguajes. DELIBERADAMENTE corta: un tipo que no esté aquí hace
 * fallar el test en vez de compararse como cadena suelta, que es como `int4` e `integer` pasarían
 * por distintos sin que nadie lo decidiera. Los parametrizados (`varchar(n)`, `numeric(p,s)`) se
 * normalizan quitando espacios, porque drizzle los renderiza `numeric(14, 2)` y el `.sql` los
 * escribe `numeric(14,2)`: es el mismo tipo.
 */
const TIPOS: Record<string, string> = {
  uuid: 'uuid',
  integer: 'integer',
  int: 'integer',
  int4: 'integer',
  text: 'text',
  date: 'date',
  timestamptz: 'timestamptz',
  'timestampwithtimezone': 'timestamptz',
};

function tipoCanonico(bruto: string): string {
  const compacto = bruto.trim().toLowerCase().replace(/\s+/g, '');
  if (/^(varchar|numeric)\(\d+(,\d+)?\)$/.test(compacto)) return compacto;
  expect(
    TIPOS[compacto],
    `tipo '${bruto}' desconocido para este test. Si la HU introduce un tipo nuevo hay que añadirlo `
    + 'a TIPOS: comparar tipos como cadena suelta daría verde a cambios que no lo son',
  ).toBeDefined();
  return TIPOS[compacto];
}

function fkDe(resto: string): Columna['fk'] {
  const m = /\bREFERENCES\s+([a-z0-9_]+)\s*\(\s*([a-z0-9_]+)\s*\)(?:\s+ON DELETE (RESTRICT|CASCADE|SET NULL|SET DEFAULT|NO ACTION))?/i
    .exec(resto);
  if (!m) return null;
  // Sin cláusula, PostgreSQL aplica NO ACTION. Se normaliza al vocabulario de drizzle para que los
  // dos lados sean comparables sin traducir en la aserción.
  return { tabla: m[1].toLowerCase(), columna: m[2].toLowerCase(), onDelete: (m[3]?.toLowerCase() ?? 'no action') as AccionFk };
}

/** Cuerpo del `CREATE TABLE` de una tabla, troceado en definiciones de primer nivel. */
function definicionesDe(tabla: string): string[] {
  const sentencia = SENTENCIAS.find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${tabla}\\b`, 'i').test(s));
  expect(sentencia, `no se encontró el CREATE TABLE de ${tabla} en ${ARCHIVO}`).toBeDefined();

  const abre = sentencia!.indexOf('(');
  const cuerpo = sentencia!.slice(abre + 1, sentencia!.lastIndexOf(')'));

  const partes: string[] = [];
  let actual = '';
  let profundidad = 0;
  let enCadena = false;
  for (const c of cuerpo) {
    if (c === "'") enCadena = !enCadena;
    if (!enCadena && c === '(') profundidad++;
    if (!enCadena && c === ')') profundidad--;
    if (!enCadena && c === ',' && profundidad === 0) { partes.push(actual); actual = ''; continue; }
    actual += c;
  }
  partes.push(actual);
  return partes.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Las columnas de una tabla según el `.sql`. Las líneas `CONSTRAINT ...` se apartan. */
function columnasDelSql(tabla: string): Columna[] {
  return definicionesDe(tabla)
    .filter((d) => !/^CONSTRAINT\b/i.test(d))
    .map((d) => {
      const m = /^([a-z0-9_]+)\s+(.+)$/i.exec(d);
      // Extractor estricto a propósito: una forma que no se entienda tiene que FALLAR, no ignorarse.
      // Un extractor permisivo es peor que ninguno — da verde sobre un eje que ya no está mirando.
      expect(m, `no se supo leer la definición de columna: '${d}'`).not.toBeNull();
      const resto = m![2];
      const tipo = /^(.+?)(?=\s+PRIMARY\b|\s+REFERENCES\b|\s+NOT NULL\b|\s+UNIQUE\b|\s+DEFAULT\b|$)/i.exec(resto);
      expect(tipo, `no se supo leer el tipo de '${m![1]}'`).not.toBeNull();
      return {
        nombre: m![1].toLowerCase(),
        tipo: tipoCanonico(tipo![1]),
        nullable: !/\bNOT NULL\b/i.test(resto) && !/\bPRIMARY KEY\b/i.test(resto),
        tieneDefault: /\bDEFAULT\b/i.test(resto),
        pk: /\bPRIMARY KEY\b/i.test(resto),
        unica: /\bUNIQUE\b/i.test(resto),
        fk: fkDe(resto),
      };
    });
}

/** Las columnas que el `.sql` AÑADE a una tabla existente, leídas de sus `ALTER TABLE ADD COLUMN`. */
function columnasAnadidasDelSql(tabla: string): Columna[] {
  return SENTENCIAS
    .filter((s) => new RegExp(`^ALTER TABLE ${tabla}\\b`, 'i').test(s) && /\bADD COLUMN\b/i.test(s))
    .map((s) => {
      const m = new RegExp(`^ALTER TABLE ${tabla} ADD COLUMN (?:IF NOT EXISTS )?([a-z0-9_]+) (.+)$`, 'i').exec(s);
      expect(m, `no se supo leer el ADD COLUMN: '${s}'`).not.toBeNull();
      const resto = m![2];
      const tipo = /^(.+?)(?=\s+REFERENCES\b|\s+NOT NULL\b|\s+DEFAULT\b|$)/i.exec(resto);
      return {
        nombre: m![1].toLowerCase(),
        tipo: tipoCanonico(tipo![1]),
        nullable: !/\bNOT NULL\b/i.test(resto),
        tieneDefault: /\bDEFAULT\b/i.test(resto),
        pk: false,
        unica: false,
        fk: fkDe(resto),
      };
    });
}

interface Indice { nombre: string; unico: boolean; tabla: string; columnas: string[]; parcial: boolean }

/** Los índices que crea el `.sql`. */
function indicesDelSql(): Indice[] {
  return SENTENCIAS
    .filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s))
    .map((s) => {
      const m = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+) ON ([a-z0-9_]+) \(([^)]*)\)(.*)$/i.exec(s);
      expect(m, `no se supo leer el CREATE INDEX: '${s}'`).not.toBeNull();
      return {
        nombre: m![2].toLowerCase(),
        unico: !!m![1],
        tabla: m![3].toLowerCase(),
        columnas: m![4].split(',').map((c) => c.trim().toLowerCase()),
        parcial: /\bWHERE\b/i.test(m![5]),
      };
    });
}

/** Los CHECK con nombre del archivo, vengan del CREATE TABLE o de un ALTER. */
function checkDe(nombre: string): string {
  const enTabla = [...definicionesDe('flito_conciliacion_boletas'), ...definicionesDe('flito_conciliacion_lineas')]
    .find((d) => new RegExp(`^CONSTRAINT ${nombre}\\b`, 'i').test(d));
  if (enTabla) return enTabla;
  const enAlter = SENTENCIAS.find((s) => new RegExp(`\\bADD CONSTRAINT ${nombre}\\b`, 'i').test(s));
  expect(enAlter, `no se encontró el CHECK ${nombre} en ${ARCHIVO}`).toBeDefined();
  return enAlter!;
}

/** Los literales de una lista `IN ('a','b',…)` de un CHECK, en su orden. */
function valoresDelCheck(nombre: string): string[] {
  return [...checkDe(nombre).matchAll(/'([a-z0-9_]+)'/gi)].map((m) => m[1]);
}

/** La EXPRESIÓN de un CHECK: lo que hay entre los paréntesis de `CHECK (…)`, sin el envoltorio. */
function cuerpoDelCheck(nombre: string): string {
  const def = checkDe(nombre);
  const i = def.search(/\bCHECK\s*\(/i);
  expect(i, `el CHECK ${nombre} no tiene cuerpo`).toBeGreaterThanOrEqual(0);
  const abre = def.indexOf('(', i);
  let profundidad = 0;
  let enCadena = false;
  let fin = -1;
  for (let j = abre; j < def.length; j++) {
    const c = def[j];
    if (c === "'") { enCadena = !enCadena; continue; }
    if (enCadena) continue;
    if (c === '(') profundidad++;
    else if (c === ')') { profundidad--; if (profundidad === 0) { fin = j; break; } }
  }
  expect(fin, `paréntesis sin cerrar en el CHECK ${nombre}`).toBeGreaterThan(abre);
  return def.slice(abre + 1, fin).trim();
}

/**
 * Deja dos expresiones comparables sin volverlas comparables de más.
 *
 * Quita el calificador de tabla y las comillas dobles que pone drizzle (`"t"."col"` → `col`),
 * normaliza espacios y baja a minúsculas **solo fuera de los literales**: pasar el literal entero a
 * minúsculas haría que `'^[A-Z0-9]{1,60}$'` y `'^[a-z0-9]{1,60}$'` —que NO son el mismo CHECK—
 * compararan iguales, que es justo el tipo de diferencia que este archivo existe para cazar.
 */
function normalizarExpr(expr: string): string {
  return expr
    .split(/('(?:[^']|'')*')/)
    .map((parte, i) => (i % 2 === 1 ? parte : parte
      .replace(/"[a-z0-9_]+"\."([a-z0-9_]+)"/gi, '$1')
      .replace(/"/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1')))
    .join('')
    .trim();
}

/**
 * Evalúa una expresión de NULABILIDAD (`col IS [NOT] NULL`, `AND`, `OR`, paréntesis) sobre una
 * valuación `columna → está en NULL`. Es lo que permite afirmar lo que un CHECK **hace** —qué
 * filas admite y cuáles rechaza— en vez de cómo está escrito: una reformulación equivalente pasa,
 * y un ensanche que abra un estado ilegal falla aunque el texto siga pareciéndose.
 */
function evaluarNulabilidad(expr: string, esNulo: Record<string, boolean>): boolean {
  const js = expr
    // Drizzle renderiza `"tabla"."columna"`; el `.sql` escribe `columna`. Se igualan antes de nada
    // para que este evaluador sirva sobre los dos lados sin traducir en cada llamada.
    .replace(/"[a-z0-9_]+"\."([a-z0-9_]+)"/gi, '$1')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z_][a-z0-9_]*) IS NOT NULL\b/gi, '(!N["$1"])')
    .replace(/\b([a-z_][a-z0-9_]*) IS NULL\b/gi, '(N["$1"])');
  const soloSintaxis = js
    .replace(/N\["[a-z0-9_]+"\]/g, '')
    .replace(/\bAND\b/gi, '&')
    .replace(/\bOR\b/gi, '|');
  // Guardarraíl: si queda cualquier cosa que no sea sintaxis conocida, el CHECK dejó de ser una
  // expresión de nulabilidad pura y este evaluador ya no lo estaría evaluando — fallar es lo
  // correcto, seguir devolviendo `true` sería dar verde sobre un eje que ya no se mira.
  expect(soloSintaxis, `expresión no traducible a nulabilidad: '${expr}'`).toMatch(/^[\s()!&|]*$/);
  const cuerpo = js.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||');
  return new Function('N', `return (${cuerpo});`)(esNulo) as boolean;
}

/** Los CHECK con nombre que el `.sql` declara DENTRO del `CREATE TABLE` de una tabla. */
function checksDelSql(tabla: string): Map<string, string> {
  const encontrados = new Map<string, string>();
  for (const d of definicionesDe(tabla)) {
    const m = /^CONSTRAINT ([a-z0-9_]+) CHECK\b/i.exec(d);
    if (!m) continue;
    encontrados.set(m[1].toLowerCase(), cuerpoDelCheck(m[1]));
  }
  return encontrados;
}

const DIALECTO = new PgDialect();

/** Los CHECK que `schema.ts` declara con `check()`, renderizados a SQL por el propio drizzle. */
function checksDelSchema(tabla: PgTable): Map<string, string> {
  return new Map(getTableConfig(tabla).checks
    .map((c) => [c.name.toLowerCase(), DIALECTO.sqlToQuery(c.value).sql]));
}

// ─────────────────────────── Lectura de `schema.ts` (objetos, no texto) ─────────────────────────

function columnasDelSchema(tabla: PgTable, soloEstas?: readonly string[]): Columna[] {
  const config = getTableConfig(tabla);

  // Las FK viven fuera de la columna en la API de drizzle: se indexan por nombre de columna.
  const fks = new Map<string, Columna['fk']>();
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length !== 1) continue; // una compuesta no podría venir de un ADD COLUMN
    fks.set(ref.columns[0].name.toLowerCase(), {
      tabla: getTableConfig(ref.foreignTable as never).name.toLowerCase(),
      columna: ref.foreignColumns[0].name.toLowerCase(),
      onDelete: (fk.onDelete?.toLowerCase() ?? 'no action') as AccionFk,
    });
  }

  return config.columns
    .filter((c) => !soloEstas || soloEstas.includes(c.name.toLowerCase()))
    .map((c) => ({
      nombre: c.name.toLowerCase(),
      tipo: tipoCanonico(c.getSQLType()),
      nullable: !c.notNull && !c.primary,
      tieneDefault: c.hasDefault,
      pk: c.primary,
      unica: c.isUnique ?? false,
      fk: fks.get(c.name.toLowerCase()) ?? null,
    }));
}

function indicesDelSchema(tabla: PgTable): Indice[] {
  const config = getTableConfig(tabla);
  return config.indexes.map((i) => ({
    nombre: i.config.name.toLowerCase(),
    unico: i.config.unique,
    tabla: config.name.toLowerCase(),
    columnas: i.config.columns.map((c) => (c as { name?: string }).name?.toLowerCase() ?? String(c)),
    parcial: !!i.config.where,
  }));
}

const porNombre = (cols: Columna[], nombre: string) => cols.find((c) => c.nombre === nombre);

// ─────────────────────────── Guardarraíl: ¿el extractor leyó algo? ──────────────────────────────

const TABLAS = [
  { sql: 'flito_conciliacion_boletas', drizzle: flitoConciliacionBoletas as PgTable },
  { sql: 'flito_conciliacion_lineas', drizzle: flitoConciliacionLineas as PgTable },
] as const;

describe('migración 0157 — el extractor lee el archivo (sin esto, todo lo demás pasa por vacuidad)', () => {
  // Va primero y es el test más importante del archivo: un regex que dejara de casar devolvería
  // listas vacías y TODAS las comparaciones de abajo pasarían sin comparar nada.
  it('el .sql tiene sentencias, dos CREATE TABLE, índices y un backfill', () => {
    expect(SENTENCIAS.length).toBeGreaterThan(15);
    expect(SENTENCIAS.filter((s) => /^CREATE TABLE\b/i.test(s))).toHaveLength(2);
    expect(indicesDelSql().length).toBeGreaterThanOrEqual(8);
    expect(SENTENCIAS.filter((s) => /^UPDATE flito_soat\b/i.test(s))).toHaveLength(1);
  });

  it('de cada tabla salen tantas columnas como declara `schema.ts`', () => {
    for (const t of TABLAS) {
      expect(columnasDelSql(t.sql).length, `columnas leídas de ${t.sql}`)
        .toBe(columnasDelSchema(t.drizzle).length);
    }
  });

  it('hay UN bloque DO y solo contiene GRANTs (nada de DDL escondido)', () => {
    expect(BLOQUES_DO).toHaveLength(1);
    // Por FORMA de sentencia y no por palabra suelta: los propios GRANT nombran UPDATE y DELETE
    // como privilegios, que no es lo mismo que ejecutarlos.
    expect(BLOQUES_DO[0]).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|SEQUENCE|TYPE|CONSTRAINT)\b/i);
    expect(BLOQUES_DO[0]).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[a-z0-9_]+\s+SET)\b/i);
    expect(BLOQUES_DO[0]).toMatch(/GRANT/);
  });
});

// ─────────────────────────── Paridad columna a columna (AC1) ────────────────────────────────────

describe.each(TABLAS)('$sql — el .sql y schema.ts declaran la misma tabla', ({ sql, drizzle }) => {
  const delSql = columnasDelSql(sql);
  const delSchema = columnasDelSchema(drizzle);

  it('mismo nombre físico de tabla y mismas columnas', () => {
    // El nombre físico es el que compara: una columna cuyo `.name` de drizzle no sea el de la
    // migración compila y falla en producción con un `42703 column does not exist`.
    expect(getTableConfig(drizzle).name).toBe(sql);
    expect(delSchema.map((c) => c.nombre).sort()).toEqual(delSql.map((c) => c.nombre).sort());
  });

  it.each(columnasDelSql(sql).map((c) => c.nombre))('%s — mismo tipo, nulabilidad, default, PK y UNIQUE', (nombre) => {
    const a = porNombre(delSql, nombre)!;
    const b = porNombre(delSchema, nombre);
    expect(b, `${nombre} falta en schema.ts`).toBeDefined();
    expect(b!.tipo).toBe(a.tipo);
    expect(b!.nullable).toBe(a.nullable);
    expect(b!.tieneDefault).toBe(a.tieneDefault);
    expect(b!.pk).toBe(a.pk);
    expect(b!.unica).toBe(a.unica);
  });

  it.each(columnasDelSql(sql).filter((c) => c.fk).map((c) => c.nombre))('%s — misma FK y mismo ON DELETE', (nombre) => {
    expect(porNombre(delSchema, nombre)!.fk).toEqual(porNombre(delSql, nombre)!.fk);
  });

  it('mismos índices, con la misma unicidad, las mismas columnas y la misma parcialidad', () => {
    const orden = (i: Indice[]) => [...i].sort((x, y) => x.nombre.localeCompare(y.nombre));
    expect(orden(indicesDelSchema(drizzle)))
      .toEqual(orden(indicesDelSql().filter((i) => i.tabla === sql)));
  });
});

// ─────────────────────────── Las dos columnas añadidas a tablas vivas (AC1, AC2) ────────────────

describe('las columnas que la 0157 añade a tablas que ya existían', () => {
  it('**flito_soat.numero_poliza: varchar(60) NULL, sin default, sin FK**, en los dos lados', () => {
    const delSql = porNombre(columnasAnadidasDelSql('flito_soat'), 'numero_poliza');
    const delSchema = porNombre(columnasDelSchema(flitoSoat as PgTable, ['numero_poliza']), 'numero_poliza');
    for (const lado of [{ que: ARCHIVO, col: delSql }, { que: 'schema.ts', col: delSchema }]) {
      expect(lado.col, `numero_poliza falta en ${lado.que}`).toBeDefined();
      // Contra el valor esperado y no un lado contra el otro: un NOT NULL puesto en los dos archivos
      // a la vez dejaría verde cualquier comparación entre copias, y seguiría siendo una columna que
      // no se puede añadir a una tabla con filas sin inventarles un valor.
      expect(lado.col!.tipo, `tipo en ${lado.que}`).toBe(`varchar(${POLIZA_MAX_LONGITUD})`);
      expect(lado.col!.nullable, `nulabilidad en ${lado.que}`).toBe(true);
      expect(lado.col!.tieneDefault, `default en ${lado.que}`).toBe(false);
      expect(lado.col!.fk, `FK en ${lado.que}`).toBeNull();
    }
  });

  it('**flito_soportes.conciliacion_boleta_id: uuid NULL con FK CASCADE a la boleta**, en los dos lados', () => {
    const esperada = { tabla: 'flito_conciliacion_boletas', columna: 'id', onDelete: 'cascade' };
    const delSql = porNombre(columnasAnadidasDelSql('flito_soportes'), 'conciliacion_boleta_id');
    const delSchema = porNombre(columnasDelSchema(flitoSoportes as PgTable, ['conciliacion_boleta_id']), 'conciliacion_boleta_id');
    for (const lado of [{ que: ARCHIVO, col: delSql }, { que: 'schema.ts', col: delSchema }]) {
      expect(lado.col, `conciliacion_boleta_id falta en ${lado.que}`).toBeDefined();
      expect(lado.col!.tipo, `tipo en ${lado.que}`).toBe('uuid');
      expect(lado.col!.nullable, `nulabilidad en ${lado.que}`).toBe(true);
      // La quinta FK del patrón soat/impuesto/derecho/factura: el soporte no sobrevive a su dueño.
      expect(lado.col!.fk, `FK en ${lado.que}`).toEqual(esperada);
    }
  });

  it('los dos índices que acompañan a esas columnas están en el .sql y en `schema.ts`', () => {
    const enSql = indicesDelSql();
    const poliza = enSql.find((i) => i.nombre === 'idx_flito_soat_numero_poliza');
    const boletaTipo = enSql.find((i) => i.nombre === 'idx_flito_soportes_boleta_tipo');

    // **El de póliza NO puede ser único** (ADR-0006 §8): lo crea esta migración, y un duplicado
    // heredado —una reexpedición, un `0` leído como `O`— abortaría la cadena de migraciones en el
    // despliegue. El duplicado se resuelve en el cruce, delante de quien puede arreglarlo.
    expect(poliza, 'falta el índice de póliza').toBeDefined();
    expect(poliza!.unico, 'el índice de póliza NO puede ser único').toBe(false);
    expect(poliza!.parcial, 'el índice de póliza es parcial: los SOAT pendientes no tienen').toBe(true);

    expect(boletaTipo?.unico, 'un solo comprobante vivo de cada tipo por boleta').toBe(true);
    expect(boletaTipo?.parcial, 'parcial: solo los soportes no descartados').toBe(true);

    for (const nombre of ['idx_flito_soat_numero_poliza', 'idx_flito_soportes_boleta_tipo']) {
      const tabla = nombre.includes('soat') ? flitoSoat : flitoSoportes;
      const enSchema = indicesDelSchema(tabla as PgTable).find((i) => i.nombre === nombre);
      expect(enSchema, `${nombre} falta en schema.ts`).toBeDefined();
      expect(enSchema).toEqual(enSql.find((i) => i.nombre === nombre));
    }
  });
});

// ─────────────────────────── Vocabularios: el CHECK y el tipo dicen lo mismo (AC5, AC6) ─────────

describe('los CHECK de valor y sus tipos en shared-types', () => {
  it.each([
    // ResultadoCruce ya no vive en la 0157: Bug #11773 lo ensanchó en la 0162. Igualarlo aquí
    // al CHECK congelado volvería a romper en cuanto se añada un desenlace.
    ['flito_concil_boleta_estado_chk', Object.values(EstadoBoleta), 'EstadoBoleta'],
    ['flito_concil_boleta_concepto_chk', Object.values(ConceptoBoleta), 'ConceptoBoleta'],
  ])('%s enumera exactamente los valores de %s', (constraint, valores) => {
    // Conjuntos y no arrays: el orden de un `IN (...)` no significa nada en PostgreSQL (a diferencia
    // del orden de un enum, que sí es el orden de comparación).
    expect(new Set(valoresDelCheck(constraint as string))).toEqual(new Set(valores as string[]));
  });

  it('el CHECK congelado de 0157 NO admite cobrado_otro_cliente (eso es la 0162)', () => {
    const del0157 = new Set(valoresDelCheck('flito_concil_linea_resultado_chk'));
    expect(del0157.has('cobrado_otro_cliente')).toBe(false);
    expect(del0157).toEqual(new Set([
      'ok', 'no_encontrada', 'no_pagado', 'valor_distinto', 'poliza_duplicada',
      'otra_compania', 'ya_conciliada',
    ]));
    expect(new Set(Object.values(ResultadoCruce))).not.toEqual(del0157);
    expect(Object.values(ResultadoCruce)).toContain('cobrado_otro_cliente');
  });

  it('**el estado de la boleta admite `descartada`** además de cargada y conciliada', () => {
    // No lo usa ningún endpoint todavía (llega con la HU de la carga), y aun así va desde ya: es lo
    // que libera el hash del archivo para rehacer una boleta mal cargada sin renombrar el .xlsx, y
    // añadirlo después costaría otra migración sobre una columna con CHECK.
    expect(valoresDelCheck('flito_concil_boleta_estado_chk')).toContain('descartada');
  });

  it('**los DOS CHECK de origen quedan ensanchados con `conciliacion`** (AC6)', () => {
    // Esto es lo que `schema.ts` NO sabe: las dos columnas son varchar(20) y el esquema de drizzle
    // nunca conoció sus CHECK. Sin este par de aserciones, el único aviso de que falta uno sería un
    // 23514 dentro de la transacción que mueve dinero.
    expect(new Set(valoresDelCheck('flito_bolsa_mov_origen_valido')))
      .toEqual(new Set(Object.values(OrigenMovimientoBolsa)));
    expect(new Set(valoresDelCheck('flito_org_mov_origen_valido')))
      .toEqual(new Set(Object.values(OrigenMovimientoTransito)));
    expect(Object.values(OrigenMovimientoBolsa)).toContain('conciliacion');
    expect(Object.values(OrigenMovimientoTransito)).toContain('conciliacion');
  });

  it('el CHECK de tránsito se ensancha por su nombre VIEJO, el que sobrevivió al rename de la 0124', () => {
    // La 0124 renombró flito_organismo_movimientos → flito_bolsa_transito_movimientos pero NO la
    // restricción. Buscarla por el nombre «lógico» no encontraría nada y el DROP ... IF EXISTS se
    // saltaría en silencio, dejando el CHECK viejo en pie y el ADD fallando por duplicado... o peor,
    // creando un segundo CHECK que sí rechaza 'conciliacion'.
    const alter = SENTENCIAS.filter((s) => /^ALTER TABLE flito_bolsa_transito_movimientos\b/i.test(s));
    expect(alter).toHaveLength(2); // el DROP IF EXISTS y el ADD
    for (const s of alter) expect(s).toMatch(/flito_org_mov_origen_valido/);
  });
});

// ─────────────────────────── El backfill (AC3) ──────────────────────────────────────────────────

describe('el backfill de la póliza', () => {
  const UPDATE = SENTENCIAS.find((s) => /^UPDATE flito_soat\b/i.test(s))!;

  it('**lleva su `numero_poliza IS NULL`**: sin él deja de ser idempotente y pisa correcciones', () => {
    // Es la diferencia entre «la segunda pasada no cambia una fila» y «la segunda pasada revierte a
    // lo que dijo el OCR cualquier número corregido a mano». Las dos producen el mismo resultado la
    // primera vez, que es justo por lo que nadie lo nota al revisar el diff.
    expect(UPDATE).toMatch(/WHERE numero_poliza IS NULL/i);
  });

  it('lee la póliza de `extraccion->numeroPoliza->>valor` y exige que exista', () => {
    expect(UPDATE).toMatch(/extraccion->'numeroPoliza'->>'valor' IS NOT NULL/);
  });

  it("**normaliza igual que `normalizarPoliza()`**: mismo filtro y el `upper` POR FUERA", () => {
    // El orden importa y no es estilo: `upper()` primero convertiría 'ß' en 'SS' en JavaScript
    // (`'ß'.toUpperCase()`), letra que PostgreSQL habría tirado. Filtrando primero solo sobreviven
    // ASCII, y sobre ASCII las dos implementaciones coinciden siempre.
    expect(UPDATE).toMatch(/upper\(regexp_replace\(extraccion->'numeroPoliza'->>'valor', '\[\^A-Za-z0-9\]', '', 'g'\)\)/);
    expect(normalizarPoliza('ß')).toBe('');
  });

  it(`descarta lo ilegible con el mismo guarda que \`polizaParaColumna\` (1..${POLIZA_MAX_LONGITUD})`, () => {
    // Los dos extremos importan: la cadena vacía cruzaría con cualquier otra fila vacía, y un
    // párrafo entero leído por el OCR sería un 22001 en mitad de la transacción del pago.
    expect(UPDATE).toMatch(new RegExp(`BETWEEN 1 AND ${POLIZA_MAX_LONGITUD}`, 'i'));
    expect(polizaParaColumna('')).toBeNull();
    expect(polizaParaColumna('   ')).toBeNull();
    expect(polizaParaColumna('X'.repeat(POLIZA_MAX_LONGITUD + 1))).toBeNull();
    expect(polizaParaColumna('X'.repeat(POLIZA_MAX_LONGITUD))).toHaveLength(POLIZA_MAX_LONGITUD);
  });

  it('el CHECK de formato de la columna afirma lo que el backfill produce, y va DESPUÉS de él', () => {
    // Si el CHECK se colocara antes del UPDATE daría igual (el UPDATE lo cumple), pero si alguien
    // aflojara el backfill sin tocar el CHECK, la migración fallaría en el ambiente que tuviera el
    // dato malo. Van en este orden para que la que falle sea la fila, no el archivo.
    const iUpdate = SENTENCIAS.indexOf(UPDATE);
    const iCheck = SENTENCIAS.findIndex((s) => /ADD CONSTRAINT flito_soat_numero_poliza_norm_chk/i.test(s));
    expect(iCheck).toBeGreaterThan(iUpdate);
    expect(SENTENCIAS[iCheck]).toMatch(new RegExp(`\\^\\[A-Z0-9\\]\\{1,${POLIZA_MAX_LONGITUD}\\}\\$`));
  });

  it('la normalización, caso a caso — los mismos valores que devolvió PostgreSQL', () => {
    // Verificado contra la base local corriendo el UPDATE de la 0157 sobre SOAT sembrados con estas
    // extracciones (HU #11673): la columna quedó exactamente con estos valores. Si alguien cambia
    // `normalizarPoliza`, esta tabla es lo que dice que el SQL ya no opina lo mismo.
    const casos: [string | null, string | null][] = [
      ['  1234-5678 ', '12345678'],
      ['abc0O1', 'ABC0O1'],
      ['Póliza 12', 'PLIZA12'],
      ['   ', null],
      [null, null],
      ['X'.repeat(70), null],
      ['FLIT-999', 'FLIT999'],
      ['flit 999', 'FLIT999'],
    ];
    for (const [entrada, esperado] of casos) {
      expect(polizaParaColumna(entrada), `entrada ${JSON.stringify(entrada)}`).toBe(esperado);
    }
  });
});

// ─────────────────────────── Lo que protege el dinero (ADR-0006 §2.5) ───────────────────────────

describe('las restricciones de las que depende que no se descuente dos veces', () => {
  it('**idx_flito_concil_linea_soat_unica**: un SOAT se concilia como mucho una vez, y es PARCIAL', () => {
    const i = indicesDelSql().find((x) => x.nombre === 'idx_flito_concil_linea_soat_unica');
    expect(i, 'sin este índice, dos boletas pueden conciliar el mismo SOAT').toBeDefined();
    expect(i!.unico).toBe(true);
    expect(i!.columnas).toEqual(['soat_id']);
    // Parcial sobre `conciliada_en IS NOT NULL`: sin el WHERE, un SOAT no podría ni siquiera
    // APARECER en dos boletas cargadas a la vez, que es un estado legítimo mientras nadie concilie.
    expect(i!.parcial).toBe(true);
  });

  it('**la póliza no se repite dentro de una boleta**: dos filas iguales son el mismo pago dos veces', () => {
    const i = indicesDelSql().find((x) => x.nombre === 'idx_flito_concil_linea_poliza');
    expect(i?.unico).toBe(true);
    expect(i!.columnas).toEqual(['boleta_id', 'numero_poliza_norm']);
  });

  it('el sello de la línea exige SOAT y resultado ok', () => {
    // Es lo que hace que borrar un SOAT ya conciliado falle (el `SET NULL` de la FK chocaría con
    // este CHECK) en vez de dejar una línea que dice «se descontó por un SOAT que ya no está».
    // Lo que el MOVIMIENTO exige tiene bloque propio más abajo, evaluado caso a caso.
    expect(checkDe('flito_concil_linea_sello_chk'))
      .toMatch(/conciliada_en IS NULL OR \(soat_id IS NOT NULL AND resultado = 'ok'\)/i);
  });

  it('el sello de la BOLETA es una sola cosa: o los tres campos o ninguno', () => {
    const chk = checkDe('flito_concil_boleta_sello_chk');
    expect(chk).toMatch(/conciliada_en IS NULL\) = \(conciliada_por_id IS NULL/i);
    expect(chk).toMatch(/conciliada_en IS NULL\) = \(conciliada_por_nombre IS NULL/i);
  });

  it('las dos FK de autoría de la boleta son RESTRICT (ADR-0005)', () => {
    // `set null` dejaría boletas que dicen «esto lo concilió nadie»: auditoría que miente en vez de
    // auditoría que falta, sobre un acto que movió dinero de un tercero.
    const delSql = columnasDelSql('flito_conciliacion_boletas');
    const delSchema = columnasDelSchema(flitoConciliacionBoletas as PgTable);
    for (const nombre of ['cargada_por_id', 'conciliada_por_id']) {
      for (const lado of [{ que: ARCHIVO, cols: delSql }, { que: 'schema.ts', cols: delSchema }]) {
        expect(porNombre(lado.cols, nombre)!.fk, `${nombre} en ${lado.que}`)
          .toEqual({ tabla: 'users', columna: 'id', onDelete: 'restrict' });
      }
    }
  });
});

// ─────────────── `flito_concil_linea_mov_chk`: qué ADMITE, no cómo está escrito ────────────────

/**
 * Las ocho combinaciones de «tiene valor / está en NULL» de las tres columnas que el CHECK mira.
 *
 * `true` = la columna LLEVA valor. La regla del dominio, dicha sin mirar el texto del CHECK: **una
 * línea que ya movió dinero en cualquiera de los dos libros tiene que estar sellada**. El sello sin
 * movimientos sí es legal: los tres campos se escriben en la misma transacción y el orden dentro de
 * ella no es asunto de la base.
 */
const CASOS_MOV: Array<{ bolsa: boolean; transito: boolean; sellada: boolean; admitida: boolean; que: string }> = [
  { bolsa: false, transito: false, sellada: false, admitida: true, que: 'línea cargada, sin conciliar' },
  { bolsa: false, transito: false, sellada: true, admitida: true, que: 'sellada, los asientos vienen en la misma tx' },
  { bolsa: true, transito: true, sellada: true, admitida: true, que: 'conciliada con sus dos asientos' },
  { bolsa: true, transito: false, sellada: true, admitida: true, que: 'conciliada; ninguna bolsa de tránsito cubría el par' },
  { bolsa: false, transito: true, sellada: true, admitida: true, que: 'conciliada; el asiento del cliente fue duplicado' },
  { bolsa: true, transito: false, sellada: false, admitida: false, que: 'salida del libro del cliente SIN sello' },
  // ESTE es el que la formulación original dejaba pasar, y es una vía de doble cobro:
  // `operaciones_app` tiene UPDATE sobre la tabla, así que un `SET conciliada_en = NULL` sobre una
  // línea ya conciliada era un estado legal mientras el movimiento del cliente estuviera en NULL.
  // Des-sellada, la línea sale del índice PARCIAL `idx_flito_concil_linea_soat_unica` y el mismo
  // SOAT vuelve a poder conciliarse en otra boleta — con el dinero de tránsito ya descontado y sin
  // contramovimiento que lo devuelva.
  { bolsa: false, transito: true, sellada: false, admitida: false, que: 'salida de TRÁNSITO sin sello (CF-04)' },
  { bolsa: true, transito: true, sellada: false, admitida: false, que: 'los dos asientos sin sello' },
];

const valuacionMov = (c: { bolsa: boolean; transito: boolean; sellada: boolean }) => ({
  movimiento_bolsa_id: !c.bolsa,
  movimiento_transito_id: !c.transito,
  conciliada_en: !c.sellada,
});

describe('flito_concil_linea_mov_chk — el CHECK evaluado, no leído', () => {
  const delSql = cuerpoDelCheck('flito_concil_linea_mov_chk');
  const delSchema = checksDelSchema(flitoConciliacionLineas as PgTable).get('flito_concil_linea_mov_chk');

  it('`schema.ts` también lo declara (si no, esto mediría un solo lado)', () => {
    expect(delSchema, 'flito_concil_linea_mov_chk falta en schema.ts').toBeDefined();
  });

  it.each(CASOS_MOV)('$que → admitida=$admitida, en los dos lados', (caso) => {
    const v = valuacionMov(caso);
    expect(evaluarNulabilidad(delSql, v), `${ARCHIVO}: ${caso.que}`).toBe(caso.admitida);
    expect(evaluarNulabilidad(delSchema!, v), `schema.ts: ${caso.que}`).toBe(caso.admitida);
  });

  it('la formulación ANTERIOR admitía el estado que abre el doble cobro — por eso se cambió', () => {
    // Se deja escrita para que el día que alguien «simplifique» el CHECK a esto sepa qué está
    // reabriendo. No es un test del archivo: es la contraprueba del caso de arriba.
    const anterior = 'movimiento_bolsa_id IS NULL OR conciliada_en IS NOT NULL';
    const desSellada = valuacionMov({ bolsa: false, transito: true, sellada: false });
    expect(evaluarNulabilidad(anterior, desSellada)).toBe(true);
    expect(evaluarNulabilidad(delSql, desSellada)).toBe(false);
  });
});

// ───────────────── «Uno y solo uno» en flito_soportes, ensanchado a la quinta FK ────────────────

describe('flito_soportes_factura_excluyente_chk — la 0157 lo ensancha a la columna nueva', () => {
  const COLUMNAS = ['soat_id', 'impuesto_id', 'derecho_id', 'siigo_factura_id', 'conciliacion_boleta_id'] as const;
  const delSql = cuerpoDelCheck('flito_soportes_factura_excluyente_chk');
  const delSchema = checksDelSchema(flitoSoportes as PgTable).get('flito_soportes_factura_excluyente_chk');

  it('se re-declara con la pareja DROP + ADD, y DESPUÉS del ADD COLUMN', () => {
    // PostgreSQL no admite modificar un CHECK en sitio ni un `ADD CONSTRAINT IF NOT EXISTS`: la
    // idempotencia es por composición. Y un CHECK no puede nombrar una columna que aún no existe.
    const alter = SENTENCIAS.filter((s) => /flito_soportes_factura_excluyente_chk/i.test(s));
    expect(alter).toHaveLength(2);
    expect(alter[0]).toMatch(/^ALTER TABLE flito_soportes DROP CONSTRAINT IF EXISTS\b/i);
    expect(alter[1]).toMatch(/^ALTER TABLE flito_soportes ADD CONSTRAINT\b/i);
    const iColumna = SENTENCIAS.findIndex((s) => /^ALTER TABLE flito_soportes ADD COLUMN/i.test(s));
    expect(iColumna).toBeGreaterThanOrEqual(0);
    expect(SENTENCIAS.indexOf(alter[1])).toBeGreaterThan(iColumna);
  });

  it('`schema.ts` lo declara igual que el `.sql`', () => {
    expect(delSchema, 'falta en schema.ts').toBeDefined();
    expect(normalizarExpr(delSchema!)).toBe(normalizarExpr(delSql));
  });

  // Las 32 combinaciones de las cinco FK. La regla se escribe aquí en su forma de dominio, sin
  // mirar el texto del CHECK: la factura y la boleta se excluyen de TODO lo demás (y entre sí); las
  // tres viejas siguen sin excluirse entre ellas, que es como las dejó la 0139 y que esta migración
  // no viene a cambiar.
  const combinaciones = [...Array(2 ** COLUMNAS.length).keys()].map((n) => Object.fromEntries(
    COLUMNAS.map((c, i) => [c, ((n >> i) & 1) === 1]),
  ) as Record<(typeof COLUMNAS)[number], boolean>);

  it.each(combinaciones.map((c) => [COLUMNAS.filter((k) => c[k]).join(' + ') || '(ninguna)', c] as const))(
    'con %s puesta(s), el CHECK dice lo que dice la regla',
    (_nombre, tiene) => {
      const conFactura = tiene.siigo_factura_id;
      const conBoleta = tiene.conciliacion_boleta_id;
      const conViejas = tiene.soat_id || tiene.impuesto_id || tiene.derecho_id;
      const esperado = !((conBoleta && (conFactura || conViejas)) || (conFactura && conViejas));

      const esNulo = Object.fromEntries(COLUMNAS.map((c) => [c, !tiene[c]]));
      expect(evaluarNulabilidad(delSql, esNulo), ARCHIVO).toBe(esperado);
      expect(evaluarNulabilidad(delSchema!, esNulo), 'schema.ts').toBe(esperado);
    },
  );

  it('el estado concreto que este ensanche cierra: factura Y boleta a la vez', () => {
    // Con las dos puestas, el soporte contaba como comprobante vivo en los DOS índices parciales y
    // —las dos FK son CASCADE— borrar la factura se llevaba por delante el comprobante PSE de una
    // boleta ya conciliada. Lo cerrado es eso, no una simetría de estilo.
    const ambas = Object.fromEntries(COLUMNAS.map((c) => [
      c, c !== 'siigo_factura_id' && c !== 'conciliacion_boleta_id',
    ]));
    expect(evaluarNulabilidad(delSql, ambas)).toBe(false);
  });
});

// ─────────────────── Paridad de los CHECK: el `.sql` y `schema.ts`, uno a uno ───────────────────

// Los CHECK de las dos tablas nuevas son INLINE dentro de un `CREATE TABLE IF NOT EXISTS`, así que
// —a diferencia de los `ADD CONSTRAINT` del archivo— NO se auto-reparan: si la tabla ya existiera
// sin ellos, la migración se saltaría el CREATE entero y la tabla se quedaría permanentemente sin
// restricciones, en silencio. Declararlos también en `schema.ts` (precedente:
// `flito_comparendos_gestion_auditoria_chk`, 0156) es lo que hace que se vean; ESTE bloque es lo que
// impide que los dos sitios vuelvan a separarse.
describe.each(TABLAS)('$sql — los mismos CHECK en el .sql y en schema.ts', ({ sql, drizzle }) => {
  const delSql = checksDelSql(sql);
  const delSchema = checksDelSchema(drizzle);

  it('los mismos nombres, sin sobras por ningún lado', () => {
    expect(delSql.size, `el extractor no leyó ningún CHECK de ${sql}`).toBeGreaterThan(0);
    expect([...delSchema.keys()].sort()).toEqual([...delSql.keys()].sort());
  });

  it.each(
    [...checksDelSql(sql).keys()].filter((n) => n !== 'flito_concil_linea_resultado_chk'),
  )('%s — la misma expresión', (nombre) => {
    expect(delSchema.get(nombre), `${nombre} falta en schema.ts`).toBeDefined();
    expect(normalizarExpr(delSchema.get(nombre)!)).toBe(normalizarExpr(delSql.get(nombre)!));
  });

  it('flito_concil_linea_resultado_chk de 0157 queda congelado: el octavo valor vive en schema.ts vía 0162', () => {
    if (sql !== 'flito_conciliacion_lineas') return;
    expect(delSql.get('flito_concil_linea_resultado_chk')).not.toMatch(/cobrado_otro_cliente/);
    expect(delSchema.get('flito_concil_linea_resultado_chk')).toMatch(/cobrado_otro_cliente/);
  });
});
// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0157 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner (ADR-DB-001)', () => {
    // `scanForTxControl` es la función que `db:apply` ejecuta antes de aplicar el archivo: si esto
    // encontrara algo, el `db:apply` abortaría con exit 2 en el despliegue. Se importa en vez de
    // reimplementar el regex para que el test no pueda ser más laxo que el guarda de verdad.
    expect(scanForTxControl(ARCHIVO, SQL_CRUDO)).toEqual([]);
  });

  it('**ningún comentario escribe el par de dólares** (lección de la 0156)', () => {
    // El guarda tapa los bloques citados con dólares ANTES de quitar los comentarios, así que un par
    // suelto dentro de un `--` empareja con el que abre el bloque de GRANTs, deja su BEGIN a la
    // intemperie y aborta un `db:apply` por una migración que está bien.
    const comentarios = SQL_CRUDO.split('\n').filter((l) => l.trim().startsWith('--'));
    for (const l of comentarios) expect(l, `comentario con $$: '${l}'`).not.toContain('$$');
  });

  it('**toda sentencia lleva su guarda de idempotencia**', () => {
    // La migración se re-aplica entera en cualquier ambiente que vaya por detrás, y basta con que
    // UNA sentencia no sea idempotente para que la segunda pasada aborte y pare la cadena. Los
    // `ADD CONSTRAINT` no admiten `IF NOT EXISTS`: su idempotencia es por composición, con el
    // `DROP CONSTRAINT IF EXISTS` que va justo antes.
    const constraintsSoltados = new Set(
      SENTENCIAS.flatMap((s) => [...s.matchAll(/DROP CONSTRAINT IF EXISTS ([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase())),
    );
    for (const s of SENTENCIAS) {
      const add = /\bADD CONSTRAINT ([a-z0-9_]+)/i.exec(s);
      const idempotente = /\bIF NOT EXISTS\b/i.test(s)
        || /^COMMENT ON\b/i.test(s)
        || /\bDROP CONSTRAINT IF EXISTS\b/i.test(s)
        || (!!add && constraintsSoltados.has(add[1].toLowerCase()))
        || /^UPDATE flito_soat\b/i.test(s); // idempotente por su `numero_poliza IS NULL` (arriba)
      expect(idempotente, `sentencia sin guarda de idempotencia: '${s}'`).toBe(true);
    }
  });

  it('**el único DML es el backfill**: la migración no siembra ni una boleta', () => {
    for (const s of SENTENCIAS) {
      if (/^UPDATE flito_soat\b/i.test(s)) continue;
      expect(s, `sentencia DML en la migración: '${s}'`)
        .not.toMatch(/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i);
    }
  });

  it('no concede DELETE sobre las boletas: descartar una boleta es un UPDATE de estado', () => {
    // Una boleta conciliada es un documento contable. Las LÍNEAS sí lo llevan, porque descartar una
    // boleta todavía 'cargada' borra sus filas.
    const grants = BLOQUES_DO[0];
    expect(grants).toMatch(/GRANT SELECT, INSERT, UPDATE\s+ON flito_conciliacion_boletas/);
    expect(grants).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON flito_conciliacion_lineas/);
    expect(grants).toMatch(/GRANT USAGE, SELECT ON SEQUENCE flito_conciliacion_boleta_seq/);
  });

  it('la secuencia de la referencia se crea ANTES de la tabla que la usa por defecto', () => {
    const iSeq = SENTENCIAS.findIndex((s) => /^CREATE SEQUENCE IF NOT EXISTS flito_conciliacion_boleta_seq$/i.test(s));
    const iTabla = SENTENCIAS.findIndex((s) => /^CREATE TABLE IF NOT EXISTS flito_conciliacion_boletas\b/i.test(s));
    expect(iSeq).toBeGreaterThanOrEqual(0);
    expect(iSeq).toBeLessThan(iTabla);
  });
});
