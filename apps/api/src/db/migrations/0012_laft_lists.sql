-- Sprint 2 LAFT — Listas restrictivas + motor de match
-- Cubre la sección 11 de la política (consulta de listas vinculantes y de referencia).

-- 1. Extensiones para fuzzy match y normalización
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Catálogo de listas
CREATE TABLE IF NOT EXISTS laft_restrictive_lists (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  binding BOOLEAN NOT NULL DEFAULT FALSE,
  source_url VARCHAR(500),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  total_entries INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: 8 listas (5 vinculantes + 3 de referencia)
INSERT INTO laft_restrictive_lists (code, name, binding, source_url, description) VALUES
  ('OFAC', 'OFAC SDN (Estados Unidos)', TRUE, 'https://www.treasury.gov/ofac/downloads/sdn.csv', 'Specially Designated Nationals — Departamento del Tesoro EE.UU.'),
  ('UN', 'Consejo de Seguridad ONU', TRUE, 'https://scsanctions.un.org/resources/xml/en/consolidated.xml', 'Resoluciones 1267, 1373, 1718, 1988, 2231'),
  ('EU', 'Unión Europea', TRUE, 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content', 'Lista consolidada de sanciones financieras UE'),
  ('CLINTON', 'Lista Clinton', TRUE, NULL, 'Subset de OFAC SDN históricamente conocido como Lista Clinton'),
  ('INTERPOL', 'INTERPOL Notas Rojas', TRUE, NULL, 'Personas con orden internacional de captura'),
  ('PROCURADURIA', 'Procuraduría General', FALSE, NULL, 'Antecedentes disciplinarios — carga manual de CSV'),
  ('CONTRALORIA', 'Contraloría General', FALSE, NULL, 'Antecedentes fiscales — carga manual de CSV'),
  ('POLICIA', 'Policía Nacional', FALSE, NULL, 'Antecedentes judiciales — carga manual de CSV')
ON CONFLICT (code) DO NOTHING;

-- 3. Registros normalizados de cada lista
CREATE TABLE IF NOT EXISTS laft_list_entries (
  id SERIAL PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES laft_restrictive_lists(id) ON DELETE CASCADE,
  full_name VARCHAR(500) NOT NULL,
  full_name_norm VARCHAR(500) NOT NULL,
  aliases JSONB,
  doc_type VARCHAR(20),
  doc_number VARCHAR(50),
  country VARCHAR(80),
  birth_date VARCHAR(20),
  remarks TEXT,
  source_id VARCHAR(100),
  source_hash VARCHAR(64),
  valid_from DATE,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_le_list ON laft_list_entries(list_id);
CREATE INDEX IF NOT EXISTS idx_laft_le_doc ON laft_list_entries(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_laft_le_name_trgm ON laft_list_entries USING gin (full_name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_laft_le_source ON laft_list_entries(list_id, source_id);

-- 4. Historial de consultas (evidencia de DD §11)
CREATE TABLE IF NOT EXISTS laft_list_checks (
  id BIGSERIAL PRIMARY KEY,
  counterparty_id INTEGER NOT NULL REFERENCES laft_counterparties(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES laft_restrictive_lists(id) ON DELETE RESTRICT,
  query_doc VARCHAR(50),
  query_name_norm VARCHAR(500),
  match_entry_id INTEGER REFERENCES laft_list_entries(id) ON DELETE SET NULL,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_kind VARCHAR(20),
  evidence JSONB,
  checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laft_checks_cp ON laft_list_checks(counterparty_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_laft_checks_match ON laft_list_checks(counterparty_id, match_score) WHERE match_score >= 85;

-- 5. GRANTs para el rol de la app
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON laft_restrictive_lists TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_restrictive_lists_id_seq TO operaciones_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON laft_list_entries TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_list_entries_id_seq TO operaciones_app;

    GRANT SELECT, INSERT ON laft_list_checks TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_list_checks_id_seq TO operaciones_app;
  END IF;
END $$;
