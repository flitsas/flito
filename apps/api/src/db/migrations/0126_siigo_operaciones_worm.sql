-- 0126_siigo_operaciones_worm.sql
-- Feature #11239 — Integración con Siigo API. HU #11251: bitácora inalterable de operaciones.
-- ISO 27001 A.12.4.2 — protección de información de logs (inmutabilidad).
--
-- Append-only: los disparadores prohíben UPDATE y DELETE. Una factura electrónica respalda una
-- venta ante la DIAN; si la bitácora de lo que se envió se pudiera editar, no probaría nada.
--
-- Idempotente: se puede correr dos veces sin efecto adicional.

CREATE TABLE IF NOT EXISTS siigo_operaciones (
  id             bigserial PRIMARY KEY,
  -- Qué se hizo: 'auth', 'crear_factura', 'consultar_factura', … Texto y no enum porque el catálogo
  -- de operaciones crecerá con las Features 11 a 15 y un enum obligaría a migrar por cada una.
  operacion      varchar(40) NOT NULL,
  metodo         varchar(10),
  ruta           varchar(300),
  -- Entidad de FLITO relacionada (tramite, cliente, …) para poder reconstruir su historia.
  entidad_tipo   varchar(20),
  entidad_id     varchar(60),
  intento        smallint NOT NULL DEFAULT 1,
  ambiente       varchar(12) NOT NULL,
  -- 'real' o 'mock'. Permite distinguir una prueba de una operación productiva.
  modo           varchar(10) NOT NULL DEFAULT 'real',
  request_body   jsonb,
  response_body  jsonb,
  status_http    smallint,
  resultado      varchar(20) NOT NULL,
  codigo         varchar(60),
  mensaje        text,
  duracion_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT siigo_operaciones_resultado_chk
    CHECK (resultado IN ('ok', 'error_negocio', 'error_tecnico', 'timeout'))
);

-- «¿Qué le pasó a este trámite?» sin barrer la tabla entera.
CREATE INDEX IF NOT EXISTS idx_siigo_op_entidad
  ON siigo_operaciones (entidad_tipo, entidad_id, created_at DESC);
-- Barrido por rango de fechas y tablero de fallos.
CREATE INDEX IF NOT EXISTS idx_siigo_op_created_at
  ON siigo_operaciones (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_siigo_op_resultado
  ON siigo_operaciones (resultado, created_at DESC);

-- WORM: bloquear UPDATE y DELETE con disparadores.
CREATE OR REPLACE FUNCTION fn_siigo_operaciones_worm()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'siigo_operaciones es WORM (write-once, read-many): % no permitido',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_siigo_op_no_update ON siigo_operaciones;
CREATE TRIGGER trg_siigo_op_no_update BEFORE UPDATE ON siigo_operaciones
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_operaciones_worm();

DROP TRIGGER IF EXISTS trg_siigo_op_no_delete ON siigo_operaciones;
CREATE TRIGGER trg_siigo_op_no_delete BEFORE DELETE ON siigo_operaciones
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_operaciones_worm();

-- Endurecimiento por ownership, igual que en 0045_rndc_operaciones_worm.sql.
-- El guard es por docker-compose: allí POSTGRES_USER es `operaciones_app` y no existe ningún rol
-- llamado `postgres`, así que sin guard la cadena moría con `role "postgres" does not exist`. En ese
-- escenario el WORM tampoco aporta: el rol de la app YA es superusuario y podría quitar el trigger.
-- Los disparadores de arriba sí se crean siempre; lo condicional es solo el endurecimiento.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER TABLE siigo_operaciones OWNER TO postgres;
    ALTER FUNCTION fn_siigo_operaciones_worm() OWNER TO postgres;
  END IF;
END $$;

-- Permisos mínimos: SELECT + INSERT. NO UPDATE, NO DELETE, NO TRUNCATE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT ON siigo_operaciones TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE siigo_operaciones_id_seq TO operaciones_app;
  END IF;
END $$;

COMMENT ON TABLE siigo_operaciones IS
  'Bitácora WORM de las llamadas a Siigo API. Append-only por disparador (HU #11251).';
COMMENT ON COLUMN siigo_operaciones.request_body IS
  'Cuerpo enviado, ya saneado: nunca contiene access_key ni cabecera de autorización.';
