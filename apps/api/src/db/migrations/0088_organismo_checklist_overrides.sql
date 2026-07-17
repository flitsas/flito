-- 0088 — Overrides de checklist por organismo × tipología (TRAM-MT-02 Fase 2).

CREATE TABLE IF NOT EXISTS organismo_checklist_overrides (
  organismo_codigo varchar(5) NOT NULL,
  tipologia_codigo varchar(40) NOT NULL,
  items_json       jsonb NOT NULL DEFAULT '{"hide":[],"require":[],"add":[]}'::jsonb,
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organismo_codigo, tipologia_codigo)
);

CREATE INDEX IF NOT EXISTS idx_org_checklist_overrides_org
  ON organismo_checklist_overrides (organismo_codigo);
