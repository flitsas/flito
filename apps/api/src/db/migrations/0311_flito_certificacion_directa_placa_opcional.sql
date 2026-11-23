-- 0311_flito_certificacion_directa_placa_opcional.sql — HU #14665. La consulta RUNT de la
-- certificación sin trámite pasa a ser SIEMPRE por VIN (reemplaza al Bug #14406, que decidía
-- placa+documento o VIN según hubiera documento del propietario): la placa deja de ser obligatoria.
-- Los índices únicos parciales `uq_flito_imp_cert_dir_placa`/`uq_flito_imp_cert_dir_vin`
-- (`WHERE estado = 'certificado'`) no cambian: en Postgres varios NULL no violan un índice único,
-- así que varios certificados sin placa coexisten bien.
-- Idempotente: las dos sentencias se pueden correr dos veces sin error ni cambio (una columna ya
-- nullable no vuelve a fallar al repetir el DROP NOT NULL). Sin BEGIN/COMMIT (lo pone el runner).

ALTER TABLE flito_impuesto_certificacion_directa ALTER COLUMN placa DROP NOT NULL;
ALTER TABLE flito_impuesto_certificacion_directa ALTER COLUMN placa_norm DROP NOT NULL;
