-- 0072 — TRAM-10: rastrear el último error de generación de FUR (CEA).
--
-- Si la integración con CEA falla (timeout / 5xx tras reintentos), el endpoint
-- `generar-fur` registra el motivo aquí en vez de dejar el trámite "en limbo"
-- (G4 de la auditoría TRAM-04). El admin ve el error y reintenta llamando de
-- nuevo a `POST /tramites/:id/generar-fur` (idempotente; al tener éxito se limpia).
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS fur_error TEXT;
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS fur_error_at TIMESTAMPTZ;
