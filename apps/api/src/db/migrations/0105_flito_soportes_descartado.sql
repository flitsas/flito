-- 0105 — Soportes descartados en la cola de revisión OCR.
--
-- Un comprobante rechazado (descartado) por Operaciones NO debe bloquear la recarga del mismo archivo:
-- se marca su soporte como `descartado` y el dedup por hash lo excluye. Antes, el hash quedaba en
-- flito_soportes y el gestor recibía "duplicado" al reintentar. Sin BEGIN/COMMIT (ADR-DB-001).

ALTER TABLE flito_soportes ADD COLUMN IF NOT EXISTS descartado boolean NOT NULL DEFAULT false;
