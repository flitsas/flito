-- 0305_flito_vistas_columnas.sql (Épica #14560)
-- Autor: David Chica
-- ADR-0045: vistas de columnas persistidas en servidor (personales y compartidas) para tablas FLITO.
-- Primer consumidor: Gestión Trámites (tabla_id = 'flito-tramites').
--
-- Modelo (Opción 2 del ADR):
--   · flito_vistas_columnas: todas las vistas. alcance 'personal' (owner obligatorio) o 'compartida' (owner NULL).
--     Las claves de columna van en `columnas` (jsonb, sin valores de datos del titular).
--   · flito_vistas_columnas_preferencias: punteros por tabla. user_id NULL = predeterminada general;
--     vista_id NULL = sistema explícito (es lo que escribe «Restablecer»).
--   · La vista del sistema NO es una fila: vive en el catálogo de código.
--
-- Borrado: borrar un usuario se lleva sus vistas personales y sus punteros (ON DELETE CASCADE);
-- las compartidas se conservan y creado_por_user_id pasa a NULL. Borrar una vista cascadea sus punteros:
-- el usuario cae a la general (o al sistema), según la regla de resolución del servicio.
--
-- Reglas que la base no puede expresar y que valida el servicio: propiedad de los punteros
-- (personal → vista personal del mismo usuario; general → vista compartida), límites de 30 columnas y
-- 20 vistas personales por usuario y tabla.
--
-- Idempotente: CREATE ... IF NOT EXISTS. Se puede aplicar dos veces. Sin control de transacción propio
-- (lo pone el runner). Sin drizzle-kit (ADR-0035).
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS flito_vistas_columnas (
  id                    serial PRIMARY KEY,
  tabla_id              varchar(80) NOT NULL,
  alcance               varchar(16) NOT NULL,
  owner_user_id         integer REFERENCES users(id) ON DELETE CASCADE,
  nombre                varchar(60) NOT NULL,
  columnas              jsonb NOT NULL,
  creado_por_user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_vista_alcance CHECK (alcance IN ('personal', 'compartida')),
  CONSTRAINT ck_vista_owner CHECK (
    (alcance = 'personal' AND owner_user_id IS NOT NULL)
    OR (alcance = 'compartida' AND owner_user_id IS NULL)
  ),
  CONSTRAINT ck_vista_columnas_array CHECK (jsonb_typeof(columnas) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vista_personal_nombre
  ON flito_vistas_columnas (tabla_id, owner_user_id, nombre)
  WHERE alcance = 'personal';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vista_compartida_nombre
  ON flito_vistas_columnas (tabla_id, nombre)
  WHERE alcance = 'compartida';

CREATE INDEX IF NOT EXISTS ix_vista_tabla_alcance
  ON flito_vistas_columnas (tabla_id, alcance);

CREATE INDEX IF NOT EXISTS ix_vista_owner
  ON flito_vistas_columnas (owner_user_id);

CREATE TABLE IF NOT EXISTS flito_vistas_columnas_preferencias (
  id          serial PRIMARY KEY,
  tabla_id    varchar(80) NOT NULL,
  user_id     integer REFERENCES users(id) ON DELETE CASCADE,
  vista_id    integer REFERENCES flito_vistas_columnas(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Una predeterminada personal por usuario y tabla.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pref_usuario_tabla
  ON flito_vistas_columnas_preferencias (tabla_id, user_id)
  WHERE user_id IS NOT NULL;

-- Una predeterminada general por tabla.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pref_general_tabla
  ON flito_vistas_columnas_preferencias (tabla_id)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_pref_vista
  ON flito_vistas_columnas_preferencias (vista_id);

-- Permiso (ADR-0045 §Guardas; ratchet HU #13425 AC6: ninguna regla del servidor decide por el nombre del rol).
-- «Administrar vistas de columnas» = crear/editar/borrar vistas compartidas y fijar la predeterminada general.
-- La ACCIÓN nace después de la siembra del árbol (mismo molde que la 0274): la operación que piden las guardas
-- (`tramites.vistas_columnas.administrar`) nace absorbida por ella y no se siembra. Reparto: solo `admin` (lo que el
-- PO aprobó: «solo el administrador»), que la puede repartir desde la pantalla de permisos.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.tramites.administrar_vistas_columnas', 'tramites', 'Administrar vistas de columnas', 'Crear vistas de columnas para todos y fijar la predeterminada general.', 'accion', 'pagina.flito_tramites', '3', '90')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'accion.tramites.administrar_vistas_columnas')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
