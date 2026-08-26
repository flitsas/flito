// FLITO comparendos — invariantes de la 0164: fecha de notificación y mapa v4 (HU #11794).
//
// La 0164 hace tres cosas, y cada una se vigila por su lado:
//
//   · **DDL** — una columna `date` nullable y sin default, que tiene que decir lo mismo que
//     `schema.ts`. Es la paridad de las hermanas 0151 y 0153-0156.
//   · **DML** — la v4 del `field_map`, cuya contraparte no es el esquema sino el comportamiento del
//     módulo (la vigilancia que estrenó la paridad de la 0158).
//   · **Lo que la migración NO hace** — y aquí es donde vive el AC: no hay backfill, ni de la
//     columna nueva ni del centinela ya escrito en `fecha_comparendo`.
//
// Las mutaciones que se están cazando, todas plausibles:
//
//   · **Sembrar una v4 PARCIAL** (solo las dos filas nuevas). El merge lee la versión MÁXIMA y NO
//     hereda: dejaría al módulo sin número, sin placa, sin fecha y sin monto — el apagón del
//     histórico entero que RN-12 existe para evitar. Por eso la cobertura de la v3 se lee del propio
//     `.sql` de la 0160 y no de una lista escrita aquí.
//
//   · **No mapear `fechaNotificacion` en uno de los dos orígenes.** La columna se llenaría solo para
//     media realidad, y en el origen mudo la poda seguiría tirando el campo (RN-25).
//
//   · **Rellenar el histórico con un `UPDATE`.** Para la columna nueva sería inventar un dato que no
//     está en ninguna parte (los payloads viejos se podaron sin `fechaNotificacion`); para
//     `fecha_comparendo` sería escribir la decisión de hoy sobre filas que nadie volvió a medir.
//
//   · **Editar la 0158, la 0160 o la 0163** para «arreglar» el mapa allí. Son historial aplicado: en
//     cualquier ambiente que ya las corrió, el cambio no se ejecuta nunca y el `.sql` pasa a mentir
//     sobre lo que hay en la base.
//
//   · **Añadir cualquier ruta de persona.** Esta tabla ES la lista blanca de la poda RN-25: nombrar
//     aquí `infractor.*`, `nombres` o `estadoCuenta.direccion` no documenta un campo, ordena que se
//     PERSISTA. Ley 1581.
//
// Análisis estático puro: NO toca la base. Se leen de disco los `.sql` y de `schema.ts` los objetos
// de drizzle. Lo que ninguna aserción de aquí cubre —que la migración esté REALMENTE aplicada en un
// ambiente— lo hace el `db:apply`.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoComparendosRegistros } from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

// `flito-comparendos-merge.ts` abre el cliente de base al cargarse y aquí solo se leen constantes.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { CAMPOS_CANONICOS, FECHA_CENTINELA_NO_NOTIFICADO } =
  await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const ARCHIVO = '0164_flito_comparendos_fecha_notificacion.sql';
const ruta = (nombre: string) =>
  fileURLToPath(new URL(`../../src/db/migrations/${nombre}`, import.meta.url));

const TABLA = 'flito_comparendos_registros';
const COLUMNA = 'fecha_notificacion';

const sql0164 = readFileSync(ruta(ARCHIVO), 'utf8');

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

// La cabecera de la 0164 explica EN PROSA lo que el archivo no hace —«ni un UPDATE», «sin
// backfill»—. Sin podarla, el texto que dice «no hay UPDATE» alimentaría la búsqueda de `UPDATE` y
// pondría en rojo justo el test que existe para comprobarlo.
const CUERPO = podarComentarios(sql0164);
const COMPACTO = CUERPO.replace(/\s+/g, ' ').trim();

// ─────────────────────────── Lectura de las filas sembradas ─────────────────────────────────────

interface FilaSembrada {
  version: number; origen: string; sourcePath: string; targetField: string;
  prioridad: number; provisional: boolean;
}

/** Extractor ESTRICTO: una tupla con forma que no se entienda tiene que hacer fallar el guardarraíl. */
function filasSembradas(sql: string): FilaSembrada[] {
  const tupla = /\(\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*,\s*(true|false)\s*,\s*(?:NULL|'(?:[^']*)')\s*\)/gi;
  return [...podarComentarios(sql).matchAll(tupla)].map((m) => ({
    version: Number(m[1]),
    origen: m[2],
    sourcePath: m[3],
    targetField: m[4],
    prioridad: Number(m[5]),
    provisional: m[6].toLowerCase() === 'true',
  }));
}

const FILAS = filasSembradas(sql0164);
const SIMIT = FILAS.filter((f) => f.origen === 'simit');
const MUNICIPAL = FILAS.filter((f) => f.origen === 'municipal');
/** La v3, leída del `.sql` de la 0160: es la cobertura que la v4 no puede perder. */
const FILAS_V3 = filasSembradas(readFileSync(ruta('0160_flito_comparendos_tipo_registro.sql'), 'utf8'));

const rutasDe = (filas: FilaSembrada[]): string[] => filas.map((f) => f.sourcePath);

// ─────────────────────────── Guardarraíl: ¿los extractores leyeron algo? ────────────────────────

describe('migración 0164 — los extractores leen los archivos', () => {
  // Va primero: si los regex dejaran de casar, todo lo de abajo pasaría por vacuidad —`[].every(…)`
  // es `true` y `expect([]).not.toContain(x)` también pasa—.
  it('el .sql siembra las 43 filas de la v4 (21 SIMIT + 22 municipal)', () => {
    expect(FILAS).toHaveLength(43);
    expect(SIMIT).toHaveLength(21);
    expect(MUNICIPAL).toHaveLength(22);
  });

  it('la v3 se lee de la 0160 y trae sus 41 filas', () => {
    expect(FILAS_V3).toHaveLength(41);
  });

  it('el cuerpo sin comentarios conserva el DDL', () => {
    expect(COMPACTO).toContain(`ALTER TABLE ${TABLA}`);
  });
});

// ─────────────────────────── La columna ─────────────────────────────────────────────────────────

describe('`fecha_notificacion` nace NULLABLE, sin default y como `date`', () => {
  it('el `.sql` la declara `DATE` y sin adornos', () => {
    const m = new RegExp(`ADD COLUMN IF NOT EXISTS ${COLUMNA}([^,;]*)`, 'i').exec(COMPACTO);
    expect(m, `no se supo leer el ADD COLUMN de ${COLUMNA} en ${ARCHIVO}`).not.toBeNull();

    const decl = m![1].toUpperCase();
    expect(decl).toContain('DATE');
    // Un `DEFAULT` aquí sería una afirmación sobre filas que nadie ha medido, y un `NOT NULL`
    // impediría la propia migración: al aplicarla, TODA la tabla está sin valor.
    expect(decl, `${COLUMNA} declara DEFAULT`).not.toContain('DEFAULT');
    expect(decl, `${COLUMNA} declara NOT NULL`).not.toContain('NOT NULL');
  });

  it('`schema.ts` la declara igual: nullable, sin default y de tipo fecha', () => {
    const c = getTableConfig(flitoComparendosRegistros).columns.find((x) => x.name === COLUMNA);
    expect(c, `\`schema.ts\` no declara la columna ${COLUMNA}`).toBeDefined();
    expect(c!.notNull, `${COLUMNA} es NOT NULL en schema.ts`).toBe(false);
    expect(c!.hasDefault, `${COLUMNA} tiene default en schema.ts`).toBe(false);
    expect(c!.getSQLType().toLowerCase()).toBe('date');
  });

  it('lleva su `COMMENT ON COLUMN`: el porqué vive también en la base', () => {
    expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.${COLUMNA} IS`);
  });

  it('**el COMMENT de `fecha_comparendo` también se reescribe**: el criterio nuevo la alcanza', () => {
    // El centinela no es una regla de la columna nueva, es una regla del módulo, y la columna vieja
    // cambia de comportamiento por ella. Un comentario que siguiera describiendo el comportamiento
    // anterior sería la documentación mintiendo desde el sitio que sobrevive a los refactors.
    expect(COMPACTO).toContain(`COMMENT ON COLUMN ${TABLA}.fecha_comparendo IS`);
  });

  it('no crea índices y no borra nada', () => {
    // Nadie filtra ni ordena todavía por esta columna: el visor es la HU #11795. Un índice que el
    // planner descarta solo cuesta escrituras en la tabla que más crece del módulo.
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bDROP\b/);
  });
});

// ─────────────────────────── AC4 · Sin backfill ─────────────────────────────────────────────────

describe('AC4 · la migración NO reescribe ni una fila', () => {
  it('**ni `UPDATE`, ni `DELETE`, ni `TRUNCATE` sobre los registros**', () => {
    // Las dos formas de la misma mentira: rellenar `fecha_notificacion` con algo, o «arreglar» los
    // `1900-01-01` ya escritos en `fecha_comparendo`. Lo primero es imposible —el dato no está en
    // ninguna parte—; lo segundo es escribir hoy sobre filas que nadie volvió a medir.
    const cuerpo = COMPACTO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_REGISTROS\s+SET\b/);
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(cuerpo).not.toMatch(/\bTRUNCATE\b/);
  });

  it('**no hay ni un `WHERE`**: una migración que no elige filas no puede reescribir ninguna', () => {
    // Dicho por la forma y no por el literal, que es más difícil de sortear: un backfill —o un
    // `WHERE fecha_comparendo = '1900-01-01'`— necesita elegir filas, y aquí no se elige ninguna.
    // Las tres sentencias del archivo son un `ADD COLUMN`, tres `COMMENT` y un `INSERT`.
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bWHERE\b/);
    // Y el centinela sí vive en el archivo: en los COMMENT, que son prosa. Lo contrario —que no
    // apareciera— significaría que la base no documenta el criterio que estrena esta migración.
    expect(sql0164).toContain(FECHA_CENTINELA_NO_NOTIFICADO);
    expect(sql0164).toContain('01/01/1900');
  });
});

// ─────────────────────────── AC4 · El mapa v4 se siembra ENTERO ─────────────────────────────────

describe('AC1/AC4 · la v4 re-siembra los dos orígenes enteros y no hereda de la v3', () => {
  it('**todas las filas son `version = 4` y ninguna provisional**', () => {
    expect(FILAS.every((f) => f.version === 4)).toBe(true);
    expect(FILAS.every((f) => f.provisional === false)).toBe(true);
  });

  it('**cubre TODO lo que cubría la v3**, leído de la 0160 y no de una lista escrita aquí', () => {
    // El merge lee la versión MÁXIMA y NO hereda: una v4 con dos filas dejaría al módulo sin número,
    // sin placa, sin fecha y sin monto. Copiar la lista de la v3 a este archivo crearía una tercera
    // copia del mismo hecho y el problema volvería una casilla más allá.
    const enV4 = new Map(FILAS.map((f) => [`${f.origen}|${f.sourcePath}`, f.targetField]));
    const faltan = FILAS_V3
      .filter((f) => enV4.get(`${f.origen}|${f.sourcePath}`) !== f.targetField)
      .map((f) => `${f.origen} ${f.sourcePath} -> ${f.targetField}`);

    expect(faltan).toEqual([]);
  });

  it('**y conserva las PRIORIDADES de la v3**: la cobertura no basta si cambia quién gana', () => {
    // Una v4 que trajera las mismas rutas con otro orden sería «completa» y elegiría otros valores:
    // `estadoPago` delante de `estadoComparendo` cambia el estado que se pinta sin perder ni una
    // fila. La comparación de arriba no lo vería.
    const enV4 = new Map(FILAS.map((f) => [`${f.origen}|${f.sourcePath}`, f.prioridad]));
    const movidas = FILAS_V3
      .filter((f) => enV4.get(`${f.origen}|${f.sourcePath}`) !== f.prioridad)
      .map((f) => `${f.origen} ${f.sourcePath}: v3=${f.prioridad} v4=${enV4.get(`${f.origen}|${f.sourcePath}`)}`);

    expect(movidas).toEqual([]);
  });

  it('**lo ÚNICO que la v4 añade son las dos filas de `fechaNotificacion`**', () => {
    // Al revés que el test anterior: que no se haya colado nada más. Una fila de más en esta tabla
    // no es documentación, es una orden de persistir (RN-25).
    const enV3 = new Set(FILAS_V3.map((f) => `${f.origen}|${f.sourcePath}`));
    const nuevas = FILAS.filter((f) => !enV3.has(`${f.origen}|${f.sourcePath}`))
      .map((f) => `${f.origen}|${f.sourcePath}`);

    expect(nuevas.sort()).toEqual(['municipal|fechaNotificacion', 'simit|fechaNotificacion']);
  });

  it('**`fechaNotificacion` está en los DOS orígenes**, cada una a su canónico y en prioridad 1', () => {
    for (const [origen, filas] of [['simit', SIMIT], ['municipal', MUNICIPAL]] as const) {
      const suyas = filas.filter((f) => f.targetField === 'fechaNotificacion');
      expect(rutasDe(suyas), origen).toEqual(['fechaNotificacion']);
      expect(suyas[0]!.prioridad, origen).toBe(1);
    }
  });

  it('**no se mapea a `fechaComparendo`**: son dos hitos distintos del proceso', () => {
    // El error fácil: colgarla como respaldo de la fecha del comparendo. Pintaría la fecha de
    // notificación en la columna de la imposición justo en los comparendos peor documentados.
    expect(FILAS.filter((f) => f.sourcePath === 'fechaNotificacion')
      .every((f) => f.targetField === 'fechaNotificacion')).toBe(true);
    expect(FILAS.filter((f) => f.targetField === 'fechaComparendo').map((f) => f.sourcePath).sort())
      .toEqual(['fecha', 'fechaComparendo', 'fechaComparendo', 'fechaImposicion']);
  });

  it('**ningún `target_field` fuera de `CAMPOS_CANONICOS`**, y `fechaNotificacion` es uno de ellos', () => {
    // `esCampoCanonico` ignora en silencio lo que no reconoce: una fila mal apuntada no rompe nada,
    // simplemente no homologa — y la columna se quedaría vacía sin que nada avisara.
    const canonicos = new Set<string>(CAMPOS_CANONICOS);
    for (const f of FILAS) {
      expect(canonicos.has(f.targetField), `\`${f.sourcePath}\` apunta a \`${f.targetField}\``).toBe(true);
    }
    expect(canonicos.has('fechaNotificacion')).toBe(true);
  });

  it('cada `target_field` de cada origen tiene prioridades SIN empatar', () => {
    // Un empate hace que el ganador dependa del desempate por `source_path` del ORDER BY, que no es
    // una decisión de nadie.
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
});

// ─────────────────────────── AC4 · Las anteriores son historial ─────────────────────────────────

describe('AC4 · la 0158, la 0160 y la 0163 no se tocan', () => {
  it('**la 0164 no reescribe versiones anteriores del mapa**', () => {
    expect(COMPACTO.toUpperCase()).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_FIELD_MAP\s+SET\b/);
    expect(new Set(FILAS.map((f) => f.version))).toEqual(new Set([4]));
  });

  it('**la 0158 sigue sembrando SOLO la v2 y la 0160 SOLO la v3**', () => {
    // La salida fácil para «arreglar» el mapa es editar la migración donde ya estaba escrito. En un
    // ambiente que ya la corrió, ese cambio no se ejecuta nunca y el `.sql` pasa a mentir sobre lo
    // que hay en la base.
    const v2 = filasSembradas(readFileSync(ruta('0158_flito_comparendos_field_map_v2.sql'), 'utf8'));
    expect(v2.length).toBeGreaterThan(0);
    expect(new Set(v2.map((f) => f.version))).toEqual(new Set([2]));
    expect(new Set(FILAS_V3.map((f) => f.version))).toEqual(new Set([3]));
  });

  it('la 0163 sigue sin tocar el `field_map`: no hay v4 escondida ahí', () => {
    const sql0163 = readFileSync(ruta('0163_flito_comparendos_clave_negocio_prefijo.sql'), 'utf8');
    expect(filasSembradas(sql0163)).toEqual([]);
    expect(podarComentarios(sql0163).toUpperCase()).not.toContain('FLITO_COMPARENDOS_FIELD_MAP');
  });
});

// ─────────────────────────── Invariantes del archivo (ADR-DB-001) ───────────────────────────────

describe('la 0164 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, sql0164)).toEqual([]);
  });

  it('**el INSERT es idempotente**: lleva su `ON CONFLICT ... DO NOTHING`', () => {
    // La cadena se re-aplica en cualquier ambiente que vaya por detrás; sin esto la segunda pasada
    // aborta con un 23505 y deja parado el `db:apply`.
    expect(COMPACTO).toMatch(/ON CONFLICT \(\s*version\s*,\s*origen\s*,\s*source_path\s*\) DO NOTHING/i);
  });

  it('la columna se añade con `IF NOT EXISTS`, que es la otra mitad de la idempotencia', () => {
    expect(COMPACTO).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${COLUMNA}\\b`, 'i'));
  });
});
