-- Hotfix: el rol operaciones_app necesita UPDATE/DELETE sobre system_locks para que
-- el lock distribuido (acquireLock con onConflictDoUpdate y releaseLock con DELETE) funcione.
-- Sin esto el reconciler falla con "permission denied for table system_locks".

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON system_locks TO operaciones_app;
  END IF;
END $$;
