-- HU #13958 (Feature #13940, Épica #13671) — «Activar o desactivar proveedores», función EXCLUSIVA del Administrador
-- (mecanismo de la HU #13944, 0253; mismo molde que la 0255 y la 0258 de clientes).
--
-- Qué se siembra: la ACCIÓN `accion.clientes.activar_desactivar_proveedores` (nivel 3, bajo el ítem «Clientes y
-- proveedores», orden 90, tras «Eliminar clientes»). La operación que exige la guarda
-- (`parametrizacion.proveedores.estado`, en `GET /api/flito/parametrizacion/proveedores-soat/:id/impacto` y
-- `PATCH …/:id/estado`) nace absorbida por ella y no se siembra (`OPERACIONES_NACIDAS_EN_EL_ARBOL` /
-- `ACCIONES_NACIDAS_TRAS_LA_SIEMBRA`). Valores = los de `catalogoCompleto()`.
--
-- «Eliminar proveedores» NO va aquí: el catálogo exige que toda operación que concede una acción tenga guarda viva
-- (`permisos-arbol-administracion.test.ts` AC6, muestreo 200/403), y la ruta DELETE es de otra HU: la siembra esa HU.
-- `exclusiva_admin = true` es la copia de `FUNCIONES_EXCLUSIVAS_ADMIN` que `verificarCatalogoAlArrancar` compara.
--
-- Después repite la limpieza de la 0253 (como la 0255 y la 0258), en el mismo orden: ningún rol distinto de `admin`
-- conserva una exclusiva, ningún usuario tiene excepción sobre ella, y `admin` las tiene todas.
-- Filas que se espera BORRAR: 0 (la acción es nueva; nadie la tenía). La segunda pasada no cambia nada.
--
-- Sin índice nuevo: el cambio de estado lee y bloquea la fila del proveedor por su PK y el SOAT en curso usa
-- `idx_flito_soat_proveedor`. `users.flito_proveedor_soat_id` y `clients.flito_proveedor_soat_sin_tramite_id` no tienen
-- índice (tablas pequeñas, operación exclusiva de admin); queda como deuda para una migración futura.
--
-- Idempotente: INSERT … ON CONFLICT DO UPDATE solo si algo difiere; los DELETE no encuentran nada la segunda vez;
-- los INSERT de reparto con ON CONFLICT DO NOTHING.

-- 1. La acción, marcada como exclusiva del Administrador.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden, exclusiva_admin) VALUES
  ('accion.clientes.activar_desactivar_proveedores', 'clientes', 'Activar o desactivar proveedores',
   'Desactivar un proveedor SOAT (sus usuarios pierden el acceso) o volver a activarlo, viendo antes el impacto.',
   'accion', 'pagina.clients', '3', '90', true)
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden, exclusiva_admin = EXCLUDED.exclusiva_admin
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden,
         permisos_funciones.exclusiva_admin)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden, EXCLUDED.exclusiva_admin);

-- 1b. `admin` recibe la acción (HU #13424: toda siembra se le marca a `admin`, con el literal; patrón de la 0258).
--     Ningún otro rol. El paso 3 lo vuelve a garantizar para todas las exclusivas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'accion.clientes.activar_desactivar_proveedores')) AS v(rol, fn)
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
