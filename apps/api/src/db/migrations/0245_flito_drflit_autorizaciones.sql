-- HU #13803 (Feature #13695) — Dr. Flit: autorizaciones de tratamiento de datos (Ley 1581). Solo inserción.
-- Diseño: docs/diseno/feature-13695-dr-flit-soporte.md. Idempotente: IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION y DROP TRIGGER IF EXISTS + CREATE TRIGGER (se puede aplicar dos veces).
--
-- Por qué triggers y no REVOKE: la aplicación se conecta como dueña de las tablas. Mismo mecanismo y
-- mismo nivel de garantía que `pii_access_log` (0059): el dueño puede DROP TRIGGER. La purga futura
-- de autorizaciones (P9-10) abrirá una vía controlada en una migración NUEVA; no se adelanta aquí.
CREATE TABLE IF NOT EXISTS flito_drflit_autorizaciones (
  id            serial PRIMARY KEY,
  usuario_id    integer      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  finalidad     varchar(20)  NOT NULL,
  version       varchar(40)  NOT NULL,
  texto_sha256  char(64)     NOT NULL,
  aceptada_en   timestamptz  NOT NULL DEFAULT now(),
  ip            varchar(45),
  user_agent    varchar(300),
  CONSTRAINT ck_flito_drflit_aut_finalidad CHECK (finalidad IN ('soporte','ia')),
  CONSTRAINT ck_flito_drflit_aut_sha CHECK (texto_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_drflit_aut_usuario_finalidad_version
  ON flito_drflit_autorizaciones (usuario_id, finalidad, version);

CREATE OR REPLACE FUNCTION flito_drflit_autorizaciones_solo_insercion() RETURNS trigger AS $drflit0245$
BEGIN
  RAISE EXCEPTION 'flito_drflit_autorizaciones es de solo inserción (Ley 1581)' USING ERRCODE = 'P0001';
END;
$drflit0245$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_flito_drflit_aut_solo_insercion ON flito_drflit_autorizaciones;
CREATE TRIGGER tr_flito_drflit_aut_solo_insercion BEFORE UPDATE OR DELETE ON flito_drflit_autorizaciones
  FOR EACH ROW EXECUTE FUNCTION flito_drflit_autorizaciones_solo_insercion();
DROP TRIGGER IF EXISTS tr_flito_drflit_aut_sin_truncate ON flito_drflit_autorizaciones;
CREATE TRIGGER tr_flito_drflit_aut_sin_truncate BEFORE TRUNCATE ON flito_drflit_autorizaciones
  FOR EACH STATEMENT EXECUTE FUNCTION flito_drflit_autorizaciones_solo_insercion();
