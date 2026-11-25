-- HU #13957 (Feature #13940, Épica #13671) — Liberar el nombre de los proveedores SOAT eliminados.
-- Autor: David Chica. Módulo FLITO `flito-parametrizacion` (tabla `flito_proveedores_soat`).
--
-- 1. Baja lógica: `deleted_at timestamptz NULL` (NULL = vigente) y `deleted_by` (actor, FK a `users.id`
--    ON DELETE RESTRICT, como en `clients` — 0257). Esta migración NO las escribe.
-- 2. La unicidad de `nombre` deja de ser global: se elimina la constraint única de la columna y se crea el índice
--    único parcial `uq_flito_proveedores_soat_nombre_vivo` (solo vigentes). Un proveedor eliminado libera su nombre.
--    Comparación EXACTA, la misma que la constraint que reemplaza y la que hacen las rutas (`eq(nombre, …)`): no se
--    normaliza con upper/btrim porque hoy no lo hace nadie y cambiaría qué nombres se consideran iguales.
--    No hace falta un DO de duplicados: la constraint actual ya garantiza que no existen.
--    La API traduce el 23505 de este índice (carrera entre dos altas) al mismo 409 de la validación previa.
--    La constraint se llama `flito_proveedores_soat_nombre_key` en las BD creadas por SQL; `…_nombre_unique` es el
--    nombre que le daría Drizzle. Se retiran ambas con IF EXISTS.
--
-- AVISO PDN: hacer `pg_dump` antes.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, FK solo si no existe, DROP CONSTRAINT IF EXISTS, CREATE UNIQUE INDEX IF NOT
-- EXISTS. Sin control de transacción propio (lo pone el runner).

ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS deleted_by integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_proveedores_soat_deleted_by_users_id_fk') THEN
    ALTER TABLE flito_proveedores_soat ADD CONSTRAINT flito_proveedores_soat_deleted_by_users_id_fk
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE flito_proveedores_soat DROP CONSTRAINT IF EXISTS flito_proveedores_soat_nombre_key;
ALTER TABLE flito_proveedores_soat DROP CONSTRAINT IF EXISTS flito_proveedores_soat_nombre_unique;

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_proveedores_soat_nombre_vivo
  ON flito_proveedores_soat (nombre)
  WHERE deleted_at IS NULL;
