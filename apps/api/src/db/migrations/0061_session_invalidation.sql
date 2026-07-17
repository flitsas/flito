-- Sprint Hardening · Invalidación automática de sesiones JWT al cambiar rol/permisos.
--
-- Problema: req.user.role viene del JWT (no de BD). Cambiar role en BD no surte efecto
-- hasta que el JWT expira (24h). Resultado: usuarios degradados conservan permisos viejos.
--
-- Solución: cada user tiene session_invalidated_at. authMiddleware compara payload.iat
-- contra esta marca y rechaza el JWT si es anterior.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_invalidated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_session_invalidated ON users(session_invalidated_at)
  WHERE session_invalidated_at IS NOT NULL;

-- Bumpear todos los users existentes a now() para forzar relogin de cualquier sesión
-- emitida ANTES de este parche (los JWT viejos no traen iat válido).
UPDATE users SET session_invalidated_at = now()
 WHERE session_invalidated_at IS NULL;

COMMIT;
