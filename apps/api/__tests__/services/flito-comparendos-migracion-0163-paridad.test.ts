// FLITO comparendos — invariantes de la 0163: la clave de negocio entre fuentes (HU #11806).
//
// La 0163 es la primera migración del módulo **sin una línea de DDL**. No crea, no altera y no borra
// ningún objeto: declara una regla en el `COMMENT` de la columna y repara lo ya persistido. Por eso
// su paridad no compara tipos ni constraints con `schema.ts` —no hay nada que comparar—, sino otras
// tres cosas, y las tres son mutaciones que alguien haría de buena fe:
//
//   · **La deriva regex código ↔ SQL.** La regla vive dos veces: en `NUMERO_FORMA_NACIONAL`
//     (`flito-comparendos-merge.ts`) y en el `UPDATE` de este `.sql`. Si se separan, el resultado no
//     es un error: es una base donde la mitad de las filas está en una grafía y la mitad en otra, y
//     el síntoma —una deuda contada dos veces— aparece semanas después y lejos de aquí. Este archivo
//     compara los dos literales contra un tercero escrito aquí, no uno contra otro: relajar la regla
//     en los dos sitios a la vez dejaría verde cualquier comparación entre copias.
//
//   · **Convertir el `UPDATE` en `DELETE`.** Es la reparación «obvia»: si la fila prefijada estorba,
//     se borra. `flito_comparendos_eventos` referencia `flito_comparendos_registros` con
//     `ON DELETE CASCADE`, así que ese borrado se llevaría por delante el TIMELINE de la fila. Eso
//     no es reparar, es perder auditoría — y en un módulo cuya razón de ser es demostrar qué se vio
//     y cuándo (Ley 1581 art. 17), es la peor pérdida posible.
//
//   · **Quitar la guarda `NOT EXISTS` del `UPDATE`.** La más plausible de las tres, porque parece
//     defensiva y no lo es: sin ella, en cuanto exista ya la fila de SIMIT con los veinte dígitos,
//     el `UPDATE` choca contra `uq_flito_comparendos_numero` con un 23505 y **para la cadena de
//     migraciones entera**. Verificado contra PostgreSQL 16 en una base desechable durante la HU, no
//     deducido: sin la guarda muere con
//     `duplicate key value violates unique constraint "uq_flito_comparendos_numero"`.
//
// Y una cuarta, de omisión: que **no aparezca un `INSERT` en `flito_comparendos_field_map`**. No hay
// v4 y no puede haberla: los `source_path` no cambian —el proveedor sigue mandando lo mismo por la
// misma ruta— y esa tabla ES la lista blanca de la poda RN-25. Sembrar una v4 aquí movería la lista
// blanca sin que nadie lo hubiera pedido.
//
// Análisis estático puro: NO toca la base. Se lee de disco el `.sql` y del módulo la constante.
//
// ── Desviación declarada: qué NO prueba este archivo ────────────────────────────────────────────
//
// Que el `UPDATE` repare de verdad. Aquí se compara TEXTO, y un `UPDATE` correcto que nunca llegó a
// aplicarse produce exactamente la misma salida verde. Los tests del API no tienen base (`setup.ts`
// usa un `DATABASE_URL` falso y todo va contra un mock de drizzle). La ejecución real —dos pasadas
// seguidas para la idempotencia, y una pasada sin la guarda para ver el 23505— se hizo a mano contra
// PostgreSQL 16 durante la HU y se repite en el gate de `db-review`.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: es literalmente lo
// que abortaría el `db:apply`, incluida su forma de ignorar los bloques citados con dólares — que
// aquí importa, porque este archivo tiene uno y su `BEGIN`/`END` no es control de transacción.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

// `flito-comparendos-merge.ts` abre el cliente de base al cargarse y aquí solo se lee una constante.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { NUMERO_FORMA_NACIONAL, numeroCanonico } =
  await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const ARCHIVO = '0163_flito_comparendos_clave_negocio_prefijo.sql';
const RUTA = fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url));

const TABLA = 'flito_comparendos_registros';
const UNICO = 'uq_flito_comparendos_numero';

/**
 * La forma, escrita AQUÍ. Es el tercer testigo: el `.sql` y el código se comparan contra esto y no
 * entre ellos, para que aflojar la regla en los dos a la vez no pase desapercibido.
 *
 * `[0-9]{20}` y no `\d{20}` a propósito: en PostgreSQL `\d` dentro de una expresión regular POSIX
 * depende de la clase de caracteres del locale, mientras que `[0-9]` son esos diez dígitos y ninguno
 * más. El día que alguien «modernice» el literal a `\d`, la regla dejaría de decir lo mismo en los
 * dos lenguajes sin cambiar una sola letra visible.
 */
const FORMA_ESPERADA_SQL = '^[A-Z]{1,2}[0-9]{20}$';
/** La misma, con el grupo que extrae la clave. Es la ÚNICA diferencia admitida entre las dos. */
const FORMA_ESPERADA_CODIGO = '^[A-Z]{1,2}([0-9]{20})$';

const sql0163 = readFileSync(RUTA, 'utf8');

/**
 * Quita los comentarios `--` sin comerse los `--` que vivan DENTRO de una cadena SQL.
 *
 * El mismo podador de las paridades de la 0154, 0156, 0158 y 0160, y aquí es MÁS necesario que en
 * ninguna: la cabecera de la 0163 explica en prosa, y con su SQL de ejemplo, exactamente lo que el
 * archivo NO hace —por qué no hay `DELETE`, por qué no fusiona, por qué no hay v4 del mapa—. Sin
 * podarla, el texto que dice «ni un DELETE» alimentaría la búsqueda de `DELETE` y pondría ROJO el
 * test que existe para lo contrario; y la consulta de medición comentada aportaría un `SELECT` que
 * nadie ejecuta.
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

const CUERPO = podarComentarios(sql0163);
const COMPACTO = CUERPO.replace(/\s+/g, ' ').trim();

// ─────────────────────────── Guardarraíl: ¿el podador dejó algo? ────────────────────────────────

describe('migración 0163 — el extractor lee el archivo', () => {
  // Va primero: si el podador se comiera el cuerpo, todos los `not.toContain` de abajo pasarían por
  // vacuidad y este archivo entero sería una mentira verde.
  it('el cuerpo sin comentarios conserva el UPDATE y el COMMENT', () => {
    expect(COMPACTO).toContain(`UPDATE ${TABLA} r`);
    expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.numero_comparendo IS`);
    expect(COMPACTO.length).toBeGreaterThan(400);
  });

  it('y **descarta la prosa**: la cabecera habla de DELETE y de la v4 sin que cuenten', () => {
    // Si esto fallara, los tests de «no hay DELETE» y «no hay v4» estarían leyendo los comentarios.
    expect(sql0163).toContain('NI UN `DELETE`');
    expect(sql0163).toContain('NO TOCA el `field_map`');
    expect(CUERPO).not.toContain('NI UN `DELETE`');
  });
});

// ─────────────────────────── La regla, en los dos lenguajes ─────────────────────────────────────

describe('la forma nacional dice lo MISMO en el .sql y en el código', () => {
  /** Los literales de expresión regular del `.sql`, tal como están escritos. */
  const literalesDelSql = (): string[] =>
    [...COMPACTO.matchAll(/~\s*'([^']+)'/g)].map((m) => m[1]);

  it('el `.sql` usa la forma esperada, y la usa en su `WHERE`', () => {
    const literales = literalesDelSql();
    // Extractor estricto: si el `~` desapareciera —por ejemplo sustituido por un `LIKE`—, esto
    // tiene que fallar, no ignorarse.
    expect(literales.length, `no se supo leer ningún literal de regex en ${ARCHIVO}`)
      .toBeGreaterThan(0);
    for (const literal of literales) expect(literal).toBe(FORMA_ESPERADA_SQL);
  });

  it('**el código declara la MISMA forma**, y la única diferencia es el grupo de captura', () => {
    expect(NUMERO_FORMA_NACIONAL.source).toBe(FORMA_ESPERADA_CODIGO);
    // Y la relación entre las dos escrituras, afirmada: quitar los paréntesis del código da el
    // literal del SQL. Es lo que impide que una de las dos se «mejore» por su cuenta.
    expect(NUMERO_FORMA_NACIONAL.source.replace(/[()]/g, '')).toBe(FORMA_ESPERADA_SQL);
  });

  it('**la forma está ANCLADA por los dos lados** en los dos lenguajes', () => {
    // Sin `^` la regla dispararía sobre un número con basura delante; sin `$`, sobre uno con basura
    // detrás. Cualquiera de las dos convierte «quitar letras» en «recortar», que es lo prohibido.
    for (const forma of [FORMA_ESPERADA_SQL, NUMERO_FORMA_NACIONAL.source]) {
      expect(forma.startsWith('^')).toBe(true);
      expect(forma.endsWith('$')).toBe(true);
    }
  });

  it('**la longitud es EXACTA**: ni `+`, ni `*`, ni un rango', () => {
    // La mutación de la HU. `^[A-Z]*[0-9]+$` pondría en verde el caso de las dos grafías reales y
    // fundiría dos deudas distintas el día que un municipio numere con otra longitud.
    for (const forma of [FORMA_ESPERADA_SQL, NUMERO_FORMA_NACIONAL.source]) {
      expect(forma).toContain('[0-9]{20}');
      expect(forma).not.toMatch(/\[0-9][*+]/);
      expect(forma).not.toMatch(/\{\d+,\d+\}$/);
    }
    // Y el comportamiento, no solo el literal: `D` + 19 y `D` + 21 salen intactos.
    expect(numeroCanonico('D9999900000012345678')).toBe('D9999900000012345678');
    expect(numeroCanonico('D999990000001234567890')).toBe('D999990000001234567890');
  });

  it('el `substring` del `.sql` extrae 20 dígitos anclados al final, no una posición', () => {
    // `substring(… from '[0-9]{20}$')` no puede recortar porque el `WHERE` ya garantizó la forma
    // entera; lo que NO puede aparecer aquí es un `right(…, 20)` o un `substr(…, n)`, que sí
    // recortarían si el `WHERE` se relajara.
    expect(COMPACTO).toMatch(/substring\(\s*r\.numero_comparendo\s+from\s+'\[0-9\]\{20\}\$'\s*\)/i);
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bRIGHT\s*\(/);
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bSUBSTR\s*\(/);
  });
});

// ─────────────────────────── La reparación: lo que hace y lo que no ─────────────────────────────

describe('el UPDATE repara sin destruir', () => {
  it('**lleva la guarda `NOT EXISTS`** contra la fila gemela', () => {
    // Sin ella el propio UPDATE muere con 23505 contra el único en cuanto exista la fila de SIMIT, y
    // se lleva por delante la cadena de migraciones. No es defensiva: es la condición de que esto
    // pueda aplicarse en un ambiente con datos.
    expect(COMPACTO).toMatch(
      new RegExp(`AND NOT EXISTS \\(\\s*SELECT 1 FROM ${TABLA} g\\s+WHERE g\\.numero_comparendo =`, 'i'),
    );
  });

  it('**ni un `DELETE`, ni un `TRUNCATE`, ni un `DROP`**: el timeline se conserva', () => {
    // `flito_comparendos_eventos` cuelga de esta tabla con ON DELETE CASCADE.
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(cuerpo).not.toMatch(/\bTRUNCATE\b/);
    expect(cuerpo).not.toMatch(/\bDROP\b/);
  });

  it('**el UPDATE solo toca dos columnas**: la clave y `updated_at`', () => {
    // Un `SET` que además tocara `causal_id`, `observacion` o `estado` estaría tomando la decisión
    // humana que esta migración se niega a tomar.
    const set = /UPDATE .*? SET (.*?) WHERE/i.exec(COMPACTO);
    expect(set, `no se supo leer el SET del UPDATE en ${ARCHIVO}`).not.toBeNull();
    const columnas = [...set![1].matchAll(/(\w+)\s*=/g)].map((m) => m[1].toLowerCase());
    expect(columnas).toEqual(['numero_comparendo', 'updated_at']);
  });

  it('el caso «existen las dos grafías» **se cuenta y se deja**, con su RAISE NOTICE', () => {
    // Fusionar dos filas exige decidir qué gestión sobrevive, y eso no lo decide una migración.
    expect(COMPACTO).toMatch(/RAISE NOTICE '0163: % fila\(s\) prefijadas CONVIVEN/i);
    expect(COMPACTO).toMatch(/GET DIAGNOSTICS \w+ = ROW_COUNT/i);
  });
});

// ─────────────────────────── Lo que la 0163 NO puede contener ───────────────────────────────────

describe('la 0163 como archivo: sin DDL, sin mapa y sin control de transacción', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    // El `BEGIN`/`END` del bloque citado con dólares no lo es, y esta es la única forma de afirmarlo
    // sin reimplementar (y ablandar) el regex del runner.
    expect(scanForTxControl(ARCHIVO, sql0163)).toEqual([]);
  });

  it('**no hay una sola línea de DDL**: la columna, el tipo y el único se quedan como están', () => {
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bALTER TABLE\b/);
    expect(cuerpo).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
    expect(cuerpo).not.toMatch(/\bCREATE\s+(TABLE|TYPE)\b/);
    expect(cuerpo).not.toMatch(/\bADD\s+CONSTRAINT\b/);
    // Y en particular el único que hace de red no se toca: si esta migración lo quitara «para que el
    // UPDATE no falle», el módulo perdería su defensa contra el duplicado.
    expect(COMPACTO).not.toContain(UNICO);
  });

  it('**no siembra una v4 del `field_map`**: los `source_path` no cambian (RN-25)', () => {
    // Esa tabla ES la lista blanca de la poda. Un INSERT aquí movería lo que se persiste en los
    // payloads sin que la HU lo haya pedido.
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bINSERT\s+INTO\s+FLITO_COMPARENDOS_FIELD_MAP\b/);
    expect(cuerpo).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_FIELD_MAP\b/);
  });

  it('el `COMMENT ON COLUMN` declara la grafía canónica y su ALCANCE (AC1/AC2)', () => {
    // Es donde los dos AC quedan escritos en el sitio que sobrevive a los refactors del código. Se
    // afirma el CONTENIDO y no solo que exista el COMMENT: un comentario que no diga cuál es la
    // grafía canónica no declara nada.
    const comment = new RegExp(`COMMENT ON COLUMN ${TABLA}.numero_comparendo IS (.*?);`, 'i')
      .exec(COMPACTO);
    expect(comment, `no se supo leer el COMMENT de numero_comparendo en ${ARCHIVO}`).not.toBeNull();
    const texto = comment![1];
    expect(texto).toContain('VEINTE DIGITOS');
    expect(texto).toContain(FORMA_ESPERADA_SQL);
    // El alcance, que es la mitad que se olvida: que la regla NO recorta y que D+19 / D+21 no
    // disparan. Sin esto, quien lea el comentario dentro de un año entenderá «quítale la letra».
    expect(texto).toContain('NO recorta');
    expect(texto).toContain('D+19');
    expect(texto).toContain('D+21');
    // Y CF-07, que es el argumento entero: sin él la regla parece una comodidad.
    expect(texto).toContain('CF-07');
  });
});
