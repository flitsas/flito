-- 0320 — Persona que gestiona el trámite: nombre y correo (FLIT 1 y FLIT 2).
--
-- Dos columnas nullable en flito_tramites. PII: la lectura que las proyecta va a pii_access_log y la
-- Bitácora del sync detecta el cambio sin escribir el valor. null = la fuente aún no lo trae.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.

ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS nombre_gestor varchar(200);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS correo_gestor varchar(254);
