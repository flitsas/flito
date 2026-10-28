-- HU #14134 (Feature #14013, Épica #13760, ADR-0032) — carga masiva de SOAT: datos del vehículo que devuelve el RUNT
-- por fila, para pintar la tabla de avance. Sobre la 0272. Tres columnas nullable, sin default.
-- Son PII EFÍMERA como la placa: se anonimizan junto con ella (al terminar el lote las aceptadas y por validar;
-- las rechazadas en la purga de la descarga). Idempotente (ADD COLUMN IF NOT EXISTS). Sin BEGIN/COMMIT (el runner envuelve).
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS vehiculo_marca varchar(60);
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS vehiculo_linea varchar(80);
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS vehiculo_modelo smallint;
