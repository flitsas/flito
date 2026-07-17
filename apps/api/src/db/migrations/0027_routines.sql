-- Sprint 2A — Rutinas de mantenimiento (E3).
-- Una rutina agrupa jobs + parts y se aplica a vehículos según periodicidad.
-- routine_periodicity define cuándo se repite (km, horas, días) y a quién aplica.

CREATE TABLE IF NOT EXISTS maintenance_routines (
  id serial PRIMARY KEY,
  codigo varchar(30) NOT NULL UNIQUE,
  nombre varchar(150) NOT NULL,
  descripcion text,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routine_jobs (
  routine_id integer NOT NULL REFERENCES maintenance_routines(id) ON DELETE CASCADE,
  job_id integer NOT NULL REFERENCES maintenance_jobs(id) ON DELETE RESTRICT,
  orden integer NOT NULL DEFAULT 1,
  PRIMARY KEY (routine_id, job_id)
);

CREATE TABLE IF NOT EXISTS routine_parts (
  routine_id integer NOT NULL REFERENCES maintenance_routines(id) ON DELETE CASCADE,
  part_id integer NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  cantidad numeric(12, 3) NOT NULL DEFAULT 1,
  PRIMARY KEY (routine_id, part_id)
);

CREATE TABLE IF NOT EXISTS routine_periodicity (
  id serial PRIMARY KEY,
  routine_id integer NOT NULL REFERENCES maintenance_routines(id) ON DELETE CASCADE,
  criterio criterio_periodicidad NOT NULL,
  ref_id integer,
  tipo_vehiculo vehicle_type,
  combustible fuel_type,
  km_periodo integer,
  horas_periodo integer,
  dias_periodo integer,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_periodicidad_alguno CHECK (km_periodo IS NOT NULL OR horas_periodo IS NOT NULL OR dias_periodo IS NOT NULL),
  CONSTRAINT chk_criterio_ref CHECK (
    (criterio = 'vehicle' AND ref_id IS NOT NULL) OR
    (criterio = 'tipo_vehiculo' AND tipo_vehiculo IS NOT NULL) OR
    (criterio = 'combustible' AND combustible IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_periodicity_routine ON routine_periodicity(routine_id);
CREATE INDEX IF NOT EXISTS idx_periodicity_vehicle ON routine_periodicity(ref_id) WHERE criterio = 'vehicle';
CREATE INDEX IF NOT EXISTS idx_periodicity_tipo ON routine_periodicity(tipo_vehiculo) WHERE criterio = 'tipo_vehiculo';
