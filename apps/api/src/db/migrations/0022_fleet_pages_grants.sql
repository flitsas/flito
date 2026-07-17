-- Añade la página "fleet" al pool de allowed_pages de los usuarios admin.
-- El check evita duplicados en re-ejecuciones.

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'fleet')
 WHERE role = 'admin'
   AND NOT ('fleet' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

-- Permisos sobre las nuevas tablas para el rol de la app (mismo patrón que migración 0016).
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle_equipment_links, vehicle_measurements,
                                       document_types, vehicle_documents, alerts_sent
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE vehicle_equipment_links_id_seq,
                                vehicle_measurements_id_seq,
                                document_types_id_seq,
                                vehicle_documents_id_seq,
                                alerts_sent_id_seq
  TO operaciones_app;
