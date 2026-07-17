-- Permisos granulares por usuario: cada cuenta tiene un array de page slugs habilitadas.
-- Se aplica en UNIÓN con el default del rol (ver helpers/permissions.ts).
-- Vacío significa "usar solo los defaults del rol".

ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_pages text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_users_allowed_pages ON users USING gin (allowed_pages);
