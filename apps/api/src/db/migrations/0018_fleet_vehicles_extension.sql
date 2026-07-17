-- Sprint 1 Flota — Núcleo CloudFleet-style.
-- E1: Extensión de la tabla vehicles para soportar flota propia (FLIT SAS).
-- Las columnas son nullables y aplica solo cuando es_flota_propia=true.
-- El pipeline de tránsito (CEA/clientes externos) sigue funcionando intacto.

DO $$ BEGIN
  CREATE TYPE vehicle_type AS ENUM ('tractomula', 'camion', 'buseta', 'camioneta', 'automovil', 'motocicleta', 'otro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE measurement_type AS ENUM ('km', 'horas', 'ambos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE work_load AS ENUM ('bajo', 'normal', 'severo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fuel_type AS ENUM ('acpm', 'gasolina', 'gas', 'electrico', 'hibrido');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS es_flota_propia boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tipo_vehiculo vehicle_type,
  ADD COLUMN IF NOT EXISTS tipo_medicion measurement_type,
  ADD COLUMN IF NOT EXISTS medicion_principal varchar(10),
  ADD COLUMN IF NOT EXISTS tipo_trabajo work_load DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS combustible_principal fuel_type,
  ADD COLUMN IF NOT EXISTS combustible_secundario fuel_type,
  ADD COLUMN IF NOT EXISTS num_motor varchar(50),
  ADD COLUMN IF NOT EXISTS num_serie varchar(50),
  ADD COLUMN IF NOT EXISTS fecha_compra date,
  ADD COLUMN IF NOT EXISTS precio_compra numeric(15, 2),
  ADD COLUMN IF NOT EXISTS dist_max_24h integer,
  ADD COLUMN IF NOT EXISTS dist_promedio_dia integer,
  ADD COLUMN IF NOT EXISTS horas_op_mes integer,
  ADD COLUMN IF NOT EXISTS rendimiento_ideal numeric(8, 2),
  ADD COLUMN IF NOT EXISTS color varchar(30),
  ADD COLUMN IF NOT EXISTS alias varchar(80);

-- Índice parcial: las consultas de flota nunca tocan los millones de registros de tránsito.
CREATE INDEX IF NOT EXISTS idx_vehicles_flota
  ON vehicles(es_flota_propia)
  WHERE es_flota_propia = true;

-- Backfill: medicion_principal default a 'km' cuando es flota.
UPDATE vehicles SET medicion_principal = 'km' WHERE es_flota_propia = true AND medicion_principal IS NULL;
