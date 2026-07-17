-- Sprint 2A — Mecánicos como users con flag (no tabla nueva).
-- Reusa auth + audit log + permisos existentes. La vista filtra es_mecanico=true.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS es_mecanico boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS especialidades text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_users_mecanico ON users(es_mecanico) WHERE es_mecanico = true;
