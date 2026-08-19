// HU #11335 — la cuarta clave foránea de `flito_soportes` (Feature #11243).
//
// Las garantías de esta historia que de verdad importan son de la BASE DE DATOS: el índice único
// que impide dos veces el mismo documento y el CHECK que impide que un soporte cuelgue de dos cosas
// a la vez. Esta suite corre con la base mockeada, así que **no puede provocar esas violaciones** —
// se verificaron aplicando la migración contra un PostgreSQL 16 real, y el resultado está en el PR.
//
// Lo que sí puede hacer, y es donde aporta, es impedir que alguien las relaje sin darse cuenta: que
// el índice deje de ser único, que se le quite el filtro de descartados —lo que haría imposible
// rehacer el archivo de un documento rechazado— o que la migración toque la tabla de facturas, que
// es justo lo que el AC7 prohíbe.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SIIGO_DOCUMENTOS_FACTURA,
  SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE,
  SIIGO_DOCUMENTO_FACTURA_FIRMA,
  TIPOS_SOPORTE_FACTURA,
  TIPO_SOPORTE_FACTURA,
  TipoSoporte,
} from '@operaciones/shared-types';

const MIGRACION = readFileSync(
  path.resolve(process.cwd(), 'src/db/migrations/0139_siigo_soportes_factura.sql'),
  'utf8',
);

describe('el vínculo se establece desde los soportes hacia la factura (AC7)', () => {
  it('la columna nueva vive en flito_soportes y apunta a siigo_facturas', () => {
    expect(MIGRACION).toMatch(
      /ALTER TABLE flito_soportes\s+ADD COLUMN IF NOT EXISTS siigo_factura_id uuid REFERENCES siigo_facturas\(id\)/,
    );
  });

  it('la tabla de facturas NO gana ninguna columna', () => {
    // El AC7 es explícito y la Feature de emisión se desarrolla en paralelo: un ALTER sobre
    // `siigo_facturas` desde aquí sería además una colisión con esa rama.
    expect(MIGRACION).not.toMatch(/ALTER TABLE siigo_facturas\s+ADD COLUMN/i);
  });

  it('no se añade un tramite_id, que es el error natural al leer el Feature', () => {
    // «Enlazado al trámite» suena a `tramite_id`. Esa columna nunca ha existido en esta tabla: un
    // soporte cuelga de su flujo, y el trámite se alcanza desde él. Añadirla crearía dos respuestas
    // distintas a «¿de qué es este documento?».
    expect(MIGRACION).not.toMatch(/ADD COLUMN IF NOT EXISTS tramite_id/i);
  });
});

describe('el mismo documento no se puede archivar dos veces (AC3)', () => {
  it('el índice es ÚNICO por factura y tipo', () => {
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_flito_soportes_factura_tipo[\s\S]*?\(siigo_factura_id,\s*tipo\)/,
    );
  });

  it('excluye los descartados: un documento rechazado tiene que poder rehacerse', () => {
    expect(MIGRACION).toMatch(/idx_flito_soportes_factura_tipo[\s\S]*?WHERE siigo_factura_id IS NOT NULL AND descartado = false/);
  });
});

describe('un soporte cuelga de una sola cosa', () => {
  it('el CHECK impide que un documento de factura sea además de un SOAT, un impuesto o un derecho', () => {
    expect(MIGRACION).toContain('flito_soportes_factura_excluyente_chk');
    expect(MIGRACION).toMatch(
      /siigo_factura_id IS NULL\s*OR \(soat_id IS NULL AND impuesto_id IS NULL AND derecho_id IS NULL\)/,
    );
  });

  it('se añade con guarda de existencia: la migración se puede aplicar dos veces', () => {
    expect(MIGRACION).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'flito_soportes_factura_excluyente_chk'\)/);
  });
});

describe('la migración cumple las reglas del repositorio', () => {
  it('no abre transacción propia (ADR-DB-001)', () => {
    // Se busca la SENTENCIA con su punto y coma: el `BEGIN` de un bloque `DO $$ … $$` es plpgsql y
    // no tiene nada que ver con el control de transacción que el runner ya gestiona.
    expect(MIGRACION).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
  });

  it('todo lo que crea es idempotente', () => {
    const creaciones = [...MIGRACION.matchAll(/^(ALTER TABLE[\s\S]*?ADD COLUMN|CREATE (?:UNIQUE )?INDEX)([^;]*)/gim)];
    expect(creaciones.length).toBeGreaterThan(0);
    for (const [sentencia] of creaciones) {
      expect(sentencia).toMatch(/IF NOT EXISTS/i);
    }
  });
});

describe('los dos documentos son dos, y cada uno sabe lo que es', () => {
  it('el tipo con que se guardan es el del catálogo de soportes, no un literal suelto', () => {
    expect(TIPO_SOPORTE_FACTURA.pdf).toBe(TipoSoporte.FACTURA_ELECTRONICA_PDF);
    expect(TIPO_SOPORTE_FACTURA.xml).toBe(TipoSoporte.FACTURA_ELECTRONICA_XML);
    expect(TIPOS_SOPORTE_FACTURA).toEqual([TIPO_SOPORTE_FACTURA.pdf, TIPO_SOPORTE_FACTURA.xml]);
  });

  it('cada documento tiene content-type y firma propios: son piezas distintas', () => {
    for (const doc of SIIGO_DOCUMENTOS_FACTURA) {
      expect(SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE[doc]).toBeTruthy();
      expect(SIIGO_DOCUMENTO_FACTURA_FIRMA[doc]).toBeTruthy();
    }
    // El XML es la prueba con validez ante la DIAN y el PDF es lo que se le enseña a una persona:
    // archivar solo uno deja la mitad de la prueba.
    expect(SIIGO_DOCUMENTOS_FACTURA).toEqual(['pdf', 'xml']);
  });
});
