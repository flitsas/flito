-- Sprint 3B — Plan de emergencias (Res. 40595/2022).
-- Directorio de contactos por zona, protocolos versionados, simulacros con evidencia.

DO $$ BEGIN
  CREATE TYPE emergency_contact_tipo AS ENUM ('arl', 'ambulancia', 'bombero', 'policia', 'taller_grua', 'aseguradora', 'interno');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE emergency_categoria AS ENUM ('accidente', 'averia', 'medico', 'seguridad');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id serial PRIMARY KEY,
  tipo emergency_contact_tipo NOT NULL,
  zona varchar(100) NOT NULL,
  nombre varchar(150) NOT NULL,
  telefono varchar(40) NOT NULL,
  telefono_alternativo varchar(40),
  email varchar(150),
  direccion varchar(300),
  observaciones text,
  prioridad smallint NOT NULL DEFAULT 100,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emergency_zona_tipo ON emergency_contacts(zona, tipo, prioridad) WHERE activo = true;

INSERT INTO emergency_contacts (tipo, zona, nombre, telefono, prioridad) VALUES
  ('policia',    'nacional', 'Policía Nacional',           '123', 10),
  ('ambulancia', 'nacional', 'Línea de emergencias 123',   '123', 10),
  ('bombero',    'nacional', 'Bomberos',                   '119', 20),
  ('arl',        'nacional', 'ARL — línea de emergencias', '018000', 30)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS emergency_protocols (
  id serial PRIMARY KEY,
  titulo varchar(200) NOT NULL,
  categoria emergency_categoria NOT NULL,
  descripcion_md text NOT NULL,
  zonas text[] NOT NULL DEFAULT '{}'::text[],
  version integer NOT NULL DEFAULT 1,
  vigente boolean NOT NULL DEFAULT true,
  archivo_pdf_storage_key varchar(500),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_protocols_vigente ON emergency_protocols(categoria, vigente) WHERE vigente = true;

CREATE TABLE IF NOT EXISTS emergency_drills (
  id serial PRIMARY KEY,
  fecha date NOT NULL,
  escenario varchar(200) NOT NULL,
  protocolo_id integer REFERENCES emergency_protocols(id) ON DELETE SET NULL,
  participantes integer[] NOT NULL DEFAULT '{}'::int[],
  evidencia_storage_keys text[] NOT NULL DEFAULT '{}'::text[],
  observaciones text,
  plan_mejora text,
  responsable_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drills_fecha ON emergency_drills(fecha DESC);
