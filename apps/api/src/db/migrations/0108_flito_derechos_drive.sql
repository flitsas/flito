-- 0108 — Sincronización de derechos de trámite desde el Drive del organismo (HU #10952).
--
-- Cada secretaría de tránsito publica sus recibos en su propio Drive, así que la carpeta es un
-- parámetro POR ORGANISMO y no una constante global. El interruptor `activo` separa "configurado"
-- de "encendido": se puede dejar la carpeta puesta y la sincronización apagada mientras se valida.
--
-- La idempotencia se lleva en `procesamiento_cuentas` porque el scope de Drive es de solo lectura y
-- no permite marcar el archivo en el origen. Se guarda también la fecha de modificación: un mismo
-- archivo puede reemplazarse en Drive conservando su id, y en ese caso SÍ hay que reprocesarlo.
--
-- Sin BEGIN/COMMIT (ADR-DB-001). Idempotente.

ALTER TABLE organismos_transito_config
  ADD COLUMN IF NOT EXISTS flito_drive_folder_id varchar(120),
  ADD COLUMN IF NOT EXISTS flito_drive_activo boolean NOT NULL DEFAULT false;

ALTER TABLE procesamiento_cuentas
  ADD COLUMN IF NOT EXISTS organismo_codigo varchar(5),
  ADD COLUMN IF NOT EXISTS drive_modified_time timestamptz;

-- El barrido pregunta «¿ya procesé este fileId con esta fecha?»: ese es el índice que lo sostiene.
CREATE INDEX IF NOT EXISTS idx_procesamiento_cuentas_drive
  ON procesamiento_cuentas (drive_file_id, estado);
