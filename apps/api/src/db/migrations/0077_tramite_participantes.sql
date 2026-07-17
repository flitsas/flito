-- 0077 — TRAM-INNOV A3: portal de comprador/vendedor por magic link.
--
-- Participantes externos (sin cuenta FLIT) que completan pasos del trámite vía
-- enlace. Cumplimiento (epic §3): token de un solo propósito por rol, TTL ≤ 24h,
-- revocable (completed_at), sin enumeración de IDs (lookup por hash). El token
-- crudo viaja solo en el enlace; en BD guardamos su SHA-256 (`token_hash`).
--
-- Consentimiento Ley 1581: se registra en la fila (timestamp + versión fechada +
-- IP/UA reducidos) como prueba de autorización (art. 9), además del evento A2.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS tramite_participantes (
  id                 BIGSERIAL PRIMARY KEY,
  tramite_id         INTEGER NOT NULL REFERENCES tramites_digitales(id) ON DELETE CASCADE,
  rol                VARCHAR(20) NOT NULL,           -- comprador | vendedor | mandatario
  nombre             VARCHAR(200),
  email              VARCHAR(150),
  telefono           VARCHAR(30),
  token_hash         VARCHAR(64) NOT NULL,           -- SHA-256 del token crudo
  whatsapp_opt_in    BOOLEAN NOT NULL DEFAULT false, -- A4
  consent_1581_at    TIMESTAMPTZ,
  consent_version    VARCHAR(20),
  consent_ip         VARCHAR(45),
  consent_user_agent VARCHAR(300),
  expires_at         TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tramite_part_token ON tramite_participantes (token_hash);
CREATE INDEX IF NOT EXISTS idx_tramite_part_tramite ON tramite_participantes (tramite_id);
