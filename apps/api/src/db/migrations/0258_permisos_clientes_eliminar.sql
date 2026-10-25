-- HU #13954 (Feature #13943, Épica #13671) — «Eliminar clientes», segunda función EXCLUSIVA del Administrador
-- (mecanismo de la HU #13944, 0253; mismo molde que la 0255 de la HU #13945).
--
-- Qué se siembra: la ACCIÓN `accion.clientes.eliminar` (nivel 3, bajo el ítem «Clientes y proveedores», orden 80, tras
-- «Activar o desactivar clientes»). La operación que exige la guarda (`clients.clientes.eliminar`, en
-- `DELETE /api/clients/:id`) nace absorbida por ella y no se siembra (`OPERACIONES_NACIDAS_EN_EL_ARBOL` /
-- `ACCIONES_NACIDAS_TRAS_LA_SIEMBRA`). Valores = los de `catalogoCompleto()` para el nodo.
-- `exclusiva_admin = true` es la copia de `FUNCIONES_EXCLUSIVAS_ADMIN` que `verificarCatalogoAlArrancar` compara.
--
-- Después repite la limpieza de la 0253 (como la 0255), en el mismo orden: ningún rol distinto de `admin` conserva una
-- exclusiva, ningún usuario tiene excepción sobre ella, y `admin` las tiene todas.
-- Filas que se espera BORRAR: 0 (la acción es nueva; nadie la tenía). La segunda pasada no cambia nada.
--
-- Sin índice nuevo sobre `clients(deleted_at)`: la baja lee y bloquea la fila por su PK.
--
-- Idempotente: INSERT … ON CONFLICT DO UPDATE solo si algo difiere; los DELETE no encuentran nada la segunda vez;
-- los INSERT de reparto con ON CONFLICT DO NOTHING.

-- 1. La acción, marcada como exclusiva del Administrador.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden, exclusiva_admin) VALUES
  ('accion.clientes.eliminar', 'clientes', 'Eliminar clientes',
   'Eliminar un cliente inactivo, sin procesos abiertos ni saldo en su bolsa. Sus usuarios quedan dados de baja.',
   'accion', 'pagina.clients', '3', '80', true)
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden, exclusiva_admin = EXCLUDED.exclusiva_admin
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden,
         permisos_funciones.exclusiva_admin)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden, EXCLUDED.exclusiva_admin);

-- 1b. `admin` recibe la acción (HU #13424: toda siembra se le marca a `admin`, con el literal; patrón de la 0248 y la 0255).
--     Ningún otro rol. El paso 3 lo vuelve a garantizar para todas las exclusivas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'accion.clientes.eliminar')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- 2. (= 0253 paso 2) Ningún rol distinto de `admin` conserva una exclusiva, y ningún usuario tiene excepción sobre ella.
DELETE FROM permisos_rol_funcion rf
 USING permisos_funciones f
 WHERE rf.funcion_codigo = f.codigo
   AND f.exclusiva_admin
   AND rf.rol_codigo <> 'admin';

DELETE FROM permisos_usuario_funcion uf
 USING permisos_funciones f
 WHERE uf.funcion_codigo = f.codigo
   AND f.exclusiva_admin;

-- 3. (= 0253 paso 3) `admin` tiene todas las exclusivas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT 'admin', f.codigo
  FROM permisos_funciones f
 WHERE f.exclusiva_admin
   AND EXISTS (SELECT 1 FROM permisos_roles r WHERE r.codigo = 'admin')
ON CONFLICT DO NOTHING;
