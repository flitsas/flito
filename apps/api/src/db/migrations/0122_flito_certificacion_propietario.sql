-- 0122 — Nombre del propietario en el snapshot de la certificación (HU #11167, Feature #11159).
--
-- El certificado PDF debe mostrar el bloque de propietario tal como FLITO lo tenía AL CERTIFICAR
-- (AC2), y dos descargas del mismo certificado deben mostrar exactamente los mismos datos (AC4).
-- Leer el nombre en vivo de `vehicles.owner_name` al generar el PDF rompería ambas cosas: si alguien
-- corrige el propietario después de certificar, el certificado emitido hoy diría algo distinto de lo
-- que se verificó ayer, y el PDF afirmaría sobre un nombre que nunca entró en la comparación.
--
-- El documento ya viajaba (`documento_consultado`) porque es la prueba de propiedad; el nombre no,
-- porque no se compara contra nada —el RUNT no lo devuelve—. Pero sí se IMPRIME, y todo lo que el
-- certificado imprime tiene que quedar congelado con él.
--
-- Nullable a propósito: las certificaciones ya emitidas por la HU #11165 no lo tienen y no se pueden
-- inventar. El PDF las resuelve mostrando el nombre como no registrado, no fabricándolo.
--
-- PII: dato personal (Ley 1581), igual que `documento_consultado`. Misma política de retención.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

ALTER TABLE flito_impuesto_certificaciones
  ADD COLUMN IF NOT EXISTS propietario_nombre varchar(200);
