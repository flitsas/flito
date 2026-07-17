-- TRAM-OPS-02: denormalización del último motivo de rechazo OT (source of truth: tramite_eventos).
ALTER TABLE tramites_digitales
  ADD COLUMN IF NOT EXISTS motivo_rechazo_codigo varchar(40);

CREATE INDEX IF NOT EXISTS idx_tramites_motivo_rechazo
  ON tramites_digitales (motivo_rechazo_codigo)
  WHERE motivo_rechazo_codigo IS NOT NULL;
