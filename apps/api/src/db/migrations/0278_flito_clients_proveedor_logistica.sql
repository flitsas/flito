-- HU #14104 (Feature #14089, Épica #13758): cada compañía con la logística encendida tiene un proveedor de logística.
-- `clients.flito_proveedor_logistica_id` (uuid, NULLABLE) -> flito_proveedores_logistica(id), ON DELETE RESTRICT.
-- SIN proveedor por defecto: las compañías con la logística encendida hoy (logistica_autogestionable = false) quedan
-- con NULL y Operaciones lo asigna después; la regla «encendida exige proveedor» la aplica el PATCH de compañías
-- (422), no un CHECK, para no invalidar las filas existentes. Idempotente. Depende de la 0277 / tabla de la HU #14103.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS flito_proveedor_logistica_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_flito_proveedor_logistica_id_fkey') THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_flito_proveedor_logistica_id_fkey
      FOREIGN KEY (flito_proveedor_logistica_id) REFERENCES flito_proveedores_logistica (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clients_flito_proveedor_logistica ON clients (flito_proveedor_logistica_id);

COMMENT ON COLUMN clients.flito_proveedor_logistica_id IS
  'HU #14104: proveedor que maneja la logistica de la compania (siempre mensajeria propia). NULL = sin asignar. Exigido solo si logistica_autogestionable = false (lo valida el PATCH de companias).';
