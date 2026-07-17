-- Multas de tránsito (SIMIT) por vehículo.
-- Estado:
--   no_consultado — el operador aún no consultó SIMIT
--   sin_multas    — SIMIT respondió sin comparendos
--   con_multas    — hay comparendos pendientes
--   acuerdo_pago  — el contribuyente tiene acuerdo de pago vigente

DO $$ BEGIN
  CREATE TYPE multas_estado AS ENUM ('no_consultado', 'sin_multas', 'con_multas', 'acuerdo_pago');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS multas_estado multas_estado NOT NULL DEFAULT 'no_consultado',
  ADD COLUMN IF NOT EXISTS multas_total numeric(15, 2),
  ADD COLUMN IF NOT EXISTS multas_count integer,
  ADD COLUMN IF NOT EXISTS multas_consultado_at timestamptz,
  ADD COLUMN IF NOT EXISTS multas_notas text;

CREATE INDEX IF NOT EXISTS idx_vehicles_multas_estado ON vehicles(multas_estado);
