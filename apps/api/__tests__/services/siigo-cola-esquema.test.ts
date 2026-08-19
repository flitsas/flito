// HU #11327 — el modelo de datos de la cola de emisión (Feature #11242).
//
// Las garantías de esta historia son de la BASE DE DATOS: el índice único por lote, los CHECK que
// impiden estados incoherentes y —sobre todo— la sentencia que toma y marca a la vez. Esta suite
// corre con la base mockeada, así que **no puede probarlas**: se verificaron aplicando la migración
// dos veces contra un PostgreSQL 16 real y provocando cada violación.
//
// Lo que sí puede hacer, y es donde aporta, es impedir que las dos copias del catálogo de estados se
// separen —el `CHECK` de la migración y la lista de `shared-types`— y que alguien retire de la
// migración una restricción sin darse cuenta de qué estaba sujetando. Mismo patrón que la 0135.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SIIGO_COLA_ARRENDAMIENTO_MIN,
  SIIGO_COLA_ESTADOS,
  SIIGO_COLA_DESENLACES,
  SIIGO_COLA_ESTADO_ETIQUETA,
  SIIGO_COLA_LOTE_DEFECTO,
  SIIGO_COLA_MAX_ESPERAS,
  SIIGO_COLA_MAX_INTENTOS,
  ARRENDAMIENTO_EN_PROCESO_MIN_DEFECTO,
} from '@operaciones/shared-types';

const MIGRACION = readFileSync(
  path.resolve(process.cwd(), 'src/db/migrations/0144_siigo_cola_facturacion.sql'),
  'utf8',
);

/** Extrae los literales de un `CHECK (... IN ('a','b'))` por el nombre de su restricción. */
function valoresDelCheck(nombreRestriccion: string): string[] {
  const re = new RegExp(`CONSTRAINT\\s+${nombreRestriccion}[\\s\\S]*?IN\\s*\\(([^)]*)\\)`);
  const m = re.exec(MIGRACION);
  if (!m) throw new Error(`No se encontró el CHECK ${nombreRestriccion} en la migración 0144`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('los catálogos del código y los de la base no se pueden separar', () => {
  it('los cuatro estados de la cola son los mismos en las dos copias', () => {
    expect(valoresDelCheck('siigo_cola_estado_chk')).toEqual([...SIIGO_COLA_ESTADOS].sort());
  });

  it('son exactamente cuatro: el arrendamiento NO es un quinto estado', () => {
    // Si algún día aparece un `procesando`, es que alguien convirtió el arrendamiento en estado — y
    // entonces una instancia que muere deja la fila atascada, porque no queda nadie que la devuelva.
    expect(SIIGO_COLA_ESTADOS).toHaveLength(4);
    expect([...SIIGO_COLA_ESTADOS].sort())
      .toEqual(['enviado', 'error', 'fallido_definitivo', 'pendiente']);
  });

  it('cada estado tiene su etiqueta: la pantalla no puede quedarse sin texto', () => {
    for (const estado of SIIGO_COLA_ESTADOS) expect(SIIGO_COLA_ESTADO_ETIQUETA[estado]).toBeTruthy();
    expect(Object.keys(SIIGO_COLA_ESTADO_ETIQUETA).sort()).toEqual([...SIIGO_COLA_ESTADOS].sort());
  });

  it('el ambiente admite los mismos dos valores que el resto del módulo', () => {
    expect(valoresDelCheck('siigo_cola_ambiente_chk')).toEqual(['produccion', 'pruebas']);
  });

  it('el desenlace también está restringido en la base', () => {
    // Todas las columnas de catálogo del módulo llevan CHECK. Esta se quedó sin él porque el valor
    // no existía como lista: un desenlace inventado no rompía nada hoy, pero dejaba una fila que
    // ninguna pantalla sabe pintar y que nadie descubre hasta que alguien la mira.
    expect(valoresDelCheck('siigo_cola_desenlace_chk')).toEqual([...SIIGO_COLA_DESENLACES].sort());
  });
});

describe('las incoherencias que la tabla se niega a guardar', () => {
  it('una fila en error SIEMPRE tiene cita', () => {
    // Sin cita es una fila que no vuelve jamás, y no vuelve en silencio: nadie recibe un error,
    // simplemente ese trámite deja de facturarse.
    expect(MIGRACION).toMatch(
      /CONSTRAINT siigo_cola_cita_chk\s*CHECK \(estado <> 'error' OR proximo_intento_at IS NOT NULL\)/,
    );
    expect(MIGRACION).toMatch(/proximo_intento_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it('«enviado» exige factura: sin identificador no hay nada que enseñar', () => {
    expect(MIGRACION).toMatch(
      /CONSTRAINT siigo_cola_enviado_chk\s*CHECK \(estado <> 'enviado' OR factura_id IS NOT NULL\)/,
    );
  });

  it('un trabajo terminado no puede estar arrendado', () => {
    expect(MIGRACION).toMatch(
      /siigo_cola_arrendamiento_estado_chk\s*CHECK \(estado IN \('pendiente', 'error'\) OR tomado_por IS NULL\)/,
    );
  });

  it('las dos columnas del arrendamiento van juntas o no van', () => {
    // Con solo una, el vencimiento no se puede calcular y la fila queda tomada para siempre por nadie.
    expect(MIGRACION).toMatch(
      /siigo_cola_arrendamiento_chk\s*CHECK \(\(tomado_por IS NULL\) = \(tomado_en IS NULL\)\)/,
    );
  });

  it('los contadores no pueden ser negativos y los techos están acotados', () => {
    expect(MIGRACION).toMatch(/CHECK \(intentos >= 0 AND esperas >= 0\)/);
    expect(MIGRACION).toMatch(/max_intentos BETWEEN 1 AND 50 AND max_esperas BETWEEN 1 AND 500/);
  });

  it('los techos por defecto son los que dice el código', () => {
    expect(MIGRACION).toMatch(new RegExp(`max_intentos\\s+integer NOT NULL DEFAULT ${SIIGO_COLA_MAX_INTENTOS}`));
    expect(MIGRACION).toMatch(new RegExp(`max_esperas\\s+integer NOT NULL DEFAULT ${SIIGO_COLA_MAX_ESPERAS}`));
  });
});

describe('los índices que sostienen el ciclo', () => {
  it('una fila por lote: reencolar lo mismo NO crea un segundo trabajo', () => {
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_cola_lote[\s\S]*?\(lote_id\)/,
    );
  });

  it('la lista del trabajador es un índice parcial sobre lo que queda por hacer', () => {
    // Lo terminado es la mayor parte de la tabla con el tiempo y no se vuelve a mirar nunca: no tiene
    // por qué ocupar el índice por el que se pregunta cada dos minutos.
    expect(MIGRACION).toMatch(
      /idx_siigo_cola_lista[\s\S]*?\(ambiente, proximo_intento_at, created_at\)[\s\S]*?WHERE estado IN \('pendiente', 'error'\)/,
    );
  });

  it('ir de la factura a la petición que la originó', () => {
    expect(MIGRACION).toMatch(/idx_siigo_cola_factura[\s\S]*?\(factura_id\)[\s\S]*?WHERE factura_id IS NOT NULL/);
  });
});

describe('el lote sabe qué contiene', () => {
  it('hay una tabla de pertenencia: la huella identifica pero no se puede invertir', () => {
    // Sin ella, el trabajador toma una fila con un `lote_id` y no puede saber qué facturar.
    expect(MIGRACION).toContain('CREATE TABLE IF NOT EXISTS siigo_lote_tramites');
    expect(MIGRACION).toMatch(/idx_siigo_lote_tramites_par[\s\S]*?\(lote_id, tramite_id\)/);
  });

  it('los lotes anteriores a esta migración recuperan su contenido desde las facturas', () => {
    // Sin el relleno, un lote viejo reencolado daría un trabajo sin trámites.
    expect(MIGRACION).toMatch(/INSERT INTO siigo_lote_tramites[\s\S]*?FROM siigo_facturas f[\s\S]*?ON CONFLICT \(lote_id, tramite_id\) DO NOTHING/);
  });
});

describe('permisos y forma del archivo', () => {
  it('se concede SELECT, INSERT y UPDATE — nunca DELETE', () => {
    // Una fila de cola es el rastro de que alguien pidió facturar. Borrarla no arregla nada y hace
    // desaparecer la única prueba de que se pidió.
    expect(MIGRACION).toContain('GRANT SELECT, INSERT, UPDATE ON siigo_cola_facturacion TO operaciones_app');
    expect(MIGRACION).not.toMatch(/GRANT[^;]*DELETE[^;]*siigo_cola_facturacion/);
    expect(MIGRACION).not.toMatch(/GRANT[^;]*DELETE[^;]*siigo_lote_tramites/);
  });

  it('el GRANT va con guard: en docker-compose no existe el rol', () => {
    expect(MIGRACION).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app'");
  });

  it('la migración no abre transacción propia (ADR-DB-001)', () => {
    expect(MIGRACION).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
  });

  it('es idempotente: nada se crea sin IF NOT EXISTS', () => {
    const creaciones = [...MIGRACION.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s+(\S+)/g)];
    expect(creaciones.length).toBeGreaterThan(0);
    for (const c of creaciones) expect(c[1]).toBe('IF');
  });

  it('deja escrito qué NO garantiza', () => {
    // La cola no impide la doble factura: eso son la reserva de clave, el índice de trámites vivos y
    // el Idempotency-Key. Que esté en un COMMENT es lo que hace que se lea desde la propia base.
    expect(MIGRACION).toMatch(/COMMENT ON TABLE siigo_cola_facturacion IS[\s\S]*?NO impide la doble factura/);
  });
});

describe('los números que sostienen la cadencia', () => {
  it('el arrendamiento de la cola es MAYOR que el de la factura', () => {
    // Si fuera menor, la cola daría por abandonada una fila cuya emisión sigue viva y la entregaría a
    // un segundo trabajador: dos procesos llamando a emitir sobre el mismo lote.
    expect(SIIGO_COLA_ARRENDAMIENTO_MIN).toBeGreaterThan(ARRENDAMIENTO_EN_PROCESO_MIN_DEFECTO);
  });

  it('el lote por defecto cabe en la ventana de peticiones de Siigo', async () => {
    const { MAX_PETICIONES_POR_VENTANA } = await import('../../src/modules/siigo/siigo.resiliencia.js');
    // Peor caso ≈ 6 peticiones por fila (los 4 intentos de la resiliencia más el margen del tercero).
    expect(SIIGO_COLA_LOTE_DEFECTO * 6).toBeLessThan(MAX_PETICIONES_POR_VENTANA);
  });
});
