-- Sprint 4 Fase 4.2 — Credenciales RNDC cifradas con AES-256-GCM
-- ISO 27001 A.8.24 — uso de criptografía
-- ISO 27001 A.10.1.2 — gestión de claves

CREATE TABLE IF NOT EXISTS rndc_credenciales (
  id smallserial PRIMARY KEY,
  empresa_nit varchar(20) NOT NULL,
  habilitador_nit varchar(20) NOT NULL,
  num_nit varchar(20) NOT NULL,
  -- Cifrado AES-256-GCM
  clave_qr_cipher bytea NOT NULL,
  clave_qr_iv bytea NOT NULL,
  clave_qr_auth_tag bytea NOT NULL,
  -- AAD nonce: UUID generado pre-INSERT y persistido. Vincula cipher a esta fila
  -- exacta (defensa contra swap de ciphertext entre filas con mismo NIT/version).
  aad_nonce uuid NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  ambiente varchar(10) NOT NULL DEFAULT 'sandbox',
  activo boolean NOT NULL DEFAULT true,
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by integer REFERENCES users(id) ON DELETE RESTRICT,

  CONSTRAINT chk_rndc_cred_iv_size CHECK (octet_length(clave_qr_iv) = 12),
  CONSTRAINT chk_rndc_cred_tag_size CHECK (octet_length(clave_qr_auth_tag) = 16),
  CONSTRAINT chk_rndc_cred_cipher_min CHECK (octet_length(clave_qr_cipher) > 0),
  CONSTRAINT chk_rndc_cred_ambiente CHECK (ambiente IN ('sandbox', 'produccion'))
);

-- Solo una credencial activa por empresa+ambiente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rndc_cred_activa
  ON rndc_credenciales(empresa_nit, ambiente) WHERE activo = true;

DROP TRIGGER IF EXISTS trg_rndc_cred_touch ON rndc_credenciales;
CREATE TRIGGER trg_rndc_cred_touch BEFORE UPDATE ON rndc_credenciales
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Permisos: SELECT, INSERT, UPDATE. NO DELETE: política — desactivar (activo=false), no borrar.
GRANT SELECT, INSERT, UPDATE ON rndc_credenciales TO operaciones_app;
GRANT USAGE, SELECT ON SEQUENCE rndc_credenciales_id_seq TO operaciones_app;
