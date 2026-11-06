-- 0290_flito_cert_directa_tipo_documento.sql
-- Bug #14406 — certificar sin trámite: la pasarela RUNT exige el código del tipo de documento para consultar por
-- placa y documento. Se guarda el valor del formulario (CC, NIT…); el código RUNT se deriva al consultar.
-- Sin backfill: no se inventa el tipo de los registros existentes. Con documento y sin tipo, la consulta responde 400
-- hasta que el gestor lo diligencie. Los certificados emitidos no cambian.
-- Sin BEGIN/COMMIT. Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE flito_impuesto_certificacion_directa ADD COLUMN IF NOT EXISTS tipo_documento_propietario varchar(5);
