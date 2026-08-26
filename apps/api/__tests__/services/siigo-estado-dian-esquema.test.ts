// HU #11330 — lo que la migración `0137` promete y el código da por hecho (Feature #11243).
//
// Las garantías de esta historia son de la BASE DE DATOS: dos `CHECK`, dos disparadores de
// append-only y un orden total. Con la base mockeada no se pueden ejercer —se verificaron aplicando
// la cadena dos veces contra un PostgreSQL 16 real y provocando cada violación; el resultado está
// en el PR—. Lo que sí se puede hacer aquí, y es donde de verdad aporta, es **impedir que las dos
// copias de cada catálogo se separen** y que alguien deshaga sin querer las decisiones del modelo.
//
// La duplicación entre `shared-types` y los `CHECK` es deliberada: la base no puede importar
// TypeScript. Lo que no puede pasar es que se añada un estado en un sitio y no en el otro; el
// síntoma sería un `INSERT` rechazado en producción por una restricción que nadie recuerda.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  esEstadoDianFinal,
  SIIGO_ESTADOS_DIAN,
  SIIGO_ESTADOS_DIAN_NO_FINALES,
  SIIGO_ESTADO_DIAN_ETIQUETA,
  SIIGO_FACTURA_ESTADOS,
  SIIGO_FUENTES_ESTADO_DIAN,
  SIIGO_FUENTE_ESTADO_DIAN_ETIQUETA,
} from '@operaciones/shared-types';

const MIGRACION = readFileSync(
  path.resolve(process.cwd(), 'src/db/migrations/0137_siigo_estado_dian.sql'),
  'utf8',
);

/**
 * La migración sin sus comentarios. Hace falta para las afirmaciones sobre lo que el archivo NO
 * hace: el encabezado explica por escrito que aquí no se toca `siigo_facturas`, y una búsqueda
 * ingenua encontraría esa misma frase y daría el test por fallado.
 */
const SQL_EJECUTABLE = MIGRACION
  .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

/** Extrae los literales de un `CHECK (... IN ('a','b'))` por el nombre de su restricción. */
function valoresDelCheck(nombreRestriccion: string): string[] {
  const re = new RegExp(`CONSTRAINT\\s+${nombreRestriccion}[\\s\\S]*?IN\\s*\\(([^)]*)\\)`);
  const m = re.exec(MIGRACION);
  if (!m) throw new Error(`No se encontró el CHECK ${nombreRestriccion} en la migración 0137`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('los catálogos del código y los de la base no se pueden separar', () => {
  it('los estados ante la DIAN son los mismos en las dos copias', () => {
    expect(valoresDelCheck('siigo_estado_dian_estado_chk'))
      .toEqual([...SIIGO_ESTADOS_DIAN].sort());
  });

  it('los cuatro orígenes también', () => {
    expect(valoresDelCheck('siigo_estado_dian_fuente_chk'))
      .toEqual([...SIIGO_FUENTES_ESTADO_DIAN].sort());
  });

  it('cada estado y cada origen tienen etiqueta: la pantalla no puede quedarse sin texto', () => {
    expect(Object.keys(SIIGO_ESTADO_DIAN_ETIQUETA).sort()).toEqual([...SIIGO_ESTADOS_DIAN].sort());
    expect(Object.keys(SIIGO_FUENTE_ESTADO_DIAN_ETIQUETA).sort())
      .toEqual([...SIIGO_FUENTES_ESTADO_DIAN].sort());
  });
});

describe('los dos ejes de estado no se pueden confundir', () => {
  it('ni un solo valor se comparte entre el estado de emisión y el de la DIAN', () => {
    // Si un día coincidieran, un `switch` mal escrito compilaría y trataría «emitida» como si la
    // DIAN hubiera dicho algo. Que los vocabularios sean disjuntos hace imposible ese error.
    const compartidos = SIIGO_ESTADOS_DIAN
      .filter((e) => (SIIGO_FACTURA_ESTADOS as readonly string[]).includes(e));
    expect(compartidos).toEqual([]);
  });

  it('`anulada` vive en el eje de la DIAN, no en el de la emisión', () => {
    // Es el caso que motivó separar los ejes: una factura anulada SIGUE constando como emitida,
    // porque el documento existe ante la autoridad y existirá siempre.
    expect(SIIGO_ESTADOS_DIAN).toContain('anulada');
    expect(SIIGO_FACTURA_ESTADOS).not.toContain('anulada');
  });

  it('la migración no añade una sola columna a siigo_facturas', () => {
    // La propiedad que sostiene las Features #11243 y #11244 enteras: todo son tablas nuevas con
    // clave foránea HACIA `siigo_facturas`, para que la Feature #11242 pueda evolucionar su fila
    // sin arrastrar a las otras dos.
    expect(SQL_EJECUTABLE).not.toMatch(/ALTER\s+TABLE\s+siigo_facturas\b/i);
    expect(SQL_EJECUTABLE)
      .toMatch(/factura_id\s+uuid\s+NOT NULL\s+REFERENCES\s+siigo_facturas\(id\)/);
  });
});

describe('el historial es append-only, con una única excepción reglada', () => {
  it('el DELETE está prohibido por disparador, no por buenas intenciones', () => {
    expect(MIGRACION).toContain('trg_siigo_estado_dian_no_delete');
    expect(MIGRACION).toMatch(/BEFORE DELETE ON siigo_factura_estados_dian/);
  });

  it('el UPDATE solo puede tocar verificado_en, y solo hacia adelante', () => {
    // Confirmar que una factura sigue aceptada no es un hecho nuevo del documento: es una
    // observación nuestra. Todo lo demás de la fila es inmutable.
    expect(MIGRACION).toContain('trg_siigo_estado_dian_solo_verificado');
    for (const columna of [
      'factura_id', 'secuencia', 'estado', 'cufe', 'motivo', 'fuente', 'payload', 'created_at',
    ]) {
      expect(MIGRACION).toContain(`NEW.${columna} IS DISTINCT FROM OLD.${columna}`);
    }
    expect(MIGRACION).toContain('NEW.verificado_en < OLD.verificado_en');
  });

  it('nunca se concede DELETE sobre la tabla', () => {
    const grants = [...MIGRACION.matchAll(/GRANT ([^;]*?) ON siigo_factura_estados_dian/g)]
      .map((m) => m[1]!);
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g).not.toMatch(/DELETE|TRUNCATE|ALL/i);
    }
  });
});

describe('«la última fila» tiene que ser una respuesta, no una lotería', () => {
  it('el orden lo da una secuencia y no la fecha', () => {
    // `now()` es la hora de INICIO DE LA TRANSACCIÓN: dos filas escritas en la misma transacción
    // comparten instante al microsegundo, y desempatar por un uuid aleatorio sería desempatar al
    // azar justo en el momento en que importa.
    expect(MIGRACION).toMatch(/secuencia\s+bigserial/);
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_estado_dian_secuencia[\s\S]*?\(factura_id,\s*secuencia DESC\)/,
    );
  });

  it('el índice por factura y fecha existe para los informes por rango', () => {
    expect(MIGRACION).toMatch(
      /CREATE INDEX[^;]*idx_siigo_estado_dian_factura_fecha[\s\S]*?\(factura_id,\s*created_at DESC\)/,
    );
  });

  it('una verificación anterior a la propia creación de la fila es un reloj mal puesto', () => {
    expect(MIGRACION).toContain('siigo_estado_dian_verificado_chk');
    expect(MIGRACION).toMatch(/CHECK\s*\(verificado_en\s*>=\s*created_at\)/);
  });

  it('la migración no abre transacción propia (ADR-DB-001)', () => {
    // Se busca la SENTENCIA con su punto y coma: el `BEGIN` de un bloque plpgsql no tiene nada que
    // ver con el control de transacción que el runner ya gestiona.
    expect(MIGRACION).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
  });

  it('es idempotente: todo se crea con IF NOT EXISTS o OR REPLACE', () => {
    // La cadena se aplica dos veces en la verificación del PR; si un objeto no fuera idempotente,
    // la segunda pasada rompería y nadie podría reconstruir la base desde cero.
    const creaciones = [...MIGRACION.matchAll(/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|FUNCTION|TRIGGER)/gm)];
    expect(creaciones.length).toBeGreaterThan(0);
    for (const m of creaciones) {
      const linea = MIGRACION.slice(m.index!, MIGRACION.indexOf('\n', m.index!));
      // Los TRIGGER no admiten IF NOT EXISTS: se preceden de un DROP TRIGGER IF EXISTS.
      if (m[1] === 'TRIGGER') continue;
      expect(linea).toMatch(/IF NOT EXISTS|OR REPLACE/);
    }
    const triggers = [...MIGRACION.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]!);
    for (const t of triggers) {
      expect(MIGRACION).toContain(`DROP TRIGGER IF EXISTS ${t}`);
    }
  });
});

describe('a qué facturas hay que volver a preguntarles', () => {
  it('solo `en_validacion` queda abierta: es la única que el sondeo tiene que reconsultar', () => {
    expect([...SIIGO_ESTADOS_DIAN_NO_FINALES]).toEqual(['en_validacion']);
    expect(esEstadoDianFinal('en_validacion')).toBe(false);
    for (const estado of ['aceptada', 'rechazada', 'anulada'] as const) {
      expect(esEstadoDianFinal(estado)).toBe(true);
    }
  });

  it('el índice del sondeo está limitado a esas, que son la minoría', () => {
    // Sin el `WHERE`, el índice cargaría con las aceptadas —la inmensa mayoría de la tabla— sin
    // que nadie las vaya a consultar nunca por ahí.
    expect(MIGRACION).toMatch(
      /idx_siigo_estado_dian_pendientes[\s\S]*?WHERE estado = 'en_validacion'/,
    );
  });
});
