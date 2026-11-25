-- 0289_flito_cert_directa_propietario_opcional.sql
-- Bug #14406 — certificar sin trámite: documento y nombre del propietario pasan a ser opcionales.
-- Con documento se consulta el RUNT por placa y documento; sin él, solo por VIN.
-- Las filas existentes conservan sus valores y los certificados emitidos no cambian.
-- Sin BEGIN/COMMIT. Idempotente: DROP NOT NULL sobre una columna ya anulable no hace nada.

ALTER TABLE flito_impuesto_certificacion_directa ALTER COLUMN documento_propietario DROP NOT NULL;
ALTER TABLE flito_impuesto_certificacion_directa ALTER COLUMN nombre_propietario DROP NOT NULL;
