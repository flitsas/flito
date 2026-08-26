// FLITO comparendos — invariantes de la 0160: tipo de registro y resolución (HU #11712).
//
// La 0160 hace dos cosas que se vigilan de forma distinta:
//
//   · **DDL** —un enum, tres columnas y un CHECK— que tiene que decir lo MISMO que `schema.ts`. Es
//     la paridad de las hermanas 0151 y 0153-0156: dos copias del mismo hecho en dos lenguajes.
//   · **DML** —la v3 del `field_map`—, cuya contraparte no es el esquema sino el comportamiento del
//     módulo. Es la vigilancia que estrenó la paridad de la 0158.
//
// Estas son las mutaciones que se están cazando, todas plausibles y ninguna teórica:
//
//   · **`DEFAULT 'comparendo'` en la columna, o un `UPDATE` que rellene el histórico.** Es lo cómodo
//     y es una mentira que nadie va a corregir: las filas `inactivo` ya no las visita ningún sync
//     (CF-10), así que el default se quedaría en pantalla para siempre y el visor de la HU #11713 lo
//     pintaría como dato verificado. `NULL` = «no se sabe».
//
//   · **Podar la primera rama del CHECK** por parecer redundante, o **podar la guarda
//     `tipo_registro IS NOT NULL AND` de la segunda**. Son dos mutaciones distintas con dos daños
//     distintos, y conviene no confundirlas — están verificadas contra PostgreSQL 16, no deducidas:
//
//       - Sin la PRIMERA rama, `tipo_registro IS NOT NULL` da FALSE y el CHECK **rechaza toda fila
//         sin tipo**. No abre un hueco: cierra de más. Y como al aplicar la 0160 las tres columnas
//         acaban de nacer y TODA la tabla está en `(NULL, NULL, NULL)`, el `ADD CONSTRAINT` moriría
//         al validar («is violated by some row») y la migración no pasaría de ahí. Esa rama está
//         para **admitir el histórico**.
//       - Sin la GUARDA de la segunda rama sí hay hueco: la comparación desnuda
//         `(NULL = 'multa') = (…)` evalúa a NULL, y un CHECK que evalúa a NULL **pasa**, así que se
//         colaría justo la fila peor —sin tipo y CON número de resolución—. Con la guarda,
//         `FALSE AND NULL` es FALSE y la fila se rechaza.
//
//   · **Mapear `fechaResolucion`.** El ítem real de Medellín la trae CON valor (`2026-09-22`) y
//     `nroResolucion` en `null` a la vez: usarla como señal fabricaría multas.
//
//   · **Mapear `tipoRegistro` como `target_field`.** Haría que una fila de una tabla de TEXTO
//     decidiera el valor de una columna `enum`: `22P02` a mitad de corrida y el NIT entero perdido.
//
//   · **Sembrar una v3 PARCIAL** (solo las filas nuevas). El merge lee la versión MÁXIMA y NO hereda
//     de las anteriores: una v3 con cuatro filas dejaría al módulo sin placa, sin fecha y sin monto.
//     Por eso la cobertura de la v2 se lee del propio `.sql` de la 0158 y no de una lista de aquí.
//
//   · **Añadir cualquier ruta de persona.** Esta tabla ES la lista blanca de la poda RN-25, así que
//     nombrar aquí `infractor.*`, `nombres` o `estadoCuenta.direccion` no documenta un campo:
//     ordena que se PERSISTA. Ley 1581.
//
// Análisis estático puro: NO toca la base. Se leen de disco los dos `.sql` y de `schema.ts` los
// objetos de drizzle.
//
// ── Desviación declarada del AC2: qué NO prueba este archivo ─────────────────────────────────────
//
// El AC2 pide un test que intente INSERTAR una fila con `tipo = 'comparendo'` y número de resolución
// y que **la base** la rechace. Este archivo no puede hacerlo y no lo finge: aquí se compara TEXTO
// —que la expresión del `.sql` y la de `schema.ts` son la misma y son la esperada, con sus dos
// piezas—, y un CHECK que dice lo correcto y no llegó a aplicarse produciría exactamente la misma
// salida verde. Los tests del API no tienen base: `setup.ts` usa un `DATABASE_URL` falso y todo va
// contra un mock de drizzle, así que montar infraestructura de base para una aserción se descartó
// como desproporcionado (decisión explícita, no olvido).
//
// El invariante está cubierto en tres capas, y conviene saber cuál responde por qué:
//
//   1. **Aquí**: que la expresión escrita es la correcta, en los dos sitios que la declaran.
//   2. **`mienteLaFila` en `flito-comparendos-merge.test.ts`**: el CHECK replicado en TypeScript,
//      que demuestra que ninguna combinación de las dos fuentes y el histórico produce una fila que
//      lo viole. Prueba el CÓDIGO que escribe, no la base que rechaza.
//   3. **Verificación manual contra PostgreSQL 16.14**, en una base desechable (durante la HU y
//      repetida por el gate de db-review): la fila mentirosa muere con `23514`, el histórico entra,
//      y podar la primera rama hace fallar el propio `ADD CONSTRAINT`.
//
// Lo que ninguna de las tres cubre: que el CHECK esté REALMENTE aplicado en un ambiente. Eso lo hace
// el `db:apply`, y si faltara, la primera escritura mentirosa entraría sin ruido.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  flitoComparendosRegistros, flitoComparendosTipoRegistroEnum,
} from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: es literalmente lo
// que abortaría el `db:apply`, incluida su forma de ignorar los bloques citados con dólares —que
// aquí importa, porque este archivo tiene dos y su `BEGIN`/`END` no es control de transacción—.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

// `flito-comparendos-merge.ts` abre el cliente de base al cargarse y aquí solo se lee una constante.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { CAMPOS_CANONICOS } = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const ARCHIVO = '0160_flito_comparendos_tipo_registro.sql';
const RUTA = fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url));
const RUTA_0158 = fileURLToPath(
  new URL('../../src/db/migrations/0158_flito_comparendos_field_map_v2.sql', import.meta.url),
);

const TABLA = 'flito_comparendos_registros';
const CONSTRAINT = 'flito_comparendos_tipo_resolucion_chk';
const ENUM = 'flito_comparendos_tipo_registro';
const COLUMNAS_NUEVAS = ['tipo_registro', 'numero_resolucion', 'id_resolucion'] as const;

const sql0160 = readFileSync(RUTA, 'utf8');

/**
 * Quita los comentarios `--` sin comerse los `--` que vivan DENTRO de una cadena SQL.
 *
 * El mismo podador de las paridades de la 0154, 0156 y 0158, y por el mismo motivo: la cabecera de
 * la 0160 explica en prosa **lo que el archivo NO hace** —por qué no hay `UPDATE`, por qué
 * `fechaResolucion` se queda fuera, por qué un `DEFAULT` sería una mentira—. Sin podarla, el texto
 * que dice «no se mapea `fechaResolucion`» alimentaría la búsqueda de `fechaResolucion` y pondría
 * verde justo el test que existe para detectarlo.
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

const CUERPO = podarComentarios(sql0160);
const COMPACTO = CUERPO.replace(/\s+/g, ' ').trim();

// ─────────────────────────── Lectura de las filas sembradas ─────────────────────────────────────

interface FilaSembrada {
  version: number;
  origen: string;
  sourcePath: string;
  targetField: string;
  prioridad: number;
  provisional: boolean;
}

/**
 * Las tuplas de un `INSERT ... VALUES` de `field_map`, tal como están escritas.
 *
 * Extractor ESTRICTO a propósito, igual que el de la 0158: una tupla con forma que no se entienda
 * tiene que hacer fallar el guardarraíl de abajo, no ignorarse en silencio.
 */
function filasSembradas(sql: string): FilaSembrada[] {
  const tupla = /\(\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*,\s*(true|false)\s*,\s*(?:NULL|'(?:[^']*)')\s*\)/gi;
  const filas: FilaSembrada[] = [];
  for (const m of podarComentarios(sql).matchAll(tupla)) {
    filas.push({
      version: Number(m[1]),
      origen: m[2],
      sourcePath: m[3],
      targetField: m[4],
      prioridad: Number(m[5]),
      provisional: m[6].toLowerCase() === 'true',
    });
  }
  return filas;
}

const FILAS = filasSembradas(sql0160);
const SIMIT = FILAS.filter((f) => f.origen === 'simit');
const MUNICIPAL = FILAS.filter((f) => f.origen === 'municipal');
/** La v2, leída del `.sql` de la 0158: es la cobertura que la v3 no puede perder. */
const FILAS_V2 = filasSembradas(readFileSync(RUTA_0158, 'utf8'));

const rutasDe = (filas: FilaSembrada[]): string[] => filas.map((f) => f.sourcePath);
const prioridadDe = (filas: FilaSembrada[], ruta: string): number | undefined =>
  filas.find((f) => f.sourcePath === ruta)?.prioridad;

// ─────────────────────────── Guardarraíl: ¿los extractores leyeron algo? ────────────────────────

describe('migración 0160 — los extractores leen los archivos', () => {
  // Va primero: si los regex dejaran de casar, todas las comprobaciones de abajo pasarían por
  // vacuidad — `[].every(...)` es `true` y `expect([]).not.toContain(x)` también pasa.
  it('el .sql siembra las 41 filas de la v3 (20 SIMIT + 21 municipal)', () => {
    expect(FILAS).toHaveLength(41);
    expect(SIMIT).toHaveLength(20);
    expect(MUNICIPAL).toHaveLength(21);
  });

  it('la v2 se lee de la 0158 y trae sus 35 filas', () => {
    expect(FILAS_V2).toHaveLength(35);
  });

  it('el cuerpo sin comentarios conserva el DDL', () => {
    expect(COMPACTO).toContain('ALTER TABLE flito_comparendos_registros');
  });
});

// ─────────────────────────── El enum ────────────────────────────────────────────────────────────

describe('el tipo `flito_comparendos_tipo_registro` dice lo mismo en los dos sitios', () => {
  it('**los mismos valores y en el mismo orden** que `schema.ts`', () => {
    // El orden de un `pg_enum` es su orden de COMPARACIÓN: reordenarlo es un cambio de datos
    // disfrazado de cambio de tipo (lo mismo que documenta la 0154 para `evento_tipo`).
    const m = new RegExp(`CREATE TYPE ${ENUM} AS ENUM \\(([^)]*)\\)`, 'i').exec(COMPACTO);
    expect(m, `no se supo leer el CREATE TYPE de ${ENUM} en ${ARCHIVO}`).not.toBeNull();
    const enSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

    expect(enSql).toEqual(['comparendo', 'multa']);
    expect([...flitoComparendosTipoRegistroEnum.enumValues]).toEqual(enSql);
    expect(flitoComparendosTipoRegistroEnum.enumName).toBe(ENUM);
  });

  it('**se crea con guarda**: PostgreSQL no admite `CREATE TYPE IF NOT EXISTS`', () => {
    // Sin la guarda, la segunda pasada aborta con 42710 y deja parada la cadena en cualquier
    // ambiente que vaya por detrás.
    expect(COMPACTO).toMatch(
      new RegExp(`IF NOT EXISTS \\(\\s*SELECT 1 FROM pg_type WHERE typname = '${ENUM}'\\s*\\)`, 'i'),
    );
  });
});

// ─────────────────────────── Las tres columnas ──────────────────────────────────────────────────

describe('las tres columnas nacen NULLABLE y SIN default (la afirmación de la HU)', () => {
  /** El fragmento `ADD COLUMN` de cada columna, hasta la coma o el punto y coma que lo cierra. */
  const fragmento = (columna: string): string => {
    const m = new RegExp(`ADD COLUMN IF NOT EXISTS ${columna}([^,;]*)`, 'i').exec(COMPACTO);
    expect(m, `no se supo leer el ADD COLUMN de ${columna} en ${ARCHIVO}`).not.toBeNull();
    return m![1];
  };

  it('**ninguna declara DEFAULT ni NOT NULL** — el histórico se queda en NULL', () => {
    // El mutante principal de esta HU. Un `DEFAULT 'comparendo'` sería una afirmación sobre filas
    // que nadie ha comprobado y que nadie va a volver a visitar (CF-10).
    for (const columna of COLUMNAS_NUEVAS) {
      const decl = fragmento(columna).toUpperCase();
      expect(decl, `${columna} declara DEFAULT`).not.toContain('DEFAULT');
      expect(decl, `${columna} declara NOT NULL`).not.toContain('NOT NULL');
    }
  });

  it('**la migración no reescribe ni una fila**: ni UPDATE, ni DELETE, ni TRUNCATE', () => {
    // La otra forma de escribir la misma mentira: rellenar el histórico con un `UPDATE`.
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_REGISTROS\s+SET\b/);
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(cuerpo).not.toMatch(/\bTRUNCATE\b/);
  });

  it('`schema.ts` las declara igual: nullable, sin default y con el tipo que toca', () => {
    const columnas = getTableConfig(flitoComparendosRegistros).columns;
    for (const nombre of COLUMNAS_NUEVAS) {
      const c = columnas.find((x) => x.name === nombre);
      expect(c, `\`schema.ts\` no declara la columna ${nombre}`).toBeDefined();
      expect(c!.notNull, `${nombre} es NOT NULL en schema.ts`).toBe(false);
      expect(c!.hasDefault, `${nombre} tiene default en schema.ts`).toBe(false);
    }
    // Y los anchos, que son lo que `ANCHO` del merge recorta: si la columna encogiera sin que el
    // merge se enterara, el INSERT moriría con un 22001 y se llevaría el NIT entero.
    expect(COMPACTO).toMatch(/ADD COLUMN IF NOT EXISTS numero_resolucion varchar\(60\)/i);
    expect(COMPACTO).toMatch(/ADD COLUMN IF NOT EXISTS id_resolucion varchar\(60\)/i);
    expect(COMPACTO).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS tipo_registro ${ENUM}`, 'i'));
  });

  it('las tres llevan su `COMMENT ON COLUMN`: el porqué vive también en la base', () => {
    for (const columna of COLUMNAS_NUEVAS) {
      expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.${columna} IS`);
    }
  });

  it('no crea índices: `tipo_registro` son dos valores y el planner no lo usaría', () => {
    // Mismo razonamiento que `origen_merge` en `schema.ts`. Si algún día hiciera falta, se mide
    // primero; un índice que el planner descarta solo cuesta escrituras.
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bDROP\b/);
  });
});

// ─────────────────────────── El CHECK ───────────────────────────────────────────────────────────

/**
 * La expresión del CHECK, normalizada a algo comparable entre el `.sql` y drizzle.
 *
 * Igual que en la paridad de la 0156: se comparan sin comillas, sin el prefijo de tabla, en
 * minúsculas y sin espacios sobrantes. Lo que NO se normaliza es la forma lógica — que es
 * justamente donde vive la mutación que se caza.
 */
function normalizar(expresion: string): string {
  return expresion
    .replace(/"/g, '')
    .replace(new RegExp(`${TABLA}\\.`, 'g'), '')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .toLowerCase()
    .trim();
}

const ESPERADA = '(tipo_registro is null and numero_resolucion is null and id_resolucion is null) '
  + "or (tipo_registro is not null and (tipo_registro = 'multa') = "
  + '(numero_resolucion is not null or id_resolucion is not null))';

function expresionDelSql(): string {
  const m = new RegExp(`ADD CONSTRAINT ${CONSTRAINT} CHECK \\((.+?)\\); END IF`, 'i').exec(COMPACTO);
  // Extractor estricto: una forma que no se entienda tiene que FALLAR, no ignorarse.
  expect(m, `no se supo leer el CHECK de ${CONSTRAINT} en ${ARCHIVO}`).not.toBeNull();
  return m![1];
}

function expresionDelSchema(): string {
  const chequeos = getTableConfig(flitoComparendosRegistros).checks;
  const nuestro = chequeos.find((c) => c.name === CONSTRAINT);
  expect(nuestro, `\`schema.ts\` no declara el check ${CONSTRAINT}`).toBeDefined();
  return new PgDialect().sqlToQuery(nuestro!.value).sql;
}

describe('el CHECK impide que la fila mienta, y dice lo mismo en los dos sitios', () => {
  it('el extractor lee una expresión de cada lado', () => {
    expect(expresionDelSql().length).toBeGreaterThan(0);
    expect(expresionDelSchema().length).toBeGreaterThan(0);
  });

  it('**la expresión es la esperada en los DOS lados**, no un lado comparado con el otro', () => {
    // Contra el valor esperado: relajar la condición en los dos archivos a la vez dejaría verde
    // cualquier comparación entre copias.
    expect(normalizar(expresionDelSql())).toBe(ESPERADA);
    expect(normalizar(expresionDelSchema())).toBe(ESPERADA);
  });

  it('**las dos piezas que parecen sobrar están en los dos lados**, y hacen cosas distintas', () => {
    for (const lado of [
      { que: ARCHIVO, expresion: normalizar(expresionDelSql()) },
      { que: 'schema.ts', expresion: normalizar(expresionDelSchema()) },
    ]) {
      // (a) La rama del HISTÓRICO. No cierra ningún hueco: es la que ADMITE `(NULL, NULL, NULL)`.
      // Sin ella el CHECK rechaza toda fila sin tipo y el `ADD CONSTRAINT` de la migración muere al
      // validar, porque al aplicarla la tabla entera está así.
      expect(lado.expresion, `el CHECK de ${lado.que} perdió la rama del histórico`)
        .toContain('tipo_registro is null and numero_resolucion is null and id_resolucion is null');
      // (b) La GUARDA de la segunda rama, que es la que SÍ cierra el hueco: sin ella,
      // `(NULL = 'multa') = (…)` evalúa a NULL y un CHECK que evalúa a NULL pasa, así que se colaría
      // una fila sin tipo y con número de resolución — la que el visor de la HU #11713 no sabría
      // pintar. La comparación con `ESPERADA` ya la cubre; se afirma aparte porque es la pieza cuyo
      // porqué se documenta mal con más facilidad, y un `toContain` dice qué falta y no solo que la
      // cadena cambió.
      expect(lado.expresion, `el CHECK de ${lado.que} perdió la guarda de la segunda rama`)
        .toContain('tipo_registro is not null and');
      // (c) La disyunción: exigir los DOS campos dejaría sin promover a las multas del municipal,
      // que no manda `idResolucion`.
      expect(lado.expresion, `el CHECK de ${lado.que} exige las dos resoluciones a la vez`)
        .toContain('numero_resolucion is not null or id_resolucion is not null');
    }
  });

  it('**la expresión solo puede nombrar las tres columnas nuevas**', () => {
    // Atarla a `estado_fuente` o a `origen_merge` la convertiría en otra regla: `estado_fuente` es
    // texto crudo del proveedor y de ahí NO se puede deducir si la fila es comparendo o multa.
    for (const lado of [normalizar(expresionDelSql()), normalizar(expresionDelSchema())]) {
      for (const columna of COLUMNAS_NUEVAS) expect(lado).toContain(columna);
      expect(lado).not.toContain('estado_fuente');
      expect(lado).not.toContain('origen_merge');
      expect(lado).not.toContain('numero_comparendo');
    }
  });

  it('**lleva su guarda de idempotencia** y protege al constraint que de verdad crea', () => {
    expect(COMPACTO).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint WHERE conname = '[a-z0-9_]+'\s*\)/i);
    const guardado = /WHERE conname = '([a-z0-9_]+)'/i.exec(COMPACTO);
    expect(guardado![1]).toBe(CONSTRAINT);
  });

  it('**no añade `NOT VALID`**: las tres columnas acaban de nacer y no hay fila que pueda violarlo', () => {
    // Y el runner envuelve el archivo en UNA transacción, dentro de la cual `VALIDATE` no libera el
    // lock antes de tiempo: el patrón en dos pasos solo tiene sentido en dos migraciones (0156).
    expect(COMPACTO.toUpperCase()).not.toContain('NOT VALID');
  });
});

// ─────────────────────────── El mapa v3 ─────────────────────────────────────────────────────────

describe('la v3 re-siembra los dos orígenes enteros y no hereda de la v2', () => {
  it('**todas las filas son version=3 y provisional=false**', () => {
    expect(FILAS.every((f) => f.version === 3)).toBe(true);
    expect(FILAS.every((f) => f.provisional === false)).toBe(true);
  });

  it('**cubre TODO lo que cubría la v2**, leído de la 0158 y no de una lista escrita aquí', () => {
    // El merge lee la versión MÁXIMA y NO hereda: una v3 con solo las filas nuevas dejaría al módulo
    // sin placa, sin fecha y sin monto. Copiar la lista de la v2 a este archivo crearía una tercera
    // copia del mismo hecho y el problema volvería una casilla más allá.
    const enV3 = new Map(FILAS.map((f) => [`${f.origen}|${f.sourcePath}`, f.targetField]));
    const faltan = FILAS_V2
      .filter((f) => enV3.get(`${f.origen}|${f.sourcePath}`) !== f.targetField)
      .map((f) => `${f.origen} ${f.sourcePath} -> ${f.targetField}`);

    expect(faltan).toEqual([]);
  });

  it('**ningún `target_field` fuera de `CAMPOS_CANONICOS`**, y `tipoRegistro` NO es uno de ellos', () => {
    // `esCampoCanonico` ignora en silencio lo que no reconoce, así que una fila mal apuntada no
    // rompe nada: simplemente no homologa. Y `tipoRegistro` en el mapa sería peor que inútil —una
    // fila de texto eligiendo el valor de un `enum`, con `22P02` a mitad de corrida—.
    const canonicos = new Set<string>(CAMPOS_CANONICOS);
    for (const f of FILAS) {
      expect(canonicos.has(f.targetField), `\`${f.sourcePath}\` apunta a \`${f.targetField}\``).toBe(true);
    }
    expect(canonicos.has('tipoRegistro')).toBe(false);
    expect(FILAS.some((f) => f.targetField === 'tipoRegistro')).toBe(false);
  });

  it('los dos campos de resolución de SIMIT entran, y cada uno a SU canónico', () => {
    // `idResolucion` como candidato de `numeroResolucion` acabaría pintado en la columna «N.º
    // resolución» de la pantalla: es un identificador de sistema, no un número legible.
    const numero = SIMIT.filter((f) => f.targetField === 'numeroResolucion');
    const id = SIMIT.filter((f) => f.targetField === 'idResolucion');
    expect(rutasDe(numero)).toEqual(['numeroResolucion']);
    expect(rutasDe(id)).toEqual(['idResolucion']);
  });

  it('el municipal usa `nroResolucion` de prioridad 1, con el nombre largo de respaldo', () => {
    const resolucion = MUNICIPAL.filter((f) => f.targetField === 'numeroResolucion');
    expect(prioridadDe(resolucion, 'nroResolucion')).toBe(1);
    expect(prioridadDe(resolucion, 'numeroResolucion')).toBe(2);
  });

  it('**`fechaResolucion` NO se mapea a nada**: fabricaría multas', () => {
    // El ítem real de Medellín trae la fecha CON valor y `nroResolucion` en `null` a la vez.
    expect(rutasDe(FILAS)).not.toContain('fechaResolucion');
    expect(FILAS.some((f) => f.sourcePath.toLowerCase().includes('fecharesolucion'))).toBe(false);
  });

  it('**`idEstadoComparendo` NO se mapea**: es un `int` y pondría «3» como estado en pantalla', () => {
    expect(rutasDe(FILAS)).not.toContain('idEstadoComparendo');
  });

  it('`estadoPago` entra en la cadena de estado de los DOS orígenes, cada uno con su orden', () => {
    const simit = SIMIT.filter((f) => f.targetField === 'estadoFuente');
    const municipal = MUNICIPAL.filter((f) => f.targetField === 'estadoFuente');

    // SIMIT: delante de `estado`, que es un alias heredado de la v1 y por doctrina de la 0158 los
    // alias inertes son respaldo de ÚLTIMA prioridad. Un campo real del proveedor no va detrás.
    expect(prioridadDe(simit, 'estadoPago')).toBe(3);
    expect(prioridadDe(simit, 'estado')).toBe(4);
    expect(prioridadDe(simit, 'estadoComparendo')).toBe(1);

    // Municipal: detrás de `estado`, y la asimetría es deliberada — allí `estado` no es un alias
    // inerte, es lo que emite el mock del UTS, que es el modo POR DEFECTO.
    expect(prioridadDe(municipal, 'descripcionEstado')).toBe(1);
    expect(prioridadDe(municipal, 'estado')).toBe(2);
    expect(prioridadDe(municipal, 'estadoPago')).toBe(3);
  });

  it('cada `target_field` de cada origen tiene prioridades SIN empatar', () => {
    // Un empate hace que el candidato ganador dependa del desempate por `source_path` del ORDER BY,
    // que no es una decisión de nadie.
    for (const filas of [SIMIT, MUNICIPAL]) {
      const vistos = new Set<string>();
      for (const f of filas) {
        const llave = `${f.targetField}|${f.prioridad}`;
        expect(vistos.has(llave), `${f.origen}: ${f.targetField} repite prioridad ${f.prioridad}`).toBe(false);
        vistos.add(llave);
      }
    }
  });

  it('**ninguna ruta de persona entra en la lista blanca** (RN-25, Ley 1581)', () => {
    // Esta tabla ES la lista blanca de la poda: nombrar aquí un campo de persona no lo documenta,
    // ordena que se persista en `payload_simit` / `payload_municipal`.
    const prohibidos = [
      'infractor', 'nombres', 'apellidos', 'contraventores', 'direccion', 'identificador', 'cedula',
      'moroso', 'correo', 'telefono',
    ];
    for (const f of FILAS) {
      for (const p of prohibidos) {
        expect(
          f.sourcePath.toLowerCase(),
          `\`${f.sourcePath}\` (${f.origen}) contiene \`${p}\``,
        ).not.toContain(p);
      }
    }
  });

  it('**no toca las versiones anteriores**: la v1 y la v2 son historial', () => {
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_FIELD_MAP\s+SET\b/);
    expect(new Set(FILAS.map((f) => f.version))).toEqual(new Set([3]));
  });
});

// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0160 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    // El `BEGIN`/`END` de los dos bloques citados con dólares no lo es, y esta es la única forma de
    // afirmarlo sin reimplementar (y ablandar) el regex del runner.
    expect(scanForTxControl(ARCHIVO, sql0160)).toEqual([]);
  });

  it('**el INSERT es idempotente**: lleva su `ON CONFLICT ... DO NOTHING`', () => {
    // La cadena se re-aplica en cualquier ambiente que vaya por detrás; sin esto la segunda pasada
    // aborta con un 23505 y deja parado el `db:apply`.
    expect(COMPACTO).toMatch(/ON CONFLICT \(\s*version\s*,\s*origen\s*,\s*source_path\s*\) DO NOTHING/i);
  });

  it('las tres columnas se añaden con `IF NOT EXISTS`, que es la otra mitad de la idempotencia', () => {
    for (const columna of COLUMNAS_NUEVAS) {
      expect(COMPACTO).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${columna}\\b`, 'i'));
    }
  });
});
