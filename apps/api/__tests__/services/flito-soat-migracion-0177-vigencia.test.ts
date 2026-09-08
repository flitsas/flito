// HU #12096 (Feature #12075) — invariantes de la migración 0177, la que trae al MODELO DE DATOS la
// verificación diaria del SOAT contra el RUNT.
//
// ── Por qué esta migración necesita un guarda escrito ───────────────────────────────────────────
//
// No es destructiva como la 0176, pero tiene dos trampas que un `db:apply` verde NO delata:
//
//   1. **`ADD COLUMN IF NOT EXISTS estado`** —el nombre literal del AC1— sería un NO-OP SILENCIOSO:
//      `flito_soat.estado` ya existe y es el enum `flito_soat_estado`. La migración aplicaría bien,
//      el CD saldría verde, y el primer `set({ estadoVigencia: 'vigente' })` de la corrida moriría en
//      producción con `22P02 invalid input value for enum`. Lo mismo con `poliza` frente a
//      `numero_poliza`, salvo que ahí el fallo sería peor: escribiría encima de la llave de
//      conciliación del Feature #11623 sin que nada se pusiera rojo.
//   2. **El `target` del upsert de la tabla de corridas.** La llave tiene que ser (día, intento); con
//      solo el día, la corrida de un día borraría la del anterior, que es exactamente la deuda que
//      esta migración viene a cerrar al retirar la clave de `system_kv`.
//
// Los mutantes que este archivo tiene que matar, nombrados:
//
//   · Las columnas con el nombre del AC1 (`estado`, `poliza`) en vez de los desambiguados.
//   · Un `pgEnum` en vez de `varchar` + CHECK (el 55P04 que este dominio ya pagó dos veces).
//   · El CHECK solo en la base y no en `schema.ts` (lección de la 0157) — o al revés.
//   · `vencido` colado en el CHECK: no se persiste, se deriva.
//   · Un `UPDATE` de backfill que rellene `vigente` porque la fila está `pagado` (regla de la 0174).
//   · El `DELETE` del KV sin su `RAISE NOTICE` delante: se retiraría un estado vivo sin constancia.
//   · Un índice único sobre `(soat_id, tipo)` de `flito_soportes` — `factura_soat` SÍ se repite.
//   · Reintroducir el índice sobre `verificada_en`, que el gate de esquema retiró por INERTE
//     (btree `ASC NULLS LAST` contra un censo que ordena `ASC NULLS FIRST`, y un predicado con OR y
//     sin `LIMIT`). Y perder de paso el párrafo que dice cuándo SÍ tocaría crearlo.
//   · Control de transacción propio (ADR-DB-001), con el guarda REAL del runner.
//   · Que `schema.ts` y el `.sql` dejen de decir lo mismo.
//
// Análisis estático puro: NO toca la base. Se lee de disco el `.sql` y de `schema.ts` los objetos de
// drizzle. Que la migración esté REALMENTE aplicada lo dice el `db:apply` del CD.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema.js';
import { flitoSoat, flitoSoatVerificacionCorridas, flitoSoportes } from '../../src/db/schema.js';
import { ESTADOS_VIGENCIA_SOAT } from '@operaciones/shared-types';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const ARCHIVO = '0177_flito_soat_vigencia_runt.sql';
const CRUDO = readFileSync(
  fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url)), 'utf8',
);

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin entrar en las cadenas.
 *
 * Imprescindible aquí: la cabecera EXPLICA en prosa justo lo que el archivo NO hace —el backfill, el
 * enum, el nombre `estado` del AC1— y sin podarla cada comprobación negativa de abajo sería roja por
 * su propia documentación. Copiado de la 0176.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      salida += c;
      if (c === "'") enCadena = false;
      continue;
    }
    if (c === "'") { enCadena = true; salida += c; continue; }
    if (c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    salida += c;
  }
  return salida;
}

const SQL = podarComentarios(CRUDO);
const MAY = SQL.toUpperCase();

/**
 * El SQL sin los `COMMENT ON`, para las comprobaciones NEGATIVAS.
 *
 * Segunda poda, y hace falta: los `COMMENT ON` de esta migración EXPLICAN los dos nombres que no se
 * usan (`flito_soat.estado`, `numero_poliza`) y la columna que no existe (`proximo_intento_en`),
 * porque justo eso es lo que quien lea la base dentro de un año necesita saber. Sin quitarlos, cada
 * `not.toMatch` sería rojo por su propia documentación —el mismo problema que `podarComentarios`
 * resuelve para los `--`, un nivel más adentro—. Los asertos POSITIVOS siguen yendo contra `SQL`,
 * que es donde los comentarios sí cuentan como contenido de la migración.
 */
const SENTENCIAS = SQL.replace(/COMMENT ON [\s\S]*?;/g, ' ');

/** Dónde empieza cada statement clave, para poder afirmar sobre el ORDEN y no solo la presencia. */
const posicion = (re: RegExp): number => {
  const m = SQL.match(re);
  expect(m, `no se encontró ${re}`).not.toBeNull();
  return m!.index!;
};

const columnasDe = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).columns.map((c) => c.name);

describe('migración 0177 — las cuatro columnas y sus DOS nombres desambiguados', () => {
  it('**`estado_vigencia` y no `estado`**: el literal del AC1 sería un no-op silencioso', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS estado_vigencia\s+varchar\(15\)\s+NOT NULL\s+DEFAULT\s+'no_verificado'/i);
    // Y la forma peligrosa NO está en ninguna parte: `flito_soat.estado` existe y es un ENUM, así
    // que `ADD COLUMN IF NOT EXISTS estado` aplicaría sin error y el primer UPDATE moriría con 22P02.
    expect(SENTENCIAS).not.toMatch(/ADD COLUMN IF NOT EXISTS estado\s+/i);
    // El enum de la SOLICITUD no se nombra: son dos ejes ortogonales y esta migración no lo toca.
    // El `(?!_)` no es cosmético: `flito_soat_estado_vigencia_chk` —el CHECK que esta migración SÍ
    // crea— contiene el nombre del tipo como prefijo, y sin el lookahead este aserto sería rojo
    // contra su propio código correcto.
    expect(SENTENCIAS).not.toMatch(/flito_soat_estado(?!_)/i);
  });

  it('**`poliza_runt` y no `poliza`**: `numero_poliza` es la llave de conciliación del #11623', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS poliza_runt\s+varchar\(60\)/i);
    // Que no haya ni una mención a `numero_poliza` fuera de los comentarios es lo que garantiza que
    // esta migración no la toca. Escribir la póliza del RUNT encima borraría la llave con la que una
    // boleta de pago externo cruza contra el SOAT, y ningún test lo vería.
    expect(SENTENCIAS).not.toMatch(/numero_poliza/i);
  });

  it('`verificada_en` y `vence_el` con el nombre literal del AC, y NULLABLES', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS verificada_en\s+timestamptz\s*,/i);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS vence_el\s+date\s*,/i);
    // Sin `NOT NULL` y sin default: `NULL` significa «de este SOAT no consta ninguna respuesta del
    // RUNT», que es la verdad de las filas existentes. Un `DEFAULT now()` habría escrito la fecha de
    // la MIGRACIÓN como si fuera la de una consulta al registro nacional (lo que la 0174 rechazó).
    expect(SQL).not.toMatch(/verificada_en\s+timestamptz\s+NOT NULL/i);
    expect(SQL).not.toMatch(/verificada_en[^,;]*DEFAULT/i);
  });

  it('las cuatro llevan `COMMENT ON COLUMN`, con el porqué del nombre en las dos que chocan', () => {
    for (const c of ['estado_vigencia', 'verificada_en', 'vence_el', 'poliza_runt']) {
      expect(SQL, `falta el COMMENT de ${c}`).toMatch(new RegExp(`COMMENT ON COLUMN flito_soat\\.${c} IS`, 'i'));
    }
    // El comentario de `estado_vigencia` tiene que decir que NO es `flito_soat.estado`: es lo único
    // que verá quien abra la base dentro de un año y encuentre dos columnas parecidas.
    const est = SQL.slice(posicion(/COMMENT ON COLUMN flito_soat\.estado_vigencia IS/i));
    expect(est).toMatch(/NO es flito_soat\.estado/i);
    const pol = SQL.slice(posicion(/COMMENT ON COLUMN flito_soat\.poliza_runt IS/i));
    expect(pol).toMatch(/numero_poliza/i);
  });
});

describe('migración 0177 — varchar + CHECK, nunca un enum', () => {
  it('**ni un `CREATE TYPE`**: el enum arrastra el 55P04 que este dominio ya pagó dos veces', () => {
    expect(MAY).not.toContain('CREATE TYPE');
    expect(MAY).not.toContain('ALTER TYPE');
  });

  it('el CHECK se pone con DROP + ADD, porque `ADD CONSTRAINT IF NOT EXISTS` no existe', () => {
    // Es lo que la 0167:139 dejó escrito y lo que hace idempotente la segunda pasada (P6). Los DOS
    // CHECK del archivo: el de la columna y el de la tabla nueva.
    const drops = [...SQL.matchAll(/DROP CONSTRAINT IF EXISTS/gi)];
    const adds = [...SQL.matchAll(/ADD CONSTRAINT \w+\s*\n?\s*CHECK/gi)];
    expect(drops.length).toBe(2);
    expect(adds.length).toBe(2);
    expect(posicion(/DROP CONSTRAINT IF EXISTS flito_soat_estado_vigencia_chk/i))
      .toBeLessThan(posicion(/ADD CONSTRAINT flito_soat_estado_vigencia_chk/i));
  });

  it('el CHECK nombra los TRES valores y **`vencido` NO está**', () => {
    const m = SQL.match(/CHECK \(estado_vigencia IN \(([^)]*)\)\)/i);
    expect(m, 'falta el CHECK de estado_vigencia').not.toBeNull();
    const valores = [...m![1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort();
    expect(valores).toEqual(['no_verificado', 'sin_registro', 'vigente']);
    // MUTANTE — colar `vencido`. No se persiste: un SOAT vigente hoy está vencido mañana sin que
    // nadie lo toque, así que como estado obligaría a reescribir filas cada medianoche. Se deriva.
    expect(valores).not.toContain('vencido');
  });

  it('el CHECK de la tabla de corridas usa el MISMO vocabulario que el `EstadoCorrida` del cron', () => {
    const m = SQL.match(/CHECK \(estado IN \(([^)]*)\)\)/i);
    expect(m, 'falta el CHECK de la tabla de corridas').not.toBeNull();
    const valores = [...m![1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort();
    // No se inventa otro vocabulario: la lectura del cron reconstruye su `EstadoDelDia` de esta
    // columna, y dos vocabularios obligarían a una traducción que nadie recordaría mantener.
    expect(valores).toEqual(['completa', 'en_curso', 'parcial']);
  });
});

describe('migración 0177 — la tabla de corridas: una fila por CORRIDA', () => {
  it('la llave única es el PAR (dia, intento), no el día', () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_verif_corrida_dia_intento\s*\n?\s*ON flito_soat_verificacion_corridas \(dia, intento\)/i);
    // MUTANTE — dejarla en `(dia)`: el upsert del intento 2 machacaría lo que midió el intento 1, y
    // el primer intento de un día nuevo se llevaría por delante la fila del día anterior, que es
    // literalmente la deuda que esta migración viene a cerrar.
    expect(SQL).not.toMatch(/UNIQUE INDEX[^;]*\(dia\)/i);
  });

  it('la migración crea EXACTAMENTE dos índices, y ninguno de más', () => {
    // El censo completo, no un `toContain`: es lo que hace que añadir uno sin justificarlo ponga
    // esto rojo. Aquí se retiró uno —ver el test de `verificada_en` más abajo— y sin este aserto
    // reintroducirlo sería gratis.
    //
    // NO hay un índice extra sobre `(dia)` de la tabla de corridas: el único, `(dia, intento)`, lo
    // sirve por prefijo izquierdo.
    const indices = [...SQL.matchAll(/CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)/gi)].map((m) => m[2]);
    expect(indices.sort()).toEqual([
      'idx_flito_soportes_soat_tipo',
      'uq_flito_soat_verif_corrida_dia_intento',
    ]);
  });

  it('**no tiene columna `proximo_intento_en`**: eso se deriva de `iniciada_en + 1 h`', () => {
    // Persistir una resta es garantizar que un día deje de cuadrar con sus sumandos, y encima habría
    // dos verdades sobre la cadencia sin forma de saber cuál creerse.
    expect(SENTENCIAS).not.toMatch(/proximo_intento_en/i);
  });

  it('los cinco contadores existen con DEFAULT 0 y `motivos` con `{}`', () => {
    for (const c of ['total', 'verificados', 'cambiaron', 'fallidos']) {
      expect(SQL, `falta ${c}`).toMatch(new RegExp(`${c}\\s+integer\\s+NOT NULL DEFAULT 0`, 'i'));
    }
    expect(SQL).toMatch(/motivos\s+jsonb\s+NOT NULL DEFAULT\s+'\{\}'::jsonb/i);
    // `fallidos` es lo único que reprograma el reintento horario, y por eso lleva comentario propio.
    expect(SQL).toMatch(/COMMENT ON COLUMN flito_soat_verificacion_corridas\.fallidos IS/i);
  });

  it('**ningún identificador de vehículo** entra en la tabla ni en el vocabulario de `motivos`', () => {
    const bloque = SQL.slice(
      posicion(/CREATE TABLE IF NOT EXISTS flito_soat_verificacion_corridas/i),
      posicion(/CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_tipo/i),
    );
    for (const p of ['vin', 'placa', 'documento', 'soat_id', 'vehiculo']) {
      expect(bloque.toLowerCase(), `${p} no debería estar en la tabla de corridas`)
        .not.toMatch(new RegExp(`^\\s*${p}\\s`, 'm'));
    }
    const motivos = SQL.slice(posicion(/COMMENT ON COLUMN flito_soat_verificacion_corridas\.motivos IS/i));
    expect(motivos).toMatch(/timeout \| red \| circuito \| otro/i);
    // Y dice POR QUÉ es cerrado: un `err.message` de un tercero puede traer la placa dentro.
    expect(motivos).toMatch(/err\.message/i);
  });
});

describe('migración 0177 — los dos índices del recorrido', () => {
  it('`idx_flito_soportes_soat_tipo` **NO es único**: `factura_soat` se repite por SOAT', () => {
    const m = SQL.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_flito_soportes_soat_tipo/i);
    expect(m).not.toBeNull();
    // MUTANTE — hacerlo único: el despliegue fallaría en cualquier base con dos comprobantes vivos
    // del mismo SOAT, parando la cadena entera. El único índice único por `soat_id` que hay acota
    // `factura_venta`, y por eso el censo usa EXISTS y no un JOIN.
    expect(m![1]).toBeUndefined();
    expect(SQL).toMatch(/WHERE soat_id IS NOT NULL AND descartado = false/i);
  });

  it('**`verificada_en` NO se indexa**, y el archivo explica por qué y cuándo habría que hacerlo', () => {
    // Este archivo llegó a traer `CREATE INDEX ... ON flito_soat (verificada_en)`. El gate de esquema
    // lo retiró por INERTE, medido con EXPLAIN: un btree se declara `ASC NULLS LAST` y el censo pide
    // `ASC NULLS FIRST` —que ningún recorrido de ese índice puede suplir—, y encima el predicado es
    // un OR de baja selectividad SIN `LIMIT`, donde seq scan + sort gana igual.
    //
    // MUTANTE — reintroducirlo «porque hay una columna de fecha que se filtra». Este aserto lo mata,
    // y el bloque de prosa de abajo es lo que evita que se reintroduzca de buena fe: sin él quedaría
    // una ausencia muda que el siguiente lee como un olvido.
    expect(SENTENCIAS).not.toMatch(/CREATE INDEX[^;]*ON flito_soat\s*\(\s*verificada_en/i);

    // La condición que lo haría legítimo tiene que estar ESCRITA, no supuesta.
    expect(CRUDO).toMatch(/NULLS FIRST/i);
    expect(CRUDO).toMatch(/enable_seqscan/i);
    expect(CRUDO).toMatch(/LIMIT/);
  });
});

describe('migración 0177 — el KV se retira con constancia, y CERO backfill', () => {
  it('el `RAISE NOTICE` va ANTES del `DELETE`, no al principio del archivo', () => {
    const notice = posicion(/RAISE NOTICE 'HU #12096: se retira el estado provisional/i);
    const del = posicion(/DELETE FROM system_kv/i);
    // Si algo de arriba abortara, no se borraría nada y el aviso habría sido falso. Mismo patrón que
    // la 0176 antes de suprimir `observacion_rechazo`.
    expect(notice).toBeLessThan(del);
  });

  it('el NOTICE dice día, estado, intentos y conteos — y NADA de PII', () => {
    const bloque = SQL.slice(posicion(/RAISE NOTICE 'HU #12096: se retira/i));
    for (const k of ['dia', 'estado', 'intentos', 'verificados', 'pendientes']) {
      expect(bloque, `el NOTICE no nombra ${k}`).toMatch(new RegExp(`'${k}'`));
    }
    // El KV solo guardó conteos: no hay nada más que decir, y no se inventa.
    expect(bloque.toLowerCase()).not.toContain('placa');
    expect(bloque.toLowerCase()).not.toContain('vin');
  });

  it('el DELETE es **por la clave exacta**, no un barrido de `system_kv`', () => {
    expect(SQL).toMatch(/DELETE FROM system_kv WHERE k = 'flito-soat\.vigencia\.corrida-dia'/i);
    // Un `DELETE FROM system_kv WHERE k LIKE 'flito-soat%'` se llevaría por delante claves de otros
    // procesos —el sync de FLIT y la salud del reconciliador viven en la misma tabla.
    expect(SQL).not.toMatch(/DELETE FROM system_kv WHERE k LIKE/i);
  });

  it('**CERO backfill**: ni un UPDATE de datos, ni un INSERT de corridas inventadas', () => {
    // Regla que la 0174 dejó escrita. De las corridas anteriores no consta NADA por corrida —el KV
    // guardaba solo la última, machacada cada día—, así que fabricar una fila sería inventar un
    // intento que nadie observó. Y rellenar `vigente` porque la fila está `pagado` sería escribir
    // como hecho justo lo que este Feature existe para comprobar.
    expect(MAY).not.toMatch(/\bUPDATE\s+FLITO_SOAT\b/);
    expect(MAY).not.toMatch(/INSERT\s+INTO\s+FLITO_SOAT_VERIFICACION_CORRIDAS/);
    // El único DELETE del archivo es el del KV, nombrado arriba.
    expect([...MAY.matchAll(/\bDELETE\b/g)]).toHaveLength(1);
    expect(MAY).not.toContain('TRUNCATE');
  });

  it('la consulta al KV va dentro de un `IF EXISTS` sobre la tabla (plpgsql resuelve al ejecutar)', () => {
    expect(SQL).toMatch(/information_schema\.tables/i);
    expect(SQL).toMatch(/table_name = 'system_kv'/i);
  });

  it('no lleva control de transacción propio — medido con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it('la segunda pasada no cambia ni una fila: todo lleva `IF NOT EXISTS` o `IF EXISTS`', () => {
    const adds = [...SQL.matchAll(/ADD COLUMN( IF NOT EXISTS)?/gi)];
    expect(adds).toHaveLength(4);
    for (const a of adds) expect(a[1], 'un ADD COLUMN sin IF NOT EXISTS').toBeDefined();
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    const indices = [...SQL.matchAll(/CREATE (UNIQUE )?INDEX( IF NOT EXISTS)?/gi)];
    expect(indices).toHaveLength(2);
    for (const i of indices) expect(i[2], 'un CREATE INDEX sin IF NOT EXISTS').toBeDefined();
  });
});

describe('paridad `.sql` ↔ `schema.ts` — que las dos verdades sean la misma', () => {
  it('`flito_soat` declara las cuatro columnas con el nombre desambiguado', () => {
    const cols = columnasDe(flitoSoat);
    expect(cols).toEqual(expect.arrayContaining(['estado_vigencia', 'verificada_en', 'vence_el', 'poliza_runt']));
    // Y las de siempre siguen ahí: sin este aserto, «están las cuatro» pasaría también si alguien se
    // llevara media tabla por delante.
    expect(cols).toEqual(expect.arrayContaining(['estado', 'numero_poliza', 'updated_at']));
  });

  it('**el CHECK está en `schema.ts` y no solo en la base** (lección de la 0157)', () => {
    const dialecto = new PgDialect();
    const checks = getTableConfig(flitoSoat).checks;
    const chk = checks.find((c) => c.name === 'flito_soat_estado_vigencia_chk');
    expect(chk, 'el CHECK solo vive en la migración').toBeDefined();
    const rendered = dialecto.sqlToQuery(chk!.value).sql;
    // Un CHECK que solo vive en la base convence a quien lee `schema.ts` de que añadir un valor no
    // necesita migración, y el primer INSERT con el valor nuevo muere con 23514.
    for (const v of ESTADOS_VIGENCIA_SOAT) expect(rendered).toContain(`'${v}'`);
    expect(rendered).not.toContain("'vencido'");
  });

  it('el CHECK de `schema.ts` dice EXACTAMENTE los mismos valores que el `.sql`', () => {
    const dialecto = new PgDialect();
    const chk = getTableConfig(flitoSoat).checks.find((c) => c.name === 'flito_soat_estado_vigencia_chk')!;
    const enTs = [...dialecto.sqlToQuery(chk.value).sql.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const enSql = [...SQL.match(/CHECK \(estado_vigencia IN \(([^)]*)\)\)/i)![1].matchAll(/'([^']+)'/g)]
      .map((m) => m[1]).sort();
    // MUTANTE — ampliar uno y no el otro. El fallo se vería en producción, no aquí, y con un 23514.
    expect(enTs).toEqual(enSql);
  });

  it('la tabla de corridas existe en `schema.ts` con su índice único de DOS columnas', () => {
    expect(schema).toHaveProperty('flitoSoatVerificacionCorridas');
    const cfg = getTableConfig(flitoSoatVerificacionCorridas);
    expect(cfg.name).toBe('flito_soat_verificacion_corridas');
    const uq = cfg.indexes.find((i) => i.config.name === 'uq_flito_soat_verif_corrida_dia_intento');
    expect(uq, 'falta el índice único').toBeDefined();
    expect(uq!.config.unique).toBe(true);
    expect(uq!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['dia', 'intento']);
  });

  it('`flito_soportes` declara el índice del censo, y NO como único', () => {
    const idx = getTableConfig(flitoSoportes).indexes
      .find((i) => i.config.name === 'idx_flito_soportes_soat_tipo');
    expect(idx, 'falta el índice del censo en schema.ts').toBeDefined();
    expect(idx!.config.unique).toBe(false);
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['soat_id', 'tipo']);
  });

  it('**`schema.ts` tampoco declara el índice de antigüedad**: la ausencia es la misma en los dos', () => {
    const idx = getTableConfig(flitoSoat).indexes
      .find((i) => i.config.name === 'idx_flito_soat_verificada_en');
    // Un índice declarado aquí y ausente en la base (o al revés) es un plan de consulta que nadie
    // puede reproducir en local, y en este caso además reintroduciría uno que se midió inerte.
    expect(idx, 'el índice retirado volvió a schema.ts sin volver a la migración').toBeUndefined();
    // Control positivo del recorte: los índices que la tabla SÍ tiene siguen ahí, así que este
    // `toBeUndefined()` no está pasando porque `getTableConfig` haya dejado de ver los índices.
    const nombres = getTableConfig(flitoSoat).indexes.map((i) => i.config.name);
    expect(nombres).toEqual(expect.arrayContaining(['idx_flito_soat_estado', 'idx_flito_soat_compania']));
  });

  it('`system_kv` sigue existiendo: lo que se retira es UNA clave, no la tabla', () => {
    // La usan el sync de FLIT y la salud del reconciliador. Borrarla «ya que estamos» sería llevarse
    // por delante procesos que esta HU no toca.
    expect(schema).toHaveProperty('systemKv');
    expect(SQL).not.toMatch(/DROP TABLE[^;]*system_kv/i);
  });
});
