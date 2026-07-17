-- 0076 — TRAM-INNOV A2: timeline del expediente + token de verificación pública.
--
-- `tramite_eventos`: bitácora APPEND-ONLY del expediente (creación, documentos,
-- cambios de paso/estado, envío a tránsito, placa, rechazo OT, acceso portal
-- externo A3). Da trazabilidad Res. 17145 sin blockchain. `doc_hash` = SHA-256
-- del archivo al subir. `payload` guarda metadatos NO sensibles (sin cédulas
-- completas) para que el QR público pueda exponerse sin fuga de PII.
--
-- Token de verificación pública (QR): columnas en `tramites_digitales`. Token
-- opaco de un solo recurso, TTL 7d, revocable (set NULL). Mismo enfoque que el
-- QR de RNDC (lookup por token, no JWT) para poder revocar.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS tramite_eventos (
  id             BIGSERIAL PRIMARY KEY,
  tramite_id     INTEGER NOT NULL REFERENCES tramites_digitales(id) ON DELETE CASCADE,
  actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role     VARCHAR(30),
  tipo           VARCHAR(40) NOT NULL,
  payload        JSONB,
  doc_hash       VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lectura cronológica del expediente (GET /:id/timeline).
CREATE INDEX IF NOT EXISTS idx_tramite_eventos_tramite ON tramite_eventos (tramite_id, created_at);

ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS verify_token VARCHAR(64);
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMPTZ;

-- Lookup público por token (verificación QR). UNIQUE evita colisiones.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tramites_verify_token ON tramites_digitales (verify_token) WHERE verify_token IS NOT NULL;
