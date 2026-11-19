-- 0267 — Varios SOAT por vehículo, UNO ABIERTO a la vez (Feature #14012, HU #14016, ADR-0031).
-- Idempotente. Crea primero los índices (nunca hay un instante sin garantía) y luego quita los
-- UNIQUE incondicionales de vin y vehiculo_id. Sin backfill: hoy hay <=1 fila por vin/vehiculo.

-- 1. índices de lookup (los UNIQUE que se quitan eran también el índice de búsqueda)
CREATE INDEX IF NOT EXISTS idx_flito_soat_vin ON flito_soat (vin);
CREATE INDEX IF NOT EXISTS idx_flito_soat_vehiculo ON flito_soat (vehiculo_id);

-- 2. a lo sumo UN SOAT abierto (no terminal) por vin y por vehículo
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_vin_abierto
  ON flito_soat (vin) WHERE estado <> 'pagado';
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_vehiculo_abierto
  ON flito_soat (vehiculo_id) WHERE estado <> 'pagado';

-- 3. quitar los UNIQUE incondicionales por columna (se resuelven por catálogo, no por nombre)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'flito_soat'::regclass AND c.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
          IN (ARRAY['vin'], ARRAY['vehiculo_id'])
  LOOP
    EXECUTE format('ALTER TABLE flito_soat DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

COMMENT ON TABLE flito_soat IS 'Un SOAT por fila. RN-01 (ADR-0031): a lo sumo UN abierto (estado <> pagado) por vin/vehiculo; los pagados son historial.';
