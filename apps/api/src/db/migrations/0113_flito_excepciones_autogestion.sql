-- HU #10980 — desbloqueo excepcional de la autogestión, por trámite.
--
-- Cuando una compañía autogestiona un concepto, FLITO no le crea el registro: `flito_soat` o
-- `flito_impuestos` simplemente NO nacen durante la sincronización. Por eso el desbloqueo no puede
-- ser una bandera que filtre — tiene que CREAR el registro que faltaba y marcarlo.
--
-- La marca va en el registro, no en el trámite, y eso es deliberado: las colas de SOAT e impuestos
-- consultan `flito_soat → clients` sin pasar por `flito_tramites`, así que una bandera en el trámite
-- sería invisible desde ahí. Con la columna en el propio registro, la frontera pasa de
-- `autogestionable = false` a `(autogestionable = false OR excepcion_autogestion)`: una condición
-- plana, sin subconsultas, válida también dentro del COUNT de la cola paginada.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001): el runner ya envuelve cada archivo en una transacción.

ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS excepcion_autogestion boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN flito_soat.excepcion_autogestion IS
  'true = creado por un desbloqueo excepcional pese a que la compañía autogestiona su SOAT.';

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS excepcion_autogestion boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN flito_impuestos.excepcion_autogestion IS
  'true = creado por un desbloqueo excepcional pese a que la compañía autogestiona sus impuestos.';

-- Auditoría del desbloqueo, y única sede del caso de LOGÍSTICA, que no tiene registro propio que
-- marcar: su frontera se resuelve por EXISTS sobre esta tabla.
CREATE TABLE IF NOT EXISTS flito_excepciones_autogestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  concepto varchar(20) NOT NULL,
  motivo text NOT NULL,
  creado_por_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revocado_en timestamptz,
  revocado_por_id integer REFERENCES users(id),
  revocado_motivo text
);

-- Índice parcial: un trámite no puede tener DOS excepciones vivas del mismo concepto, pero sí puede
-- acumular varias revocadas — el histórico de por qué se desbloqueó y por qué se deshizo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_excepciones_vigente
  ON flito_excepciones_autogestion (tramite_id, concepto)
  WHERE revocado_en IS NULL;

CREATE INDEX IF NOT EXISTS idx_flito_excepciones_tramite
  ON flito_excepciones_autogestion (tramite_id);
