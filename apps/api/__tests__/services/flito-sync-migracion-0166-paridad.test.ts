// FLITO Sync — paridad entre la 0166 y `schema.ts` / el guardián del adaptador (HU #11906).
//
// La migración `0166_flito_vehiculo_datos_flit.sql` es la capa de datos entera de la HU: tres
// columnas en `vehicles` y nada más. Ese mismo hecho está escrito TRES veces y en tres lenguajes:
// el `.sql`, que es lo que corre en `db:apply`; `schema.ts`, que es lo que lee quien escribe una
// consulta; y `MAX_DATOS_VEHICULO` en `flit-http.adapter.ts`, que es el ancho que el adaptador cree
// que tienen esas columnas. Nada, hasta este archivo, vigilaba que los tres dijeran lo mismo.
//
// Qué mutaciones se están cazando. No las obvias —borrar una columna se nota al primer test del
// módulo— sino las que dejan el esquema VÁLIDO y la promesa ROTA:
//
//   · **`cilindraje` convertido en `integer`.** Compila, pasa los tests de mapeo (drizzle acepta el
//     string y PostgreSQL lo castea) y destruye dos cosas en silencio: el `0` que este repo ya usa
//     con el significado «vehículo eléctrico» (`vehicles/ocr.routes.ts`) deja de distinguirse del
//     cero «no se sabe», y un `"1.598"` futuro aterriza como `1`.
//
//   · **el guardián de longitud separado de su columna.** `MAX_DATOS_VEHICULO` es una tripleta de
//     números en otro archivo: subir el ancho en el `.sql` sin subirlo ahí desperdicia columna en
//     silencio, y BAJARLO en el `.sql` sin bajarlo ahí devuelve el `22001` dentro de la transacción
//     del trámite, que es justo lo que el guardián existe para evitar.
//
//   · **el backfill «de paso» desde `flit_raw`.** El AC3 pide explícitamente que NO lo haya: el
//     histórico se completa en el próximo sync. Un `UPDATE vehicles ... FROM flito_tramites` dejaría
//     el AC3 verde por accidente, sin que la ruta del sync —que es lo que la HU entrega— funcione, y
//     escribiría valores tan viejos como la última foto guardada del trámite.
//
//   · **un `NOT NULL DEFAULT ''` en cualquiera de las tres.** Inventa un tercer valor para «no sé» y
//     obliga a escribir en las 6.422 filas de `vehicles` que ya existen.
//
// La 0166 no se reescribe una vez aplicada (regla del repo): si este test se pone rojo, lo que toca
// es una migración NUEVA o corregir el otro lado, según de qué lado esté el error.
//
// El test es análisis estático puro: NO toca la base. El `.sql` se lee de disco y de `schema.ts` se
// importan los objetos de drizzle. Copiar aquí las definiciones crearía una copia más y movería el
// problema una casilla.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { vehicles } from '../../src/db/schema.js';
import { MAX_DATOS_VEHICULO } from '../../src/modules/flito-sync/flit-http.adapter.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: así lo que este
// test comprueba es LITERALMENTE lo que abortaría el `db:apply`. Importar `db-apply.ts` no conecta
// a nada — el cliente de postgres se abre en `main()`, y `main()` solo corre como entrypoint.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0166_flito_vehiculo_datos_flit.sql';
const ruta = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));
const SQL_CRUDO = readFileSync(ruta(`../../src/db/migrations/${ARCHIVO}`), 'utf8');

// ─────────────────────────── Lectura del `.sql` ─────────────────────────────────────────────────

/**
 * Quita los comentarios `--` conservando los saltos de línea.
 *
 * Imprescindible y no cosmético: la cabecera de la 0166 explica en prosa por qué NO hay backfill y
 * por qué `cilindraje` no es `integer`. Sin esta poda, la explicación de cómo NO es el archivo
 * alimentaría la comprobación de cómo ES — y la aserción estrella («no hay ningún UPDATE vehicles»)
 * fallaría por una frase de la documentación.
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

const SENTENCIAS = sentenciasDe(CUERPO);

/**
 * Lo que la migración EJECUTA, sin los `COMMENT ON`.
 *
 * Los `COMMENT ON` de este archivo explican en prosa —dentro de un literal SQL, que `podarComentarios`
 * conserva a propósito— que NO hay backfill desde `flit_raw` y por qué. Buscar «flit_raw» sobre el
 * cuerpo entero encontraría esa explicación y daría por incumplido justo lo que se está cumpliendo.
 * Un backfill de verdad sería una sentencia ejecutable, así que es aquí donde hay que buscarlo.
 */
const EJECUTABLE = SENTENCIAS.filter((s) => !/^COMMENT ON\b/i.test(s)).join(';\n');

interface Columna {
  nombre: string;
  tipo: string;
  nullable: boolean;
  tieneDefault: boolean;
  unica: boolean;
}

/**
 * Traducción de tipos entre los dos lenguajes. DELIBERADAMENTE corta: un tipo que no esté aquí hace
 * fallar el test en vez de compararse como cadena suelta, que es como `int4` e `integer` pasarían
 * por distintos sin que nadie lo decidiera. `varchar(n)` se normaliza quitando espacios y bajando a
 * minúsculas, porque el `.sql` escribe `VARCHAR(10)` y drizzle renderiza `varchar(10)`.
 */
const TIPOS: Record<string, string> = {
  integer: 'integer',
  int: 'integer',
  int4: 'integer',
  text: 'text',
};

function tipoCanonico(bruto: string): string {
  const compacto = bruto.trim().toLowerCase().replace(/\s+/g, '');
  if (/^varchar\(\d+\)$/.test(compacto)) return compacto;
  expect(
    TIPOS[compacto],
    `tipo '${bruto}' desconocido para este test. Si la HU introduce un tipo nuevo hay que añadirlo `
    + 'a TIPOS: comparar tipos como cadena suelta daría verde a cambios que no lo son',
  ).toBeDefined();
  return TIPOS[compacto];
}

/** Las columnas que el `.sql` AÑADE a una tabla existente, leídas de sus `ALTER TABLE ADD COLUMN`. */
function columnasAnadidasDelSql(tabla: string): Columna[] {
  return SENTENCIAS
    .filter((s) => new RegExp(`^ALTER TABLE ${tabla}\\b`, 'i').test(s) && /\bADD COLUMN\b/i.test(s))
    .map((s) => {
      const m = new RegExp(`^ALTER TABLE ${tabla} ADD COLUMN (?:IF NOT EXISTS )?([a-z0-9_]+) (.+)$`, 'i').exec(s);
      // Extractor estricto a propósito: una forma que no se entienda tiene que FALLAR, no ignorarse.
      // Un extractor permisivo es peor que ninguno — da verde sobre un eje que ya no está mirando.
      expect(m, `no se supo leer el ADD COLUMN: '${s}'`).not.toBeNull();
      const resto = m![2];
      const tipo = /^(.+?)(?=\s+REFERENCES\b|\s+NOT NULL\b|\s+UNIQUE\b|\s+DEFAULT\b|$)/i.exec(resto);
      expect(tipo, `no se supo leer el tipo de '${m![1]}'`).not.toBeNull();
      return {
        nombre: m![1].toLowerCase(),
        tipo: tipoCanonico(tipo![1]),
        nullable: !/\bNOT NULL\b/i.test(resto),
        tieneDefault: /\bDEFAULT\b/i.test(resto),
        unica: /\bUNIQUE\b/i.test(resto),
      };
    });
}

// ─────────────────────────── Lectura de `schema.ts` (objetos, no texto) ─────────────────────────

function columnasDelSchema(tabla: PgTable, soloEstas: readonly string[]): Columna[] {
  return getTableConfig(tabla).columns
    .filter((c) => soloEstas.includes(c.name.toLowerCase()))
    .map((c) => ({
      nombre: c.name.toLowerCase(),
      tipo: tipoCanonico(c.getSQLType()),
      nullable: !c.notNull && !c.primary,
      tieneDefault: c.hasDefault,
      unica: c.isUnique ?? false,
    }));
}

const porNombre = (cols: Columna[], nombre: string) => cols.find((c) => c.nombre === nombre);

/**
 * Las tres columnas y el ancho que cada una DEBE tener, escrito aquí como valor esperado y no como
 * «lo que diga el otro lado».
 *
 * Es la diferencia entre comparar dos copias y comprobar una decisión: un `integer` puesto a la vez
 * en el `.sql` y en `schema.ts` dejaría verde cualquier comparación entre copias, y seguiría siendo
 * la columna que no distingue el cero eléctrico del cero desconocido.
 *
 * Los anchos son 2–3× el máximo MEDIDO contra el reporte real el 2026-08-27 (2733 items):
 * cilindraje 5, carrocería 23, tipo de servicio 10.
 */
const COLUMNAS = [
  { sql: 'cilindraje', drizzle: 'cilindraje', ancho: 10, medido: 5 },
  { sql: 'carroceria', drizzle: 'carroceria', ancho: 60, medido: 23 },
  { sql: 'tipo_servicio', drizzle: 'tipoServicio', ancho: 30, medido: 10 },
] as const;

const NOMBRES_SQL = COLUMNAS.map((c) => c.sql);

// ─────────────────────────── Guardarraíl: ¿el extractor leyó algo? ──────────────────────────────

describe('migración 0166 — el extractor lee el archivo (sin esto, todo lo demás pasa por vacuidad)', () => {
  // Va primero y es el test más importante del archivo: un regex que dejara de casar devolvería
  // listas vacías y TODAS las comparaciones de abajo pasarían sin comparar nada.
  it('el .sql tiene sentencias y de ellas salen exactamente tres ADD COLUMN sobre `vehicles`', () => {
    expect(SENTENCIAS.length).toBeGreaterThanOrEqual(6);
    expect(columnasAnadidasDelSql('vehicles').map((c) => c.nombre).sort())
      .toEqual([...NOMBRES_SQL].sort());
  });

  it('cada columna lleva su COMMENT ON, que es donde vive el porqué', () => {
    // Sin el comentario, el razonamiento de «texto y no entero» solo existiría en el diff de un PR.
    for (const c of COLUMNAS) {
      expect(
        SENTENCIAS.some((s) => new RegExp(`^COMMENT ON COLUMN vehicles\\.${c.sql}\\b`, 'i').test(s)),
        `falta el COMMENT ON COLUMN vehicles.${c.sql}`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────── Paridad columna a columna (AC1) ────────────────────────────────────

describe('las tres columnas que la 0166 añade a `vehicles`', () => {
  const delSql = columnasAnadidasDelSql('vehicles');
  const delSchema = columnasDelSchema(vehicles as PgTable, NOMBRES_SQL);

  it.each([...COLUMNAS])('$sql — varchar($ancho) NULL, sin default y sin UNIQUE, en los DOS lados', (c) => {
    for (const lado of [
      { que: ARCHIVO, col: porNombre(delSql, c.sql) },
      { que: 'schema.ts', col: porNombre(delSchema, c.sql) },
    ]) {
      expect(lado.col, `${c.sql} falta en ${lado.que}`).toBeDefined();
      // **Texto, no entero.** Es la aserción que mata el mutante `varchar`→`integer`: `cilindraje`
      // trae "220" y "1598" como cadena, y este repo ya usa el 0 con significado propio.
      expect(lado.col!.tipo, `tipo en ${lado.que}`).toBe(`varchar(${c.ancho})`);
      // Nullable y sin default: NULL = «FLIT no lo trajo». `NOT NULL DEFAULT ''` sería un tercer
      // valor para lo mismo y habría que inventárselo a los vehículos que ya existen.
      expect(lado.col!.nullable, `nulabilidad en ${lado.que}`).toBe(true);
      expect(lado.col!.tieneDefault, `default en ${lado.que}`).toBe(false);
      expect(lado.col!.unica, `UNIQUE en ${lado.que}`).toBe(false);
    }
  });

  it('el nombre FÍSICO de la columna es el que dice el `.sql` (no el de la propiedad de drizzle)', () => {
    // `tipoServicio` → `tipo_servicio`. Una propiedad cuyo `.name` no fuera el de la migración
    // compila y falla en producción con un `42703 column does not exist`.
    const fisicos = getTableConfig(vehicles as PgTable).columns.map((col) => col.name);
    for (const c of COLUMNAS) expect(fisicos, `${c.drizzle} → ${c.sql}`).toContain(c.sql);
  });

  it('van sobre `vehicles` y no sobre `flito_soat` — es lo que hace alcanzable el AC3', () => {
    // `resolverSoat()` sale sin actualizar campos cuando el SOAT ya existe, y solo corre para
    // trámites `Asignado` con organismo emparejado. En `flito_soat`, un SOAT sincronizado antes de
    // esta HU no se completaría NUNCA. `upsertVehiculo()` corre para todos y en cada corrida.
    expect(SENTENCIAS.filter((s) => /^ALTER TABLE\b/i.test(s)).every((s) => /^ALTER TABLE vehicles\b/i.test(s)))
      .toBe(true);
    expect(SQL_CRUDO).not.toMatch(/ALTER TABLE flito_soat\b/i);
  });

  it('los anchos declarados son holgados respecto de lo MEDIDO, no ajustados', () => {
    // El margen no es generosidad: un valor más largo que la columna es un `22001` dentro de la
    // transacción de ese trámite, que lo deja fuera del sync en esa corrida y en las siguientes.
    for (const c of COLUMNAS) expect(c.ancho, `${c.sql}`).toBeGreaterThanOrEqual(2 * c.medido);
  });
});

// ─────────────────── El guardián del adaptador conoce el ancho REAL de su columna ───────────────

describe('MAX_DATOS_VEHICULO — el guardián de `flit-http.adapter.ts` y la columna, el mismo número', () => {
  it('los tres topes coinciden con el `varchar(n)` que declara la 0166', () => {
    // Si el guardián creyera que caben más caracteres de los que caben, dejaría pasar el valor y el
    // `22001` volvería; si creyera que caben menos, tiraría datos buenos a `null` en silencio.
    for (const c of COLUMNAS) {
      expect(MAX_DATOS_VEHICULO[c.drizzle], `${c.drizzle} en el adaptador`).toBe(c.ancho);
    }
  });

  it('y con el que declara `schema.ts` (los tres archivos, no dos)', () => {
    const cols = getTableConfig(vehicles as PgTable).columns;
    for (const c of COLUMNAS) {
      expect(cols.find((col) => col.name === c.sql)!.getSQLType())
        .toBe(`varchar(${MAX_DATOS_VEHICULO[c.drizzle]})`);
    }
  });

  it('el guardián no tiene topes de más ni de menos: exactamente estas tres claves', () => {
    expect(Object.keys(MAX_DATOS_VEHICULO).sort()).toEqual(COLUMNAS.map((c) => c.drizzle).sort());
  });
});

// ─────────────────────────── SIN backfill (AC3, y es la aserción estrella) ──────────────────────

describe('la 0166 NO rellena el histórico — el AC3 lo pide así, explícitamente', () => {
  it('**el archivo no contiene ni un `UPDATE vehicles`**', () => {
    // Ésta es la que caza «aprovechemos y hacemos backfill desde el `flit_raw`». Ese UPDATE existe
    // técnicamente (los tres campos están en el raw de los trámites ya ingeridos) y dejaría el AC3
    // verde POR ACCIDENTE: las filas tendrían valor sin que la ruta del sync —que es lo que la HU
    // entrega— hubiera corrido nunca. Y los valores serían tan viejos como la última foto guardada
    // del trámite, sin forma de distinguirlos de los frescos.
    expect(EJECUTABLE, 'la 0166 no puede escribir sobre vehicles').not.toMatch(/\bUPDATE\s+vehicles\b/i);
  });

  it('no hay NINGÚN DML en el archivo: ni INSERT, ni UPDATE, ni DELETE, ni COPY', () => {
    for (const s of SENTENCIAS) {
      expect(s, `sentencia DML en la migración: '${s}'`)
        .not.toMatch(/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i);
    }
    // Y tampoco escondido detrás de un CTE o de un `WITH ... UPDATE`.
    expect(EJECUTABLE).not.toMatch(/\bWITH\b/i);
  });

  it('no lee `flito_tramites` ni su `flit_raw` — que es de donde saldría el backfill tentador', () => {
    expect(EJECUTABLE).not.toMatch(/flito_tramites/i);
    expect(EJECUTABLE).not.toMatch(/flit_raw/i);
  });
});

// ─────────────────────────── SIN índices, y es decisión (no olvido) ─────────────────────────────

describe('la 0166 no crea índices', () => {
  it('ninguna sentencia es un CREATE INDEX ni un DROP INDEX', () => {
    // Ninguna consulta filtra ni ordena por estas columnas: salen por el `innerJoin(vehicles)` que
    // la cola ya hacía. `tipo_servicio` tiene cardinalidad 2. Y `vehicles` recibe un UPDATE por
    // trámite y por corrida, así que cada índice de más es escritura pagada en cada sync.
    for (const s of SENTENCIAS) expect(s).not.toMatch(/^CREATE\s+(UNIQUE\s+)?INDEX\b/i);
    for (const s of SENTENCIAS) expect(s).not.toMatch(/^DROP\s+INDEX\b/i);
  });

  it('tampoco un enum ni un CHECK para `tipo_servicio`, aunque hoy solo tenga dos valores', () => {
    // Un tercer valor que FLIT decida mandar abortaría la transacción de ese trámite con `22P02` y
    // lo dejaría sin sincronizar para siempre, con el único rastro en un `log.error`. El precio de
    // aceptarlo es una palabra rara en la cola; el de rechazarlo, un trámite que desaparece.
    expect(EJECUTABLE).not.toMatch(/CREATE\s+TYPE\b/i);
    expect(EJECUTABLE).not.toMatch(/ADD\s+CONSTRAINT\b/i);
    expect(EJECUTABLE).not.toMatch(/\bCHECK\s*\(/i);
  });
});

// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0166 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner (ADR-DB-001)', () => {
    // `scanForTxControl` es la función que `db:apply` ejecuta antes de aplicar el archivo: si esto
    // encontrara algo, el `db:apply` abortaría con exit 2 en el despliegue. Se importa en vez de
    // reimplementar el regex para que el test no pueda ser más laxo que el guarda de verdad.
    expect(scanForTxControl(ARCHIVO, SQL_CRUDO)).toEqual([]);
  });

  it('**ningún comentario escribe el par de dólares** (lección de la 0156)', () => {
    // El guarda tapa los bloques citados con dólares ANTES de quitar los comentarios, así que un par
    // suelto dentro de un `--` empareja con el que abriría un bloque y deja su BEGIN a la intemperie.
    for (const l of SQL_CRUDO.split('\n').filter((x) => x.trim().startsWith('--'))) {
      expect(l, `comentario con $$: '${l}'`).not.toContain('$$');
    }
  });

  it('**toda sentencia lleva su guarda de idempotencia**: la segunda pasada no cambia nada', () => {
    // La migración se re-aplica entera en cualquier ambiente que vaya por detrás, y basta con que
    // UNA sentencia no sea idempotente para que la segunda pasada aborte y pare la cadena. Aquí es
    // fácil porque solo hay dos formas: `ADD COLUMN IF NOT EXISTS` y `COMMENT ON`, que reescribe.
    for (const s of SENTENCIAS) {
      const idempotente = /\bADD COLUMN IF NOT EXISTS\b/i.test(s) || /^COMMENT ON\b/i.test(s);
      expect(idempotente, `sentencia sin guarda de idempotencia: '${s}'`).toBe(true);
    }
  });

  it('el número de archivo es único en la carpeta de migraciones', () => {
    // Dos `0166_` distintas en dos ramas se mergean sin conflicto y la cadena aplica una sola.
    // El repo ya tiene el precedente: conviven `0004`/`0004a` y DOS `0121_`. El runner ordena
    // alfabéticamente y no detecta la colisión, así que la comprobación tiene que LEER el
    // directorio; que la cabecera se nombre a sí misma es otro eje y va aparte.
    const prefijo = ARCHIVO.slice(0, 5); // '0166_'
    const homonimas = readdirSync(ruta('../../src/db/migrations'))
      .filter((f) => f.startsWith(prefijo) && f.endsWith('.sql'));
    expect(homonimas, `más de una migración con el prefijo ${prefijo}: ${homonimas.join(', ')}`)
      .toEqual([ARCHIVO]);
  });

  it('la cabecera del archivo se nombra a sí misma', () => {
    // Un copia-pega de plantilla que olvida renombrar la cabecera deja la migración mintiendo
    // sobre su propio número, que es el dato con el que se rastrea un despliegue.
    expect(SQL_CRUDO.startsWith(`-- ${ARCHIVO}`), 'la cabecera nombra a su propio archivo').toBe(true);
  });
});
