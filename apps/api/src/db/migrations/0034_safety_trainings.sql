-- Capacitaciones de seguridad vial.
-- training_attendees rastrea asistencia, calificación y certificado por conductor.

DO $$ BEGIN
  CREATE TYPE training_modalidad AS ENUM ('presencial', 'virtual', 'mixta');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS safety_trainings (
  id serial PRIMARY KEY,
  titulo varchar(150) NOT NULL,
  descripcion text,
  horas numeric(4, 1) NOT NULL,
  fecha date NOT NULL,
  instructor varchar(120),
  modalidad training_modalidad NOT NULL DEFAULT 'presencial',
  link_material text,
  vigencia_meses integer,
  creada_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_horas_pos CHECK (horas > 0)
);

CREATE INDEX IF NOT EXISTS idx_trainings_fecha ON safety_trainings(fecha DESC);

CREATE TABLE IF NOT EXISTS training_attendees (
  training_id integer NOT NULL REFERENCES safety_trainings(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asistio boolean NOT NULL DEFAULT false,
  calificacion numeric(4, 2),
  certificado_storage_key varchar(500),
  registrado_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (training_id, user_id),
  CONSTRAINT chk_calif_rango CHECK (calificacion IS NULL OR (calificacion >= 0 AND calificacion <= 5))
);

CREATE INDEX IF NOT EXISTS idx_attendees_user ON training_attendees(user_id) WHERE asistio = true;
