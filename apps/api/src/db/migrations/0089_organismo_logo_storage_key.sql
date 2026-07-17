-- 0089 — TRAM-MT-02 Fase 2b: logo de organismo subido a MinIO.
--
-- `logo_storage_key` (key MinIO) tiene prioridad sobre `logo_url` (URL externa)
-- al resolver la imagen. ADR-DB-001: sin BEGIN/COMMIT.

ALTER TABLE organismos_transito_config
  ADD COLUMN IF NOT EXISTS logo_storage_key VARCHAR(500);

COMMENT ON COLUMN organismos_transito_config.logo_storage_key IS 'Key MinIO del logo subido (prioridad sobre logo_url externa).';
