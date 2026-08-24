// FLITO comparendos — invariantes de la 0163: la clave de negocio entre fuentes (HU #11806).
//
// La 0163 es la primera migración del módulo **sin una línea de DDL**. No crea, no altera y no borra
// ningún objeto: declara una regla en el `COMMENT` de la columna y repara lo ya persistido. Por eso
// su paridad no compara tipos ni constraints con `schema.ts` —no hay nada que comparar—, sino otras
// cuatro cosas, y las cuatro son mutaciones que alguien haría de buena fe:
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
//   · **Quitar el `row_number()` del `UPDATE` creyendo que el `NOT EXISTS` ya cubre el duplicado.**
//     La más sutil, y la que se le escapó a la primera versión de esta HU: son DOS huecos distintos.
//     El `NOT EXISTS` tapa la colisión contra una fila que YA ESTÁ en la tabla; no tapa la colisión
//     de la sentencia **consigo misma**, porque en PostgreSQL la calificación de un `UPDATE` —sus
//     subconsultas incluidas— se evalúa contra el snapshot del INICIO de la sentencia, y una
//     sentencia no ve las versiones de fila que ella misma está escribiendo. Con `D05001…201` y
//     `DD05001…201` presentes y la fila de veinte AUSENTE, las dos pasan el `~` (el `{1,2}` admite
//     una letra y dos), las dos pasan el `NOT EXISTS` y las dos aterrizan en la misma clave.
//     Reproducido contra PostgreSQL 16 con `ROLLBACK` durante el retrabajo, no deducido:
//     `duplicate key value violates unique constraint "uq_flito_comparendos_numero"`, con
//     `DETAIL: Key (numero_comparendo)=(05001000000054652201) already exists`.
//
//     Y lo que lo convierte de nota en bloqueante: la consulta de medición previa de la cabecera
//     clasificaba ese par como `reparables = 2, conflicto = 0`. El operador que siga la instrucción
//     de la propia migración —medir antes de aplicar— leía «seguro» y se llevaba el 23505 en el paso
//     de migración del CD. Por eso aquí se exige TAMBIÉN el bucket que lo hace visible.
//
// Y una quinta, de omisión: que **no aparezca un `INSERT` en `flito_comparendos_field_map`**. No hay
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

/**
 * El complemento del podador: SOLO las líneas de comentario. Es donde vive la medición previa —la
 * consulta que el operador copia y ejecuta ANTES de aplicar en un ambiente con datos—, y por eso hay
 * que afirmarla ahí y no en el cuerpo: una migración correcta cuya medición previa miente sobre el
 * riesgo es exactamente el fallo que este archivo existe para impedir.
 */
const CABECERA = sql0163
  .split('\n')
  .filter((linea) => linea.trimStart().startsWith('--'))
  .map((linea) => linea.replace(/^\s*--\s?/, ''))
  .join('\n')
  .replace(/\s+/g, ' ');

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

  it('**una sola fila origen por clave destino**: el `row_number()` que el `NOT EXISTS` NO sustituye', () => {
    // Son dos huecos distintos y hacen falta las dos defensas. El `NOT EXISTS` mira el snapshot del
    // inicio de la sentencia, así que es ciego a las filas hermanas que el propio `UPDATE` reescribe:
    // `D05001…201` y `DD05001…201`, sin la fila de veinte, pasan las dos el `~` y las dos la guarda,
    // y colisionan entre ellas. Medido, no deducido (ver cabecera de este archivo).
    expect(COMPACTO).toMatch(/row_number\(\s*\)\s*OVER\s*\(/i);
    // Particionado por la CLAVE DESTINO, que es lo único que hace que el desempate signifique algo:
    // un `PARTITION BY` por cualquier otra cosa —el municipio, el nit— dejaría dos filas en el mismo
    // grupo destino y el 23505 volvería.
    expect(COMPACTO).toMatch(
      /PARTITION BY substring\(\s*r\.numero_comparendo\s+from\s+'\[0-9\]\{20\}\$'\s*\)/i,
    );
    // Y con un orden TOTAL: `primera_visto_en` sola empata —dos filas sembradas en el mismo sync lo
    // hacen— y ahí cuál sobrevive lo decidiría el plan de ejecución, que es no decidirlo.
    expect(COMPACTO).toMatch(/ORDER BY r\.primera_visto_en,\s*r\.id/i);
    // El filtro, que es donde el `row_number()` deja de ser decoración: calcularlo y no filtrarlo
    // pone verde cualquier búsqueda del literal y revienta igual en ejecución.
    expect(COMPACTO).toMatch(/\brn\s*=\s*1\b/i);
    // Y la guarda SIGUE ahí: la corrección se suma a la anterior, no la reemplaza.
    expect(COMPACTO).toMatch(
      new RegExp(`AND NOT EXISTS \\(\\s*SELECT 1 FROM ${TABLA} g`, 'i'),
    );
  });

  it('las filas que se dejan por ambiguas **se cuentan y se nombran**, como el caso 2', () => {
    // Misma doctrina que «existen las dos grafías»: dejar, contar y decir en voz alta qué decisión
    // humana queda pendiente. Un `row_number()` que descarta en silencio la fila hermana es peor que
    // el 23505, porque el operador no se entera de que tiene dos gestiones sobre el mismo comparendo.
    expect(COMPACTO).toMatch(/RAISE NOTICE '0163: % fila\(s\) prefijadas COLAPSAN/i);
    // El contador es real y se mide sobre `rn > 1`, no es un literal en el texto del NOTICE.
    expect(COMPACTO).toMatch(/WHERE\s+\w+\.rn\s*>\s*1/i);
    // Y nombra la misma decisión humana que el caso 2, con las mismas tres columnas: si el texto se
    // aguara a «se omitieron N filas», el operador no sabría qué tiene que decidir.
    const notice = /RAISE NOTICE '0163: % fila\(s\) prefijadas COLAPSAN(.*?)'/i.exec(COMPACTO);
    expect(notice, 'no se supo leer el NOTICE de las filas ambiguas').not.toBeNull();
    expect(notice![1]).toContain('causal_id');
    expect(notice![1]).toContain('observacion');
    expect(notice![1]).toContain('gestion_actualizada_por');
    expect(notice![1]).toContain('decision humana');
  });

  it('el caso «existen las dos grafías» **se cuenta y se deja**, con su RAISE NOTICE', () => {
    // Fusionar dos filas exige decidir qué gestión sobrevive, y eso no lo decide una migración.
    expect(COMPACTO).toMatch(/RAISE NOTICE '0163: % fila\(s\) prefijadas CONVIVEN/i);
    expect(COMPACTO).toMatch(/GET DIAGNOSTICS \w+ = ROW_COUNT/i);
  });
});

// ─────────────────────────── La medición previa: lo que el operador lee ─────────────────────────

describe('la medición previa de la cabecera hace VISIBLE la clase que revienta', () => {
  it('**incluye el bucket de las claves que colapsan** (`GROUP BY … HAVING count(*) > 1`)', () => {
    // Sin este bucket la corrección del `UPDATE` no le sirve de nada a quien mide antes de aplicar:
    // la consulta de `reparables` / `conflicto` cuenta un par colisionante como 2 y 0 —«seguro»—
    // porque ninguna de las dos filas tiene gemela en la tabla. Es ciega a esa clase entera.
    expect(CABECERA).toMatch(/GROUP BY substring\(\s*r\.numero_comparendo\s+from\s+'\[0-9\]\{20\}\$'\s*\)/i);
    expect(CABECERA).toMatch(/HAVING count\(\*\) > 1/i);
    // Y sobre el MISMO universo que repara el UPDATE: si el bucket midiera otro filtro, mediría otra
    // cosa y volvería a mentir.
    expect(CABECERA).toContain(`FROM ${TABLA} r WHERE r.numero_comparendo ~ '${FORMA_ESPERADA_SQL}' GROUP BY`);
  });

  it('y la cabecera **sigue trayendo la consulta de `reparables` / `conflicto`**', () => {
    // El bucket nuevo se SUMA, no sustituye: las tres clases son disjuntas y el operador necesita
    // las tres para saber qué va a pasar.
    expect(CABECERA).toContain('AS reparables');
    expect(CABECERA).toContain('AS conflicto');
    expect(CABECERA).toMatch(/claves_ambiguas/i);
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
