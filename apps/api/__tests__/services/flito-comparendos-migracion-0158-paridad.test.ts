// FLITO comparendos — invariantes de la 0158, el mapa de homologación v2 (HU #11501, Feature #11492).
//
// Las paridades hermanas (0151, 0153-0156) comparan una migración DDL contra `schema.ts`. La 0158 no
// tiene con qué compararse ahí: es DML pura —siembra 35 filas en `flito_comparendos_field_map`— y su
// contraparte no es el esquema sino **el comportamiento del módulo**. Este archivo vigila eso.
//
// Por qué existe, en concreto. El gate de QA de la #11501 encontró que las filas de esta migración
// no estaban protegidas por nada: los tests de merge cargan mapas SINTÉTICOS (`MAPA_V1` y recortes),
// así que se puede podar una fila del `.sql` y el repo entero sigue verde. Estas son las mutaciones
// que se están cazando, todas plausibles y ninguna teórica:
//
//   · **Podar los respaldos municipales de prioridad baja** (`codigo`, `descripcion`, `fecha`,
//     `estado`) «porque no aparecen en el payload real». Son exactamente los nombres que emite el
//     mock del UTS, que es el modo POR DEFECTO: sin ellos, el escenario CF-08 del mock homologa a
//     NULL y el módulo parece vacío en cualquier ambiente sin credenciales. Por eso no se listan a
//     mano: se leen del propio mock (ver `clavesDelMock`), y si alguien cambia el mock SIN tocar el
//     mapa, este test se pone rojo por el otro lado.
//
//     **Contra qué se comprueba esa cobertura cambió en la HU #11877**: contra el mapa VIGENTE de la
//     cadena de migraciones, no contra la v2 de este archivo. El módulo lee la versión MÁXIMA y no
//     hereda (RN-11), así que exigirle la cobertura a una versión histórica era pedirle cuentas a
//     quien ya no decide nada — y se rompía sola en cuanto el mock estrenaba un campo que la v2 no
//     podía mapear, que es exactamente lo que pasó con `fechaNotificacion`.
//
//   · **«Restaurar» `comparendo` como candidato de `numeroComparendo` en SIMIT**, que es lo que hacía
//     la v1 y lo que haría cualquiera que compare las dos versiones sin leer la cabecera del `.sql`.
//     En el payload real ese campo es el BOOLEANO `true`; como `primerValor` devuelve el primer
//     candidato no nulo, un `true` SOMBREA a los siguientes y el ítem entero se descarta por «número
//     irreconocible». No es un respaldo: es un apagón silencioso de la ingesta.
//
//   · **Mapear `fechaNotificacion` EN LA v2**, que en la captura real trae el centinela `01/01/1900`.
//     Una fecha centinela homologada es peor que un `NULL`: se ve como un dato. Sigue siendo cierto
//     **de la v2**, y por eso el test se queda: cuando se escribió no había criterio para el
//     centinela. La v4 sí lo tiene (`fechaCanonica` lo descarta, HU #11794) y por eso ella sí la
//     mapea. Las dos afirmaciones conviven porque hablan de versiones distintas; lo que estaría mal
//     es «arreglar» la v2 añadiéndole la fila, que además es historial ya aplicado.
//
//   · **Añadir cualquier ruta de persona.** Esta tabla ES la lista blanca de la poda RN-25
//     (`camposConservables` se deriva de ella), así que nombrar aquí `infractor.*`, `nombres`,
//     `contraventores` o `estadoCuenta.direccion` no es documentar un campo: es ordenar que se
//     PERSISTA. Ley 1581.
//
//   · **Tocar la v1.** El merge lee la versión MÁXIMA y la v1 es el historial de lo que se creyó;
//     además `operaciones_app` no tiene `DELETE` sobre la tabla. La reversa documentada es sembrar
//     una v3, no borrar la v2.
//
// Análisis estático puro: NO toca la base. Se leen de disco el `.sql` y el cliente del UTS.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación: es literalmente lo
// que abortaría el `db:apply`.
import { scanForTxControl } from '../../src/scripts/db-apply.js';
// El extractor, el podador y el cálculo del mapa VIGENTE viven en un helper desde la HU #11877.
// Aquí estaba la tercera copia del mismo parser; tres copias son tres oportunidades de que una se
// quede atrás y su archivo pase por vacuidad.
import {
  filasSembradas, mapaVigenteSembrado, podarComentarios, rutaMigracion, type FilaFieldMap,
} from '../helpers/field-map-sql.js';

const ARCHIVO = '0158_flito_comparendos_field_map_v2.sql';
const RUTA = rutaMigracion(ARCHIVO);
const RUTA_MOCK = fileURLToPath(
  new URL('../../src/modules/flito-comparendos/clients/uts-municipal.client.ts', import.meta.url),
);

const sql0158 = readFileSync(RUTA, 'utf8');

// El podador es el del helper. Aquí importa más que en las paridades hermanas: la cabecera de la
// 0158 es larguísima y explica en prosa **lo que el archivo NO hace** —por qué `comparendo` no se
// mapea, por qué `fechaNotificacion` se deja fuera, qué campos son del infractor—. Sin podarla, el
// texto que dice «no se mapea `infractor`» alimentaría la búsqueda de `infractor` y volvería verde
// justo el test que existe para detectarlo.
const CUERPO = podarComentarios(sql0158);

// ─────────────────────────── Lectura de las filas sembradas ─────────────────────────────────────

const FILAS = filasSembradas(CUERPO);
const SIMIT = FILAS.filter((f) => f.origen === 'simit');
const MUNICIPAL = FILAS.filter((f) => f.origen === 'municipal');

/** Los `source_path` sembrados para un origen. */
const rutasDe = (filas: FilaFieldMap[]): string[] => filas.map((f) => f.sourcePath);

/**
 * Los nombres de campo que emite HOY el mock del UTS, leídos del cliente y no copiados aquí.
 *
 * Copiarlos a mano convertiría este test en una foto: alguien renombra `codigo` a `codigoInfraccion`
 * en el mock, el mapa deja de cubrirlo y la lista de este archivo seguiría diciendo que todo va bien.
 * Leyéndolos, la mutación se caza venga del lado que venga.
 */
function clavesDelMock(): string[] {
  const fuente = readFileSync(RUTA_MOCK, 'utf8');
  const bloque = /const items: ComparendoCrudoMunicipal\[\] = \[([\s\S]*?)\n {2}\];/.exec(fuente);
  expect(bloque, `no se supo leer el literal de ítems de respuestaSimulada en ${RUTA_MOCK}`)
    .not.toBeNull();
  const claves = new Set<string>();
  for (const m of bloque![1].matchAll(/^\s{6}(\w+):/gm)) claves.add(m[1]);
  return [...claves];
}

const CLAVES_MOCK = clavesDelMock();

// ─────────────────────────── Guardarraíl: ¿el extractor leyó algo? ──────────────────────────────

describe('migración 0158 — los extractores leen los archivos', () => {
  // Va primero: si los regex dejaran de casar, todas las comprobaciones de abajo pasarían por
  // vacuidad — `[].every(...)` es `true` y `expect([]).not.toContain(x)` también pasa.
  it('el .sql siembra las 35 filas de la v2 (17 SIMIT + 18 municipal)', () => {
    expect(FILAS).toHaveLength(35);
    expect(SIMIT).toHaveLength(17);
    expect(MUNICIPAL).toHaveLength(18);
  });

  it('el mock del UTS declara sus 9 campos y se leen del cliente, no de aquí', () => {
    // Nueve desde la HU #11877, que le añadió `fechaNotificacion`: sin ese campo el modo simulado
    // —que es el DEFECTO— dejaba la columna vacía por construcción y la funcionalidad no era
    // comprobable por ningún camino que se ejecutara de verdad.
    expect(CLAVES_MOCK).toHaveLength(9);
    expect(CLAVES_MOCK).toContain('numero');
    expect(CLAVES_MOCK).toContain('valor');
    expect(CLAVES_MOCK).toContain('fechaNotificacion');
  });
});

// ─────────────────────────── Lo que la v2 tiene que decir ───────────────────────────────────────

describe('la 0158 siembra la v2 completa y no provisional', () => {
  it('**todas las filas son version=2 y provisional=false**', () => {
    // `provisional=false` no es cosmético: es lo que declara que el mapa salió de payloads reales.
    expect(FILAS.every((f) => f.version === 2)).toBe(true);
    expect(FILAS.every((f) => f.provisional === false)).toBe(true);
  });

  it('las dos fuentes tienen candidato de prioridad 1 para `numeroComparendo`', () => {
    // Sin número el ítem se descarta entero (`homologar` devuelve null y `acumular` lo cuenta como
    // ignorado). Degradar esta fila a prioridad 2 detrás de un candidato ausente no rompe nada
    // visible, pero adelgaza la llave de negocio (CF-07).
    for (const filas of [SIMIT, MUNICIPAL]) {
      const primeros = filas.filter((f) => f.targetField === 'numeroComparendo' && f.prioridad === 1);
      expect(primeros).toHaveLength(1);
    }
  });

  it('**el mapa VIGENTE cubre TODOS los campos que emite el mock del UTS** (CF-08 sigue vivo)', () => {
    // La razón de ser de este archivo, con el ancla corregida en la HU #11877.
    //
    // La invariante es la misma y sigue siendo la buena: si alguien poda los respaldos de prioridad
    // baja porque «no aparecen en el payload real», el modo mock —que es el DEFECTO— homologa a NULL
    // en silencio. Lo que estaba mal era contra QUÉ se evaluaba. El módulo NO lee la v2: lee la
    // versión MÁXIMA y **no hereda** (RN-11), así que quien tiene que cubrir el mock es el mapa
    // vigente, no la versión que estaba vigente el día que se escribió este archivo.
    //
    // Y la diferencia no es teórica: la #11877 añadió `fechaNotificacion` al mock del UTS —la v4 la
    // mapea desde la #11794; la v2 no podía, porque el criterio del centinela no existía— y este
    // test se puso rojo afirmando algo que ya no era el contrato de nadie. Anclarlo aquí lo vuelve
    // permanente: cubra el mock la versión que lo tenga que cubrir.
    //
    // Lo que la v2 sí tiene que seguir diciendo se vigila abajo, intacto: en ELLA `fechaNotificacion`
    // no se mapea. Las dos cosas son ciertas a la vez porque hablan de versiones distintas.
    const vigente = mapaVigenteSembrado();
    const rutasVigentes = rutasDe(vigente.filas.filter((f) => f.origen === 'municipal'));

    for (const clave of CLAVES_MOCK) {
      expect(
        rutasVigentes,
        `el mock emite \`${clave}\` y la v${vigente.version} (${vigente.archivos.join(', ')}) no lo mapea`,
      ).toContain(clave);
    }
  });

  it('los cuatro respaldos que sostienen el mock apuntan al campo canónico correcto', () => {
    // Cubrir el nombre no basta: `codigo` mapeado a `estadoFuente` pasaría el test de arriba y
    // seguiría rompiendo CF-08.
    const esperado: Record<string, string> = {
      codigo: 'codigoInfraccion',
      descripcion: 'descripcionInfraccion',
      fecha: 'fechaComparendo',
      estado: 'estadoFuente',
    };
    for (const [ruta, destino] of Object.entries(esperado)) {
      const fila = MUNICIPAL.find((f) => f.sourcePath === ruta);
      expect(fila, `falta el respaldo municipal \`${ruta}\``).toBeDefined();
      expect(fila!.targetField).toBe(destino);
    }
  });

  it('el organismo municipal se saca de `estadoCuenta.secretaria`, que es la hoja autorizada', () => {
    const organismo = MUNICIPAL.filter((f) => f.targetField === 'organismo');
    expect(rutasDe(organismo)).toContain('estadoCuenta.secretaria.nombreAutoridadTransito');
    // La ruta al objeto entero arrastraría `estadoCuenta.direccion` a la lista blanca.
    expect(rutasDe(organismo)).not.toContain('estadoCuenta.secretaria');
    expect(rutasDe(organismo)).not.toContain('estadoCuenta');
  });
});

// ─────────────────────────── Lo que la v2 NO puede decir ────────────────────────────────────────

describe('la 0158 y lo que deliberadamente deja fuera', () => {
  it('**`comparendo` NO es candidato en SIMIT**: es el booleano `true` y sombrearía al número', () => {
    // `primerValor` devuelve el primer candidato NO nulo. Un `true` en esa posición no es un
    // respaldo, es un apagón: el ítem entero se descarta por «número irreconocible».
    expect(rutasDe(SIMIT)).not.toContain('comparendo');
  });

  it('**`fechaNotificacion` NO se mapea**: trae centinelas `01/01/1900`', () => {
    expect(rutasDe(SIMIT)).not.toContain('fechaNotificacion');
    expect(rutasDe(MUNICIPAL)).not.toContain('fechaNotificacion');
  });

  it('**ninguna ruta de persona entra en la lista blanca** (RN-25, Ley 1581)', () => {
    // Esta tabla ES la lista blanca de la poda: nombrar aquí un campo de persona no lo documenta,
    // ordena que se persista en `payload_simit` / `payload_municipal`.
    const prohibidos = [
      'infractor', 'nombres', 'apellidos', 'contraventores', 'direccion', 'identificador', 'cedula',
    ];
    for (const fila of FILAS) {
      for (const p of prohibidos) {
        expect(
          fila.sourcePath.toLowerCase(),
          `\`${fila.sourcePath}\` (${fila.origen}) contiene \`${p}\``,
        ).not.toContain(p);
      }
    }
  });

  it('`valorConDescuento50` no se mapea a `monto`: es una proyección, no la deuda', () => {
    // Sobre los `source_path` PARSEADOS y no sobre el texto del archivo: el nombre aparece —y debe
    // aparecer— dentro de la nota de la fila de `valor`, que es justamente donde se explica que no
    // se mapea. Buscarlo en el texto crudo confundiría la explicación con el hecho.
    expect(rutasDe(FILAS)).not.toContain('proyeccionMultaDTO.valorConDescuento50');
    expect(FILAS.some((f) => f.sourcePath.includes('valorConDescuento'))).toBe(false);
  });
});

// ─────────────────────────── Invariantes del archivo ────────────────────────────────────────────

describe('la 0158 como archivo: lo que puede y lo que no puede contener', () => {
  it('**no declara control de transacción** — con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, sql0158)).toEqual([]);
  });

  it('**es idempotente**: lleva su `ON CONFLICT ... DO NOTHING`', () => {
    // La cadena se re-aplica en cualquier ambiente que vaya por detrás; sin esto la segunda pasada
    // aborta con un 23505 y deja parado el `db:apply`.
    expect(CUERPO).toMatch(/ON CONFLICT \(\s*version\s*,\s*origen\s*,\s*source_path\s*\) DO NOTHING/i);
  });

  it('**no toca la v1**: ni la borra, ni la actualiza, ni siembra otra versión', () => {
    // El merge lee la versión MÁXIMA, así que la v2 manda por existir. Borrar la v1 destruiría el
    // historial de lo que se creyó — y `operaciones_app` ni siquiera tiene `DELETE` (0150).
    const cuerpo = CUERPO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(cuerpo).not.toMatch(/\bUPDATE\s+FLITO_COMPARENDOS_FIELD_MAP\s+SET\b/);
    expect(cuerpo).not.toMatch(/\bTRUNCATE\b/);
    expect(new Set(FILAS.map((f) => f.version))).toEqual(new Set([2]));
  });

  it('no altera la forma de la tabla: eso lo fijó la 0150', () => {
    const cuerpo = CUERPO.toUpperCase();
    expect(cuerpo).not.toMatch(/\bADD COLUMN\b/);
    expect(cuerpo).not.toMatch(/\bDROP\b/);
    expect(cuerpo).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
  });
});
