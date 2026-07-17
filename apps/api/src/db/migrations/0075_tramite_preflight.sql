-- 0075 — TRAM-INNOV A1: snapshot de pre-vuelo (semáforo de requisitos).
--
-- Antes de avanzar el wizard, el gestor consulta un semáforo (SOAT / RTM /
-- comparendos SIMIT / inscripción RUNT / impuesto) calculado con las integraciones
-- existentes (RUNT vía CEA). Cada cómputo se persiste aquí (append-only) como
-- evidencia/trazabilidad (Res. 17145) y para la métrica "pre-vuelo en verde".
--
-- `tramite_id` es nullable: el pre-vuelo puede correr en el paso 1 antes de crear
-- el trámite (solo con VIN/placa). `checks` guarda el detalle por ítem
-- (status ok|warn|fail|unknown + fuente + mensaje accionable + timestamp).
-- `overall_status` resume: green | yellow | red.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

CREATE TABLE IF NOT EXISTS tramite_preflight (
  id              BIGSERIAL PRIMARY KEY,
  tramite_id      INTEGER REFERENCES tramites_digitales(id) ON DELETE CASCADE,
  vin             VARCHAR(17),
  placa           VARCHAR(10),
  comprador_doc   VARCHAR(30),
  vendedor_doc    VARCHAR(30),
  checks          JSONB NOT NULL,
  overall_status  VARCHAR(10) NOT NULL,   -- green | yellow | red
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Último snapshot por trámite (GET /:id/preflight) y consultas por VIN.
CREATE INDEX IF NOT EXISTS idx_tramite_preflight_tramite ON tramite_preflight (tramite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tramite_preflight_vin ON tramite_preflight (vin, created_at DESC);
