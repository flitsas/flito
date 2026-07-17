-- 0082 — LOTE-PLUS-05: idempotencia por hash del CSV + columna para auditoría.
--
-- Mismo usuario + mismo contenido CSV (SHA-256 normalizado) → reutiliza lote existente.
-- ADR-DB-001: sin BEGIN/COMMIT.

ALTER TABLE tramite_lotes
  ADD COLUMN IF NOT EXISTS csv_sha256 VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tramite_lotes_user_csv_sha
  ON tramite_lotes (creado_por, csv_sha256)
  WHERE csv_sha256 IS NOT NULL;

COMMENT ON COLUMN tramite_lotes.csv_sha256 IS 'SHA-256 del CSV normalizado (idempotencia por usuario)';
