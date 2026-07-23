-- FLITO Logística (Fase 2) — idempotencia de las escrituras de campo (RN-06/CA-06).
-- La PWA del mensajero encola escrituras offline con una clave propia; un reenvío con la misma clave
-- devuelve la respuesta ya guardada en vez de re-ejecutar (una sincronización repetida no duplica).
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).

CREATE TABLE IF NOT EXISTS flito_logistica_idempotencia (
  idempotency_key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
