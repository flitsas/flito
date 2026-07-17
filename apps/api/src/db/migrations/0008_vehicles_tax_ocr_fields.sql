-- Datos extraídos del OCR de declaraciones de impuesto vehicular
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS avaluo_comercial INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS impuesto_total_pagar INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS formulario_no VARCHAR(30);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS tax_source VARCHAR(20); -- 'ocr' | 'manual' | 'paynet'

-- Relajar NOT NULL en VIN: los formularios de impuesto solo traen placa, no VIN.
-- El UNIQUE se mantiene pero permite múltiples NULLs (comportamiento estándar PostgreSQL).
ALTER TABLE vehicles ALTER COLUMN vin DROP NOT NULL;
