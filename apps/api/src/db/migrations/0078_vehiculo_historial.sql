-- 0078 — TRAM-INNOV B1: pasaporte vehicular (historial cronológico por VIN).
--
-- Cadena de hashes APPEND-ONLY tipo blockchain-lite en Postgres (epic §9: SIN
-- blockchain on-chain). Cada evento encadena `hash_prev` = `hash_self` del evento
-- anterior del mismo VIN; el primero usa GENESIS (64 ceros). `hash_self` =
-- SHA-256 de (hash_prev | vin | evento_tipo | ref | payload-canónico | created_at).
--
-- Alimentado desde trámites (creación, envío a tránsito, placa) y SOAT (vigente).
-- `payload` NO debe contener cédulas completas (Ley 1581): solo VIN/placa/metadatos.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS vehiculo_historial (
  id                    BIGSERIAL PRIMARY KEY,
  vin                   VARCHAR(17) NOT NULL,
  evento_tipo           VARCHAR(40) NOT NULL,
  referencia_tramite_id INTEGER REFERENCES tramites_digitales(id) ON DELETE SET NULL,
  payload               JSONB,
  hash_prev             VARCHAR(64) NOT NULL,
  hash_self             VARCHAR(64) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lectura cronológica por VIN (timeline + certificado + verificación de cadena).
CREATE INDEX IF NOT EXISTS idx_vehiculo_historial_vin ON vehiculo_historial (vin, created_at, id);
-- Resolver el último eslabón de la cadena al insertar (ORDER BY id DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS idx_vehiculo_historial_vin_id ON vehiculo_historial (vin, id DESC);
