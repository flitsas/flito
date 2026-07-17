-- E3: Mediciones de odómetro/horómetro.
-- Fuentes posibles:
--   manual       — cargada por un operador en el sistema
--   app          — desde la app móvil (futuro)
--   gps          — proveedor GPS (futuro)
--   combustible  — derivada de un registro de tanqueo
--   ot           — derivada al cerrar una orden de trabajo (futuro)
-- excedio_promedio se setea si la diferencia con la última medición supera 3x dist_promedio_dia.

DO $$ BEGIN
  CREATE TYPE measurement_source AS ENUM ('manual', 'app', 'gps', 'combustible', 'ot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vehicle_measurements (
  id bigserial PRIMARY KEY,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  odometro integer,
  horometro integer,
  fuente measurement_source NOT NULL DEFAULT 'manual',
  usuario_id integer REFERENCES users(id),
  nota text,
  excedio_promedio boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_meas_one_value CHECK (odometro IS NOT NULL OR horometro IS NOT NULL),
  CONSTRAINT chk_meas_odo_pos CHECK (odometro IS NULL OR odometro >= 0),
  CONSTRAINT chk_meas_horo_pos CHECK (horometro IS NULL OR horometro >= 0)
);

CREATE INDEX IF NOT EXISTS idx_meas_vehicle_fecha ON vehicle_measurements(vehicle_id, fecha DESC, id DESC);
