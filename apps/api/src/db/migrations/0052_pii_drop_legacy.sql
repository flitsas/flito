-- Sprint 1 Ola C-1 · P0-NEG-4 cleanup
-- Drop columnas *_legacy_plain creadas en 0051 (rename pre-cifrado).
--
-- Pre-condiciones verificadas 2026-05-06 (Lote 11):
--   - driver_profile: 0 filas (ningún backfill productivo aplicado)
--   - manifiestos: 0 filas con titular_pago_cuenta_legacy_plain != NULL
--   - 0 errores decryptPii/InvalidTag/cipher en logs PM2 desde 0051
--   - App ya escribe únicamente a columnas *_cipher/*_iv/*_auth_tag (0051 stable)
--
-- Riesgo de aplicación: NULO. No hay datos en columnas legacy_plain.
-- Rollback: si la app referenciara la columna (no debería, schema.ts se actualiza
--   en el mismo deploy), recrear con `ALTER TABLE ... ADD COLUMN ... varchar(N)`.
--   No hay datos que perder.

BEGIN;

ALTER TABLE driver_profile DROP COLUMN IF EXISTS cedula_legacy_plain;
ALTER TABLE driver_profile DROP COLUMN IF EXISTS licencia_numero_legacy_plain;
ALTER TABLE driver_profile DROP COLUMN IF EXISTS runt_payload_legacy_plain;

ALTER TABLE manifiestos DROP COLUMN IF EXISTS titular_pago_cuenta_legacy_plain;

COMMIT;
