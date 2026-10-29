// HU #14109 (Feature #14091, ADR-0030) — Esquema de traslados/actas/firmas, migraciones 0274-0276 y frontera por enlace.
//   AC1 tablas/columnas/CHECK · AC2 indicador (una sola vez) · AC3 en_flit en archivo aparte · AC4 backfill idempotente
//   AC5 columnas viejas intactas · AC6 acta de organismo invisible para enlace.
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL (en tx con ROLLBACK).
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const A270 = '0274_flito_logistica_enum_en_flit.sql';
const A271 = '0275_flito_logistica_traslados.sql';
const A272 = '0276_flito_logistica_actas_backfill.sql';
const SQL = { [A270]: leerMigracion(A270), [A271]: leerMigracion(A271), [A272]: leerMigracion(A272) };
const sinComentarios = (s: string) => s.replace(/--[^\n]*/g, '');

describe('0274-0276 — reglas de los archivos (estática)', () => {
  it.each(Object.keys(SQL))('%s: sin control de transacción propio', (a) => {
    expect(scanForTxControl(a, SQL[a as keyof typeof SQL])).toEqual([]);
  });

  it('AC3: en_flit va SOLO en la 0274; la 0275 y la 0276 no lo mencionan', () => {
    expect(sinComentarios(SQL[A270])).toMatch(/ALTER TYPE flito_logistica_doc_estado ADD VALUE IF NOT EXISTS 'en_flit'/);
    expect(sinComentarios(SQL[A271])).not.toMatch(/en_flit/);
    expect(sinComentarios(SQL[A272])).not.toMatch(/en_flit/);
  });

  it('AC1: la 0275 crea las 5 tablas con IF NOT EXISTS, `punto` con CHECK y compania_id NOT NULL (§17)', () => {
    const s = sinComentarios(SQL[A271]);
    for (const t of ['motivos_llegada', 'traslados', 'traslado_lts', 'acta_lineas', 'acta_firmas']) {
      expect(s).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS flito_logistica_${t} `));
    }
    // §17: acta por compañía => compania_id NOT NULL en todos los puntos (sana la forma anterior de la 0275)
    expect(s).not.toMatch(/ALTER COLUMN compania_id DROP NOT NULL/);
    expect(s).toMatch(/DROP CONSTRAINT IF EXISTS ck_flito_log_actas_compania_punto/);
    expect(s).toMatch(/ALTER COLUMN compania_id SET NOT NULL/);
    expect(s).toMatch(/CHECK \(punto IN \('organismo','flit','cliente'\)\)/);
    expect(s).toMatch(/FOREIGN KEY \(traslado_id, destino\)/);
    expect(s).not.toMatch(/requiere_acta_organismo/);
  });

  it('§17: firmante del organismo, acta con firmante (CHECK + único por compañía) y LT pendiente de trámite', () => {
    const s = sinComentarios(SQL[A271]);
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS flito_logistica_recogida_firmantes \(\s+id UUID PRIMARY KEY,/);
    expect(s).toMatch(/documento_cifrado TEXT,\s+documento_ultimos VARCHAR\(4\)/);
    expect(s).toMatch(/CHECK \(punto <> 'organismo' OR firmante_id IS NOT NULL\)/);
    expect(s).toMatch(/uq_flito_log_actas_firmante_compania ON flito_logistica_actas \(firmante_id, compania_id\)\s+WHERE punto = 'organismo'/);
    expect(s).toMatch(/ALTER COLUMN tramite_id DROP NOT NULL/);
    expect(s).toMatch(/CHECK \(tramite_id IS NOT NULL OR compania_id IS NULL\)/);
    expect(s).toMatch(/uq_flito_log_doc_vehiculo_pendiente ON flito_logistica_documentos \(vehiculo_id, tipo\)\s+WHERE tramite_id IS NULL/);
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS recogida_firmante_id UUID REFERENCES flito_logistica_recogida_firmantes/);
  });

  it('AC2: el indicador nace en un bloque condicional (backfill UNA sola vez) y solo pone false en entregado', () => {
    const s = sinComentarios(SQL[A271]);
    expect(s).toMatch(/IF NOT EXISTS \([\s\S]*column_name = 'acta_organismo_pendiente'[\s\S]*THEN\s+ALTER TABLE flito_logistica_documentos ADD COLUMN acta_organismo_pendiente BOOLEAN NOT NULL DEFAULT TRUE;\s+UPDATE flito_logistica_documentos SET acta_organismo_pendiente = FALSE WHERE estado = 'entregado';/);
  });

  it('AC4/AC5: el backfill es idempotente (ON CONFLICT), sin precio y NO borra columnas viejas', () => {
    const s = sinComentarios(SQL[A272]);
    expect(s).toMatch(/'legado', NULL/);
    expect(s).not.toMatch(/\bDROP\b/i);
    expect(s).not.toMatch(/receptor_documento\s*=/);
    for (const insert of s.split(/INSERT INTO /i).slice(1)) expect(insert).toMatch(/ON CONFLICT/);
    // la cédula no se copia en claro a las firmas: solo los 4 últimos y cifrado NULL
    expect(s).toMatch(/NULL, NULLIF\(right\(btrim\(a\.receptor_documento\), 4\), ''\)/);
  });
});

describe('Drizzle — AC1/AC5/AC3', () => {
  it('exporta las 6 tablas nuevas desde schema.ts', () => {
    for (const t of ['flitoLogisticaMotivosLlegada', 'flitoLogisticaTraslados', 'flitoLogisticaTrasladoLts',
      'flitoLogisticaActaLineas', 'flitoLogisticaActaFirmas', 'flitoLogisticaRecogidaFirmantes']) expect((schema as Record<string, unknown>)[t]).toBeDefined();
  });

  it('§17 Drizzle: firmante del organismo; acta con firmante_id; documentos con tramite_id nullable y recogida_firmante_id', () => {
    const f = getTableConfig(schema.flitoLogisticaRecogidaFirmantes).columns.map((c) => c.name);
    expect(f).toEqual(expect.arrayContaining(['id', 'nombre', 'documento_cifrado', 'documento_ultimos', 'firma_storage_key', 'registrado_por_id', 'lat', 'lng']));
    expect(f).not.toContain('documento');
    const a = getTableConfig(schema.flitoLogisticaActas).columns.find((c) => c.name === 'firmante_id');
    expect(a).toBeDefined();
    const d = Object.fromEntries(getTableConfig(schema.flitoLogisticaDocumentos).columns.map((c) => [c.name, c]));
    expect(d.tramite_id.notNull).toBe(false);
    expect(d.compania_id.notNull).toBe(false);
    expect(d.recogida_firmante_id).toBeDefined();
  });

  it('acta: punto con default cliente, compania_id NOT NULL (§17), columnas viejas intactas', () => {
    const cols = Object.fromEntries(getTableConfig(schema.flitoLogisticaActas).columns.map((c) => [c.name, c]));
    expect(cols.punto.notNull).toBe(true);
    expect(cols.punto.default).toBe('cliente');
    expect(cols.compania_id.notNull).toBe(true);
    for (const vieja of ['receptor_documento', 'receptor_nombre', 'firma_storage_key', 'firma_entrega_storage_key', 'contacto_documento']) {
      expect(cols[vieja]).toBeDefined();
    }
  });

  it('documentos: acta_organismo_pendiente (indicador, default true); enum con en_flit; eventos con columnas nuevas', () => {
    const col = getTableConfig(schema.flitoLogisticaDocumentos).columns.find((c) => c.name === 'acta_organismo_pendiente')!;
    expect(col.default).toBe(true);
    expect(col.notNull).toBe(true);
    expect(schema.flitoLogisticaDocEstadoEnum.enumValues).toContain('en_flit');
    const ev = getTableConfig(schema.flitoLogisticaEventos).columns.map((c) => c.name);
    expect(ev).toEqual(expect.arrayContaining(['tipo', 'traslado_id', 'acta_id', 'destino', 'payload']));
  });

  it('firmas: cédula solo cifrada (documento_cifrado) + últimos; no hay columna de documento en claro', () => {
    const nombres = getTableConfig(schema.flitoLogisticaActaFirmas).columns.map((c) => c.name);
    expect(nombres).toEqual(expect.arrayContaining(['documento_cifrado', 'documento_ultimos']));
    expect(nombres).not.toContain('documento');
  });
});

describe('AC6 — frontera por enlace: acta de organismo / sin compañía invisible', () => {
  const dialect = new PgDialect();
  it('enlace compañía: exige compañía Y punto <> organismo; otros enlaces: ninguna fila; sin enlace: sin acotar', async () => {
    const { condicionActasLogistica } = await import('../../src/modules/flito-logistica/flito-logistica.alcance.js');
    const base = { enlace: 'ninguno', companiaId: null, organismos: [], proveedorId: null } as never;
    expect(condicionActasLogistica(base)).toBeUndefined();

    const comp = { enlace: 'compania', companiaId: 7, organismos: [], proveedorId: null } as never;
    const q = dialect.sqlToQuery(condicionActasLogistica(comp)!);
    expect(q.sql).toContain('"flito_logistica_actas"."compania_id" = $1');
    expect(q.sql).toContain('"flito_logistica_actas"."punto" <> $2');
    expect(q.params).toEqual([7, 'organismo']);

    const org = { enlace: 'organismos_transito', companiaId: null, organismos: ['X'], proveedorId: null } as never;
    expect(dialect.sqlToQuery(condicionActasLogistica(org)!).sql).toContain('false');
  });
});

describe.skipIf(!URL_BASE)('0274-0276 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC2/AC4: dos corridas; el backfill crea traslado/líneas/firmas una vez y no cambia datos al repetir', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL[A270]);
        await tx.unsafe(SQL[A271]);
        await tx.unsafe(SQL[A272]);
        const cuenta = async () => (await tx`SELECT
          (SELECT count(*) FROM flito_logistica_traslados)::int t, (SELECT count(*) FROM flito_logistica_traslado_lts)::int l,
          (SELECT count(*) FROM flito_logistica_acta_lineas)::int al, (SELECT count(*) FROM flito_logistica_acta_firmas)::int f,
          (SELECT count(*) FROM flito_logistica_motivos_llegada)::int m,
          (SELECT count(*) FILTER (WHERE acta_organismo_pendiente) FROM flito_logistica_documentos)::int p`)[0];
        const antes = await cuenta();
        await tx.unsafe(SQL[A270]);
        await tx.unsafe(SQL[A271]);
        await tx.unsafe(SQL[A272]);
        expect(await cuenta()).toEqual(antes);
      });
    } finally { await sql.end(); }
  });
});
