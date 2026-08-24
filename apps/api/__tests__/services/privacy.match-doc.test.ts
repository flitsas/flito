import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { clients } from '../../src/db/schema.js';
import { normalizeDocument } from '../../src/shared/utils/crypto.js';
import {
  matchDocumentoCompradorJsonb,
  matchDocumentoNormalizado,
  sqlSoloDigitos,
} from '../../src/modules/privacy/privacy.match-doc.js';

const dialecto = new PgDialect();

/** Documentos sintéticos — el repro del Bug #11776. No son PII real. */
const BUSCADO = '1036640908';
const FORMATOS = [
  { etiqueta: 'dígitos puros', almacenado: '1036640908' },
  { etiqueta: 'con separadores', almacenado: '1.036.640.908' },
  { etiqueta: 'con prefijo de tipo', almacenado: 'CC1036640908' },
] as const;

function render(q: unknown): { sql: string; params: unknown[] } {
  return dialecto.sqlToQuery(q as never);
}

/**
 * El segundo argumento de `regexp_replace(col, PATRON, '', 'g')`.
 * Acepta literal (`'[^0-9]'`) o parámetro (`$1`) por si alguien interpola la clase.
 */
function patronRegexpReplace(q: { sql: string; params: unknown[] }): string {
  const m = q.sql.match(
    /regexp_replace\([\s\S]*?,\s*(?:'((?:\\'|[^'])*)'|\$(\d+))\s*,\s*''\s*,\s*'g'\)/,
  );
  if (!m) throw new Error(`sin regexp_replace en SQL renderizado: ${q.sql}`);
  if (m[1] != null) return m[1];
  const idx = Number(m[2]) - 1;
  return String(q.params[idx]);
}

function aplicaPatron(almacenado: string, patron: string): string {
  return almacenado.replace(new RegExp(patron, 'g'), '');
}

describe('Bug #11776 — el SQL viejo con \\D no muerde (mutación)', () => {
  it('en un tagged template sql`` , \\D se cocina a D y Drizzle manda esa D a PostgreSQL', () => {
    // Esta expresión ES el bug. No es código de producción: demuestra que leer el fuente
    // `'\D'` no basta — hay que renderizar. PgDialect usa el array cooked.
    const col = sql`document`;
    const viejo = sql`regexp_replace(${col}, '\D', '', 'g') = ${BUSCADO}`;
    const q = render(viejo);

    expect(patronRegexpReplace(q)).toBe('D');
    expect(q.sql).toMatch(/regexp_replace\([^,]+,\s*'D'\s*,\s*''\s*,\s*'g'\)/);
    expect(q.sql).not.toContain('[^0-9]');
    expect(q.sql).not.toContain('\\D');
  });

  it.each(FORMATOS)(
    'con el patrón cocinado a D, «$etiqueta» ($almacenado) no se normaliza (salvo dígitos puros)',
    ({ etiqueta, almacenado }) => {
      const col = sql`document`;
      const viejo = sql`regexp_replace(${col}, '\D', '', 'g')`;
      const patron = patronRegexpReplace(render(viejo));
      const normalizado = aplicaPatron(almacenado, patron);
      if (etiqueta === 'dígitos puros') {
        expect(normalizado).toBe(BUSCADO);
      } else {
        expect(normalizado).not.toBe(BUSCADO);
        expect(normalizado).toBe(almacenado);
      }
    },
  );
});

describe('Bug #11776 — matchDocumentoNormalizado renderiza no-dígitos de verdad', () => {
  it('el SQL renderizado usa [^0-9] y NO el patrón D', () => {
    const q = render(matchDocumentoNormalizado(clients.document, BUSCADO));
    const patron = patronRegexpReplace(q);

    expect(patron).toBe('[^0-9]');
    expect(patron).not.toBe('D');
    expect(q.sql).not.toMatch(/regexp_replace\([^,]+,\s*'D'\s*,/);
    expect(q.params).toContain(BUSCADO);
  });

  it.each(FORMATOS)(
    'almacenado «$etiqueta» ($almacenado) coincide con el buscado',
    ({ almacenado }) => {
      const q = render(sqlSoloDigitos(clients.document));
      const patron = patronRegexpReplace(q);
      expect(aplicaPatron(almacenado, patron)).toBe(normalizeDocument(BUSCADO));
      expect(aplicaPatron(almacenado, patron)).toBe(BUSCADO);
    },
  );

  it('SELECT de captura y UPDATE de anonimización son el mismo predicado', () => {
    // HU #11708 copia este predicado al SELECT de correos (rama por dirección de
    // purgarDestinatariosDeLotes) y al UPDATE de cada tabla. Si divergieran, uno
    // encontraría filas que el otro no toca.
    const whereSelect = matchDocumentoNormalizado(clients.document, BUSCADO);
    const whereUpdate = matchDocumentoNormalizado(clients.document, BUSCADO);
    expect(render(whereSelect)).toEqual(render(whereUpdate));
  });

  it('el JSONB del comprador usa el mismo patrón en SELECT y UPDATE', () => {
    const pred = matchDocumentoCompradorJsonb(BUSCADO);
    const selectCorreos = sql`
      SELECT comprador->>'email' AS email
        FROM tramites_digitales
       WHERE ${pred}
    `;
    const updateOlvido = sql`
      UPDATE tramites_digitales
         SET comprador = jsonb_set(comprador, '{documento}', to_jsonb('ANON-x'::text))
       WHERE ${pred}
    `;
    const pSelect = patronRegexpReplace(render(selectCorreos));
    const pUpdate = patronRegexpReplace(render(updateOlvido));
    expect(pSelect).toBe('[^0-9]');
    expect(pUpdate).toBe(pSelect);
    expect(render(selectCorreos).sql).not.toMatch(/regexp_replace\([^,]+,\s*'D'\s*,/);
    expect(render(updateOlvido).sql).not.toMatch(/regexp_replace\([^,]+,\s*'D'\s*,/);
  });

  it('preview (columna) y forget (misma columna) no pueden divergir: una sola función', () => {
    const forget = render(matchDocumentoNormalizado(clients.document, BUSCADO));
    const preview = render(matchDocumentoNormalizado(clients.document, BUSCADO));
    expect(forget).toEqual(preview);
    expect(patronRegexpReplace(forget)).toBe('[^0-9]');
  });
});
