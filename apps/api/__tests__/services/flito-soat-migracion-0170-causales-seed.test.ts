// HU #11915 (Feature #11912) — guarda de contrato de la migración 0170, el SEED del catálogo de
// causales de rechazo.
//
// **Por qué una semilla merece un test y un `CREATE TABLE` casi no.** Una tabla que no se crea falla
// ruidosamente en el primer `INSERT`; una semilla que no se siembra —o que se siembra dos veces— no
// falla en ninguna parte. Sin filas, `POST /:id/rechazar-solicitud` responde siempre `400
// causal_invalida` y el AC2 es inejecutable sin que nada esté roto; con filas duplicadas, el
// desplegable enseña la misma causal dos veces y el reporte por causal parte los números.
//
// Qué mutaciones se cazan aquí:
//
//   · **`ON CONFLICT` quitado o cambiado de columna.** La segunda pasada aborta con 23505 y para la
//     cadena de migraciones entera en el CD.
//   · **`DO UPDATE` en vez de `DO NOTHING`.** Cada pasada reescribiría `updated_at` y pisaría lo que
//     un administrador hubiera reordenado o desactivado a mano.
//   · **La semilla convertida en un `DELETE` + `INSERT`** («para que quede como el archivo»), que
//     rompería las FK de los rechazos ya registrados.
//   · **Control de transacción propio en el archivo** — el mismo guarda que aplica el runner.
//   · **Que el archivo toque el ESQUEMA.** La 0170 es datos y nada más: si alguien mete aquí un
//     `ALTER TABLE`, deja de ser reproducible como semilla.
//
// Y la paridad que el repo no vigila en ninguna otra parte: que los nombres sembrados quepan en
// `varchar(120)`. Un nombre de 121 caracteres no lo detecta ningún compilador y muere con 22001 en
// mitad del despliegue.
//
// Análisis estático puro: NO toca la base.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoSoatCausalesRechazo } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0170_flito_soat_causales_rechazo_seed.sql';
const CRUDO = readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url)), 'utf8');

/**
 * Quita los comentarios `--` conservando los saltos de línea, sin entrar en las cadenas.
 *
 * No es cosmético aquí más que en ninguna otra migración: la cabecera de la 0170 EXPLICA en prosa lo
 * que NO hace —`DO UPDATE`, las causales descartadas— y sin podarla esa explicación alimentaría las
 * comprobaciones de lo que sí se hizo. Copiado de la guarda de la 0169.
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

/** Los nombres sembrados, tal como los lee Postgres (primer literal de cada tupla). */
const NOMBRES = [...SQL.matchAll(/\(\s*'((?:[^']|'')*)'\s*,\s*\d+\s*\)/g)].map((m) => m[1].replace(/''/g, "'"));

describe('migración 0170 — la semilla del catálogo de causales', () => {
  it('**inserta en `flito_soat_causales_rechazo` y siembra al menos una causal**', () => {
    expect(SQL).toMatch(/INSERT INTO\s+flito_soat_causales_rechazo\s*\(\s*nombre\s*,\s*orden\s*\)/i);
    expect(NOMBRES.length).toBeGreaterThan(0);
  });

  it('**es idempotente en el sentido fuerte: `ON CONFLICT (nombre) DO NOTHING`**', () => {
    // `(nombre)` y no `DO NOTHING` a secas: el conflicto tiene que resolverse contra
    // `uq_flito_soat_causales_nombre`, que es el índice que la 0167 creó. Un `ON CONFLICT` sin
    // columna funcionaría hoy por casualidad y dejaría de hacerlo con el segundo índice único.
    expect(SQL).toMatch(/ON CONFLICT\s*\(\s*nombre\s*\)\s*DO NOTHING/i);
    // `DO UPDATE` reescribiría `updated_at` en cada pasada y pisaría lo reordenado a mano.
    expect(SQL.toUpperCase()).not.toContain('DO UPDATE');
  });

  it('no borra nada: una semilla siembra, no vuelve a plantar encima', () => {
    // Un `DELETE` aquí rompería la FK `flito_soat_solicitud.causal_rechazo_id` de los rechazos ya
    // registrados, o —peor— los dejaría apuntando a una causal recreada con otro uuid.
    expect(SQL.toUpperCase()).not.toContain('DELETE');
    expect(SQL.toUpperCase()).not.toContain('TRUNCATE');
  });

  it('es SOLO datos: ni una línea de esquema', () => {
    for (const prohibido of ['CREATE TABLE', 'ALTER TABLE', 'DROP', 'ALTER TYPE', 'CREATE INDEX', 'GRANT']) {
      expect(SQL.toUpperCase()).not.toContain(prohibido);
    }
  });

  it('no lleva control de transacción propio — medido con el guarda REAL del runner', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it('**cada nombre cabe en la columna** (`varchar(120)`): un 121 muere con 22001 en el despliegue', () => {
    const { columns } = getTableConfig(flitoSoatCausalesRechazo);
    const nombre = columns.find((c) => c.name === 'nombre');
    expect(nombre, 'schema.ts declara la columna `nombre`').toBeDefined();
    const maximo = (nombre as unknown as { size?: number; length?: number }).size
      ?? (nombre as unknown as { length?: number }).length ?? 120;
    for (const n of NOMBRES) expect(n.length, `"${n}" no cabe`).toBeLessThanOrEqual(maximo);
  });

  it('los nombres son ÚNICOS en el propio archivo: con el `DO NOTHING`, un duplicado se pierde en silencio', () => {
    expect(new Set(NOMBRES).size).toBe(NOMBRES.length);
  });

  it('**cada causal es una frase que se le puede leer al cliente**, no una etiqueta interna', () => {
    // El `nombre` se le pinta al Cliente LITERAL y sin prefijo en «Por qué se rechazó»
    // (`CorreccionSolicitud.tsx`). Es el criterio del doc de UX §6.3 y la razón de que la lista sea
    // contenido de negocio: un sustantivo suelto («Datos», «Documentación») no le dice qué corregir.
    for (const n of NOMBRES) {
      expect(n.trim().split(/\s+/).length, `"${n}" es demasiado corta para ser una frase`).toBeGreaterThanOrEqual(3);
      expect(n[0], `"${n}" tiene que empezar en mayúscula`).toBe(n[0].toUpperCase());
    }
  });
});
