-- 0093 — TRAM-TRASPASO-F3: paridad CEA en validación biométrica del traspaso.
-- Asocia cada validación a la parte (vendedor/comprador) y guarda el sello de
-- firma electrónica avanzada generado al aprobar (espejo de CEA
-- transito_validaciones_identidad.firma_serie/firma_hash_documento).
-- ADR-DB-001: sin BEGIN/COMMIT. Aditivo e idempotente.

ALTER TABLE tramites_validaciones ADD COLUMN IF NOT EXISTS parte VARCHAR(20);
ALTER TABLE tramites_validaciones ADD COLUMN IF NOT EXISTS firma_serie VARCHAR(60);
ALTER TABLE tramites_validaciones ADD COLUMN IF NOT EXISTS firma_hash VARCHAR(64);
ALTER TABLE tramites_validaciones ADD COLUMN IF NOT EXISTS firma_timestamp TIMESTAMPTZ;

-- Lookup del contrato/FUR por trámite + parte aprobada con sello.
CREATE INDEX IF NOT EXISTS idx_tramites_val_parte ON tramites_validaciones (tramite_id, parte);
