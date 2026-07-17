-- Sprint 4 Fase 4.2 — WORM rndc_operaciones (log inmutable de operaciones RNDC)
-- ISO 27001 A.12.4.2 — protección de información de logs (inmutabilidad)

-- Función reutilizable touch updated_at (no existía).
CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ENUMs
DO $$ BEGIN
  CREATE TYPE rndc_op_tipo AS ENUM (
    'ingresarRemesa', 'ingresarManifiesto', 'anularManifiesto',
    'anularRemesa', 'consultarEstadoIngreso', 'cumplirManifiesto'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rndc_op_resultado AS ENUM ('ok', 'error_negocio', 'error_tecnico', 'timeout');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tabla append-only.
CREATE TABLE IF NOT EXISTS rndc_operaciones (
  id bigserial PRIMARY KEY,
  tipo_op rndc_op_tipo NOT NULL,
  entidad_tipo varchar(20) NOT NULL,
  entidad_id integer NOT NULL,
  intento smallint NOT NULL DEFAULT 1,
  modo varchar(10) NOT NULL,
  request_xml text,
  response_xml text,
  resultado rndc_op_resultado NOT NULL,
  codigo_resultado varchar(10),
  consecutivo_rndc varchar(30),
  mensaje text,
  duracion_ms integer,
  ip_origen varchar(45),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id) ON DELETE RESTRICT
);

-- Índices.
CREATE INDEX IF NOT EXISTS idx_rndc_op_entidad
  ON rndc_operaciones(entidad_tipo, entidad_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rndc_op_tipo_resultado
  ON rndc_operaciones(tipo_op, resultado);
CREATE INDEX IF NOT EXISTS idx_rndc_op_created_at
  ON rndc_operaciones(created_at DESC);

-- WORM: bloquear UPDATE y DELETE con triggers.
CREATE OR REPLACE FUNCTION fn_rndc_operaciones_worm()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rndc_operaciones es WORM (write-once, read-many): % no permitido',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rndc_op_no_update ON rndc_operaciones;
CREATE TRIGGER trg_rndc_op_no_update BEFORE UPDATE ON rndc_operaciones
  FOR EACH ROW EXECUTE FUNCTION fn_rndc_operaciones_worm();

DROP TRIGGER IF EXISTS trg_rndc_op_no_delete ON rndc_operaciones;
CREATE TRIGGER trg_rndc_op_no_delete BEFORE DELETE ON rndc_operaciones
  FOR EACH ROW EXECUTE FUNCTION fn_rndc_operaciones_worm();

-- Owner = postgres (impide al rol app DISABLE TRIGGER o DROP TRIGGER).
-- En este servidor el rol de la app (operaciones_app) NO es owner por convención;
-- la migración corre como superuser. Reaseguramos owner explícitamente:
ALTER TABLE rndc_operaciones OWNER TO postgres;
ALTER FUNCTION fn_rndc_operaciones_worm() OWNER TO postgres;

-- Permisos mínimos: SELECT + INSERT. NO UPDATE, NO DELETE, NO TRUNCATE.
GRANT SELECT, INSERT ON rndc_operaciones TO operaciones_app;
GRANT USAGE, SELECT ON SEQUENCE rndc_operaciones_id_seq TO operaciones_app;
