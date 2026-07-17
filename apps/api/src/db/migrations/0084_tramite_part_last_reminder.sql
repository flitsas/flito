-- 0084 — TRAM-COMMS-02: recordatorios portal participantes.
--
-- Marca de tiempo del último recordatorio para idempotencia (máx 1 cada 24h).
-- ADR-DB-001: sin BEGIN/COMMIT.

ALTER TABLE tramite_participantes
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

COMMENT ON COLUMN tramite_participantes.last_reminder_at IS 'Último recordatorio enviado/omitido (cooldown 24h del cron portal-reminder).';
