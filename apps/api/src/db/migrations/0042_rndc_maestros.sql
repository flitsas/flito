-- Sprint 4 Fase 4.1 — Maestros propios para RNDC.
-- Tenedores (vehículos), propietarios de carga (cargadores), destinatarios.

DO $$ BEGIN
  CREATE TYPE tenedor_tipo AS ENUM ('propietario', 'poseedor', 'tenedor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tipo_doc_rndc AS ENUM ('CC', 'CE', 'NIT', 'PAS', 'TI', 'RC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tenedores (
  id serial PRIMARY KEY,
  tipo tenedor_tipo NOT NULL DEFAULT 'tenedor',
  tipo_doc tipo_doc_rndc NOT NULL,
  documento varchar(20) NOT NULL,
  nombre varchar(200) NOT NULL,
  direccion varchar(300),
  ciudad_dane varchar(5) REFERENCES rndc_municipios(codigo_dane),
  telefono varchar(40),
  email varchar(150),
  vinculado_user_id integer REFERENCES users(id),
  activo boolean NOT NULL DEFAULT true,
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenedores_doc UNIQUE (tipo_doc, documento)
);

CREATE INDEX IF NOT EXISTS idx_tenedores_nombre ON tenedores USING gin (nombre gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tenedores_activo ON tenedores(activo) WHERE activo = true;

CREATE TABLE IF NOT EXISTS propietarios_carga (
  id serial PRIMARY KEY,
  tipo_doc tipo_doc_rndc NOT NULL,
  documento varchar(20) NOT NULL,
  nombre varchar(200) NOT NULL,
  direccion varchar(300),
  ciudad_dane varchar(5) REFERENCES rndc_municipios(codigo_dane),
  telefono varchar(40),
  email varchar(150),
  client_id integer REFERENCES clients(id),
  activo boolean NOT NULL DEFAULT true,
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_propietarios_carga_doc UNIQUE (tipo_doc, documento)
);

CREATE INDEX IF NOT EXISTS idx_propietarios_carga_nombre ON propietarios_carga USING gin (nombre gin_trgm_ops);

CREATE TABLE IF NOT EXISTS destinatarios_carga (
  id serial PRIMARY KEY,
  tipo_doc tipo_doc_rndc NOT NULL,
  documento varchar(20) NOT NULL,
  nombre varchar(200) NOT NULL,
  direccion varchar(300),
  ciudad_dane varchar(5) REFERENCES rndc_municipios(codigo_dane),
  telefono varchar(40),
  email varchar(150),
  activo boolean NOT NULL DEFAULT true,
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_destinatarios_carga_doc UNIQUE (tipo_doc, documento)
);

CREATE INDEX IF NOT EXISTS idx_destinatarios_carga_nombre ON destinatarios_carga USING gin (nombre gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenedores, propietarios_carga, destinatarios_carga
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  tenedores_id_seq, propietarios_carga_id_seq, destinatarios_carga_id_seq
  TO operaciones_app;
