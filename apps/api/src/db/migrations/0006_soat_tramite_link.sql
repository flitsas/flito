-- Link soatRequests con tramitesDigitales
ALTER TABLE soat_requests ADD COLUMN IF NOT EXISTS tramite_id INTEGER REFERENCES tramites_digitales(id);

-- Nuevos estados para flujo post-SOAT
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'soat_comprado';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'soat_verificado';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'completado';
