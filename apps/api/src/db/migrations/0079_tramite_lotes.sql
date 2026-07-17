-- 0079 — TRAM-INNOV B4: trámites en lote (CSV de flota).
--
-- Admin sube CSV (VIN/placa) → preview con pre-vuelo A1 por fila (sin persistir)
-- → confirma y se crean N trámites en borrador (chunks de ≤50). El lote y sus
-- filas quedan registrados para trazabilidad y KPI mensual (`tramite_lote_id` se
-- resuelve vía `tramite_lote_filas.tramite_id`).
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS tramite_lotes (
  id           BIGSERIAL PRIMARY KEY,
  nombre       VARCHAR(120),
  creado_por   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total_filas  INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER NOT NULL DEFAULT 0,
  errores      INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tramite_lote_filas (
  id               BIGSERIAL PRIMARY KEY,
  lote_id          BIGINT NOT NULL REFERENCES tramite_lotes(id) ON DELETE CASCADE,
  fila             INTEGER NOT NULL,
  vin              VARCHAR(17),
  placa            VARCHAR(10),
  tipologia_codigo VARCHAR(40),
  estado           VARCHAR(12) NOT NULL,   -- ok (creado) | error
  tramite_id       INTEGER REFERENCES tramites_digitales(id) ON DELETE SET NULL,
  preflight        JSONB,
  error_msg        VARCHAR(300),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tramite_lote_filas_lote ON tramite_lote_filas (lote_id, fila);
-- KPI mensual de lotes.
CREATE INDEX IF NOT EXISTS idx_tramite_lotes_created ON tramite_lotes (created_at DESC);
