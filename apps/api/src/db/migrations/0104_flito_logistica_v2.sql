-- 0104 — FLITO Logística v2: el modelo correcto.
--
-- La LT ya NO nace del sync: nace del ESCANEO del PDF417 por el mensajero (match placa+VIN contra
-- un trámite aprobado). Se agregan los campos leídos del código y el n.º de LT (manual/OCR), más la
-- firma de quien ENTREGA (Operaciones, en consola) para el acta de dos firmas.
-- Sin BEGIN/COMMIT: el runner posee la transacción (ADR-DB-001).

-- Datos del PDF417 de la LT + n.º de LT (no viaja en el código).
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS numero_licencia varchar(40);
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS numero_lt varchar(40);
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS propietario_nombre varchar(200);
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS propietario_documento varchar(30);
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS combustible varchar(30);
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS foto_storage_key varchar(400);

-- Firma de quien entrega (Operaciones) para el acta de dos firmas.
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS firma_entrega_storage_key varchar(400);
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS entrega_nombre varchar(150);
