-- 0092 — TRAM-TRASPASO-F1: traspaso como trámite de 1ª clase.
-- Añade modalidad de entrada, radicado STT (TD-YYYY-NNNNN) y bitácora workflow.
-- ADR-DB-001: sin BEGIN/COMMIT (ALTER TYPE ADD VALUE no admite transacción).

ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS modalidad_entrada VARCHAR(20) NOT NULL DEFAULT 'matricula_inicial';
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS numero_radicado VARCHAR(20);
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS workflow JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tramites_numero_radicado ON tramites_digitales (numero_radicado) WHERE numero_radicado IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tramites_modalidad ON tramites_digitales (modalidad_entrada);

-- Estados STT del traspaso (alineados a CEA). Los previos ya existen en el enum.
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'subsanacion';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'en_tramite';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'entregado';
ALTER TYPE tramite_estado ADD VALUE IF NOT EXISTS 'anulado';

-- Secuencia monotónica para el radicado (sin carreras). Formato TD-YYYY-NNNNN.
CREATE SEQUENCE IF NOT EXISTS tramite_radicado_seq;
