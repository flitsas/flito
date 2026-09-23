-- 0186_permisos_roles_mantenimiento.sql
-- Feature #12072 — Roles y permisos configurables. HU #12084: mantenimiento de roles (CF-03/04/05) y
--   guardado del cuadro rol × función (CF-02). SOLO SIEMBRA: las siete funciones `permisos.*` que
--   guardan las rutas nuevas de `permisos.routes.ts` y su reparto a `admin`. Sin DDL.
-- Autor: equipo FLITO. Antecedentes: 0179 (catalogo), 0181 (reconduccion), 0185 (estilo de siembra:
--   una tupla por linea, ON CONFLICT DO NOTHING, resumen en el log del CD).
--
-- Depende de la 0178 (permisos_roles), la 0179 (permisos_funciones, permisos_rol_funcion).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente en sentido FUERTE: la segunda pasada no toca una fila (INSERT 0 0 en los dos bloques).
--     Lo comprueba __tests__/db/migracion-0186.test.ts.
--   - Nada de ALTER TYPE, ADD COLUMN ni CREATE: no crea nada, siembra.
--   - Dollar-quoting ETIQUETADO en el bloque DO, y la etiqueta no se nombra en ningun comentario.
--   - Ninguna linea del archivo empieza por «(» + comilla salvo las tuplas de siembra: el test de la 0179
--     compara esas lineas (0179 + 0181 + 0182 + 0184 + 0185 + 0186) con lo que produce generar-seed-permisos.ts.
--
-- Siete codigos y no cuatro: el catalogo es «una funcion por ruta» y los codigos son unicos (precedente:
-- `usuarios.auditoria.ver` / `.filtrar` de la 0185). Ninguno va al `auditor`: el cuadro de roles es
-- administracion, no observacion. `GET /funciones` pasa de `requireRole` de admin a
-- `exigirFuncion('permisos.catalogo.ver')`: el admin la recibe por esta siembra.
--
-- El invariante anti-bloqueo (CF-12, `shared/permisos-anti-bloqueo.ts`) cuenta sobre
-- `permisos.cuadro.guardar` y `usuarios.usuario.editar`: si algun dia no queda ningun usuario activo
-- interno con las dos, la via de recuperacion es el INSERT de reparto de abajo, a mano, por psql.

-- ── Paso 1 — Las siete funciones ────────────────────────────────────────────────────────────────
-- Formato del generador (generar-seed-permisos.ts): una tupla por linea. Textos de negocio fijados el
-- 10/09/2026; si cambian, cambian aqui y en catalogo-operaciones.ts.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('permisos.catalogo.ver', 'permisos', 'Ver el catálogo de funciones', 'Leer la lista de funciones que existen en el sistema, agrupadas por módulo, para repartirlas entre los roles.', 'operacion'),
  ('permisos.cuadro.guardar', 'permisos', 'Guardar el cuadro de funciones de un rol', 'Reescribir el conjunto completo de funciones que concede un rol.', 'operacion'),
  ('permisos.cuadro.ver', 'permisos', 'Ver el cuadro de funciones de un rol', 'Leer qué funciones concede un rol a quienes lo tienen asignado.', 'operacion'),
  ('permisos.rol.borrar', 'permisos', 'Borrar un rol', 'Eliminar un rol que ningún usuario tiene asignado, junto con su cuadro de funciones.', 'operacion'),
  ('permisos.rol.crear', 'permisos', 'Crear un rol', 'Dar de alta un rol nuevo con su tipo de enlace, su tipo principal y su cuadro de funciones.', 'operacion'),
  ('permisos.rol.editar', 'permisos', 'Editar un rol', 'Cambiar el nombre, la descripción, el tipo de enlace, el tipo principal o el estado de un rol.', 'operacion'),
  ('permisos.rol.listar', 'permisos', 'Ver los roles', 'Abrir la lista de roles con cuántos usuarios tiene cada uno y si se puede borrar.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: las siete a `admin`, y a nadie mas ────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'permisos.catalogo.ver'),
  ('admin', 'permisos.cuadro.guardar'),
  ('admin', 'permisos.cuadro.ver'),
  ('admin', 'permisos.rol.borrar'),
  ('admin', 'permisos.rol.crear'),
  ('admin', 'permisos.rol.editar'),
  ('admin', 'permisos.rol.listar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 3 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
DO $resumen0186$
DECLARE n_funciones int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funciones FROM permisos_funciones WHERE modulo = 'permisos';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin' AND funcion_codigo LIKE 'permisos.%';
  RAISE NOTICE '0186: funciones permisos.* = % (esperadas 7); reparto a admin = % (esperadas 7)',
    n_funciones, n_reparto;
END $resumen0186$;
