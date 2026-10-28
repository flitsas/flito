-- HU #14103 (Feature #14089): el proveedor de logística gana NIT, contacto y teléfono.
-- Tabla separada de flito_proveedores_soat (no se toca). Idempotente.
-- Las filas previas quedan con nit NULL (se asignan después, HU A2 / producto): el índice único es PARCIAL
-- (WHERE nit IS NOT NULL), así que varias filas sin NIT conviven y dos con el mismo NIT no.
ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS nit VARCHAR(20);
ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS contacto VARCHAR(150);
ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS telefono VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_proveedores_logistica_nit
  ON flito_proveedores_logistica (nit) WHERE nit IS NOT NULL;
