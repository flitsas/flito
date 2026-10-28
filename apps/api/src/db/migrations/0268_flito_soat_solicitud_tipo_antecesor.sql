-- 0268 — Tipo de SOAT y antecesor en la solicitud del canal (Feature #14012, HU #14017, ADR-0030/0031).
-- Idempotente. `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT 'inicial'` es el backfill (existentes = inicial).
-- `soat_anterior_id` es nullable: una renovación cuyo SOAT previo no está en FLITO no tiene antecesor.
-- La FK no lleva ON DELETE CASCADE (RESTRICT por defecto): borrar un SOAT histórico no deja huérfana la cadena.

ALTER TABLE flito_soat_solicitud ADD COLUMN IF NOT EXISTS tipo_soat varchar(10) NOT NULL DEFAULT 'inicial';
ALTER TABLE flito_soat_solicitud ADD COLUMN IF NOT EXISTS soat_anterior_id uuid REFERENCES flito_soat(id);

ALTER TABLE flito_soat_solicitud DROP CONSTRAINT IF EXISTS flito_soat_solicitud_tipo_soat_chk;
ALTER TABLE flito_soat_solicitud ADD CONSTRAINT flito_soat_solicitud_tipo_soat_chk
  CHECK (tipo_soat IN ('inicial', 'renovacion'));
ALTER TABLE flito_soat_solicitud DROP CONSTRAINT IF EXISTS flito_soat_solicitud_anterior_chk;
ALTER TABLE flito_soat_solicitud ADD CONSTRAINT flito_soat_solicitud_anterior_chk
  CHECK (tipo_soat = 'renovacion' OR soat_anterior_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_flito_soat_solicitud_anterior ON flito_soat_solicitud (soat_anterior_id) WHERE soat_anterior_id IS NOT NULL;

COMMENT ON COLUMN flito_soat_solicitud.tipo_soat IS
  'Feature #14012: Inicial (por VIN, factura obligatoria) o Renovación (por placa + documento, factura opcional). Existentes = inicial.';

-- Aserción del AC «ningún SOAT del canal sin tipo»: toda fila origen='cliente' tiene satélite.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM flito_soat s LEFT JOIN flito_soat_solicitud q ON q.soat_id = s.id
             WHERE s.origen = 'cliente' AND q.soat_id IS NULL) THEN
    RAISE EXCEPTION '0268: hay SOAT del canal sin flito_soat_solicitud; revisar antes de aplicar';
  END IF;
END $$;
