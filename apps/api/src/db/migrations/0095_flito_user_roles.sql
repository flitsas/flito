-- FLITO (migración packages/ → Operaciones) — Fase 0.
-- Añade los dos roles nuevos al enum user_role. Gestor SOAT reutiliza `proveedor`
-- y auditoría reutiliza `auditor` (no requieren valores nuevos). Ver
-- docs/MIGRACION_FLITO_A_OPERACIONES.md §9. Idempotente (IF NOT EXISTS).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'operaciones';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'gestor_impuestos';
