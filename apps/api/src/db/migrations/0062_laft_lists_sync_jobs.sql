-- 0062: Tabla de auditoría de jobs de sincronización de listas restrictivas LAFT.
-- Cada corrida (cron diaria o manual) inserta una fila por lista. WORM: append-only,
-- la app solo INSERT/SELECT — UPDATE solo durante la corrida (status running → success/failed)
-- y luego REVOKE UPDATE para que el histórico no se altere ex-post.
--
-- Pattern: idéntico al de laft_audit_log (migration 0011): REVOKE en PUBLIC + GRANT
-- explícito de SELECT/INSERT a operaciones_app. NO usamos ROW LEVEL SECURITY porque
-- el módulo LAFT existente no la usa — mantener consistencia.

CREATE TABLE IF NOT EXISTS laft_lists_sync_jobs (
  id BIGSERIAL PRIMARY KEY,
  list_code VARCHAR(20) NOT NULL,
  trigger VARCHAR(20) NOT NULL DEFAULT 'cron',          -- cron | manual
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running',        -- running | success | failed | skipped
  source_url TEXT,
  source_hash VARCHAR(64),                              -- sha256 hex del payload descargado
  entries_total INTEGER,
  entries_added INTEGER,
  entries_removed INTEGER,
  entries_modified INTEGER,
  retro_matches_new INTEGER,
  error_text TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_laft_sync_jobs_list_code_started
  ON laft_lists_sync_jobs(list_code, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_laft_sync_jobs_status
  ON laft_lists_sync_jobs(status, started_at DESC);

-- WORM defensivo: la app no debería poder UPDATE/DELETE filas ya cerradas.
-- Permitimos UPDATE en tránsito (running -> success/failed) vía un permiso temporal:
-- el flujo INSERT(running) → UPDATE(finished) lo hace el mismo proceso. Una vez status
-- distinto de 'running', un trigger bloquea cualquier UPDATE/DELETE adicional.
CREATE OR REPLACE FUNCTION laft_lists_sync_jobs_worm_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'laft_lists_sync_jobs es append-only — DELETE bloqueado';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Solo permitimos cerrar un job en estado 'running'. Cualquier otra transición = bloqueada.
    IF OLD.status <> 'running' THEN
      RAISE EXCEPTION 'laft_lists_sync_jobs WORM: UPDATE solo permitido sobre filas con status=running (id=% old_status=%)', OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_laft_sync_jobs_worm ON laft_lists_sync_jobs;
CREATE TRIGGER trg_laft_sync_jobs_worm
  BEFORE UPDATE OR DELETE ON laft_lists_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION laft_lists_sync_jobs_worm_guard();

-- Defensa en profundidad a nivel GRANT: app no puede DELETE jamás.
REVOKE DELETE ON laft_lists_sync_jobs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE DELETE ON laft_lists_sync_jobs FROM operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON laft_lists_sync_jobs TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_lists_sync_jobs_id_seq TO operaciones_app;
  END IF;
END $$;
