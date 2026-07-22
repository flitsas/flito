-- FLITO — remodelado de estados. SOAT e impuestos pasan a 4 estados unificados
-- (pendiente | solicitado | con_novedad | pagado) y la modalidad del organismo pierde
-- 'sin_clasificar' (queda requiere_gestion | autogestionado, default autogestionado).
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).
--
-- Postgres no permite quitar valores de un ENUM en uso: se recrea cada tipo. La BD se reinició a
-- datos de seed (0 trámites/SOAT/impuestos; vigencias solo con valores válidos), así que el USING
-- cast no toca datos inválidos.

-- ── flito_soat_estado ───────────────────────────────────────────────────────
ALTER TABLE flito_soat ALTER COLUMN estado DROP DEFAULT;
ALTER TYPE flito_soat_estado RENAME TO flito_soat_estado_old;
CREATE TYPE flito_soat_estado AS ENUM ('pendiente', 'solicitado', 'con_novedad', 'pagado');
ALTER TABLE flito_soat ALTER COLUMN estado TYPE flito_soat_estado USING estado::text::flito_soat_estado;
ALTER TABLE flito_soat ALTER COLUMN estado SET DEFAULT 'pendiente';
DROP TYPE flito_soat_estado_old;

-- ── flito_impuesto_estado (default pasa de 'sin_factura' a 'pendiente') ──────
ALTER TABLE flito_impuestos ALTER COLUMN estado DROP DEFAULT;
ALTER TYPE flito_impuesto_estado RENAME TO flito_impuesto_estado_old;
CREATE TYPE flito_impuesto_estado AS ENUM ('pendiente', 'solicitado', 'con_novedad', 'pagado');
ALTER TABLE flito_impuestos ALTER COLUMN estado TYPE flito_impuesto_estado USING estado::text::flito_impuesto_estado;
ALTER TABLE flito_impuestos ALTER COLUMN estado SET DEFAULT 'pendiente';
DROP TYPE flito_impuesto_estado_old;

-- ── flito_modalidad_organismo (se elimina 'sin_clasificar') ──────────────────
ALTER TYPE flito_modalidad_organismo RENAME TO flito_modalidad_organismo_old;
CREATE TYPE flito_modalidad_organismo AS ENUM ('requiere_gestion', 'autogestionado');
ALTER TABLE flito_organismo_vigencias ALTER COLUMN modalidad TYPE flito_modalidad_organismo USING modalidad::text::flito_modalidad_organismo;
ALTER TABLE flito_impuestos ALTER COLUMN modalidad_aplicada TYPE flito_modalidad_organismo USING modalidad_aplicada::text::flito_modalidad_organismo;
DROP TYPE flito_modalidad_organismo_old;
