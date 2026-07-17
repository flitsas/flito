-- 0081 — LOTE-PLUS-01: estado del lote para procesamiento asíncrono.
--
-- Valores: procesando | listo | error
-- Lotes existentes (0079) quedan en listo (DEFAULT).
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

ALTER TABLE tramite_lotes
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'listo';

COMMENT ON COLUMN tramite_lotes.estado IS 'procesando | listo | error';
