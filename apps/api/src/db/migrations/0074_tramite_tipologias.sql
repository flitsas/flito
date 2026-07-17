-- 0074 — TRAM-INNOV A5: tipología de trámite + estado de checklist.
--
-- El catálogo de tipologías y sus checklists vive en el repo
-- (`@operaciones/shared-types` → TRAMITE_TIPOLOGIAS), no en BD: el epic permite
-- "seed SQL o JSON en repo" y así evitamos duplicar/desincronizar definiciones.
-- La BD solo persiste, por trámite:
--   - `tipologia_codigo`: la tipología elegida (nullable → trámites previos y
--     matrícula inicial quedan sin tipología y NO disparan el gate de checklist).
--   - `checklist_estado`: overrides manuales { "<itemId>": true }. Los ítems con
--     `docTipo` se auto-satisfacen con el documento subido (no se guardan aquí).
--
-- El gate "Enviar a tránsito" exige obligatorios completos solo cuando hay
-- tipología elegida y TRAMITE_STRICT_CHECKLIST=true (default). Retrocompatible.
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS tipologia_codigo VARCHAR(40);
ALTER TABLE tramites_digitales ADD COLUMN IF NOT EXISTS checklist_estado JSONB;

-- Filtro frecuente: métricas de adopción por tipología (KPI epic) y reportes.
CREATE INDEX IF NOT EXISTS idx_tramites_tipologia ON tramites_digitales (tipologia_codigo);
