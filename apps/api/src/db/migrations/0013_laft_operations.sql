-- Sprint 3 LAFT — Operaciones inusuales, borradores ROS UIAF, capacitaciones
-- Cierra las secciones 9.4, 12 y 13 de la política.

-- 1. Enum de decisión sobre operación inusual
DO $$ BEGIN
  CREATE TYPE laft_unusual_decision AS ENUM ('pendiente', 'en_analisis', 'descartada', 'escalada', 'reportada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Operaciones inusuales (sección 9.4 — señales de alerta)
CREATE TABLE IF NOT EXISTS laft_unusual_operations (
  id SERIAL PRIMARY KEY,
  counterparty_id INTEGER REFERENCES laft_counterparties(id) ON DELETE SET NULL,
  detected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source VARCHAR(50) NOT NULL,
  signals JSONB NOT NULL,
  amount NUMERIC(20, 2),
  currency VARCHAR(10) DEFAULT 'COP',
  description TEXT NOT NULL,
  analysis_text TEXT,
  decision laft_unusual_decision NOT NULL DEFAULT 'pendiente',
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_uo_decision ON laft_unusual_operations(decision);
CREATE INDEX IF NOT EXISTS idx_laft_uo_cp ON laft_unusual_operations(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_laft_uo_detected ON laft_unusual_operations(detected_at DESC);

-- 3. Borradores de Reporte de Operación Sospechosa (sección 12 — ROS UIAF)
-- El envío al SIREL es manual (fuera del sistema) por reserva del artículo 105 EOSF.
CREATE TABLE IF NOT EXISTS laft_ros_drafts (
  id SERIAL PRIMARY KEY,
  operation_id INTEGER NOT NULL REFERENCES laft_unusual_operations(id) ON DELETE RESTRICT,
  sirel_payload JSONB NOT NULL,
  pdf_storage_key VARCHAR(500),
  generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_to_uiaf_at TIMESTAMPTZ,
  sirel_radicado VARCHAR(50),
  evidence_files JSONB,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_laft_ros_op ON laft_ros_drafts(operation_id);
CREATE INDEX IF NOT EXISTS idx_laft_ros_sent ON laft_ros_drafts(sent_to_uiaf_at);

-- 4. Capacitaciones (sección 13 — al menos una anual)
CREATE TABLE IF NOT EXISTS laft_trainings (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  trainer_name VARCHAR(120),
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_hours NUMERIC(4, 1),
  content_url VARCHAR(500),
  evaluation_url VARCHAR(500),
  passing_score INTEGER DEFAULT 70,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_tr_scheduled ON laft_trainings(scheduled_at DESC);

-- 5. Asistencia a capacitaciones
CREATE TABLE IF NOT EXISTS laft_training_attendees (
  id SERIAL PRIMARY KEY,
  training_id INTEGER NOT NULL REFERENCES laft_trainings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attended BOOLEAN NOT NULL DEFAULT FALSE,
  score INTEGER,
  attended_at TIMESTAMPTZ,
  certificate_storage_key VARCHAR(500),
  CONSTRAINT laft_training_attendees_unique UNIQUE (training_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_laft_ta_training ON laft_training_attendees(training_id);
CREATE INDEX IF NOT EXISTS idx_laft_ta_user ON laft_training_attendees(user_id);

-- 6. GRANTs
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON laft_unusual_operations TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_unusual_operations_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE ON laft_ros_drafts TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_ros_drafts_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON laft_trainings TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_trainings_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON laft_training_attendees TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_training_attendees_id_seq TO operaciones_app;
  END IF;
END $$;
