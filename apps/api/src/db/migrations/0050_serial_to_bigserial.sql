-- Sprint 1 Ola B · P0-DBA-2
-- Migra PKs de serial (int4, max 2.147B) a bigserial (int8, max 9.2 quintillones).
-- Tablas afectadas: audit_logs, tramites_validaciones, soat_requests,
-- soat_refresh_attempts, road_incidents, alcohol_tests, manifiestos, remesas,
-- work_orders.
--
-- Para cada PK que cambia, TODAS las columnas FK referenciantes también deben
-- cambiar a bigint en la MISMA transacción. ALTER TYPE int→bigint NO requiere
-- DROP de la FK (Postgres maneja la consistencia siempre que ambos extremos
-- terminen compatibles).
--
-- Estrategia: una sola transacción atómica. Si algo falla, ROLLBACK completo.
-- Backup pre-vuelo: /var/backups/operaciones_db_pre_olaB_<ts>.sql.gz.

BEGIN;

-- ============================================================================
-- 1. audit_logs (sin FKs entrantes)
-- ============================================================================
ALTER TABLE audit_logs ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE audit_logs_id_seq AS bigint;

-- ============================================================================
-- 2. tramites_validaciones (sin FKs entrantes)
-- ============================================================================
ALTER TABLE tramites_validaciones ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE tramites_validaciones_id_seq AS bigint;

-- ============================================================================
-- 3. soat_requests (FK desde soat_refresh_attempts.soat_request_id)
-- ============================================================================
ALTER TABLE soat_requests ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE soat_requests_id_seq AS bigint;
ALTER TABLE soat_refresh_attempts ALTER COLUMN soat_request_id TYPE bigint;

-- ============================================================================
-- 4. soat_refresh_attempts (sin FKs entrantes)
-- ============================================================================
ALTER TABLE soat_refresh_attempts ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE soat_refresh_attempts_id_seq AS bigint;

-- ============================================================================
-- 5. road_incidents (FKs desde alcohol_tests.incident_id, incident_actions.incident_id)
-- ============================================================================
ALTER TABLE road_incidents ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE road_incidents_id_seq AS bigint;
ALTER TABLE alcohol_tests ALTER COLUMN incident_id TYPE bigint;
ALTER TABLE incident_actions ALTER COLUMN incident_id TYPE bigint;

-- ============================================================================
-- 6. alcohol_tests (sin FKs entrantes)
-- ============================================================================
ALTER TABLE alcohol_tests ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE alcohol_tests_id_seq AS bigint;

-- ============================================================================
-- 7. manifiestos (FKs desde manifiesto_remesas.manifiesto_id, remesas.manifiesto_id)
-- ============================================================================
ALTER TABLE manifiestos ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE manifiestos_id_seq AS bigint;
ALTER TABLE manifiesto_remesas ALTER COLUMN manifiesto_id TYPE bigint;
ALTER TABLE remesas ALTER COLUMN manifiesto_id TYPE bigint;

-- ============================================================================
-- 8. remesas (FK desde manifiesto_remesas.remesa_id)
-- ============================================================================
ALTER TABLE remesas ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE remesas_id_seq AS bigint;
ALTER TABLE manifiesto_remesas ALTER COLUMN remesa_id TYPE bigint;

-- ============================================================================
-- 9. work_orders (FKs desde 6 tablas: parts_movements, maintenance_schedule,
--    wo_jobs, wo_otros_gastos, wo_parts, wo_seguimientos)
-- ============================================================================
ALTER TABLE work_orders ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE work_orders_id_seq AS bigint;
ALTER TABLE parts_movements ALTER COLUMN wo_id TYPE bigint;
ALTER TABLE maintenance_schedule ALTER COLUMN wo_id TYPE bigint;
ALTER TABLE wo_jobs ALTER COLUMN wo_id TYPE bigint;
ALTER TABLE wo_otros_gastos ALTER COLUMN wo_id TYPE bigint;
ALTER TABLE wo_parts ALTER COLUMN wo_id TYPE bigint;
ALTER TABLE wo_seguimientos ALTER COLUMN wo_id TYPE bigint;

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy (ejecutar manualmente):
--
-- SELECT relname, atttypid::regtype FROM pg_attribute a
--   JOIN pg_class c ON a.attrelid = c.oid
--  WHERE c.relname IN ('audit_logs','tramites_validaciones','soat_requests',
--                      'soat_refresh_attempts','road_incidents','alcohol_tests',
--                      'manifiestos','remesas','work_orders')
--    AND a.attname = 'id';
--   → todas deben mostrar 'bigint'
--
-- SELECT sequencename, data_type FROM pg_sequences
--  WHERE sequencename LIKE ANY (ARRAY['audit_logs%','tramites_validaciones%',
--                                     'soat_requests%','soat_refresh_attempts%',
--                                     'road_incidents%','alcohol_tests%',
--                                     'manifiestos%','remesas%','work_orders%']);
--   → todas deben mostrar 'bigint'
-- ============================================================================
