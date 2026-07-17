-- Sprint 3B — Pruebas de alcoholimetría (Ley 1696/2013).
-- Política cero alcohol: cualquier valor_mg > 0 es positivo y suspende al conductor.

DO $$ BEGIN
  CREATE TYPE alcohol_test_tipo AS ENUM ('preoperacional', 'aleatoria', 'post_incidente', 'periodica');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alcohol_resultado AS ENUM ('negativo', 'positivo', 'inconcluso');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS alcohol_tests (
  id serial PRIMARY KEY,
  conductor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fecha_hora timestamptz NOT NULL DEFAULT NOW(),
  tipo alcohol_test_tipo NOT NULL,
  valor_mg numeric(4, 2) NOT NULL,
  grado_alcohol smallint NOT NULL DEFAULT 0,
  resultado alcohol_resultado NOT NULL,
  equipo_serial varchar(60),
  equipo_calibracion_fecha date,
  operador_id integer NOT NULL REFERENCES users(id),
  incident_id integer REFERENCES road_incidents(id) ON DELETE SET NULL,
  foto_evidencia_keys text[] NOT NULL DEFAULT '{}'::text[],
  accion_tomada text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_alcohol_valor_rango CHECK (valor_mg >= 0 AND valor_mg < 10),
  CONSTRAINT chk_alcohol_grado_rango CHECK (grado_alcohol BETWEEN 0 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_alcohol_conductor ON alcohol_tests(conductor_id, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_alcohol_positivos ON alcohol_tests(resultado, fecha_hora DESC) WHERE resultado = 'positivo';
