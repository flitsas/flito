-- 0312_flito_certificacion_directa_organismo_opcional.sql — HU #14665 (segundo lote). La Épica
-- #14163 nunca pidió un "Organismo de tránsito" en el formulario de certificar sin trámite: no
-- participa en la consulta RUNT (siempre por VIN desde esta misma HU) y solo imprimía una línea
-- informativa "Organismo (dato de FLITO)" en el certificado/ZIP. Se quita del formulario; la columna
-- deja de ser obligatoria. La FK a `organismos_transito_config` se mantiene: un NULL no la viola.
-- Idempotente: el DROP NOT NULL no vuelve a fallar al repetirse sobre una columna ya nullable. Sin
-- BEGIN/COMMIT (lo pone el runner).

ALTER TABLE flito_impuesto_certificacion_directa ALTER COLUMN organismo_codigo DROP NOT NULL;
