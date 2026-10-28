-- 0269 — flito_soat_incompletas crece para la RENOVACIÓN con RUNT caído (Feature #14012, HU #14018, ADR-0030).
-- Idempotente: ADD COLUMN IF NOT EXISTS, DROP NOT NULL, DROP/ADD CONSTRAINT y CREATE INDEX IF NOT EXISTS
-- se pueden repetir sin efecto. Las filas existentes quedan como tipo 'inicial', modalidad 'vin',
-- motivo 'runt_sin_respuesta' (los DEFAULT son el backfill) y cumplen todos los CHECK nuevos
-- (vin y factura ya eran NOT NULL).
-- Los motivos 'falta_factura_venta' y 'faltan_datos_propietario' se definen aquí para la carga masiva
-- futura (F2/F3): ningún escritor de esta HU los produce.

ALTER TABLE flito_soat_incompletas ADD COLUMN IF NOT EXISTS tipo_soat varchar(10) NOT NULL DEFAULT 'inicial';
ALTER TABLE flito_soat_incompletas ADD COLUMN IF NOT EXISTS modalidad_consulta varchar(5) NOT NULL DEFAULT 'vin';
ALTER TABLE flito_soat_incompletas ADD COLUMN IF NOT EXISTS placa varchar(10);
ALTER TABLE flito_soat_incompletas ADD COLUMN IF NOT EXISTS motivo_pendiente varchar(30) NOT NULL DEFAULT 'runt_sin_respuesta';

-- Una renovación con RUNT caído no tiene VIN; una sin factura no tiene ninguna de las cinco columnas.
ALTER TABLE flito_soat_incompletas ALTER COLUMN vin DROP NOT NULL;
ALTER TABLE flito_soat_incompletas ALTER COLUMN factura_storage_key DROP NOT NULL;
ALTER TABLE flito_soat_incompletas ALTER COLUMN factura_hash DROP NOT NULL;
ALTER TABLE flito_soat_incompletas ALTER COLUMN factura_nombre_archivo DROP NOT NULL;
ALTER TABLE flito_soat_incompletas ALTER COLUMN factura_content_type DROP NOT NULL;
ALTER TABLE flito_soat_incompletas ALTER COLUMN factura_tamano_bytes DROP NOT NULL;

ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_tipo_soat_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_tipo_soat_chk
  CHECK (tipo_soat IN ('inicial', 'renovacion'));

ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_modalidad_consulta_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_modalidad_consulta_chk
  CHECK (modalidad_consulta IN ('vin', 'placa'));

ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_modalidad_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_modalidad_chk
  CHECK ((modalidad_consulta = 'vin' AND vin IS NOT NULL) OR (modalidad_consulta = 'placa' AND placa IS NOT NULL));

ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_factura_completa_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_factura_completa_chk
  CHECK ((factura_storage_key IS NULL) = (factura_hash IS NULL)
     AND (factura_storage_key IS NULL) = (factura_nombre_archivo IS NULL)
     AND (factura_storage_key IS NULL) = (factura_content_type IS NULL)
     AND (factura_storage_key IS NULL) = (factura_tamano_bytes IS NULL));

ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_motivo_pendiente_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_motivo_pendiente_chk
  CHECK (motivo_pendiente IN ('runt_sin_respuesta', 'falta_factura_venta', 'faltan_datos_propietario'));

-- Invariante «Inicial lleva factura» (salvo que el motivo sea precisamente que falta).
ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_factura_inicial_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_factura_inicial_chk
  CHECK (tipo_soat = 'renovacion' OR factura_storage_key IS NOT NULL OR motivo_pendiente = 'falta_factura_venta');

-- El descarte ahora admite 'sin_soat_anterior' (el RUNT dice que el vehículo no registra SOAT).
ALTER TABLE flito_soat_incompletas DROP CONSTRAINT IF EXISTS flito_soat_incompletas_motivo_chk;
ALTER TABLE flito_soat_incompletas ADD CONSTRAINT flito_soat_incompletas_motivo_chk
  CHECK (motivo_descarte IS NULL OR motivo_descarte IN
    ('soat_vigente', 'runt_no_cuadra', 'runt_sin_registro', 'runt_sin_vin', 'solicitud_existente', 'sin_soat_anterior'));

-- Gemelo del índice del VIN abierto: una sola incompleta abierta por placa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_incompletas_placa_abierta
  ON flito_soat_incompletas (placa) WHERE estado = 'incompleta' AND placa IS NOT NULL;

COMMENT ON COLUMN flito_soat_incompletas.modalidad_consulta IS
  'Feature #14012: cómo se consultó/consultará el RUNT: vin (Inicial) o placa + documento del propietario (Renovación).';
