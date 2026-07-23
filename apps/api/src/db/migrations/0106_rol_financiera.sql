-- 0106 — Rol `financiera` (usuarios del área financiera: contabilidad, facturación, cobros).
-- Su único módulo por ahora es el Reporte de costos. Sin BEGIN/COMMIT (ADR-DB-001).

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'financiera';
