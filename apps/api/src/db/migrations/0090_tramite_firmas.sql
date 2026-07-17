-- 0090 — TRAM-INNOV-B3: firma electrónica del contrato de compraventa.
-- MVP: tipología traspaso_standard, roles comprador/vendedor, proveedor mock|zapsign.
-- ADR-DB-001: sin BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS tramite_firmas (
  id BIGSERIAL PRIMARY KEY,
  tramite_id INTEGER NOT NULL REFERENCES tramites_digitales(id) ON DELETE CASCADE,
  participante_id BIGINT REFERENCES tramite_participantes(id) ON DELETE SET NULL,
  rol VARCHAR(20) NOT NULL,
  doc_tipo VARCHAR(40) NOT NULL DEFAULT 'compraventa',
  proveedor VARCHAR(30) NOT NULL,
  envelope_id VARCHAR(120),
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente_envio',
  pdf_path VARCHAR(500),
  sha256 VARCHAR(64),
  metadata JSONB,
  solicitado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  firmado_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tramite_firmas_tramite ON tramite_firmas(tramite_id);

-- Idempotencia: una sola firma ACTIVA por (tramite, rol, doc). Si la previa quedó
-- rechazada/cancelada se permite re-solicitar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tramite_firma_activa
  ON tramite_firmas (tramite_id, rol, doc_tipo)
  WHERE estado IN ('pendiente_envio', 'enviada', 'firmada');
