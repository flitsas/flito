-- E2: Vinculación de equipos cabezote ↔ trailer.
-- Un trailer (vehiculo_vinculado) está atado a un cabezote (vehiculo_principal) durante
-- un período. Solo puede haber un trailer "es_actual=true" para cada vinculado a la vez.
-- Histórico se conserva con desde/hasta.

CREATE TABLE IF NOT EXISTS vehicle_equipment_links (
  id serial PRIMARY KEY,
  vehiculo_principal_id integer NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  vehiculo_vinculado_id integer NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  desde timestamptz NOT NULL DEFAULT NOW(),
  hasta timestamptz,
  es_actual boolean NOT NULL DEFAULT true,
  creado_por integer REFERENCES users(id),
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_link_distinct CHECK (vehiculo_principal_id <> vehiculo_vinculado_id),
  CONSTRAINT chk_link_periodo CHECK (hasta IS NULL OR hasta >= desde)
);

-- Un equipo (trailer) solo puede estar vinculado a UN cabezote vigente a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_vinculado_actual_unique
  ON vehicle_equipment_links(vehiculo_vinculado_id)
  WHERE es_actual = true;

CREATE INDEX IF NOT EXISTS idx_link_principal_actual
  ON vehicle_equipment_links(vehiculo_principal_id)
  WHERE es_actual = true;

CREATE INDEX IF NOT EXISTS idx_link_principal ON vehicle_equipment_links(vehiculo_principal_id);
CREATE INDEX IF NOT EXISTS idx_link_vinculado ON vehicle_equipment_links(vehiculo_vinculado_id);
