-- 0114 — Registro de archivos del Drive: quién modificó y marca de «omitido».
--
-- Idempotente y sin BEGIN/COMMIT propio (ADR-DB-001): el runner envuelve cada fichero.
--
-- Dos añadidos a `procesamiento_cuentas`, que ya es el registro de lo procesado:
--
--   modificado_por  — quién tocó el archivo en el Drive la última vez. Se guarda EN EL REGISTRO y no
--                     solo se lee de la API al listar, porque el objeto del registro es sobrevivir
--                     al archivo: si mañana lo borran del Drive, la traza tiene que decir quién lo
--                     había subido. Consultarlo en vivo dejaría un hueco justo cuando más importa.
--
--   El estado gana el valor 'omitido' (columna de texto libre, no enum: no hace falta ALTER TYPE).
--                     Lo usa el arranque del cron para marcar como vistos los consolidados que ya
--                     estaban en la carpeta el día que se encendió, sin gastar OCR en histórico que
--                     nadie pidió. Queda constancia de que se decidió no procesarlos, que es
--                     distinto de no haberlos visto nunca.

ALTER TABLE procesamiento_cuentas
  ADD COLUMN IF NOT EXISTS modificado_por VARCHAR(255);

-- Un archivo puede reprocesarse (el organismo reemplaza el consolidado del día conservando nombre),
-- así que NO hay unicidad por drive_file_id. El índice sirve al listado, que cruza los archivos que
-- devuelve el Drive contra lo ya registrado en cada carga de la pestaña.
CREATE INDEX IF NOT EXISTS idx_procesamiento_cuentas_file_estado
  ON procesamiento_cuentas (drive_file_id, estado);

-- Para el registro visible, que ordena por fecha descendente.
CREATE INDEX IF NOT EXISTS idx_procesamiento_cuentas_created
  ON procesamiento_cuentas (created_at DESC);

COMMENT ON COLUMN procesamiento_cuentas.modificado_por IS
  'Quién modificó el archivo en el Drive por última vez, según lastModifyingUser de la API de Google. '
  'Se persiste para que la traza sobreviva al borrado del archivo.';
