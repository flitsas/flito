-- HU #13964 (Feature #13888, ADR-0028 adenda): retiro de la versión vigente del expediente documental
-- de la compañía. La versión retirada conserva su fila (y su archivo, que purga la retención de 5 años
-- contados desde el retiro: `reemplazado_en = retirado_en`). La 0248 no se toca. Idempotente.
ALTER TABLE flito_bolsas_documentos
  ADD COLUMN IF NOT EXISTS retirado_en   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS retirado_por  integer NULL,
  ADD COLUMN IF NOT EXISTS motivo_retiro varchar(300) NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_documentos_retirado_por_users_id_fk') THEN
    ALTER TABLE flito_bolsas_documentos
      ADD CONSTRAINT flito_bolsas_documentos_retirado_por_users_id_fk
      FOREIGN KEY (retirado_por) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  -- Motivo y autor solo existen con fecha de retiro (la purga anula el motivo y conserva la fecha).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_bolsas_documentos_retiro_datos') THEN
    ALTER TABLE flito_bolsas_documentos
      ADD CONSTRAINT ck_flito_bolsas_documentos_retiro_datos
      CHECK (retirado_en IS NOT NULL OR (motivo_retiro IS NULL AND retirado_por IS NULL));
  END IF;
  -- Retirada ⇒ no vigente y reemplazada en el mismo instante (la purga cuenta desde ahí).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_bolsas_documentos_retiro') THEN
    ALTER TABLE flito_bolsas_documentos
      ADD CONSTRAINT ck_flito_bolsas_documentos_retiro
      CHECK (retirado_en IS NULL OR (NOT vigente AND reemplazado_en = retirado_en));
  END IF;
END $$;
