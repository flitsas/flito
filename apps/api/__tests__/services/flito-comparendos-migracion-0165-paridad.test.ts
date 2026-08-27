// FLITO comparendos — invariantes de la 0165: el municipio del comparendo (HU #11878).
//
// Esta migración es distinta de sus hermanas en una cosa que obliga a un test propio: **el criterio
// de negocio existe DOS VECES**. Una en TypeScript (`municipioDelComparendo`, que corre en cada
// sync) y otra en SQL (el backfill de este archivo, que corre una vez sobre el histórico). Dos
// escrituras del mismo criterio se separan en el primer retoque, y el síntoma sería mudo: filas
// viejas atribuidas a un municipio distinto del que les daría el sync, sin error, sin log y sin
// nadie que las compare.
//
// Así que aquí no se comprueba «que el `.sql` contenga tal cadena»: se EXTRAEN del `.sql` las piezas
// del criterio —los dos literales del límite de palabra, la tabla de plegado de acentos, la regla de
// ambigüedad— y se ejecuta con ellas un simulador del backfill contra el MISMO corpus con el que se
// interroga a la función de TypeScript, exigiendo el mismo resultado en cada caso. Si alguien cambia
// el `~` por un `LIKE '%…%'`, o quita el `count(*) OVER (...) = 1`, o borra el `translate`, el
// simulador deja de poder construirse o deja de coincidir. Las dos cosas son rojo.
//
// Las otras mutaciones que se están cazando:
//
//   · **Backfill que toca `municipio_fuente` u `organismo`.** Es el AC5 en su forma literal: la
//     migración LEE esas dos columnas y no escribe en ninguna. Reinterpretar `municipio_fuente`
//     habría sido la corrección barata y destruye la trazabilidad de qué fuente devolvió la fila.
//   · **Dejar vivo el índice viejo.** El filtro se mudó de columna; `idx_flito_comparendos_municipio_creado`
//     se queda sin consumidor y sería escritura pagada en la tabla que más crece del módulo.
//   · **Perder la idempotencia.** Sin `municipio_comparendo IS NULL` en el WHERE, la segunda pasada
//     PISA lo que el sync haya derivado después con un catálogo más nuevo.
//   · **Una columna que no diga lo mismo que `schema.ts`**, que es la paridad de las hermanas 0151 y
//     0153-0156.
//   · **Control de transacción propio** (ADR-DB-001), con el guarda REAL del runner.
//
// Análisis estático puro: NO toca la base. Se leen de disco los `.sql` y de `schema.ts` los objetos
// de drizzle. Que la migración esté REALMENTE aplicada en un ambiente lo dice el `db:apply`.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoComparendosRegistros } from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

// `flito-comparendos-merge.ts` abre el cliente de base al cargarse y aquí solo se llama a una
// función pura.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { municipioDelComparendo, LIMITE_PALABRA_MUNICIPIO } =
  await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const ARCHIVO = '0165_flito_comparendos_municipio_comparendo.sql';
const ruta = (nombre: string) =>
  fileURLToPath(new URL(`../../src/db/migrations/${nombre}`, import.meta.url));

const TABLA = 'flito_comparendos_registros';
const COLUMNA = 'municipio_comparendo';
const INDICE_NUEVO = 'idx_flito_comparendos_municipio_comparendo_creado';
const INDICE_VIEJO = 'idx_flito_comparendos_municipio_creado';

const sql0165 = readFileSync(ruta(ARCHIVO), 'utf8');

/** Quita los `--` que no vivan dentro de una cadena SQL. El mismo podador de las paridades. */
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

// La cabecera explica EN PROSA el criterio y cita los literales; sin podarla, cada búsqueda de
// `UPDATE` o de `LIKE` se alimentaría del texto que explica por qué NO están.
const CUERPO = podarComentarios(sql0165);
const COMPACTO = CUERPO.replace(/\s+/g, ' ').trim();

// ─────────────────────────── El criterio, extraído del `.sql` ───────────────────────────────────

/**
 * Las piezas del criterio tal como están ESCRITAS en la migración.
 *
 * Cada `null` es una mutación detectada: si el `~` se convirtió en un `LIKE`, no hay literales de
 * límite; si desapareció el `translate`, no hay plegado; si se fue el `= 1`, no hay regla de
 * ambigüedad. El simulador de abajo se construye con esto y solo con esto.
 */
interface CriterioSql {
  antes: string | null;
  despues: string | null;
  plegado: { desde: string; hacia: string } | null;
  ambiguedadPorVentana: boolean;
}

function leerCriterio(sql: string): CriterioSql {
  const cuerpo = podarComentarios(sql).replace(/\s+/g, ' ');

  // El operador de EXPRESIÓN REGULAR con los dos literales alrededor del código del catálogo. Se
  // exige el `~` en la misma aserción: un `LIKE '%'||codigo_fuente||'%'` no casa con este patrón, y
  // esa es exactamente la mutación que pierde el límite de palabra.
  const limites = /~\s*\(\s*'([^']*)'\s*\|\|\s*m\.codigo_fuente\s*\|\|\s*'([^']*)'\s*\)/.exec(cuerpo);

  const translate = /translate\(\s*r\.organismo\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(cuerpo);

  // La regla de ambigüedad son DOS mitades y las dos tienen que estar: contar por fila, y quedarse
  // solo con las de cuenta uno. Quitar cualquiera de las dos deja «gana el que salga primero».
  const cuenta = /count\(\*\)\s*OVER\s*\(\s*PARTITION BY r\.id\s*\)\s*AS\s+(\w+)/i.exec(cuerpo);
  const filtro = cuenta !== null
    && new RegExp(`c\\.${cuenta[1]}\\s*=\\s*1`, 'i').test(cuerpo);

  return {
    antes: limites?.[1] ?? null,
    despues: limites?.[2] ?? null,
    plegado: translate === null ? null : { desde: translate[1], hacia: translate[2] },
    ambiguedadPorVentana: filtro,
  };
}

const CRITERIO = leerCriterio(sql0165);

/** `translate()` de PostgreSQL, con la tabla que el `.sql` declara (o identidad si no hay). */
function plegar(texto: string, tabla: { desde: string; hacia: string } | null): string {
  if (tabla === null) return texto;
  let salida = '';
  for (const c of texto) {
    const i = [...tabla.desde].indexOf(c);
    // `translate` BORRA el carácter si `hacia` es más corto que `desde`. Se emula igual: si la tabla
    // estuviera descuadrada, el simulador lo notaría antes que la base.
    if (i < 0) salida += c;
    else if (i < [...tabla.hacia].length) salida += [...tabla.hacia][i];
  }
  return salida;
}

/**
 * El backfill del `.sql`, ejecutado en memoria a partir de lo que se acaba de extraer de él.
 *
 * No reimplementa el criterio: lo ARMA con las piezas leídas del archivo. Por eso un `.sql` mutado
 * produce un simulador mutado, y el contraste contra `municipioDelComparendo` cae.
 */
function municipioSegunSql(
  municipioFuente: string | null, organismo: string | null, catalogo: readonly string[],
): string | null {
  // Escalón 1: el `UPDATE ... SET municipio_comparendo = municipio_fuente`.
  if (municipioFuente !== null) return municipioFuente;
  if (organismo === null) return null;
  if (CRITERIO.antes === null || CRITERIO.despues === null) {
    throw new Error(`la 0165 ya no busca el codigo_fuente con un \`~\` y dos literales de límite`);
  }

  const texto = plegar(organismo, CRITERIO.plegado).toUpperCase();
  const casados = new Set<string>();
  for (const codigo of catalogo) {
    if (new RegExp(`${CRITERIO.antes}${codigo}${CRITERIO.despues}`).test(texto)) casados.add(codigo);
  }
  if (CRITERIO.ambiguedadPorVentana) return casados.size === 1 ? [...casados][0]! : null;
  // Sin la regla de ambigüedad, el `UPDATE ... FROM` escribe la fila que el join entregue: la
  // primera. Es lo que hace el SQL mutado, y por eso el simulador lo imita en vez de fallar.
  return [...casados][0] ?? null;
}

/**
 * Los 8 códigos que sembró la 0150, leídos de SU `.sql` y no copiados aquí, más uno CON ESPACIOS.
 *
 * El de los espacios es el que justifica que el límite de palabra sea explícito y no `\b`: alrededor
 * de un término con espacios, `\b` delimita cada trozo y no el término. No hace falta que esté
 * sembrado en ningún ambiente —el catálogo es editable por UI— y por eso se añade a mano.
 */
function catalogoSembrado(): string[] {
  const sql0150 = readFileSync(ruta('0150_flito_comparendos_ingesta.sql'), 'utf8');
  const bloque = /INSERT INTO flito_comparendos_municipios[^;]*;/i.exec(podarComentarios(sql0150));
  const codigos = [...(bloque?.[0] ?? '').matchAll(/\(\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*(?:true|false)\s*\)/gi)]
    .map((m) => m[1]);
  return codigos;
}

const CATALOGO_0150 = catalogoSembrado();
const CATALOGO = [...CATALOGO_0150, 'SANTA FE DE ANTIOQUIA'];

// ─────────────────────────── Guardarraíl: ¿los extractores leyeron algo? ────────────────────────

describe('migración 0165 — los extractores leen el archivo', () => {
  // Va primero: si los regex dejaran de casar, la paridad de abajo pasaría por vacuidad.
  it('la 0150 sigue sembrando los 8 municipios del CF-02', () => {
    expect(CATALOGO_0150).toEqual(
      ['BELLO', 'ITAGUI', 'CALI', 'ENVIGADO', 'MANIZALES', 'MEDELLIN', 'RIONEGRO', 'SABANETA'],
    );
  });

  it('el cuerpo sin comentarios conserva el DDL y los dos backfills', () => {
    expect(COMPACTO).toContain(`ALTER TABLE ${TABLA}`);
    expect(COMPACTO.toUpperCase()).toContain('WITH CANDIDATOS AS');
  });

  it('**el criterio se puede leer entero del `.sql`**: límites, plegado y regla de ambigüedad', () => {
    expect(CRITERIO.antes, 'no se encontró el `~` con el literal de límite izquierdo').not.toBeNull();
    expect(CRITERIO.despues, 'no se encontró el literal de límite derecho').not.toBeNull();
    expect(CRITERIO.plegado, 'la 0165 ya no pliega acentos con translate()').not.toBeNull();
    expect(CRITERIO.ambiguedadPorVentana, 'falta el count(*) OVER (PARTITION BY r.id) = 1').toBe(true);
  });
});

// ─────────────────────────── AC1/AC2/AC3 · La paridad TS ↔ SQL ──────────────────────────────────

/**
 * El corpus. Cada caso responde a una pregunta distinta y ninguno es decorativo.
 *
 * `esperado` es lo que las DOS escrituras del criterio tienen que decir; se afirma también contra él
 * y no solo «una igual a la otra», porque dos implementaciones igual de equivocadas coinciden.
 */
const CORPUS: { nombre: string; municipioFuente: string | null; organismo: string | null; esperado: string | null }[] = [
  {
    nombre: 'AC1 · el municipio consultado manda, aunque el organismo diga otra cosa',
    municipioFuente: 'BELLO',
    organismo: 'STRIA DE TTOyTTE MEDELLIN',
    esperado: 'BELLO',
  },
  {
    nombre: 'AC2 · `STRIA DE TTOyTTE MEDELLIN` (solo SIMIT) → MEDELLIN',
    municipioFuente: null,
    organismo: 'STRIA DE TTOyTTE MEDELLIN',
    esperado: 'MEDELLIN',
  },
  {
    nombre: 'el organismo largo del UTS también se reconoce',
    municipioFuente: null,
    organismo: 'SECRETARIA DE TRANSITO Y TRANSPORTE DE BELLO',
    esperado: 'BELLO',
  },
  {
    nombre: 'AC3 · un organismo que no nombra ningún municipio del catálogo → null',
    municipioFuente: null,
    organismo: 'DIRECCION TERRITORIAL DE TRANSITO',
    esperado: null,
  },
  {
    nombre: 'AC3 · DOS municipios en el mismo texto → null, no se desempata',
    municipioFuente: null,
    organismo: 'CONVENIO MEDELLIN - BELLO',
    esperado: null,
  },
  {
    nombre: 'sin organismo no hay nada que deducir → null',
    municipioFuente: null,
    organismo: null,
    esperado: null,
  },
  {
    nombre: 'el LÍMITE de palabra: `CALIDAD` no es `CALI`',
    municipioFuente: null,
    organismo: 'OFICINA DE CALIDAD VIAL',
    esperado: null,
  },
  {
    nombre: 'el organismo REAL con tildes: el SQL pliega acentos como lo hace el TS',
    municipioFuente: null,
    organismo: 'Secretaría de Movilidad de Medellín',
    esperado: 'MEDELLIN',
  },
  {
    nombre: 'un código CON ESPACIOS se reconoce entero (por lo que `\\b` no servía)',
    municipioFuente: null,
    organismo: 'SECRETARIA DE TRANSITO DE SANTA FE DE ANTIOQUIA',
    esperado: 'SANTA FE DE ANTIOQUIA',
  },
];

describe('**el criterio dice lo MISMO en TypeScript y en el `.sql`**', () => {
  for (const caso of CORPUS) {
    it(caso.nombre, () => {
      const enTs = municipioDelComparendo(caso.municipioFuente, caso.organismo, CATALOGO);
      const enSql = municipioSegunSql(caso.municipioFuente, caso.organismo, CATALOGO);

      expect(enTs, 'municipioDelComparendo').toBe(caso.esperado);
      expect(enSql, 'el backfill de la 0165').toBe(caso.esperado);
      expect(enSql, 'TS y SQL discrepan sobre el mismo organismo').toBe(enTs);
    });
  }

  it('los literales del límite son los MISMOS objetos de texto en los dos sitios', () => {
    // La paridad de comportamiento de arriba ya lo cubre para este corpus; esto lo fija para
    // CUALQUIER texto futuro, que es lo que un corpus no puede hacer.
    expect(CRITERIO.antes).toBe(LIMITE_PALABRA_MUNICIPIO.antes);
    expect(CRITERIO.despues).toBe(LIMITE_PALABRA_MUNICIPIO.despues);
  });

  it('la tabla de plegado está CUADRADA: `translate` no borra caracteres', () => {
    // `translate(x, from, to)` con `to` más corto ELIMINA los sobrantes en vez de sustituirlos. Una
    // tabla descuadrada convertiría «MEDELLÍN» en «MEDELLN» y el municipio dejaría de casar.
    const { desde, hacia } = CRITERIO.plegado!;
    expect([...hacia]).toHaveLength([...desde].length);
  });
});

// ─────────────────────────── La columna ─────────────────────────────────────────────────────────

describe('`municipio_comparendo` nace NULLABLE, sin default y `varchar(40)`', () => {
  it('el `.sql` la declara así y sin adornos', () => {
    const m = new RegExp(`ADD COLUMN IF NOT EXISTS ${COLUMNA}([^,;]*)`, 'i').exec(COMPACTO);
    expect(m, `no se supo leer el ADD COLUMN de ${COLUMNA} en ${ARCHIVO}`).not.toBeNull();

    const decl = m![1].toUpperCase();
    expect(decl).toContain('VARCHAR(40)');
    // Un `DEFAULT ''` daría un TERCER valor para «no se sabe»; un `NOT NULL` impediría la propia
    // migración, porque al aplicarla toda la tabla está sin valor.
    expect(decl, `${COLUMNA} declara DEFAULT`).not.toContain('DEFAULT');
    expect(decl, `${COLUMNA} declara NOT NULL`).not.toContain('NOT NULL');
  });

  it('`schema.ts` la declara igual: nullable, sin default y `varchar(40)`', () => {
    const c = getTableConfig(flitoComparendosRegistros).columns.find((x) => x.name === COLUMNA);
    expect(c, `\`schema.ts\` no declara la columna ${COLUMNA}`).toBeDefined();
    expect(c!.notNull, `${COLUMNA} es NOT NULL en schema.ts`).toBe(false);
    expect(c!.hasDefault, `${COLUMNA} tiene default en schema.ts`).toBe(false);
    expect(c!.getSQLType().toLowerCase()).toBe('varchar(40)');
  });

  it('**no hay FK contra el catálogo**: el valor es una foto, no un puntero vivo', () => {
    // Con FK, renombrar un `codigo_fuente` desde la pantalla de parametrización se convertiría en un
    // error de escritura sobre el histórico (o, con CASCADE, en una reescritura masiva).
    expect(COMPACTO.toUpperCase()).not.toContain('REFERENCES FLITO_COMPARENDOS_MUNICIPIOS');
    const c = getTableConfig(flitoComparendosRegistros)
      .foreignKeys.map((fk) => fk.reference().columns.map((x) => x.name)).flat();
    expect(c).not.toContain(COLUMNA);
  });

  it('las DOS columnas llevan su `COMMENT`, y el de la vieja se reescribe', () => {
    // `municipio_fuente` no cambia de valor, pero SÍ cambia qué pregunta responde cada una: un
    // comentario que no lo diga es la documentación mintiendo desde el sitio que sobrevive a los
    // refactors.
    expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.${COLUMNA} IS`);
    expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.municipio_fuente IS`);
  });
});

// ─────────────────────────── AC5 · El backfill y lo que NO toca ─────────────────────────────────

describe('AC5 · el backfill corrige lo guardado SIN tocar `municipio_fuente` ni `organismo`', () => {
  /** Todas las columnas que algún `SET` de este archivo escribe. */
  const columnasEscritas = [...CUERPO.matchAll(/\bSET\s+(\w+)\s*=/gi)].map((m) => m[1].toLowerCase());

  it('**lo único que se escribe en la tabla es la columna nueva**', () => {
    expect(columnasEscritas.length).toBeGreaterThan(0);
    expect([...new Set(columnasEscritas)]).toEqual([COLUMNA]);
  });

  it('`municipio_fuente` y `organismo` solo se LEEN', () => {
    // Dicho por la forma y no por el literal: no puede haber un `SET` con esos nombres delante.
    expect(CUERPO).not.toMatch(/\bSET\s+municipio_fuente\b/i);
    expect(CUERPO).not.toMatch(/\bSET\s+organismo\b/i);
    // Y sí se leen, que es la otra mitad: un backfill que no mirara el organismo no haría nada.
    expect(COMPACTO).toContain('r.organismo');
    expect(COMPACTO).toContain('municipio_fuente IS NOT NULL');
  });

  it('**ni `DELETE` ni `TRUNCATE`**: esto rellena una columna, no reorganiza la tabla', () => {
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bTRUNCATE\b/);
  });

  it('**las filas `inactivo` NO se excluyen**: es su única oportunidad de llenarse', () => {
    // El sync ya no las visita (CF-10), así que un `AND estado = \'activo\'` aquí las condenaría a
    // quedarse sin municipio para siempre.
    expect(CUERPO).not.toMatch(/estado\s*=\s*'activo'/i);
    expect(CUERPO).not.toMatch(/estado\s*<>\s*'inactivo'/i);
  });

  it('**el catálogo entra COMPLETO: el backfill NO filtra por `activo`**', () => {
    // Mutante que sobrevivio al gate de QA (M3) y que esto mata: anadir `AND m.activo` al CTE de
    // candidatos. La premisa esta escrita TRES veces —cabecera del .sql, JSDoc de
    // `municipioDelComparendo` y JSDoc de `catalogoMunicipios`— y hasta aqui no la vigilaba nadie en
    // ninguno de los dos lados del criterio duplicado.
    //
    // Por que importa: desactivar un municipio significa dejar de CONSULTARLO, no borrar de donde
    // eran sus comparendos. Con el filtro puesto, el historico de una fuente que se apago hoy se
    // quedaria sin municipio para siempre —el backfill es su unica oportunidad— y ademas el .sql
    // diria una cosa y `municipioDelComparendo` la contraria, que es justo lo que el resto de este
    // archivo existe para impedir.
    //
    // Se mira el CUERPO podado: `activo` aparece en la prosa de la cabecera explicando esta misma
    // decision, y sin podar el aserto se caeria por su propia explicacion.
    expect(CUERPO).not.toMatch(/\bm\.activo\b/i);
    expect(CUERPO).not.toMatch(/\bactivo\s*=\s*true\b/i);
    expect(CUERPO).not.toMatch(/\bWHERE\s+activo\b/i);
  });

  it('el escalón 1 copia el municipio consultado, tal cual y sin condiciones de más', () => {
    expect(COMPACTO).toMatch(
      new RegExp(`UPDATE ${TABLA} SET ${COLUMNA} = municipio_fuente WHERE ${COLUMNA} IS NULL AND municipio_fuente IS NOT NULL`, 'i'),
    );
  });

  it('el escalón 2 solo mira lo que el 1 dejó vacío', () => {
    // Sin este `IS NULL`, el segundo backfill PISARÍA el municipio consultado con una deducción del
    // organismo, invirtiendo los dos escalones del criterio.
    expect(COMPACTO).toMatch(new RegExp(`WHERE r\\.${COLUMNA} IS NULL AND r\\.organismo IS NOT NULL`, 'i'));
  });
});

// ─────────────────────────── El índice se muda de columna ───────────────────────────────────────

describe('el índice del filtro SUSTITUYE al viejo, no convive con él', () => {
  it('crea el nuevo con la cola del cursor (RN-32)', () => {
    expect(COMPACTO).toMatch(new RegExp(
      `CREATE INDEX IF NOT EXISTS ${INDICE_NUEVO} ON ${TABLA} \\(${COLUMNA}, created_at DESC, id DESC\\)`, 'i',
    ));
  });

  it('**y BORRA el viejo**, que se quedó sin consumidor al mudarse el filtro', () => {
    expect(COMPACTO).toMatch(new RegExp(`DROP INDEX IF EXISTS ${INDICE_VIEJO}`, 'i'));
  });

  it('`schema.ts` declara el nuevo y ya no el viejo', () => {
    const indices = getTableConfig(flitoComparendosRegistros).indexes.map((i) => i.config.name);
    expect(indices).toContain(INDICE_NUEVO);
    expect(indices).not.toContain(INDICE_VIEJO);
  });

  it('sin `CONCURRENTLY`: no cabe dentro de la transacción del runner (ADR-DB-001)', () => {
    expect(COMPACTO.toUpperCase()).not.toContain('CONCURRENTLY');
  });
});

// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0165 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, sql0165)).toEqual([]);
  });

  it('**es re-aplicable**: `IF NOT EXISTS` en el DDL y `IS NULL` en los dos backfills', () => {
    expect(COMPACTO).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${COLUMNA}\\b`, 'i'));
    // Los dos `UPDATE` del archivo se saltan lo que ya tiene valor, así que la segunda pasada no
    // cambia ni una fila. Se cuenta por FORMA para que un tercer backfill futuro sin guarda caiga.
    const updates = [...COMPACTO.matchAll(/\bUPDATE\b/gi)];
    expect(updates).toHaveLength(2);
    expect([...COMPACTO.matchAll(new RegExp(`${COLUMNA} IS NULL`, 'gi'))].length).toBeGreaterThanOrEqual(2);
  });

  it('no toca el `field_map`: esta columna NO es un `target_field` (se deriva)', () => {
    // El error fácil sería «documentarla» con una fila del mapa. Esa tabla es la lista blanca de la
    // poda (RN-25) y una fila ahí no documenta: ordena persistir, y además haría que el valor de una
    // columna por la que se FILTRA lo eligiera texto libre del proveedor.
    expect(COMPACTO.toUpperCase()).not.toContain('FLITO_COMPARENDOS_FIELD_MAP');
  });

  it('no reescribe migraciones anteriores: la 0153 sigue creando el índice que la 0165 borra', () => {
    // La salida fácil para «mudar» el índice es editar la 0153 donde se creó. En un ambiente que ya
    // la corrió, ese cambio no se ejecuta nunca y el `.sql` pasa a mentir sobre lo que hay en la base.
    const sql0153 = readFileSync(ruta('0153_flito_comparendos_indices_filtro.sql'), 'utf8');
    expect(podarComentarios(sql0153)).toContain(`CREATE INDEX IF NOT EXISTS ${INDICE_VIEJO}`);
  });
});
