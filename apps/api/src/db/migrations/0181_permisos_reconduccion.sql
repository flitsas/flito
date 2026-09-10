-- 0181_permisos_reconduccion.sql
-- Feature #12072 — Roles y permisos configurables. HU #12083 (eslabon 3 de 1 → 2 → 3): las guardas
--   de rol de FLITO, tramites y usuarios pasan a preguntar al motor (`exigirFuncion`). Once funciones
--   que el catalogo de la 0179 no tenia y que hoy protege un `requireRole('admin')` o un
--   `role === 'admin'` en linea: dos de impuestos (un `for` con template literal que el lector no
--   veia), ocho de `users/` (fuera del alcance de la #12081) y el forzar-continuar de tramites.
-- Autor: equipo FLITO. Antecedentes: migracion 0179 (HU #12081, catalogo y reparto de partida),
--   0180 (HU #12082, motor unico), ADR-0016 §2 (guarda a nivel de ruta).
--
-- Depende de la 0179 (permisos_funciones, permisos_rol_funcion). Orden 0179 → 0180 → 0181.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente en sentido FUERTE: ON CONFLICT DO NOTHING en las dos siembras; la segunda pasada no
--     toca una fila. Lo comprueba __tests__/db/migracion-0181.test.ts.
--   - Sin DELETE, sin UPDATE, sin ALTER TYPE, sin ADD COLUMN: schema.ts no cambia.
--   - Sin bump de sesiones: el JWT no lleva permisos desde la #12082 y `resolverPermisos` cachea 60 s;
--     el reinicio del deploy vacia la cache.
--   - Dollar-quoting ETIQUETADO en el bloque DO, y la etiqueta no se nombra en ningun comentario.
--   - Solo `admin` recibe las once: hoy todas son `requireRole('admin')` o `role === 'admin'`.

-- ── Paso 1 — Las once funciones nuevas del catalogo ────────────────────────────────────────────
-- Lineas producidas con `npm run permisos:seed -w apps/api` sobre la foto ampliada
-- (inventario.generado.ts) y recortadas a las once que la 0179 no sembro.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('impuestos.tramite.asumir', 'impuestos', 'Asumir un trámite de impuestos en Operaciones', 'Sacar el trámite del gestor del organismo y trabajarlo desde Operaciones (traspaso por contingencia).', 'operacion'),
  ('impuestos.tramite.devolver', 'impuestos', 'Devolver un trámite de impuestos al gestor', 'Regresar al gestor del organismo un trámite que Operaciones había asumido.', 'operacion'),
  ('tramite.tramite.forzar_continuar', 'tramite', 'Forzar la continuación de un trámite', 'Al editar, saltarse las validaciones que detendrían el trámite y dejarlo continuar bajo responsabilidad propia.', 'operacion'),
  ('usuarios.contrasena.cambiar_ajena', 'usuarios', 'Cambiar la contraseña de otro usuario', 'Fijar una contraseña nueva a un usuario distinto de uno mismo.', 'operacion'),
  ('usuarios.sesiones.invalidar', 'usuarios', 'Cerrar las sesiones de un usuario', 'Invalidar todos los tokens vivos de un usuario para que vuelva a iniciar sesión.', 'operacion'),
  ('usuarios.usuario.activar', 'usuarios', 'Activar o desactivar un usuario', 'Bloquear o volver a habilitar la entrada de un usuario sin borrarlo.', 'operacion'),
  ('usuarios.usuario.crear', 'usuarios', 'Crear un usuario', 'Dar de alta un usuario con su rol, sus páginas y su ámbito.', 'operacion'),
  ('usuarios.usuario.editar', 'usuarios', 'Editar un usuario', 'Cambiar el rol, las páginas, el ámbito o los datos de un usuario.', 'operacion'),
  ('usuarios.usuario.exportar', 'usuarios', 'Exportar los usuarios a Excel', 'Descargar el listado filtrado de usuarios como archivo de Excel.', 'operacion'),
  ('usuarios.usuario.listar', 'usuarios', 'Ver los usuarios', 'Abrir la pantalla de usuarios y recorrer el listado con sus filtros.', 'operacion'),
  ('usuarios.usuario.ver_resumen', 'usuarios', 'Ver el conteo de usuarios por rol', 'Leer cuántos usuarios activos e inactivos hay por cada rol.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto de partida: `admin` y nadie mas ────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'impuestos.tramite.asumir'),
  ('admin', 'impuestos.tramite.devolver'),
  ('admin', 'tramite.tramite.forzar_continuar'),
  ('admin', 'usuarios.contrasena.cambiar_ajena'),
  ('admin', 'usuarios.sesiones.invalidar'),
  ('admin', 'usuarios.usuario.activar'),
  ('admin', 'usuarios.usuario.crear'),
  ('admin', 'usuarios.usuario.editar'),
  ('admin', 'usuarios.usuario.exportar'),
  ('admin', 'usuarios.usuario.listar'),
  ('admin', 'usuarios.usuario.ver_resumen')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen ────────────────────────────────────────────────────────────────────────────────────
DO $resumen0181$
DECLARE n_funciones int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funciones FROM permisos_funciones
   WHERE codigo IN ('impuestos.tramite.asumir', 'impuestos.tramite.devolver', 'tramite.tramite.forzar_continuar',
                    'usuarios.contrasena.cambiar_ajena', 'usuarios.sesiones.invalidar', 'usuarios.usuario.activar',
                    'usuarios.usuario.crear', 'usuarios.usuario.editar', 'usuarios.usuario.exportar',
                    'usuarios.usuario.listar', 'usuarios.usuario.ver_resumen');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin' AND funcion_codigo IN ('impuestos.tramite.asumir', 'impuestos.tramite.devolver',
                    'tramite.tramite.forzar_continuar', 'usuarios.contrasena.cambiar_ajena', 'usuarios.sesiones.invalidar',
                    'usuarios.usuario.activar', 'usuarios.usuario.crear', 'usuarios.usuario.editar',
                    'usuarios.usuario.exportar', 'usuarios.usuario.listar', 'usuarios.usuario.ver_resumen');
  RAISE NOTICE '0181: funciones nuevas en catalogo = % (esperadas 11); filas de reparto de admin = % (esperadas 11)',
    n_funciones, n_reparto;
END $resumen0181$;
