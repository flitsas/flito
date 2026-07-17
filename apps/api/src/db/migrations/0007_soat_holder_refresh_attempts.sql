-- Titular del SOAT según RUNT (puede diferir del propietario actual en caso de traspaso — es legal)
ALTER TABLE soat_requests ADD COLUMN IF NOT EXISTS soat_holder VARCHAR(200);

-- Auditoría de intentos de verificación con RUNT (Ley 1581 de 2012 Habeas Data + dashboard de lag)
CREATE TABLE IF NOT EXISTS soat_refresh_attempts (
  id SERIAL PRIMARY KEY,
  soat_request_id INTEGER NOT NULL REFERENCES soat_requests(id) ON DELETE CASCADE,
  triggered_by VARCHAR(20) NOT NULL DEFAULT 'manual',
  triggered_by_user INTEGER REFERENCES users(id),
  result VARCHAR(30) NOT NULL,
  message TEXT,
  duration_ms INTEGER,
  runt_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_soat_refresh_attempts_soat_id ON soat_refresh_attempts(soat_request_id);
CREATE INDEX IF NOT EXISTS idx_soat_refresh_attempts_created_at ON soat_refresh_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soat_refresh_attempts_result ON soat_refresh_attempts(result);
