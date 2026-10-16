-- 0236_permisos_arbol_administracion_siembra.sql
--
-- HU #13428 (Feature #13416, Épica #13411) — Catálogo nuevo de Administración, General, Perfil y de
-- Gestión · Clientes y proveedores y Bitácora (elemento Gestión por la decisión del PO del 9-oct).
-- ADR-0025 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §5-ter.
-- Autor: equipo FLITO. Antecedente: 0235 (la anterior, reparto de Finanzas). Le sigue la 0237 (reparto).
--
-- Qué hace: siembra las acciones (nivel 3) de los 6 ítems del área —Usuarios y Roles y permisos
-- (Administración), Clientes y proveedores y Bitácora (Gestión), Tablero (General) y Perfil— y marca
-- `nivel`/`orden` de esas 6 páginas. Los `menu.*` y el padre de cada página llegan con la HU #13429.
-- NO reparte ni retira nada: eso es la 0237 (aquí no hay ni una fila de `permisos_rol_funcion`).
-- Idempotente: upsert y UPDATE con `IS DISTINCT FROM` (2.ª pasada sin cambios).

-- ÁRBOL GENERADO (inicio)
-- 24 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol administracion
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.bitacora.ver', 'bitacora', 'Ver la bitácora', 'Consultar la bitácora de cambios y la de cada registro.', 'accion', 'pagina.flito_bitacora', '3', '10'),
  ('accion.clientes.autogestion', 'clientes', 'Habilitar o revocar la autogestión del cliente', 'Habilitar o revocar la autogestión de SOAT, impuestos y logística de un cliente.', 'accion', 'pagina.clients', '3', '40'),
  ('accion.clientes.crear_editar_clientes', 'clientes', 'Crear y editar clientes', 'Crear clientes y empresas, y editar sus datos generales.', 'accion', 'pagina.clients', '3', '20'),
  ('accion.clientes.crear_editar_proveedores', 'clientes', 'Crear y editar proveedores', 'Crear y editar los proveedores de SOAT.', 'accion', 'pagina.clients', '3', '30'),
  ('accion.clientes.datos_fiscales', 'clientes', 'Datos fiscales', 'Registrar y editar los datos fiscales de un cliente.', 'accion', 'pagina.clients', '3', '60'),
  ('accion.clientes.soat_sin_tramite', 'clientes', 'Configurar «SOAT sin trámite»', 'Permitir a un cliente solicitar SOAT sin trámite y elegir su proveedor.', 'accion', 'pagina.clients', '3', '50'),
  ('accion.clientes.ver', 'clientes', 'Ver clientes y proveedores', 'Consultar los clientes, las compañías y los proveedores de SOAT.', 'accion', 'pagina.clients', '3', '10'),
  ('accion.dashboard.ver', 'general', 'Ver (solo ver)', 'Ver el tablero con los bloques de los módulos a los que tiene acceso.', 'accion', 'pagina.dashboard', '3', '10'),
  ('accion.perfil.cambiar_contrasena', 'general', 'Cambiar mi contraseña', 'Cambiar la contraseña propia.', 'accion', 'pagina.perfil', '3', '20'),
  ('accion.perfil.ver_datos', 'general', 'Ver mis datos', 'Ver el nombre, el usuario, el correo y el rol propios.', 'accion', 'pagina.perfil', '3', '10'),
  ('accion.roles_permisos.asignar', 'permisos', 'Asignar permisos', 'Guardar los permisos de un rol.', 'accion', 'pagina.roles_permisos', '3', '40'),
  ('accion.roles_permisos.crear', 'permisos', 'Crear rol', 'Crear un rol nuevo.', 'accion', 'pagina.roles_permisos', '3', '20'),
  ('accion.roles_permisos.editar', 'permisos', 'Editar rol', 'Editar el nombre, la descripción y el enlace de un rol.', 'accion', 'pagina.roles_permisos', '3', '30'),
  ('accion.roles_permisos.eliminar', 'permisos', 'Eliminar rol', 'Eliminar un rol sin usuarios.', 'accion', 'pagina.roles_permisos', '3', '50'),
  ('accion.roles_permisos.ver', 'permisos', 'Ver roles', 'Consultar los roles, sus permisos y el catálogo de permisos.', 'accion', 'pagina.roles_permisos', '3', '10'),
  ('accion.usuarios.cambiar_contrasena', 'usuarios', 'Cambiar la contraseña de otro usuario', 'Asignar una contraseña nueva a otro usuario.', 'accion', 'pagina.users', '3', '40'),
  ('accion.usuarios.cerrar_sesiones', 'usuarios', 'Cerrar sesiones', 'Cerrar todas las sesiones abiertas de un usuario.', 'accion', 'pagina.users', '3', '90'),
  ('accion.usuarios.crear', 'usuarios', 'Crear usuario', 'Dar de alta un usuario nuevo.', 'accion', 'pagina.users', '3', '20'),
  ('accion.usuarios.dar_de_baja', 'usuarios', 'Dar de baja (eliminar)', 'Dar de baja a un usuario o deshacer la baja.', 'accion', 'pagina.users', '3', '60'),
  ('accion.usuarios.desactivar_reactivar', 'usuarios', 'Desactivar o reactivar', 'Suspender el acceso de un usuario o devolvérselo.', 'accion', 'pagina.users', '3', '50'),
  ('accion.usuarios.editar', 'usuarios', 'Editar usuario', 'Editar los datos, el rol y las excepciones de permisos de un usuario.', 'accion', 'pagina.users', '3', '30'),
  ('accion.usuarios.exportar', 'usuarios', 'Exportar a Excel', 'Descargar la lista de usuarios en Excel.', 'accion', 'pagina.users', '3', '80'),
  ('accion.usuarios.ver', 'usuarios', 'Ver usuarios', 'Consultar la lista de usuarios y su resumen.', 'accion', 'pagina.users', '3', '10'),
  ('accion.usuarios.ver_historial', 'usuarios', 'Ver el historial', 'Consultar el historial de cambios de los usuarios.', 'accion', 'pagina.users', '3', '70')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- 6 páginas que son ítem (nivel 2). Su padre (`menu.*`) lo pone la HU #13429.
UPDATE permisos_funciones AS f
   SET nivel = v.nivel::smallint, orden = v.orden::integer
  FROM (VALUES
    ('pagina.clients', '2', '90'),
    ('pagina.dashboard', '2', '10'),
    ('pagina.flito_bitacora', '2', '100'),
    ('pagina.perfil', '2', '10'),
    ('pagina.roles_permisos', '2', '20'),
    ('pagina.users', '2', '10')
  ) AS v(codigo, nivel, orden)
 WHERE f.codigo = v.codigo
   AND (f.nivel, f.orden) IS DISTINCT FROM (v.nivel::smallint, v.orden::integer);
-- ÁRBOL GENERADO (fin)
