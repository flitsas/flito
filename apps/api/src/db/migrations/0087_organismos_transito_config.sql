-- 0087 — Configuración FLIT por organismo de tránsito (TRAM-MT-02 Fase 1).
-- Catálogo nacional sigue en shared-types; esta tabla guarda alias, logo y activo.

CREATE TABLE IF NOT EXISTS organismos_transito_config (
  codigo      varchar(5) PRIMARY KEY,
  alias       varchar(120),
  logo_url    text,
  activo      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
