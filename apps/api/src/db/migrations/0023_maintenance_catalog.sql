-- Sprint 2A — Catálogo de mantenimiento (E1).
-- Sistemas (motor, frenos, etc.), subsistemas, jobs (trabajos atómicos).

DO $$ BEGIN
  CREATE TYPE criterio_periodicidad AS ENUM ('vehicle', 'tipo_vehiculo', 'combustible');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE schedule_tipo AS ENUM ('manual', 'automatica');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE schedule_estado AS ENUM ('pendiente', 'ejecutada', 'vencida', 'cancelada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pre_order_estado AS ENUM ('borrador', 'aprobada', 'generada_ot', 'rechazada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wo_tipo AS ENUM ('preventivo', 'correctivo', 'predictivo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wo_estado AS ENUM ('abierta', 'cerrada_tecnica', 'cerrada_final', 'anulada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE movement_type AS ENUM ('entrada', 'salida', 'traslado', 'ajuste', 'reverso_ot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance_systems (
  id serial PRIMARY KEY,
  codigo varchar(20) NOT NULL UNIQUE,
  nombre varchar(80) NOT NULL,
  orden integer NOT NULL DEFAULT 100,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO maintenance_systems (codigo, nombre, orden) VALUES
  ('MOT', 'Motor', 10),
  ('FRE', 'Frenos', 20),
  ('SUS', 'Suspensión', 30),
  ('ELE', 'Eléctrico', 40),
  ('LUB', 'Lubricación', 50),
  ('NEU', 'Neumáticos', 60),
  ('TRA', 'Transmisión', 70),
  ('DIR', 'Dirección', 80)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS maintenance_subsystems (
  id serial PRIMARY KEY,
  system_id integer NOT NULL REFERENCES maintenance_systems(id) ON DELETE RESTRICT,
  codigo varchar(20) NOT NULL,
  nombre varchar(80) NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_subsys_codigo UNIQUE (system_id, codigo)
);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id serial PRIMARY KEY,
  codigo varchar(30) NOT NULL UNIQUE,
  nombre varchar(150) NOT NULL,
  system_id integer REFERENCES maintenance_systems(id) ON DELETE RESTRICT,
  subsystem_id integer REFERENCES maintenance_subsystems(id) ON DELETE RESTRICT,
  tiempo_estimado_horas numeric(6, 2),
  descripcion text,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_system ON maintenance_jobs(system_id, subsystem_id);
CREATE INDEX IF NOT EXISTS idx_jobs_activo ON maintenance_jobs(activo) WHERE activo = true;
