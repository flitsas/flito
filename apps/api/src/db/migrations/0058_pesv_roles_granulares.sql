-- Sprint PESV-S5 · Roles granulares para PESV operativo
--
-- Hoy hay 4 roles: admin, proveedor, transito, compliance.
-- Agregamos 3 roles del PESV operacional:
--   - lider_pesv: persona designada en pesv_comite_miembros como rol 'lider_pesv'.
--                 Crea/edita política, comité, plan, diagnóstico, levanta actas.
--   - supervisor_flota: jefe de flota; anula checklists de su flota, ve incidentes.
--   - conductor: conductor de la flota; reporta incidente desde móvil con foto+GPS,
--                ve y opera SU jornada propia (ya soportado por checks de conductor_id).
--
-- ALTER TYPE ... ADD VALUE no requiere TRUNCATE; es backward compatible.

BEGIN;

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'lider_pesv';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'supervisor_flota';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'conductor';

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT enumlabel FROM pg_enum WHERE enumtypid = 'user_role'::regtype;
--     → admin, proveedor, transito, compliance, lider_pesv, supervisor_flota, conductor
-- ============================================================================
