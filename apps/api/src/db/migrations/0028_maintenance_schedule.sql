-- Sprint 2A — Schedule de mantenimiento generado por cron 6:15 AM.
-- UNIQUE parcial (vehicle_id, routine_id, fecha_programada) WHERE estado='pendiente'
-- garantiza idempotencia del cron sin duplicar entradas.

CREATE TABLE IF NOT EXISTS maintenance_schedule (
  id bigserial PRIMARY KEY,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  routine_id integer REFERENCES maintenance_routines(id) ON DELETE CASCADE,
  job_id integer REFERENCES maintenance_jobs(id) ON DELETE CASCADE,
  fecha_programada date NOT NULL,
  medicion_programada integer,
  tipo schedule_tipo NOT NULL DEFAULT 'automatica',
  secuencial boolean NOT NULL DEFAULT false,
  estado schedule_estado NOT NULL DEFAULT 'pendiente',
  wo_id integer,
  creado_por integer REFERENCES users(id),
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_schedule_routine_o_job CHECK (routine_id IS NOT NULL OR job_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_schedule_vehicle_fecha ON maintenance_schedule(vehicle_id, fecha_programada DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_pendiente_vehicle
  ON maintenance_schedule(vehicle_id, fecha_programada)
  WHERE estado = 'pendiente';

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_no_dup_pendiente
  ON maintenance_schedule(vehicle_id, routine_id, fecha_programada)
  WHERE estado = 'pendiente' AND routine_id IS NOT NULL;
