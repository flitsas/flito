-- 0190_users_baja_logica.sql
-- Feature #12072 — HU #12089: baja lógica de usuarios (`deleted_at` / `deleted_by`).
--   · DDL: columnas + índices parciales. username/email NO se liberan (la fila sigue existiendo).
--   · Semilla: `usuarios.usuario.baja` (DELETE /api/users/:id) y `usuarios.usuario.reactivar`
--     (POST /api/users/:id/reactivar) + reparto a `admin`.
-- Autor: equipo FLITO. Antecedentes: 0185 (auditoría ya admite accion baja/reactivar y campo
--   deleted_at), 0186 (estilo de siembra), #12084 (CONDICION_USUARIO_VIVO / conSeguroAntiBloqueo).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING.
--   - Dollar-quoting ETIQUETADO en el bloque DO; la etiqueta no se nombra en ningun comentario.
--   - Ninguna linea del archivo empieza por «(» + comilla salvo las tuplas de siembra: el test de la
--     0179 compara esas lineas con lo que produce generar-seed-permisos.ts.

-- ── Paso 1 — Columnas (baja lógica; independiente de `active` = suspensión) ─────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by integer
  REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN users.deleted_at IS 'HU #12089 baja lógica; NULL = en alta. Independiente de active (suspensión). username/email NO se liberan.';
COMMENT ON COLUMN users.deleted_by IS 'Actor de la baja; FK RESTRICT (nunca hard-delete de users).';

-- ── Paso 2 — Índices del camino caliente (listados / selectores / invariante) ───────────────────
CREATE INDEX IF NOT EXISTS idx_users_vivos ON users (id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Paso 3 — Funciones nuevas (admin) ───────────────────────────────────────────────────────────
-- Formato del generador (generar-seed-permisos.ts): una tupla por linea. Textos de negocio fijados
-- con el diseño slim HU #12089.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('usuarios.usuario.baja', 'usuarios', 'Dar de baja un usuario', 'Marcar un usuario como dado de baja sin borrarlo. Conserva username, permisos y ámbito.', 'operacion'),
  ('usuarios.usuario.reactivar', 'usuarios', 'Reactivar un usuario dado de baja', 'Quitar la marca de baja de un usuario para que vuelva a poder iniciar sesión.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'usuarios.usuario.baja'),
  ('admin', 'usuarios.usuario.reactivar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 4 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
DO $resumen0190$
DECLARE n_cols int; n_funciones int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users'
     AND column_name IN ('deleted_at', 'deleted_by');
  SELECT count(*) INTO n_funciones FROM permisos_funciones
   WHERE codigo IN ('usuarios.usuario.baja', 'usuarios.usuario.reactivar');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin'
     AND funcion_codigo IN ('usuarios.usuario.baja', 'usuarios.usuario.reactivar');
  RAISE NOTICE '0190: columnas deleted_* = % (esperadas 2); funciones = % (esperadas 2); reparto admin = % (esperadas 2)',
    n_cols, n_funciones, n_reparto;
END $resumen0190$;
