// FLITO comparendos — paridad entre la 0154 y `schema.ts` / `shared-types` (HU #11556).
//
// La migración `0154_flito_comparendos_auditoria_gestion.sql` abre la zona de auditoría de la
// gestión: dos columnas nullable en `flito_comparendos_registros` y un valor nuevo en el enum
// `flito_comparendos_evento_tipo`. Ese mismo hecho está escrito TRES veces y en tres lenguajes: el
// `.sql`, que es lo que corre contra la base en `db:apply`; `schema.ts`, que es lo que lee quien
// escribe una consulta; y `packages/shared-types`, que es lo que compila el frontend. Nada, hasta
// este archivo, vigilaba que las tres dijeran lo mismo.
//
// Qué mutación se está cazando. No la obvia —quitar una columna de un lado se nota al primer test
// del módulo— sino las que dejan el esquema VÁLIDO y la promesa ROTA:
//
//   · **`ON DELETE RESTRICT` degradado a `SET NULL`.** Es el eje central. La FK sigue existiendo, la
//     base sigue arrancando, ningún test del módulo se entera... y el día que se borre un usuario,
//     las filas que gestionó pasan a decir «gestionado el 3 de marzo, por nadie». Auditoría que
//     miente en vez de auditoría que falta. Se afirma en los dos lados por separado y contra el
//     valor esperado, no uno contra otro: un `git merge` que lo cambiara en los dos archivos a la
//     vez dejaría verde cualquier comparación entre copias (ADR-0005).
//
//   · **el literal nuevo del enum usado en la misma migración que lo crea.** `ALTER TYPE ... ADD
//     VALUE` corre dentro de la transacción del runner, pero el valor NO se puede usar hasta el
//     commit: PostgreSQL 16.14 responde `55P04 unsafe use of new value` tanto a un `INSERT` como a
//     un índice parcial que lo mencione. Por eso el `ADD VALUE` va al final del bloque DDL y por
//     debajo solo quedan `COMMENT ON`. Es una regla de ORDEN dentro de un archivo: no la sostiene
//     ningún tipo, ningún linter y ningún test de servicio — la sostiene esto.
//
//   · **una columna `NOT NULL` o con `DEFAULT`.** Sería el AC5 roto en su forma más cara: datar como
//     gestionado el histórico entero, o exigir reescribir la tabla para inventarle un valor a cada
//     fila.
//
//   · **el orden del enum.** En PostgreSQL el orden de `pg_enum` ES el orden de comparación del
//     tipo. Insertar `gestion` en medio (con `BEFORE`/`AFTER`) o listarlo en otro sitio en
//     shared-types no rompe nada visible y cambia lo que significa un `ORDER BY tipo`.
//
// La 0154 no se reescribe una vez aplicada (regla del repo): si este test se pone rojo, lo que toca
// es una migración NUEVA o corregir el otro lado, según de qué lado esté el error.
//
// El test es análisis estático puro: NO toca la base. Los `.sql` y el `.ts` de shared-types se leen
// de disco, y de `schema.ts` se importan los objetos de drizzle. Copiar aquí las definiciones
// crearía una CUARTA copia y movería el problema una casilla más allá.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  flitoComparendosEventoTipoEnum,
  flitoComparendosRegistros,
} from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: así lo que este
// test comprueba es LITERALMENTE lo que abortaría el `db:apply`, incluida su forma de ignorar los
// comentarios y los bloques `$$ ... $$`. Importar `db-apply.ts` no conecta a nada — el cliente de
// postgres se abre en `main()`, y `main()` solo corre si el archivo es el entrypoint.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO_0154 = '0154_flito_comparendos_auditoria_gestion.sql';

const ruta = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));

const RUTA_0154 = ruta(`../../src/db/migrations/${ARCHIVO_0154}`);
/** La 0150 es la que CREÓ el enum: sin ella, el `.sql` solo conoce el valor que añade la 0154. */
const RUTA_0150 = ruta('../../src/db/migrations/0150_flito_comparendos_ingesta.sql');
const RUTA_SHARED = ruta('../../../../packages/shared-types/src/flito-comparendos.ts');

const TABLA = 'flito_comparendos_registros';
const ENUM = 'flito_comparendos_evento_tipo';

/** Las dos columnas que introduce la HU. Los NOMBRES y solo eso: el resto sale de los archivos. */
const COLUMNAS_HU = ['gestion_actualizada_en', 'gestion_actualizada_por'] as const;

const sql0154 = readFileSync(RUTA_0154, 'utf8');

// ─────────────────────────── Lectura del `.sql` ─────────────────────────────────────────────────

/**
 * Quita los comentarios `--` conservando los saltos de línea (los números de línea siguen valiendo
 * para los mensajes de error).
 *
 * Se hace ANTES de cualquier otra cosa y es imprescindible: la cabecera de la 0154 explica en prosa
 * por qué NO hay índices, por qué no se inserta ninguna fila y qué pasa con `SET NULL`. Sin esta
 * poda, la explicación de cómo NO es el archivo alimentaría la comprobación de cómo ES.
 *
 * Recorre el texto en vez de ir línea a línea con un `replace` porque tiene que saber cuándo está
 * DENTRO de una cadena: los cuerpos de los `COMMENT ON` son literales SQL y ahí un `--` es texto,
 * no el principio de un comentario. Un podador ingenuo se comería media frase y con ella el `;` que
 * cierra la sentencia.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (!enCadena && c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n'; // el salto se conserva: los números de línea siguen siendo los del archivo
      continue;
    }
    // `''` (la comilla escapada de SQL) se ve como cerrar y volver a abrir, que deja el estado bien.
    if (c === "'") enCadena = !enCadena;
    salida += c;
  }
  return salida;
}

/**
 * Sentencias del archivo, normalizadas a una línea.
 *
 * El separador es el `;` que está FUERA de una cadena, por lo mismo de arriba: los `COMMENT ON` de
 * la 0154 llevan punto y coma dentro de su texto, y partir por ellos convertiría media frase en una
 * «sentencia» que ninguna comprobación de forma sabría clasificar.
 */
function sentenciasDe(texto: string): string[] {
  const cuerpo = podarComentarios(texto);
  // Un `DO $$ ... $$` partiría por los `;` de dentro y este extractor devolvería trozos sin sentido.
  // La 0154 no usa ninguno; si algún día se añade, hay que enseñárselo a este archivo antes.
  expect(cuerpo, 'este extractor no sabe leer bloques $$ ... $$').not.toContain('$$');

  const trozos: string[] = [];
  let actual = '';
  let enCadena = false;
  for (const c of cuerpo) {
    if (c === "'") enCadena = !enCadena;
    if (c === ';' && !enCadena) { trozos.push(actual); actual = ''; continue; }
    actual += c;
  }
  trozos.push(actual);

  return trozos.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

const SENTENCIAS = sentenciasDe(sql0154);

type AccionFk = 'restrict' | 'cascade' | 'set null' | 'set default' | 'no action';

interface ColumnaNormalizada {
  nombre: string;
  tabla: string;
  /** Tipo ya canónico: `timestamptz`, `integer`… (los dos lados lo escriben distinto). */
  tipo: string;
  nullable: boolean;
  tieneDefault: boolean;
  fk: { tabla: string; columna: string; onDelete: AccionFk } | null;
}

/**
 * `TIMESTAMPTZ` (como lo escribe el `.sql`) y `timestamp with time zone` (como lo renderiza drizzle)
 * son el mismo tipo escrito de dos formas. Esta tabla es la traducción, y es DELIBERADAMENTE corta:
 * un tipo que no esté aquí hace fallar el test en vez de compararse como cadena suelta, que es como
 * `integer` y `bigint` pasarían por distintos y `int4` e `integer` por iguales sin que nadie lo
 * decidiera.
 */
const TIPOS: Record<string, string> = {
  timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  integer: 'integer',
  int: 'integer',
  int4: 'integer',
};

function tipoCanonico(bruto: string): string {
  const clave = bruto.replace(/\s+/g, ' ').trim().toLowerCase();
  expect(
    TIPOS[clave],
    `tipo '${bruto}' desconocido para este test. Si la HU introduce un tipo nuevo, hay que añadirlo `
    + 'a TIPOS: comparar tipos como cadena suelta daría verde a cambios que no lo son',
  ).toBeDefined();
  return TIPOS[clave];
}

/** Las columnas que el `.sql` AÑADE, leídas de sus `ALTER TABLE ... ADD COLUMN`. */
function columnasDelSql(): ColumnaNormalizada[] {
  const sentencias = SENTENCIAS.filter((s) => /^ALTER TABLE\b/i.test(s) && /\bADD COLUMN\b/i.test(s));

  return sentencias.map((s) => {
    const m = /^ALTER TABLE ([a-z0-9_]+) ADD COLUMN (?:IF NOT EXISTS )?([a-z0-9_]+) (.+)$/i.exec(s);
    // Extractor estricto a propósito: una forma que no se entienda tiene que FALLAR, no ignorarse.
    // Un extractor permisivo es peor que ninguno — da verde sobre un eje que ya no está mirando.
    expect(m, `no se supo leer el ADD COLUMN: '${s}'`).not.toBeNull();

    const resto = m![3];
    const tipoBruto = /^(.+?)(?=\s+REFERENCES\b|\s+NOT NULL\b|\s+DEFAULT\b|$)/i.exec(resto);
    expect(tipoBruto, `no se supo leer el tipo de '${m![2]}'`).not.toBeNull();

    const fk = /\bREFERENCES\s+([a-z0-9_]+)\s*\(\s*([a-z0-9_]+)\s*\)(?:\s+ON DELETE (RESTRICT|CASCADE|SET NULL|SET DEFAULT|NO ACTION))?/i
      .exec(resto);

    return {
      nombre: m![2].toLowerCase(),
      tabla: m![1].toLowerCase(),
      tipo: tipoCanonico(tipoBruto![1]),
      nullable: !/\bNOT NULL\b/i.test(resto),
      tieneDefault: /\bDEFAULT\b/i.test(resto),
      fk: fk
        ? {
          tabla: fk[1].toLowerCase(),
          columna: fk[2].toLowerCase(),
          // Sin cláusula, PostgreSQL aplica NO ACTION. Se normaliza al mismo vocabulario que
          // drizzle para que los dos lados sean comparables sin traducir en la aserción.
          onDelete: (fk[3]?.toLowerCase() ?? 'no action') as AccionFk,
        }
        : null,
    };
  });
}

// ─────────────────────────── Lectura de `schema.ts` (objetos, no texto) ─────────────────────────

/** Las mismas columnas vistas desde drizzle: objetos en memoria, no una segunda lectura de texto. */
function columnasDelSchema(): ColumnaNormalizada[] {
  const config = getTableConfig(flitoComparendosRegistros);

  // Las FK viven fuera de la columna en la API de drizzle, así que se indexan por nombre de columna.
  const fks = new Map<string, ColumnaNormalizada['fk']>();
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    // Solo interesan las de una columna; una compuesta no podría venir de un ADD COLUMN.
    if (ref.columns.length !== 1) continue;
    fks.set(ref.columns[0].name.toLowerCase(), {
      tabla: getTableConfig(ref.foreignTable as never).name.toLowerCase(),
      columna: ref.foreignColumns[0].name.toLowerCase(),
      onDelete: (fk.onDelete?.toLowerCase() ?? 'no action') as AccionFk,
    });
  }

  return config.columns
    .filter((c) => (COLUMNAS_HU as readonly string[]).includes(c.name.toLowerCase()))
    .map((c) => ({
      nombre: c.name.toLowerCase(),
      tabla: config.name.toLowerCase(),
      tipo: tipoCanonico(c.getSQLType()),
      nullable: !c.notNull,
      tieneDefault: c.hasDefault,
      fk: fks.get(c.name.toLowerCase()) ?? null,
    }));
}

// ─────────────────────────── El enum, en sus tres copias ────────────────────────────────────────

/**
 * El orden del enum según los `.sql`: los valores con los que la 0150 CREÓ el tipo, más los que la
 * 0154 le añade por el final.
 *
 * Hacen falta los dos archivos porque un `ADD VALUE` solo dice el valor nuevo: preguntarle a la 0154
 * por el enum completo daría una lista de uno, y compararla contra `pgEnum` fallaría por un motivo
 * falso. La 0150 es también quien fija el ORDEN de los tres primeros.
 */
function enumDelSql(): string[] {
  const creacion = /CREATE TYPE\s+flito_comparendos_evento_tipo\s+AS ENUM\s*\(([^)]*)\)/i
    .exec(podarComentarios(readFileSync(RUTA_0150, 'utf8')));
  expect(creacion, `no se encontró el CREATE TYPE de ${ENUM} en la 0150`).not.toBeNull();

  const iniciales = [...creacion![1].matchAll(/'([a-z0-9_]+)'/gi)].map((m) => m[1]);
  const anadidos = SENTENCIAS
    .filter((s) => new RegExp(`^ALTER TYPE ${ENUM}\\b.*\\bADD VALUE\\b`, 'i').test(s))
    .map((s) => {
      const m = /ADD VALUE (?:IF NOT EXISTS )?'([a-z0-9_]+)'/i.exec(s);
      expect(m, `no se supo leer el ADD VALUE: '${s}'`).not.toBeNull();
      // `BEFORE`/`AFTER` cambiarían la POSICIÓN del valor y este extractor asume que va al final.
      // Que falle es lo correcto: la posición es justo lo que este test vigila.
      expect(s, 'un ADD VALUE con BEFORE/AFTER reordena el enum y este test asume el final')
        .not.toMatch(/\b(BEFORE|AFTER)\b/i);
      return m![1];
    });

  return [...iniciales, ...anadidos];
}

/**
 * El enum según `packages/shared-types`, leído del CÓDIGO FUENTE.
 *
 * Es un tipo de TypeScript: no existe en tiempo de ejecución, así que o se lee el texto o se copia
 * a mano aquí — y copiarlo a mano sería crear la cuarta copia que este archivo existe para evitar.
 * El orden de la unión es el dato: es lo que se compara contra `pg_enum`.
 */
function enumDeSharedTypes(): string[] {
  const fuente = readFileSync(RUTA_SHARED, 'utf8');
  const m = /export type ComparendosEventoTipo\s*=\s*([^;]+);/.exec(fuente);
  expect(m, 'no se encontró `ComparendosEventoTipo` en packages/shared-types').not.toBeNull();
  return [...m![1].matchAll(/'([a-z0-9_]+)'/gi)].map((x) => x[1]);
}

// ─────────────────────────── Guardarraíl: ¿el extractor leyó algo? ──────────────────────────────

const delSql = columnasDelSql();
const delSchema = columnasDelSchema();
const buscar = (cols: ColumnaNormalizada[], nombre: string) => cols.find((c) => c.nombre === nombre);

describe('migración 0154 — el extractor lee el archivo (sin esto, todo lo demás pasa por vacuidad)', () => {
  // Va primero y es el test más importante del archivo: un `matchAll` que dejara de casar devolvería
  // listas vacías y TODAS las comparaciones de abajo pasarían sin comparar nada.
  it('el .sql tiene sentencias y de ellas salen exactamente las dos columnas de la HU', () => {
    expect(SENTENCIAS.length).toBeGreaterThan(0);
    expect(delSql.map((c) => c.nombre).sort()).toEqual([...COLUMNAS_HU].sort());
    expect(delSql.every((c) => c.tabla === TABLA)).toBe(true);
  });

  it('`schema.ts` declara esas mismas dos columnas', () => {
    expect(delSchema.map((c) => c.nombre).sort()).toEqual([...COLUMNAS_HU].sort());
  });

  it('las tres copias del enum se leyeron y ninguna vino vacía', () => {
    expect(enumDelSql().length).toBeGreaterThan(1);
    expect(enumDeSharedTypes().length).toBeGreaterThan(1);
    expect(flitoComparendosEventoTipoEnum.enumValues.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────── Paridad columna a columna (AC1, AC3) ───────────────────────────────

describe.each(COLUMNAS_HU)('%s — el .sql y schema.ts dicen lo mismo', (nombre) => {
  it('está declarada en los dos sitios, sobre la misma tabla', () => {
    expect(buscar(delSql, nombre), `falta en ${ARCHIVO_0154}`).toBeDefined();
    expect(buscar(delSchema, nombre), 'falta en apps/api/src/db/schema.ts').toBeDefined();
    expect(buscar(delSchema, nombre)!.tabla).toBe(buscar(delSql, nombre)!.tabla);
    expect(buscar(delSql, nombre)!.tabla).toBe(TABLA);
  });

  it('mismo nombre FÍSICO y mismo tipo', () => {
    // El nombre físico es el que compara: `gestionActualizadaEn` en el código no significa nada para
    // la base, y una columna cuyo `.name` de drizzle no sea el de la migración compila y falla en
    // producción con un `42703 column does not exist`.
    expect(buscar(delSchema, nombre)!.tipo).toBe(buscar(delSql, nombre)!.tipo);
  });

  it('**es NULLABLE y sin DEFAULT en los dos lados** (AC5: el histórico no se reescribe)', () => {
    for (const lado of [
      { que: ARCHIVO_0154, col: buscar(delSql, nombre)! },
      { que: 'schema.ts', col: buscar(delSchema, nombre)! },
    ]) {
      // Contra el valor esperado y no un lado contra el otro: un `NOT NULL` añadido a los dos
      // archivos a la vez dejaría verde cualquier comparación entre copias, y seguiría siendo la
      // reescritura de la tabla entera que el AC5 prohíbe.
      expect(lado.col.nullable, `${nombre} no es nullable en ${lado.que}`).toBe(true);
      expect(lado.col.tieneDefault, `${nombre} tiene DEFAULT en ${lado.que}`).toBe(false);
    }
  });
});

// ─────────────────────────── El eje de la mutación silenciosa (ADR-0005) ────────────────────────

describe('la FK de auditoría: ON DELETE RESTRICT en los dos lados', () => {
  it('**el .sql declara `REFERENCES users(id) ON DELETE RESTRICT`**', () => {
    const fk = buscar(delSql, 'gestion_actualizada_por')!.fk;
    expect(fk, 'la columna de autoría perdió su REFERENCES').not.toBeNull();
    expect(fk!.tabla).toBe('users');
    expect(fk!.columna).toBe('id');
    // `set null` dejaría filas que dicen «gestionado el 3 de marzo, por nadie»: la fecha sobrevive,
    // el autor desaparece y nadie se entera. `no action` significaría que la cláusula se PERDIÓ en
    // una edición (es lo que PostgreSQL aplica cuando no se escribe ninguna).
    expect(fk!.onDelete).toBe('restrict');
  });

  it('**`schema.ts` declara `onDelete: \'restrict\'`** sobre la misma tabla y columna', () => {
    const fk = buscar(delSchema, 'gestion_actualizada_por')!.fk;
    expect(fk, 'la columna de autoría perdió su `.references()` en schema.ts').not.toBeNull();
    expect(fk!.tabla).toBe('users');
    expect(fk!.columna).toBe('id');
    expect(fk!.onDelete).toBe('restrict');
  });

  it('la columna de la FECHA no tiene FK ni la necesita, en ninguno de los dos lados', () => {
    // Simétrico del anterior: una FK que apareciera donde no toca es tan sospechosa como una que
    // desaparece, y sin esta aserción `gestion_actualizada_en` no tendría ninguna sobre su forma.
    expect(buscar(delSql, 'gestion_actualizada_en')!.fk).toBeNull();
    expect(buscar(delSchema, 'gestion_actualizada_en')!.fk).toBeNull();
  });
});

// ─────────────────────────── El enum, en las tres copias (AC2, AC4) ─────────────────────────────

describe('el enum flito_comparendos_evento_tipo dice lo mismo en los tres sitios', () => {
  const esperadoSql = enumDelSql();

  it('mismos valores y en el MISMO ORDEN en el .sql y en `pgEnum`', () => {
    // Array y no set: en PostgreSQL el orden de `pg_enum` ES el orden de comparación del tipo, así
    // que reordenarlo cambia lo que significa un `ORDER BY tipo` sin romper nada visible.
    expect([...flitoComparendosEventoTipoEnum.enumValues]).toEqual(esperadoSql);
    expect(flitoComparendosEventoTipoEnum.enumName).toBe(ENUM);
  });

  it('mismos valores y en el mismo orden en `packages/shared-types`', () => {
    expect(enumDeSharedTypes()).toEqual(esperadoSql);
  });

  it('**el valor nuevo va AL FINAL** en las tres copias', () => {
    for (const lado of [
      { que: 'los .sql', valores: esperadoSql },
      { que: 'pgEnum', valores: [...flitoComparendosEventoTipoEnum.enumValues] },
      { que: 'shared-types', valores: enumDeSharedTypes() },
    ]) {
      expect(lado.valores.at(-1), `el valor nuevo no es el último en ${lado.que}`).toBe('gestion');
    }
  });

  it('la 0154 añade UN valor y con `IF NOT EXISTS`', () => {
    const addValue = SENTENCIAS.filter((s) => /\bADD VALUE\b/i.test(s));
    expect(addValue).toHaveLength(1);
    expect(addValue[0]).toMatch(/^ALTER TYPE flito_comparendos_evento_tipo ADD VALUE IF NOT EXISTS 'gestion'$/i);
  });
});

// ─────────────────────────── Invariantes del archivo (AC1, AC2, ADR-DB-001) ─────────────────────

describe('la 0154 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner (ADR-DB-001)', () => {
    // `scanForTxControl` es la función que `db:apply` ejecuta antes de aplicar el archivo: si esto
    // encontrara algo, el `db:apply` abortaría con exit 2 en el despliegue. Se importa en vez de
    // reimplementar el regex para que el test no pueda ser más laxo que el guarda de verdad.
    expect(scanForTxControl(ARCHIVO_0154, sql0154)).toEqual([]);
  });

  it('**ninguna sentencia es DML** (AC2): la migración no siembra ni un evento de gestión', () => {
    // Y no podría, aunque se quisiera: el literal recién añadido al enum no se puede USAR hasta que
    // la transacción del runner haga commit (55P04). Esto lo afirma como regla, no como accidente.
    for (const s of SENTENCIAS) {
      expect(s, `sentencia DML en la migración: '${s}'`)
        .not.toMatch(/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i);
    }
    const cuerpo = podarComentarios(sql0154);
    expect(cuerpo).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(cuerpo).not.toMatch(/\bUPDATE\s+[a-z0-9_]+\s+SET\b/i);
  });

  it('**toda sentencia lleva su guarda de idempotencia**, no solo las dos columnas', () => {
    // La migración se re-aplica entera en cualquier ambiente que vaya por detrás, y basta con que
    // UNA sentencia no sea idempotente para que la segunda pasada aborte y deje la cadena parada.
    // `COMMENT ON` es idempotente por naturaleza: fija el comentario, no lo acumula.
    for (const s of SENTENCIAS) {
      const idempotente = /\bIF NOT EXISTS\b/i.test(s) || /^COMMENT ON\b/i.test(s);
      expect(idempotente, `sentencia sin guarda de idempotencia: '${s}'`).toBe(true);
    }
  });

  it('**el ADD VALUE es la última sentencia DDL**: debajo solo puede haber COMMENT ON (55P04)', () => {
    // El valor nuevo de un enum no se puede USAR en la misma transacción que lo crea, y el runner
    // envuelve el archivo entero en una. Cualquier sentencia por debajo que lo mencionara —una fila
    // sembrada, un índice parcial, un CHECK— moriría con `55P04 unsafe use of new value`, y sería
    // una migración que falla la primera vez que corre en un ambiente limpio.
    const i = SENTENCIAS.findIndex((s) => /\bADD VALUE\b/i.test(s));
    expect(i).toBeGreaterThanOrEqual(0);
    for (const posterior of SENTENCIAS.slice(i + 1)) {
      expect(posterior, `sentencia no-COMMENT después del ADD VALUE: '${posterior}'`)
        .toMatch(/^COMMENT ON\b/i);
    }
  });

  it("**el literal 'gestion' no aparece fuera de la línea del ADD VALUE** (ni siquiera abajo)", () => {
    // El punto anterior mira la FORMA de las sentencias; este mira el literal, que es lo que
    // realmente dispara el 55P04. Los comentarios sí pueden nombrarlo —la cabecera lo explica— y por
    // eso se comprueba sobre el texto ya podado.
    const lineas = podarComentarios(sql0154).split('\n');
    const conLiteral = lineas
      .map((l, n) => ({ n: n + 1, l }))
      .filter((x) => /'gestion'/.test(x.l));

    expect(conLiteral).toHaveLength(1);
    expect(conLiteral[0].l).toMatch(/ALTER TYPE .*ADD VALUE IF NOT EXISTS 'gestion'/i);
  });

  it('**no crea ningún índice**: la decisión de la HU fue no pagar escrituras que nadie consulta', () => {
    // Ninguna consulta de hoy filtra ni ordena por la zona de gestión, y el sync reescribe
    // `ultimo_visto_en` —que está indexado— en cada fila que ve, así que ninguno de sus UPDATE puede
    // ser HOT: un índice más aquí es una escritura más por fila y por corrida, a cambio de nada.
    // Si algún día hace falta, entra por una migración nueva y con un EXPLAIN delante.
    expect(SENTENCIAS.filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s))).toEqual([]);
  });
});
