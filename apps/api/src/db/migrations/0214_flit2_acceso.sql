-- 0214_flit2_acceso.sql
-- HU #13061 (Feature #13057, Épica #12736) — acceso de FLITO a FLIT 2: la tabla del usuario de
--   servicio (contraseña cifrada con FLIT2_ENC_KEY, una sola fila activa, las inactivas son el rastro)
--   y las funciones `tramites.flit2.ver_acceso` / `tramites.flit2.guardar_acceso`, sembradas SOLO a
--   admin. Las columnas de marcas (rechazo/bloqueo) las usa la HU #13063; nacen aquí para no pedir
--   otra migración.
-- Autor: equipo FLITO. Antecedentes: 0150 (token SIMIT, mismo patrón de cifrado), 0212 (calco de la
--   siembra: operación + reparto solo a admin), ADR-DB-001 (sin control de transacción propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.

-- ── Paso 1 — La tabla ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_sync_flit2_acceso (
  id                         smallserial PRIMARY KEY,
  client_id                  varchar(120) NOT NULL,
  secret_cipher              bytea NOT NULL,
  secret_iv                  bytea NOT NULL,
  secret_auth_tag            bytea NOT NULL,
  aad_nonce                  uuid NOT NULL,
  key_version                smallint NOT NULL DEFAULT 1,
  activo                     boolean NOT NULL DEFAULT true,
  rechazado_en               timestamptz NULL,
  rechazo_motivo             varchar(40) NULL,
  bloqueado_hasta            timestamptz NULL,
  bloqueo_motivo             varchar(40) NULL,
  descifrado_fallido_en      timestamptz NULL,
  descifrado_fallido_motivo  varchar(200) NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 integer NULL REFERENCES users(id),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 integer NULL REFERENCES users(id),
  CONSTRAINT ck_flito_sync_flit2_acceso_rechazo_motivo
    CHECK (rechazo_motivo IS NULL OR rechazo_motivo IN ('invalid_client', 'secret_rotation_required')),
  CONSTRAINT ck_flito_sync_flit2_acceso_bloqueo_motivo
    CHECK (bloqueo_motivo IS NULL OR bloqueo_motivo IN ('client_locked', 'rate_limited'))
);

-- Una sola fila vigente: dos PUT a la vez chocan aquí y el segundo sale como 409.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_sync_flit2_acceso_activo
  ON flito_sync_flit2_acceso (activo) WHERE activo;

COMMENT ON TABLE flito_sync_flit2_acceso IS
  'HU #13061: usuario de servicio de FLITO en FLIT 2. Contraseña cifrada (FLIT2_ENC_KEY); una fila activa; las inactivas son el rastro.';

-- ── Paso 2 — Las operaciones (byte a byte con catalogo-operaciones.ts) ───────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('tramites.flit2.ver_acceso', 'tramites', 'Ver el acceso a FLIT 2', 'Consultar con qué usuario de servicio se conecta FLITO a FLIT 2, quién lo guardó y desde cuándo.', 'operacion'),
  ('tramites.flit2.guardar_acceso', 'tramites', 'Guardar el acceso a FLIT 2', 'Registrar o reemplazar el usuario de servicio y la contraseña con los que FLITO se conecta a FLIT 2.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 3 — Reparto en VALUES explícitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'tramites.flit2.ver_acceso'),
  ('admin', 'tramites.flit2.guardar_acceso')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0214$
DECLARE n_tabla int; n_ops int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_tabla FROM pg_indexes
   WHERE tablename = 'flito_sync_flit2_acceso' AND indexname = 'uq_flito_sync_flit2_acceso_activo';
  -- Por código exacto y NO por módulo/prefijo: `tramites.*` tiene decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones
   WHERE tipo = 'operacion' AND codigo IN ('tramites.flit2.ver_acceso', 'tramites.flit2.guardar_acceso');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin' AND funcion_codigo IN ('tramites.flit2.ver_acceso', 'tramites.flit2.guardar_acceso');
  IF n_tabla <> 1 OR n_ops <> 2 OR n_reparto <> 2 THEN
    RAISE EXCEPTION '0214: acceso a FLIT 2 inconsistente (indice=%, ops=%, reparto=%)', n_tabla, n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0214: tabla flito_sync_flit2_acceso lista; % funciones FLIT 2 sembradas (solo admin)', n_ops;
END $resumen0214$;
