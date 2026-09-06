// HU #12080 (Feature #12074) — invariantes de la migración 0176, la que retira del MODELO DE DATOS
// el circuito de revisión del canal Cliente.
//
// ── Por qué esta migración merece un guarda y no basta con «aplicó bien en local» ────────────────
//
// Es una migración DESTRUCTIVA: recrea un enum quitándole dos valores, borra dos columnas y borra una
// tabla. Ninguna de esas cuatro cosas se puede deshacer con otra migración, y una de las columnas
// (`observacion_rechazo`) contiene texto libre escrito por empleados sobre casos de terceros. La
// diferencia entre «se aplicó» y «se aplicó bien» aquí es la diferencia entre una retirada ordenada
// y una pérdida de datos que nadie decidió.
//
// Los mutantes que este archivo tiene que matar, nombrados:
//
//   · **El guarda de filas quitado, o convertido en aviso.** Sin él, un entorno con solicitudes
//     todavía en `pendiente_revision` las perdería —el `USING estado::text::…` fallaría, sí, pero con
//     un error de casteo ilegible en vez del recuento que dice cuántas hay y qué hacer con ellas—.
//   · **El guarda comparando `estado = 'pendiente_revision'` en vez de `estado::text = '…'`.** El
//     literal solo es válido mientras el valor exista en el tipo: en la SEGUNDA pasada el propio
//     guarda moriría con 22P02, o sea el archivo fallaría por su comprobación y no por lo que
//     comprueba.
//   · **El `DROP DEFAULT` quitado o movido detrás del RENAME.** Es el paso que la 0101 tiene y que
//     parece sobrar. MEDIDO quitándolo contra la BD local: falla el `ALTER COLUMN ... TYPE` —no el
//     `DROP TYPE` del final— con `42804: default for column "estado" cannot be cast automatically to
//     type flito_soat_estado`. El error se cita tal cual porque la suposición cómoda es la otra (un
//     2BP01 al soltar el tipo viejo) y no es la que ocurre.
//   · **`DROP TABLE ... CASCADE`.** Funcionaría en una línea y se llevaría la columna EN SILENCIO: la
//     migración diría «borro un catálogo» mientras suprime datos personales sin nombrarlos.
//   · **La tabla borrada ANTES que la columna que la referencia** (la FK lo impide, pero el orden en
//     el archivo es lo que hace que el fallo no dependa de cuándo se lea).
//   · **Un `UPDATE` de saneo o un `DELETE` sobre el historial**, que serían decidir por el negocio y
//     destruir la trazabilidad del período en que el circuito existió.
//   · **Control de transacción propio** (ADR-DB-001), con el guarda REAL del runner.
//   · **Que `schema.ts` y el `.sql` dejen de decir lo mismo**, que es la paridad de todas sus
//     hermanas: el enum sin los dos valores, la tabla fuera y las dos columnas fuera.
//
// Análisis estático puro: NO toca la base. Se lee de disco el `.sql` y de `schema.ts` los objetos de
// drizzle. Que la migración esté REALMENTE aplicada lo dice el `db:apply` del CD.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema.js';
import { flitoSoatEstadoEnum, flitoSoatSolicitud } from '../../src/db/schema.js';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const ARCHIVO = '0176_flito_soat_retirar_estados_revision.sql';
const CRUDO = readFileSync(
  fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url)), 'utf8',
);

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin entrar en las cadenas.
 *
 * Imprescindible en ESTA migración más que en ninguna: su cabecera EXPLICA en prosa justo lo que el
 * archivo NO hace —`CASCADE`, `UPDATE` de saneo, `DELETE` sobre el historial— y sin podarla cada
 * comprobación negativa de abajo sería roja por su propia documentación. Copiado de la 0165/0170.
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

/** Dónde empieza cada statement clave, para poder afirmar sobre el ORDEN y no solo la presencia. */
const posicion = (re: RegExp): number => {
  const m = SQL.match(re);
  expect(m, `no se encontró ${re}`).not.toBeNull();
  return m!.index!;
};

describe('migración 0176 — el guarda: nada vivo en los dos estados que se retiran', () => {
  it('**aborta con RAISE EXCEPTION si queda alguna fila**, y no con un aviso', () => {
    // Un `RAISE NOTICE` aquí sería peor que nada: dejaría constancia del problema en un log que
    // nadie lee mientras la migración sigue adelante y el casteo revienta tres líneas después.
    expect(SQL).toMatch(/RAISE\s+EXCEPTION/i);
    expect(SQL).toMatch(/IF\s*\(\s*n_pendiente_revision\s*\+\s*n_rechazada\s*\)\s*>\s*0\s+THEN/i);
  });

  it('**cuenta comparando `estado::text`**, no contra el literal del enum', () => {
    // El porqué está en la cabecera del archivo: comparar con `estado = 'pendiente_revision'` exige
    // que el valor exista en el TIPO, así que en la segunda pasada —con el tipo ya recreado— el
    // guarda moriría con 22P02 antes de comprobar nada. Por texto no depende del tipo.
    for (const estado of ['pendiente_revision', 'rechazada']) {
      expect(SQL).toMatch(new RegExp(`estado::text\\s*=\\s*'${estado}'`, 'i'));
      // Y la forma frágil NO está en ninguna parte del archivo.
      expect(SQL).not.toMatch(new RegExp(`estado\\s*=\\s*'${estado}'`, 'i'));
    }
  });

  it('el mensaje del abort dice CUÁNTAS hay de cada una y el total, no «hay filas»', () => {
    // Dos que se resuelven por teléfono y doscientas que son un problema de proceso se atienden de
    // maneras distintas, y quien lee el log del CD tiene que poder distinguirlas sin abrir psql.
    const abort = SQL.slice(posicion(/RAISE\s+EXCEPTION/i));
    // Tres `%` y sus tres argumentos: total, pendiente_revision y rechazada.
    expect((abort.match(/%/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(abort).toMatch(/n_pendiente_revision\s*\+\s*n_rechazada\s*,\s*n_pendiente_revision\s*,\s*n_rechazada/);
    // Y dice qué hacer: resolverlas con la versión ANTERIOR del API, que es la que tiene las rutas.
    expect(abort).toMatch(/ANTERIOR del API/);
  });

  it('avisa cuántas observaciones de rechazo se van a suprimir (la decisión de PII, al log del CD)', () => {
    expect(SQL).toMatch(/RAISE\s+NOTICE/i);
    expect(SQL).toMatch(/observacion_rechazo\s+IS\s+NOT\s+NULL/i);
  });

  it('la decisión de PII está ESCRITA en la cabecera, con sus palabras', () => {
    // Va contra el CRUDO —es un comentario— y es la única comprobación de este archivo que mira
    // prosa. Se justifica: el AC pide que la supresión sin exportar sea una decisión declarada y
    // reversible SOLO antes de aplicar. Una migración destructiva sin ese párrafo es la que nadie
    // sabe si alguien pensó.
    expect(CRUDO).toMatch(/texto libre/i);
    expect(CRUDO).toMatch(/se suprime/i);
    expect(CRUDO).toMatch(/sin exportar ni archivar/i);
    expect(CRUDO).toMatch(/ANTES de aplicar/i);
  });
});

describe('migración 0176 — la recreación del enum, calcada de la 0101', () => {
  it('**el `DROP DEFAULT` va ANTES del recasteo**: sin él, el `ALTER COLUMN ... TYPE` muere con 42804', () => {
    const dropDefault = posicion(/ALTER TABLE flito_soat ALTER COLUMN estado DROP DEFAULT/i);
    const rename = posicion(/ALTER TYPE flito_soat_estado RENAME TO flito_soat_estado_old/i);
    const alterTipo = posicion(/ALTER COLUMN estado TYPE flito_soat_estado USING/i);
    expect(dropDefault).toBeLessThan(rename);
    // Lo que de verdad importa: antes del recasteo, que es DONDE falla si no está (42804 medido).
    expect(dropDefault).toBeLessThan(alterTipo);
  });

  it('crea el tipo con los CUATRO valores y con ninguno más', () => {
    const m = SQL.match(/CREATE TYPE flito_soat_estado AS ENUM \(([^)]*)\)/i);
    expect(m, 'falta el CREATE TYPE').not.toBeNull();
    const valores = [...m![1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort();
    expect(valores).toEqual(['con_novedad', 'pagado', 'pendiente', 'solicitado']);
  });

  it('recastea por TEXTO y devuelve el default, y borra el tipo viejo al final', () => {
    expect(SQL).toMatch(/ALTER COLUMN estado TYPE flito_soat_estado USING estado::text::flito_soat_estado/i);
    const setDefault = posicion(/ALTER COLUMN estado SET DEFAULT 'pendiente'/i);
    const dropType = posicion(/DROP TYPE flito_soat_estado_old/i);
    // El default se repone ANTES de soltar el tipo viejo; si no, la columna se queda sin default.
    expect(setDefault).toBeLessThan(dropType);
  });
});

describe('migración 0176 — las columnas, la tabla y lo que NO hace', () => {
  it('**borra las dos columnas ANTES de borrar la tabla** que una de ellas referencia', () => {
    const columnas = posicion(/DROP COLUMN IF EXISTS causal_rechazo_id/i);
    const tabla = posicion(/DROP TABLE IF EXISTS flito_soat_causales_rechazo/i);
    expect(columnas).toBeLessThan(tabla);
    expect(SQL).toMatch(/DROP COLUMN IF EXISTS observacion_rechazo/i);
  });

  it('**ni un `CASCADE` en todo el archivo**: lo que se borra se nombra', () => {
    // `DROP TABLE ... CASCADE` se llevaría `causal_rechazo_id` por delante sin nombrarla, y con ella
    // una columna de datos personales suprimida como efecto colateral de otra frase.
    expect(MAY).not.toContain('CASCADE');
  });

  it('no hay `UPDATE` de saneo ni `DELETE`: mover filas sería decidir por el negocio', () => {
    expect(MAY).not.toContain('UPDATE ');
    expect(MAY).not.toContain('DELETE');
    expect(MAY).not.toContain('TRUNCATE');
    // Y el historial no se toca: sus columnas son `varchar(30)`, no este enum, así que no bloquean
    // nada y borrarlas destruiría el rastro del período en que el circuito existió.
    expect(SQL).not.toMatch(/flito_estado_historial/i);
  });

  it('la segunda pasada no muere: los tres DROP llevan `IF EXISTS`', () => {
    const drops = [...SQL.matchAll(/DROP (COLUMN|TABLE)\s+(IF EXISTS\s+)?/gi)];
    expect(drops.length).toBe(3);
    for (const d of drops) expect(d[2], `un DROP ${d[1]} sin IF EXISTS`).toBeDefined();
  });

  it('deja al día los DOS comentarios que dejaban de ser verdad: el de la tabla y el de `origen`', () => {
    // El de la TABLA es el evidente.
    expect(SQL).toMatch(/COMMENT ON TABLE flito_soat_solicitud IS/i);
    const tabla = SQL.slice(posicion(/COMMENT ON TABLE flito_soat_solicitud IS/i));
    expect(tabla).toMatch(/#12080/);

    // **El de la COLUMNA `flito_soat.origen` es el que se escapa**, y por eso tiene aserto propio:
    // lo fijó la 0167 —otra migración, ya aplicada y congelada—, vive en la base desde entonces y
    // nada en este repo lo vuelve a nombrar. Decía que «el detalle del rechazo vive fuera, en
    // flito_soat_solicitud», que tras esta migración es falso. No es prosa decorativa: es la
    // justificación de por qué `origen` es la única columna del canal en una tabla cuya fila ENTERA
    // se le sirve al gestor del proveedor, o sea una decisión de exposición.
    expect(SQL).toMatch(/COMMENT ON COLUMN flito_soat\.origen IS/i);
    const columna = SQL.slice(posicion(/COMMENT ON COLUMN flito_soat\.origen IS/i));
    // Ya no afirma que el detalle del rechazo viva en el satélite...
    expect(columna).not.toMatch(/detalle del rechazo viven fuera/i);
    // ...y sí dice qué pasó con él y qué sigue viviendo fuera (la PII del propietario).
    expect(columna).toMatch(/0176|#12080/);
    expect(columna).toMatch(/flito_compradores/);
  });

  it('no lleva control de transacción propio — medido con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });
});

describe('paridad `.sql` ↔ `schema.ts` — que las dos verdades sean la misma', () => {
  it('el enum de Drizzle ya no declara los dos estados del canal', () => {
    // El mutante que mata: revertir `schema.ts` sin revertir la migración. Drizzle construiría el
    // WHERE con un literal que el tipo de Postgres ya no acepta → 22P02 en cada llamada.
    expect([...flitoSoatEstadoEnum.enumValues].sort())
      .toEqual(['con_novedad', 'pagado', 'pendiente', 'solicitado']);
  });

  it('`flito_soat_causales_rechazo` no existe en `schema.ts`', () => {
    // Se pregunta por el módulo entero y no por el símbolo, para que el import no tenga que citar
    // algo que ya no está. Una tabla declarada aquí y ausente en la base es un `getTableConfig`
    // verde y un 42P01 en producción.
    expect(schema).not.toHaveProperty('flitoSoatCausalesRechazo');
  });

  it('el satélite ya no declara las dos columnas del rechazo, y CONSERVA las del revisor', () => {
    const columnas = getTableConfig(flitoSoatSolicitud).columns.map((c) => c.name);
    expect(columnas).not.toContain('causal_rechazo_id');
    expect(columnas).not.toContain('observacion_rechazo');
    // La otra mitad: la migración NO borra el rastro del revisor ni el contador de reenvíos, y por
    // eso `schema.ts` tiene que seguir declarándolos. Sin este aserto, «no están las dos» pasaría
    // también si alguien se llevara la mitad de la tabla por delante.
    for (const c of ['revisado_por_id', 'revisado_por_nombre', 'revisado_en', 'reenvios']) {
      expect(columnas, `${c} desapareció: la 0176 no la borra`).toContain(c);
    }
  });

  it('el índice de la causal tampoco: cae con su columna', () => {
    const indices = getTableConfig(flitoSoatSolicitud).indexes.map((i) => i.config.name);
    expect(indices).not.toContain('idx_flito_soat_solicitud_causal');
  });
});
