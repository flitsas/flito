-- 0086 — Bandeja de tránsito multitenant por organismo (código DIVIPOLA/DANE).
-- Cada usuario rol `transito` queda acotado a un organismo; los trámites
-- enviados persisten organismo_codigo para filtrar en API.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS transito_codigo varchar(5);

ALTER TABLE tramites_digitales
  ADD COLUMN IF NOT EXISTS organismo_codigo varchar(5);

-- Backfill desde vehiculo._orgTransito.codigo (wizard paso 5).
UPDATE tramites_digitales t
SET organismo_codigo = btrim((t.vehiculo->'_orgTransito'->>'codigo'))
WHERE t.organismo_codigo IS NULL
  AND t.vehiculo IS NOT NULL
  AND btrim(COALESCE(t.vehiculo->'_orgTransito'->>'codigo', '')) <> '';

CREATE INDEX IF NOT EXISTS idx_tramites_estado_organismo
  ON tramites_digitales (estado, organismo_codigo);

CREATE INDEX IF NOT EXISTS idx_users_transito_codigo
  ON users (transito_codigo)
  WHERE transito_codigo IS NOT NULL;
