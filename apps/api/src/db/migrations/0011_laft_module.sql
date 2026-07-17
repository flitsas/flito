-- Módulo LAFT (Política de Prevención LA/FT/FPADM — FLIT SAS, abril 2026)
-- Sprint 1: Fundamento + Contrapartes + Beneficiarios finales + Soportes + Audit log inmutable
-- Cubre §6, §7, §9.3 (parcial), §10, §15, §16 de la política.

-- 1. Agregar rol 'compliance' al enum existente
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'compliance';

-- 2. Enums LAFT
DO $$ BEGIN
  CREATE TYPE laft_kind AS ENUM ('PN', 'PJ');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE laft_risk_level AS ENUM ('bajo', 'medio', 'alto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE laft_status AS ENUM ('pendiente', 'vinculada', 'bloqueada', 'archivada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Contrapartes (núcleo §10 — Debida Diligencia)
CREATE TABLE IF NOT EXISTS laft_counterparties (
  id SERIAL PRIMARY KEY,
  kind laft_kind NOT NULL,
  doc_type VARCHAR(10) NOT NULL,
  doc_number VARCHAR(20) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  email VARCHAR(150),
  phone VARCHAR(20),
  address VARCHAR(300),
  city VARCHAR(100),
  country VARCHAR(80) NOT NULL DEFAULT 'Colombia',
  economic_activity VARCHAR(200),
  ciiu VARCHAR(10),
  fund_origin TEXT NOT NULL,
  is_pep BOOLEAN NOT NULL DEFAULT FALSE,
  pep_role VARCHAR(200),
  pep_period_start DATE,
  pep_period_end DATE,
  pep_kinship VARCHAR(50),
  factor_counterparty INTEGER CHECK (factor_counterparty BETWEEN 1 AND 3),
  factor_product INTEGER CHECK (factor_product BETWEEN 1 AND 3),
  factor_channel INTEGER CHECK (factor_channel BETWEEN 1 AND 3),
  factor_jurisdiction INTEGER CHECK (factor_jurisdiction BETWEEN 1 AND 3),
  risk_level laft_risk_level,
  status laft_status NOT NULL DEFAULT 'pendiente',
  block_reason TEXT,
  next_review_at DATE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT laft_counterparties_doc_unique UNIQUE (doc_type, doc_number)
);

CREATE INDEX IF NOT EXISTS idx_laft_cp_doc ON laft_counterparties(doc_number);
CREATE INDEX IF NOT EXISTS idx_laft_cp_status ON laft_counterparties(status);
CREATE INDEX IF NOT EXISTS idx_laft_cp_review ON laft_counterparties(next_review_at) WHERE next_review_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_laft_cp_risk ON laft_counterparties(risk_level);

-- 4. Beneficiarios finales (§5, §10.1 — ≥ 5%)
CREATE TABLE IF NOT EXISTS laft_beneficial_owners (
  id SERIAL PRIMARY KEY,
  counterparty_id INTEGER NOT NULL REFERENCES laft_counterparties(id) ON DELETE CASCADE,
  doc_type VARCHAR(10) NOT NULL,
  doc_number VARCHAR(20) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  ownership_pct NUMERIC(5,2) NOT NULL CHECK (ownership_pct >= 5 AND ownership_pct <= 100),
  is_pep BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_bo_cp ON laft_beneficial_owners(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_laft_bo_doc ON laft_beneficial_owners(doc_number);

-- 5. Soportes documentales (§10 + §16 — conservación 5 años)
CREATE TABLE IF NOT EXISTS laft_documents (
  id SERIAL PRIMARY KEY,
  counterparty_id INTEGER NOT NULL REFERENCES laft_counterparties(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  size_bytes INTEGER,
  mime_type VARCHAR(100),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_docs_cp ON laft_documents(counterparty_id);

-- 6. Audit log inmutable (§15, §16 — append-only, conservación 5 años)
CREATE TABLE IF NOT EXISTS laft_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_username VARCHAR(50),
  action VARCHAR(50) NOT NULL,
  resource VARCHAR(50) NOT NULL,
  resource_id VARCHAR(50),
  before_state JSONB,
  after_state JSONB,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_audit_created ON laft_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_laft_audit_resource ON laft_audit_log(resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_laft_audit_user ON laft_audit_log(user_id);

-- Append-only: la app no puede UPDATE/DELETE el log (defensa en profundidad).
-- Solo INSERT permitido. Si en el futuro se requiere borrado masivo legal, se hace con superuser.
REVOKE UPDATE, DELETE ON laft_audit_log FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE UPDATE, DELETE ON laft_audit_log FROM operaciones_app;
    GRANT SELECT, INSERT ON laft_audit_log TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_audit_log_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE ON laft_counterparties TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_counterparties_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON laft_beneficial_owners TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_beneficial_owners_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON laft_documents TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_documents_id_seq TO operaciones_app;
  END IF;
END $$;
