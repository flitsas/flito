-- audit_logs: añade el valor 'view' al enum audit_action
--
-- Necesario para los endpoints nuevos de PESV diagnóstico que registran
-- visualización de evidencia (GET /pesv/diagnostico/:id/items/:eId/evidencias/:keyHash)
-- y descarga de export por estándar. Permite cumplir trazabilidad ONAC +
-- Ley 1581 sin perder semántica (action='view' es diferente a 'export').
--
-- Compatibilidad: PostgreSQL 12+ permite ALTER TYPE ADD VALUE en transacción
-- siempre que el nuevo valor no se USE dentro de la misma transacción.
-- Confirmado en BD live: PostgreSQL 16.13.
--
-- Idempotencia: IF NOT EXISTS protege el ADD VALUE.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'view';

COMMIT;
