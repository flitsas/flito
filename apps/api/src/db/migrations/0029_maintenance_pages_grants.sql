-- Sprint 2A — Permisos y grants para módulo Mantenimiento.

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'maintenance')
 WHERE role = 'admin'
   AND NOT ('maintenance' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'maintenance_admin')
 WHERE role = 'admin'
   AND NOT ('maintenance_admin' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  maintenance_systems, maintenance_subsystems, maintenance_jobs,
  parts_locations, parts, parts_stock, parts_movements,
  maintenance_routines, routine_jobs, routine_parts, routine_periodicity,
  maintenance_schedule
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  maintenance_systems_id_seq, maintenance_subsystems_id_seq, maintenance_jobs_id_seq,
  parts_locations_id_seq, parts_id_seq, parts_stock_id_seq, parts_movements_id_seq,
  maintenance_routines_id_seq, routine_periodicity_id_seq, maintenance_schedule_id_seq
  TO operaciones_app;
