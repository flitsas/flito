-- Perfil del conductor con campos exigidos por Resolución 40595/2022 (PESV).
-- Tabla satélite 1:1 con users — aísla PII sensible (cédula, restricciones médicas, EPS).

DO $$ BEGIN
  CREATE TYPE contrato_tipo AS ENUM ('directo', 'contratista', 'temporal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS driver_profile (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cedula varchar(20) UNIQUE,
  fecha_nacimiento date,
  licencia_numero varchar(40) NOT NULL,
  categorias text[] NOT NULL DEFAULT '{}'::text[],
  licencia_vigencia date,
  examen_psico_fecha date,
  examen_psico_vigencia date,
  restricciones_medicas text[] NOT NULL DEFAULT '{}'::text[],
  arl varchar(80),
  eps varchar(80),
  fondo_pensiones varchar(80),
  contrato_tipo contrato_tipo,
  experiencia_anios numeric(4, 1) NOT NULL DEFAULT 0,
  sanciones_count integer NOT NULL DEFAULT 0,
  foto_storage_key varchar(500),
  runt_consultado_at timestamptz,
  runt_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_categorias CHECK (categorias <@ ARRAY['A1','A2','B1','B2','B3','C1','C2','C3']),
  CONSTRAINT chk_licencia_no_empty CHECK (length(licencia_numero) > 0)
);

CREATE INDEX IF NOT EXISTS idx_driver_profile_licencia ON driver_profile(licencia_numero);
CREATE INDEX IF NOT EXISTS idx_driver_profile_vencimiento ON driver_profile(licencia_vigencia);
