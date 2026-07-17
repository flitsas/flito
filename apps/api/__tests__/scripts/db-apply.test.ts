// ADR-DB-001 — guard scanForTxControl / isGrandfathered
// Valida que el runner detecte BEGIN/COMMIT top-level en migraciones nuevas
// (≥0071) y respete las grandfathered (0050-0070).

import { describe, it, expect } from 'vitest';
import { scanForTxControl, isGrandfathered } from '../../src/scripts/db-apply.js';

describe('isGrandfathered', () => {
  it('returns true for migs <=0070', () => {
    expect(isGrandfathered('0050_serial_to_bigserial.sql')).toBe(true);
    expect(isGrandfathered('0068_pesv_diagnostico_niveles.sql')).toBe(true);
    expect(isGrandfathered('0070_pesv_trigger_worm_rubrica.sql')).toBe(true);
  });

  it('returns false for migs >=0071', () => {
    expect(isGrandfathered('0071_anything.sql')).toBe(false);
    expect(isGrandfathered('0100_future_mig.sql')).toBe(false);
    expect(isGrandfathered('9999_test.sql')).toBe(false);
  });

  it('returns false for files without numeric prefix', () => {
    expect(isGrandfathered('seed.sql')).toBe(false);
    expect(isGrandfathered('rollback.sql')).toBe(false);
  });
});

describe('scanForTxControl', () => {
  it('detects top-level BEGIN;', () => {
    const sql = `
      ALTER TABLE foo ADD COLUMN bar text;
      BEGIN;
      UPDATE foo SET bar = 'x';
      COMMIT;
    `;
    const hits = scanForTxControl('0071_test.sql', sql);
    expect(hits.length).toBe(2);
    expect(hits[0]).toMatch(/0071_test\.sql:3/);
    expect(hits[1]).toMatch(/0071_test\.sql:5/);
  });

  it('detects START TRANSACTION', () => {
    const sql = `START TRANSACTION;\nALTER TABLE foo ADD COLUMN bar text;\nCOMMIT;`;
    const hits = scanForTxControl('0072.sql', sql);
    expect(hits.length).toBe(2);
  });

  it('detects ROLLBACK', () => {
    const sql = `ALTER TABLE foo ADD COLUMN bar text;\nROLLBACK;`;
    const hits = scanForTxControl('0073.sql', sql);
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/ROLLBACK/i);
  });

  it('is case-insensitive', () => {
    const sql = `begin;\nALTER TABLE foo ADD COLUMN bar text;\ncommit;`;
    const hits = scanForTxControl('0074.sql', sql);
    expect(hits.length).toBe(2);
  });

  it('IGNORES BEGIN/END inside dollar-quoted DO block', () => {
    const sql = `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'foo_enum') THEN
          CREATE TYPE foo_enum AS ENUM ('a', 'b');
        END IF;
      END
      $$;
      ALTER TABLE bar ADD COLUMN baz text;
    `;
    const hits = scanForTxControl('0075.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside named dollar-quoted block', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION my_fn() RETURNS trigger AS $body$
      BEGIN
        RAISE NOTICE 'hello';
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    `;
    const hits = scanForTxControl('0076.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside line comments', () => {
    const sql = `
      -- BEGIN this is a comment
      ALTER TABLE foo ADD COLUMN bar text;
      -- COMMIT also a comment
    `;
    const hits = scanForTxControl('0077.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside block comments', () => {
    const sql = `
      /* BEGIN; in a block comment
         COMMIT; should not trigger */
      ALTER TABLE foo ADD COLUMN bar text;
    `;
    const hits = scanForTxControl('0078.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('returns empty for clean mig', () => {
    const sql = `
      ALTER TABLE foo ADD COLUMN bar text NOT NULL DEFAULT 'x';
      CREATE INDEX idx_foo_bar ON foo (bar);
      COMMENT ON COLUMN foo.bar IS 'bar column';
    `;
    expect(scanForTxControl('0079.sql', sql).length).toBe(0);
  });

  it('detects BEGIN with extra whitespace', () => {
    const sql = `    BEGIN  ;\nALTER TABLE foo ADD COLUMN bar text;`;
    const hits = scanForTxControl('0080.sql', sql);
    expect(hits.length).toBe(1);
  });
});
