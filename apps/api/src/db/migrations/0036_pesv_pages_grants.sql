-- Permisos PESV + grants sobre tablas nuevas.

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'pesv')
 WHERE role = 'admin'
   AND NOT ('pesv' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'pesv_admin')
 WHERE role = 'admin'
   AND NOT ('pesv_admin' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'pesv')
 WHERE role = 'compliance'
   AND NOT ('pesv' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  driver_profile, driver_document_types, driver_documents, driver_alerts_sent,
  safety_trainings, training_attendees,
  road_incidents, incident_actions
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  driver_document_types_id_seq, driver_documents_id_seq, driver_alerts_sent_id_seq,
  safety_trainings_id_seq, road_incidents_id_seq, incident_actions_id_seq
  TO operaciones_app;
