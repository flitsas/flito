-- CHECK constraints para validar datos en capa BD (defensa en profundidad)
-- Los endpoints ya validan pero la BD es la última línea contra bugs/ingest malicioso.

-- vehicles: año realista + valores monetarios no negativos
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_vehicles_year_range') THEN
    ALTER TABLE vehicles ADD CONSTRAINT chk_vehicles_year_range
      CHECK (year IS NULL OR (year >= 1970 AND year <= 2030));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_vehicles_tax_amount_nonneg') THEN
    ALTER TABLE vehicles ADD CONSTRAINT chk_vehicles_tax_amount_nonneg
      CHECK (tax_amount IS NULL OR tax_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_vehicles_avaluo_nonneg') THEN
    ALTER TABLE vehicles ADD CONSTRAINT chk_vehicles_avaluo_nonneg
      CHECK (avaluo_comercial IS NULL OR avaluo_comercial >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_vehicles_total_pagar_nonneg') THEN
    ALTER TABLE vehicles ADD CONSTRAINT chk_vehicles_total_pagar_nonneg
      CHECK (impuesto_total_pagar IS NULL OR impuesto_total_pagar >= 0);
  END IF;
END $$;

-- soat_requests: fechas coherentes (compra <= vencimiento)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_soat_dates_coherent') THEN
    ALTER TABLE soat_requests ADD CONSTRAINT chk_soat_dates_coherent
      CHECK (purchase_date IS NULL OR expiry_date IS NULL OR purchase_date <= expiry_date);
  END IF;
END $$;

-- Índices compuestos adicionales (los 2 principales ya están en 0009)
CREATE INDEX IF NOT EXISTS idx_soat_requests_vehicle_status
  ON soat_requests(vehicle_id, status);

CREATE INDEX IF NOT EXISTS idx_soat_refresh_attempts_soat_created
  ON soat_refresh_attempts(soat_request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicles_client
  ON vehicles(client_id)
  WHERE client_id IS NOT NULL;
