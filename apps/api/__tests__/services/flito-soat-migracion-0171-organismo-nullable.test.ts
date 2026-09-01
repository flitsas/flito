// HU #11935 — guarda de contrato de la migración 0171: organismo nullable + verificación en el satélite.
//
// Análisis estático puro: NO toca la base. P6 (aplicar el SQL dos veces) vive en el HANDOFF del
// backend-agent, no aquí.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoSoat, flitoSoatSolicitud } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0171_flito_soat_organismo_nullable_verificacion.sql';
const CRUDO = readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${ARCHIVO}`, import.meta.url)), 'utf8');

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

describe('migración 0171 — organismo nullable y verificación en el satélite', () => {
  it('no lleva control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it('**DROP NOT NULL de `flito_soat.organismo_codigo`**', () => {
    expect(SQL).toMatch(/ALTER TABLE\s+flito_soat\s+ALTER COLUMN\s+organismo_codigo\s+DROP NOT NULL/i);
  });

  it('NO suelta la FK: no hay DROP de constraint de organismo', () => {
    expect(SQL).not.toMatch(/DROP CONSTRAINT.*organismo/i);
    expect(SQL).not.toMatch(/DROP CONSTRAINT.*flito_soat_organismo/i);
  });

  it('añade las cuatro columnas derivadas (NO jsonb)', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+verificacion_estado varchar\(20\) NOT NULL DEFAULT 'pendiente'/i);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+soat_vigente boolean/i);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+soat_vigente_hasta date/i);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+verificacion_codigo varchar\(40\)/i);
    expect(SQL).not.toMatch(/jsonb/i);
  });

  it('**CHECK de `verificacion_estado` con los cinco valores, idempotente (DROP IF EXISTS + ADD)**', () => {
    expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS\s+flito_soat_solicitud_verificacion_estado_chk/i);
    expect(SQL).toMatch(/ADD CONSTRAINT\s+flito_soat_solicitud_verificacion_estado_chk/i);
    expect(SQL).toMatch(/verificacion_estado IN \('pendiente', 'caido', 'sin_registro', 'no_cuadra', 'ok'\)/i);
  });

  it('backfill: filas viejas del canal (organismo NOT NULL) → `ok`; las nuevas con NULL no entran', () => {
    expect(SQL).toMatch(/SET\s+verificacion_estado = 'ok'/i);
    expect(SQL).toMatch(/so\.origen = 'cliente'/i);
    expect(SQL).toMatch(/so\.organismo_codigo IS NOT NULL/i);
    expect(SQL).toMatch(/s\.verificacion_estado = 'pendiente'/i);
  });

  it('columnas nuevas con IF NOT EXISTS (segunda pasada no aborta)', () => {
    const adds = SQL.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(adds.length).toBe(4);
  });
});

describe('paridad 0171 ↔ schema.ts', () => {
  const columnas = (t: Parameters<typeof getTableConfig>[0]) =>
    new Map(getTableConfig(t).columns.map((c) => [c.name, c]));

  it('`flito_soat.organismo_codigo` es nullable en Drizzle', () => {
    expect(columnas(flitoSoat).get('organismo_codigo')!.notNull).toBe(false);
  });

  it('el satélite declara las cuatro columnas y el CHECK', () => {
    const cols = columnas(flitoSoatSolicitud);
    expect(cols.get('verificacion_estado')!.notNull).toBe(true);
    expect(cols.get('soat_vigente')!.notNull).toBe(false);
    expect(cols.get('soat_vigente_hasta')).toBeDefined();
    expect(cols.get('verificacion_codigo')).toBeDefined();
    const chks = getTableConfig(flitoSoatSolicitud).checks.map((c) => c.name);
    expect(chks).toContain('flito_soat_solicitud_verificacion_estado_chk');
  });
});
