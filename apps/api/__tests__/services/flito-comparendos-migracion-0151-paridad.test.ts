// FLITO comparendos — paridad entre la lista blanca del SQL y la del runtime (TC #11523).
//
// La migración `0151_flito_comparendos_poda_pii.sql` poda los payloads YA ESCRITOS a la lista blanca
// del `field_map`, y para eso repite —hardcodeada, porque una migración no puede importar
// TypeScript— la lista de campos canónicos que el runtime tiene en `CAMPOS_CANONICOS`
// (`flito-comparendos-merge.ts`). Son dos copias del mismo hecho en dos lenguajes distintos y hasta
// ahora nada vigilaba que siguieran diciendo lo mismo.
//
// Qué pasa si divergen. La 0151 ya está APLICADA: no se reescribe, así que la divergencia no se
// corrige editándola sino con una migración nueva. El error cae del lado seguro —si el runtime gana
// un campo canónico, la 0151 podó de MENOS y dejó vivo un `source_path` que ya nadie lee; nunca de
// más— pero «de menos» en una poda de PII significa datos personales que se creían borrados y
// siguen en la base. Por eso esto es una red de seguridad y no la corrección de un fallo: hoy las
// dos listas coinciden, y este test existe para que se sepa el día que dejen de hacerlo.
//
// El test lee el `.sql` de disco a propósito. Copiar la lista aquí crearía una TERCERA copia y el
// problema volvería una casilla más allá.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `flito-comparendos-merge.ts` importa el cliente de base al cargarse. Aquí no se consulta nada —solo
// se lee una constante—, así que se corta el pool en el import en vez de abrirlo para nada.
vi.mock('../../src/db/client.js', () => ({
  db: {},
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const { CAMPOS_CANONICOS } = await import('../../src/modules/flito-comparendos/flito-comparendos-merge.js');

const RUTA_MIGRACION = fileURLToPath(
  new URL('../../src/db/migrations/0151_flito_comparendos_poda_pii.sql', import.meta.url),
);

/**
 * Los campos del `WHERE target_field IN (...)` de la migración.
 *
 * Se quitan antes los comentarios de línea porque la cabecera de la 0151 habla de `target_field` en
 * prosa; sin eso, un comentario podría alimentar la comparación. Y se exige UNA sola lista: si
 * mañana aparecen dos filtros por `target_field`, comparar solo el primero sería justamente el tipo
 * de vigilancia a medias que este test viene a evitar, así que se prefiere fallar y que alguien mire.
 */
function camposDelSql(sql: string): string[] {
  const sinComentarios = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const listas = [...sinComentarios.matchAll(/target_field\s+IN\s*\(([^)]*)\)/gi)];

  expect(
    listas.length,
    'se esperaba exactamente un `target_field IN (...)` en la 0151; si la migración cambió de forma, '
    + 'este extractor hay que actualizarlo (no la migración, que ya está aplicada)',
  ).toBe(1);

  return [...listas[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('migración 0151 — la lista blanca del SQL y CAMPOS_CANONICOS no pueden divergir (TC #11523)', () => {
  const sqlCampos = camposDelSql(readFileSync(RUTA_MIGRACION, 'utf8'));
  const runtimeCampos = [...CAMPOS_CANONICOS] as string[];

  it('extrae una lista no vacía del .sql (si esto falla, el resto del test no vigila nada)', () => {
    expect(sqlCampos.length).toBeGreaterThan(0);
    expect(new Set(sqlCampos).size).toBe(sqlCampos.length); // sin duplicados
  });

  it('las dos listas contienen exactamente los mismos campos', () => {
    const enSql = new Set(sqlCampos);
    const enRuntime = new Set(runtimeCampos);

    // Un array de frases y no dos `toEqual` de sets: lo que un fallo tiene que decir es QUÉ campo y
    // en CUÁL de los dos lados, no «esperaba Set(8) y recibí Set(9)».
    const divergencias = [
      ...runtimeCampos.filter((c) => !enSql.has(c)).map((c) => (
        `'${c}': está en CAMPOS_CANONICOS (runtime, flito-comparendos-merge.ts) y FALTA en la lista `
        + 'del SQL (0151_flito_comparendos_poda_pii.sql) → la poda histórica lo ignora y sus '
        + 'source_path siguen vivos en los payloads ya escritos; corregir con una migración NUEVA'
      )),
      ...sqlCampos.filter((c) => !enRuntime.has(c)).map((c) => (
        `'${c}': está en la lista del SQL (0151_flito_comparendos_poda_pii.sql) y SOBRA respecto de `
        + 'CAMPOS_CANONICOS (runtime, flito-comparendos-merge.ts) → el runtime ya no lo homologa; '
        + 'quitarlo del runtime sin más deja la 0151 podando por un campo muerto'
      )),
    ];

    expect(divergencias).toEqual([]);
  });
});
