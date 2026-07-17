-- Agregar rol transito
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'transito';

-- Agregar estados de tramite
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'recibido_transito';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'placa_preasignada';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'placa_asignada';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'solicitud_soat';

-- Agregar campos de tracking
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS recibido_por INTEGER REFERENCES users(id);
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS recibido_at TIMESTAMPTZ;
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS placa_asignada_at TIMESTAMPTZ;
