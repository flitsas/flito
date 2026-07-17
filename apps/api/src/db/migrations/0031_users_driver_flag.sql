-- Sprint 3A — PESV Conductores.
-- Mismo patrón que 0024 (es_mecanico): conductor es un user con flag + tabla satélite.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS es_conductor boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_conductor ON users(es_conductor) WHERE es_conductor = true;
