-- 0083 — FLOTA-01: KV genérico para estado operativo (no secretos).
--
-- Primer uso: última corrida del reconciler SOAT (health endpoint sin SSH).
-- ADR-DB-001: sin BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS system_kv (
  k          VARCHAR(120) PRIMARY KEY,
  v          JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE system_kv IS 'Key-value de estado operativo (no secretos). FLOTA-01: soat_reconciler:last_run.';
