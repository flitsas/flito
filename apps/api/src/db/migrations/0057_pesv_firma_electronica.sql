-- Sprint PESV-S4 · Firma electrónica para política PSV y actas de comité
-- Ley 527/1999 firma electrónica (no digital certificada — eso requiere CA acreditada).
-- Persistimos: PDF generado + bloque de firma con SHA-256 + cert PEM auto-firmado por
-- Kyverum LLC + timestamp UTC. Suficiente para auditoría ONAC interna.
--
-- Cuando Kyverum adquiera cert de Certicámara, los campos se reusan para PKCS#7 real.

BEGIN;

ALTER TABLE pesv_policy
  ADD COLUMN IF NOT EXISTS pdf_firmado_storage_key varchar(500),
  ADD COLUMN IF NOT EXISTS pkcs7_signature bytea,
  ADD COLUMN IF NOT EXISTS signer_cert_pem text,
  ADD COLUMN IF NOT EXISTS signature_algo varchar(40);

ALTER TABLE pesv_comite_actas
  ADD COLUMN IF NOT EXISTS pdf_firmado_storage_key varchar(500),
  ADD COLUMN IF NOT EXISTS pkcs7_signature bytea,
  ADD COLUMN IF NOT EXISTS signer_cert_pem text,
  ADD COLUMN IF NOT EXISTS signature_algo varchar(40);

COMMIT;
