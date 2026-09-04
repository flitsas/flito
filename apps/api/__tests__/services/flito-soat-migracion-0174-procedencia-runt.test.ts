// HU #12093 (Feature #12073) — guarda de contrato de la migración 0174: la procedencia de cada dato
// del propietario y la fecha en que respondió el RUNT.
//
// Análisis estático puro: NO toca la base. P6 —aplicar el SQL DOS VECES contra la BD local— vive en
// el HANDOFF del backend-agent, no aquí: un test que abriera una conexión no correría en CI.
//
// Lo que estas suites afirman, por orden de lo que costaría más caro si dejara de ser verdad:
//
//   1. **`procedencia` es `jsonb NOT NULL DEFAULT '{}'` y `runt_consultado_en` es `timestamptz`
//      NULLABLE.** Es el AC1 letra por letra. Un `NOT NULL DEFAULT now()` en la fecha escribiría en
//      la base el instante de la MIGRACIÓN como si fuera una consulta al registro nacional.
//   2. **Cero backfill.** Ni un `UPDATE`. De las solicitudes ya radicadas no consta ni cuándo
//      respondió el RUNT ni de dónde salió cada dato: rellenarlo sería escribir una suposición.
//   3. **Idempotencia real** (P6): `ADD COLUMN IF NOT EXISTS` ×2 y `COMMENT ON COLUMN` ×2, que es
//      idempotente por definición. Ningún `ADD CONSTRAINT`, que es lo que obliga al patrón
//      `DROP IF EXISTS` + `ADD` de la 0172.
//   4. **Paridad con `schema.ts`**, por la lección de la 0157: una columna que solo vive en la base
//      convence a quien lee `schema.ts` de que no hace falta migración.
//   5. **La 0173 no se reescribe** — ya está aplicada y su sha256 registrado en
//      `_kyverum_applied_migrations`. Se comprueba leyéndola: si alguien la editara, este test cae.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { CAMPOS_COMPRADOR_FACTURA, PROCEDENCIAS_DATO } from '@operaciones/shared-types';
import { flitoCompradores, flitoSoatSolicitud } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0174_flito_soat_procedencia_runt_consultado.sql';
const leer = (nombre: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${nombre}`, import.meta.url)), 'utf8');

const CRUDO = leer(ARCHIVO);

/**
 * Quita los comentarios `--` sin tocar lo que va dentro de una cadena. Calcado de la suite de la
 * 0172 y por el mismo motivo: media docena de afirmaciones de este archivo son sobre lo que el SQL
 * **no** dice (`UPDATE`, `NOT NULL` en la fecha), y la prosa de la cabecera de la migración las
 * nombra todas para explicar por qué no están. Sin podar, cada negación sería verde por el
 * comentario que la justifica.
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

describe('migración 0174 — las dos columnas de la HU #12093', () => {
  it('no lleva control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it('**`flito_soat_solicitud.runt_consultado_en timestamptz`, con IF NOT EXISTS**', () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+flito_soat_solicitud\s+ADD COLUMN IF NOT EXISTS\s+runt_consultado_en timestamptz\s*;/i,
    );
  });

  it('**`flito_compradores.procedencia jsonb NOT NULL DEFAULT \'{}\'`, con IF NOT EXISTS**', () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+flito_compradores\s+ADD COLUMN IF NOT EXISTS\s+procedencia jsonb NOT NULL DEFAULT '\{\}'(::jsonb)?\s*;/i,
    );
  });

  it('**la fecha NO es NOT NULL y NO trae DEFAULT** — no se inventa un instante que nadie observó', () => {
    // El mutante: `runt_consultado_en timestamptz NOT NULL DEFAULT now()`. Aplicaría sin error y
    // dejaría ~todas las solicitudes viejas diciendo que el RUNT respondió el día de la migración.
    const linea = /ADD COLUMN IF NOT EXISTS\s+runt_consultado_en[^;]*/i.exec(SQL);
    expect(linea, 'no se encontró el ADD COLUMN de runt_consultado_en').not.toBeNull();
    expect(linea![0]).not.toMatch(/NOT NULL/i);
    expect(linea![0]).not.toMatch(/DEFAULT/i);
  });

  it('**dos y solo dos `ADD COLUMN`**, las dos con la guarda: ni una columna de más', () => {
    const conGuarda = SQL.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(conGuarda).toHaveLength(2);
    // Uno solo sin la guarda rompería la segunda pasada entera (42701).
    const todos = SQL.match(/ADD COLUMN/gi) ?? [];
    expect(todos).toHaveLength(2);
  });

  it('**CERO backfill**: la migración no toca ni una fila existente', () => {
    // El `DEFAULT '{}'` puebla las ~7 052 filas de `flito_compradores` sin un solo UPDATE (PG 11+ no
    // reescribe la tabla con un default constante). Un `UPDATE` aquí sería escribir una procedencia
    // que nadie observó sobre todas las solicitudes de golpe.
    expect(SQL).not.toMatch(/\bUPDATE\b/i);
    expect(SQL).not.toMatch(/\bINSERT\b/i);
    expect(SQL).not.toMatch(/\bDELETE\b/i);
  });

  it('**ningún CONSTRAINT**: el vocabulario lo impone Zod, no un CHECK sobre jsonb', () => {
    // Un CHECK aquí obligaría a enumerar en SQL los nueve campos y los tres valores, y esa lista
    // quedaría en la base sin forma de crecer con el enum de shared-types. Es el mismo argumento con
    // el que la 0172 no añadió el recíproco de `flito_compradores_titular_chk`.
    expect(SQL).not.toMatch(/ADD CONSTRAINT/i);
    expect(SQL).not.toMatch(/\bCHECK\s*\(/i);
  });

  it('**las dos columnas llevan `COMMENT ON COLUMN`** (AC1)', () => {
    expect(SQL).toMatch(/COMMENT ON COLUMN\s+flito_soat_solicitud\.runt_consultado_en\s+IS/i);
    expect(SQL).toMatch(/COMMENT ON COLUMN\s+flito_compradores\.procedencia\s+IS/i);
    expect(SQL.match(/COMMENT ON COLUMN/gi) ?? []).toHaveLength(2);
  });

  it('no toca `flito_soat` ni `vehicles`: esta migración es de otras dos tablas', () => {
    expect(SQL).not.toMatch(/ALTER TABLE\s+flito_soat\b/i);
    expect(SQL).not.toMatch(/ALTER TABLE\s+vehicles\b/i);
  });
});

describe('paridad 0174 ↔ schema.ts', () => {
  const columnas = (t: Parameters<typeof getTableConfig>[0]) =>
    new Map(getTableConfig(t).columns.map((c) => [c.name, c]));

  it('`flito_soat_solicitud` declara `runt_consultado_en`, nullable y sin default', () => {
    const c = columnas(flitoSoatSolicitud).get('runt_consultado_en');
    expect(c, 'runt_consultado_en no está en schema.ts').toBeDefined();
    expect(c!.notNull, 'no puede ser NOT NULL: de las solicitudes viejas no consta').toBe(false);
    expect(c!.hasDefault, 'un default aquí sería inventarse cuándo respondió el RUNT').toBe(false);
    expect(c!.getSQLType()).toMatch(/timestamp with time zone/);
  });

  it('`flito_compradores` declara `procedencia` jsonb NOT NULL CON default', () => {
    const c = columnas(flitoCompradores).get('procedencia');
    expect(c, 'procedencia no está en schema.ts').toBeDefined();
    expect(c!.notNull, 'NOT NULL: `{}` y NULL no pueden significar lo mismo con dos formas').toBe(true);
    // Sin default, el `ADD COLUMN NOT NULL` habría abortado con 23502 sobre las filas existentes, y
    // todo INSERT que no la nombrara —los del sync de trámites— moriría igual.
    expect(c!.hasDefault, 'sin DEFAULT el NOT NULL rompe el sync de trámites').toBe(true);
    expect(c!.getSQLType()).toBe('jsonb');
  });

  it('la 0174 no toca lo que declaró la 0172: los CHECK del comprador siguen ahí', () => {
    const chks = getTableConfig(flitoCompradores).checks.map((k) => k.name);
    expect(chks).toContain('flito_compradores_titular_chk');
    expect(chks).toContain('flito_compradores_padre_chk');
  });
});

describe('el vocabulario que la columna guarda vive en shared-types, no en el SQL', () => {
  it('son los NUEVE campos del comprador y los TRES valores, y la migración no los enumera', () => {
    // Si mañana la factura ganara un décimo campo, el mapa lo gana solo: la lista es la compartida y
    // el alta la recorre. Lo que este caso protege es que la migración no haya congelado una copia.
    expect(CAMPOS_COMPRADOR_FACTURA).toHaveLength(9);
    expect([...PROCEDENCIAS_DATO]).toEqual(['factura', 'runt', 'manual']);
    for (const campo of CAMPOS_COMPRADOR_FACTURA) {
      expect(SQL, `la migración no debe enumerar ${campo}`).not.toMatch(new RegExp(`'${campo}'`));
    }
  });
});

describe('la 0173 no se reescribe: ya está aplicada y su sha registrado', () => {
  it('conserva lo que la define', () => {
    const previa = podarComentarios(leer('0173_flito_gestor_organismos.sql'));
    expect(previa).not.toMatch(/procedencia|runt_consultado_en/i);
  });
});
