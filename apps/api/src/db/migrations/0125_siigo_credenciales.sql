-- 0125_siigo_credenciales.sql
-- Feature #11239 — Integración con Siigo API. HU #11247: credenciales cifradas.
-- Autor: equipo FLITO. Motivo: guardar username/access_key de Siigo sin exponer el secreto.
--
-- El access_key se cifra con AES-256-GCM (clave maestra SIIGO_ENC_KEY, keyspace propio).
-- El cipher viaja con su IV, su auth_tag y un aad_nonce que entra en los datos asociados:
-- eso ata el ciphertext a esta fila y hace que un swap entre filas falle la verificación.
--
-- Idempotente: se puede correr dos veces sin efecto adicional.

CREATE TABLE IF NOT EXISTS siigo_credenciales (
  id                        smallserial PRIMARY KEY,
  ambiente                  varchar(12) NOT NULL,
  username                  varchar(150) NOT NULL,
  access_key_cipher         bytea NOT NULL,
  access_key_iv             bytea NOT NULL,
  access_key_auth_tag       bytea NOT NULL,
  aad_nonce                 uuid NOT NULL,
  key_version               smallint NOT NULL DEFAULT 1,
  activo                    boolean NOT NULL DEFAULT true,
  notas                     text,
  descifrado_fallido_en     timestamptz,
  descifrado_fallido_motivo varchar(200),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                integer REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                integer REFERENCES users(id),
  CONSTRAINT siigo_credenciales_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion'))
);

-- Una sola credencial ACTIVA por ambiente. Es la garantía real de AC3: sin este índice, dos filas
-- activas harían que la credencial elegida dependiera del orden de lectura. Parcial a propósito —
-- las desactivadas son historial y pueden repetirse cuantas veces se reconfigure.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_credenciales_ambiente_activo
  ON siigo_credenciales (ambiente)
  WHERE activo;

COMMENT ON TABLE siigo_credenciales IS
  'Credenciales de Siigo API cifradas AES-256-GCM. Una activa por ambiente (HU #11247).';
COMMENT ON COLUMN siigo_credenciales.username IS
  'Usuario de Siigo. En claro a propósito: no es el secreto y permite listar sin descifrar.';
COMMENT ON COLUMN siigo_credenciales.aad_nonce IS
  'Nonce de datos asociados. Ata el ciphertext a esta fila; alterarlo hace fallar el descifrado.';
COMMENT ON COLUMN siigo_credenciales.descifrado_fallido_en IS
  'Marca del último descifrado fallido. La credencial se desactiva y exige reconfiguración.';
