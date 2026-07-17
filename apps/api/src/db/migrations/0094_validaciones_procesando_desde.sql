-- TRAM-F3: timestamp de inicio de análisis biométrico para recovery de locks huérfanos.
ALTER TABLE tramites_validaciones ADD COLUMN IF NOT EXISTS procesando_desde TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tramites_val_en_proceso
  ON tramites_validaciones (estado, procesando_desde)
  WHERE estado = 'en_proceso';
