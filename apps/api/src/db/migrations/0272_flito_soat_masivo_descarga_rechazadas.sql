-- HU #14133 (Feature #14013, Épica #13760, ADR-0032) — carga masiva de SOAT: resumen del lote y descarga de rechazadas.
-- Sobre la 0271. Una sola columna: instante de la PRIMERA descarga de las rechazadas. La PII de las filas rechazadas
-- se purga a las 24 h de terminado el lote, o a los 15 min de esta primera descarga (lo que ocurra antes).
-- Idempotente (ADD COLUMN IF NOT EXISTS). Sin BEGIN/COMMIT (el runner ya envuelve). Sin PII nueva.
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS primera_descarga_en timestamptz;
