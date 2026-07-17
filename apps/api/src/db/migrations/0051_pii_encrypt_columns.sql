-- Sprint 1 Ola C-1 · P0-NEG-4
-- Cifrado en reposo de PII sensible: cédula, licencia y runt_payload de conductores;
-- cuenta bancaria del titular de pago en manifiestos.
--
-- Estrategia: rename plain → *_legacy_plain (preservación temporal por 7d), agregar
-- columnas cipher/iv/auth_tag/aad_nonce/key_version + cedula_hash para búsqueda HMAC.
-- Pattern alineado con `rndc_credenciales` (migration 0046).
--
-- Volumen al momento de migrar: driver_profile=0 filas, manifiestos.titular_pago_cuenta=0
-- filas no nulas. Ningún backfill productivo necesario; las columnas plain se renombran
-- por consistencia de nomenclatura y se dropearán en 0052 después de 7d sin issues.
--
-- App ya cargada con encryptPii/decryptPii/hmacCedula. PII_HMAC_KEY recién creada.
-- Si la migration corre antes que el code esté desplegado, INSERTs fallarán por
-- columnas NOT NULL — por eso esta migration NO marca cipher cols como NOT NULL.

BEGIN;

-- ============================================================================
-- 1. driver_profile — cifrar cédula (con HMAC para búsqueda), licencia, runtPayload
-- ============================================================================

ALTER TABLE driver_profile RENAME COLUMN cedula TO cedula_legacy_plain;
ALTER TABLE driver_profile RENAME COLUMN licencia_numero TO licencia_numero_legacy_plain;
ALTER TABLE driver_profile RENAME COLUMN runt_payload TO runt_payload_legacy_plain;

ALTER TABLE driver_profile
  ADD COLUMN cedula_cipher bytea,
  ADD COLUMN cedula_iv bytea,
  ADD COLUMN cedula_auth_tag bytea,
  ADD COLUMN cedula_aad_nonce uuid,
  ADD COLUMN cedula_key_version smallint,
  ADD COLUMN cedula_hash bytea,
  ADD COLUMN licencia_numero_cipher bytea,
  ADD COLUMN licencia_numero_iv bytea,
  ADD COLUMN licencia_numero_auth_tag bytea,
  ADD COLUMN licencia_numero_aad_nonce uuid,
  ADD COLUMN licencia_numero_key_version smallint,
  ADD COLUMN runt_payload_cipher bytea,
  ADD COLUMN runt_payload_iv bytea,
  ADD COLUMN runt_payload_auth_tag bytea,
  ADD COLUMN runt_payload_aad_nonce uuid,
  ADD COLUMN runt_payload_key_version smallint;

-- Búsqueda exacta por cédula vía HMAC (UNIQUE, ya que cada conductor tiene una sola cédula).
CREATE UNIQUE INDEX uq_driver_profile_cedula_hash ON driver_profile(cedula_hash) WHERE cedula_hash IS NOT NULL;

-- Sanidad de tamaños AES-GCM: IV=12 bytes, authTag=16 bytes.
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_cedula_iv_size CHECK (cedula_iv IS NULL OR octet_length(cedula_iv) = 12);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_cedula_tag_size CHECK (cedula_auth_tag IS NULL OR octet_length(cedula_auth_tag) = 16);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_cedula_hash_size CHECK (cedula_hash IS NULL OR octet_length(cedula_hash) = 32);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_lic_iv_size CHECK (licencia_numero_iv IS NULL OR octet_length(licencia_numero_iv) = 12);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_lic_tag_size CHECK (licencia_numero_auth_tag IS NULL OR octet_length(licencia_numero_auth_tag) = 16);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_runt_iv_size CHECK (runt_payload_iv IS NULL OR octet_length(runt_payload_iv) = 12);
ALTER TABLE driver_profile ADD CONSTRAINT chk_dp_runt_tag_size CHECK (runt_payload_auth_tag IS NULL OR octet_length(runt_payload_auth_tag) = 16);

-- Drop NOT NULL/UNIQUE/CHECK heredados que ahora apuntan a *_legacy_plain
-- (RENAME preserva esos atributos pero ya no aplican: la unicidad real vive en cedula_hash,
--  la no-nulidad real la enforza la app vía zod + cipher, los CHECK pierden semántica).
ALTER TABLE driver_profile ALTER COLUMN licencia_numero_legacy_plain DROP NOT NULL;
ALTER TABLE driver_profile DROP CONSTRAINT IF EXISTS chk_licencia_no_empty;
ALTER TABLE driver_profile DROP CONSTRAINT IF EXISTS driver_profile_cedula_key;
DROP INDEX IF EXISTS idx_driver_profile_licencia;

-- ============================================================================
-- 2. manifiestos.titular_pago_cuenta — cifrar (sin HMAC, no se busca por cuenta)
-- ============================================================================

ALTER TABLE manifiestos RENAME COLUMN titular_pago_cuenta TO titular_pago_cuenta_legacy_plain;

ALTER TABLE manifiestos
  ADD COLUMN titular_pago_cuenta_cipher bytea,
  ADD COLUMN titular_pago_cuenta_iv bytea,
  ADD COLUMN titular_pago_cuenta_auth_tag bytea,
  ADD COLUMN titular_pago_cuenta_aad_nonce uuid,
  ADD COLUMN titular_pago_cuenta_key_version smallint;

ALTER TABLE manifiestos ADD CONSTRAINT chk_man_tpc_iv_size CHECK (titular_pago_cuenta_iv IS NULL OR octet_length(titular_pago_cuenta_iv) = 12);
ALTER TABLE manifiestos ADD CONSTRAINT chk_man_tpc_tag_size CHECK (titular_pago_cuenta_auth_tag IS NULL OR octet_length(titular_pago_cuenta_auth_tag) = 16);

COMMIT;

-- ============================================================================
-- Migration siguiente (0052_pii_drop_legacy.sql) DESPUÉS de 7d sin issues:
--   ALTER TABLE driver_profile DROP COLUMN cedula_legacy_plain;
--   ALTER TABLE driver_profile DROP COLUMN licencia_numero_legacy_plain;
--   ALTER TABLE driver_profile DROP COLUMN runt_payload_legacy_plain;
--   ALTER TABLE manifiestos DROP COLUMN titular_pago_cuenta_legacy_plain;
-- ============================================================================
