-- Sprint 3B — Extensiones a driver_profile (suspensión por alcoholimetría) + PIN preoperacional + grants.

ALTER TABLE driver_profile
  ADD COLUMN IF NOT EXISTS suspendido_por_alcohol boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_suspension timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_suspension text,
  ADD COLUMN IF NOT EXISTS suspension_levantada_por integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS suspension_levantada_at timestamptz,
  ADD COLUMN IF NOT EXISTS checklist_pin_hash varchar(120);

CREATE INDEX IF NOT EXISTS idx_driver_suspendido ON driver_profile(suspendido_por_alcohol) WHERE suspendido_por_alcohol = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  checklist_templates, checklist_template_items, checklists, checklist_responses,
  alcohol_tests,
  emergency_contacts, emergency_protocols, emergency_drills
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  checklist_templates_id_seq, checklist_template_items_id_seq,
  checklists_id_seq, checklist_responses_id_seq,
  alcohol_tests_id_seq,
  emergency_contacts_id_seq, emergency_protocols_id_seq, emergency_drills_id_seq
  TO operaciones_app;
