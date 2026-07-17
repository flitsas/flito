-- Hardening de integridad referencial (QA crítico)

-- 1. soat_refresh_attempts: CASCADE → RESTRICT
-- Preservar auditoría Habeas Data (Ley 1581) incluso si se borra la solicitud SOAT.
-- La tabla es append-only; borrados de SOAT son raros y deben ser deliberados.
ALTER TABLE soat_refresh_attempts
  DROP CONSTRAINT IF EXISTS soat_refresh_attempts_soat_request_id_soat_requests_id_fk;
ALTER TABLE soat_refresh_attempts
  ADD CONSTRAINT soat_refresh_attempts_soat_request_id_soat_requests_id_fk
  FOREIGN KEY (soat_request_id) REFERENCES soat_requests(id) ON DELETE RESTRICT;

-- 2. soat_requests.tramite_id: ON DELETE SET NULL explícito
-- El schema.ts declara set null pero la migración 0006 no lo especificó → Postgres
-- aplicó NO ACTION por default. Alineamos comportamiento real con el declarado.
ALTER TABLE soat_requests
  DROP CONSTRAINT IF EXISTS soat_requests_tramite_id_tramites_digitales_id_fk;
ALTER TABLE soat_requests
  ADD CONSTRAINT soat_requests_tramite_id_tramites_digitales_id_fk
  FOREIGN KEY (tramite_id) REFERENCES tramites_digitales(id) ON DELETE SET NULL;

-- 3. Lock para el reconciliador — evita superposición de corridas si una tarda >intervalo
-- Patrón advisory: insertamos una fila con lock_name UNIQUE; la siguiente corrida lee y
-- decide saltarse si está fresca. Mucho más simple que PostgreSQL advisory locks puros.
CREATE TABLE IF NOT EXISTS system_locks (
  lock_name VARCHAR(50) PRIMARY KEY,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acquired_by VARCHAR(100),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 4. Índices compuestos críticos (performance en listados y reconciliador)
CREATE INDEX IF NOT EXISTS idx_soat_requests_status_created
  ON soat_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_stage_created
  ON vehicles(stage, created_at DESC);
