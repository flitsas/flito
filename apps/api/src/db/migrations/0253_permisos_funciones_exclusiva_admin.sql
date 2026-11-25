-- HU #13944 (Feature #13939, Épica #13671) — Funciones exclusivas del Administrador.
--
-- `permisos_funciones.exclusiva_admin`: la función solo la tiene el rol `admin`; nadie puede asignarla a otro rol
-- ni a un usuario (excepción `conceder`), ni quitársela a `admin` (cuadro o excepción `revocar`). La fuente de
-- verdad es `FUNCIONES_EXCLUSIVAS_ADMIN` en `catalogo-operaciones.ts`; esta columna es su copia, que
-- `verificarCatalogoAlArrancar` compara al arrancar. La regla de escritura vive en el servicio (sin trigger),
-- igual que el seguro antibloqueo.
--
-- Esta migración entrega SOLO el mecanismo: no marca ninguna función. Las primeras exclusivas las marca la
-- migración de la HU que crea sus rutas (#13945/#13954). Por eso los pasos 2 y 3 afectan 0 filas hoy; quedan
-- para que el invariante sea cierto desde aquí y la migración sea re-ejecutable sin efecto.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; los INSERT con ON CONFLICT DO NOTHING; los DELETE no encuentran nada
-- en la segunda pasada.

-- 1. La columna. NOT NULL DEFAULT false: todas las funciones existentes quedan como no exclusivas.
ALTER TABLE permisos_funciones
  ADD COLUMN IF NOT EXISTS exclusiva_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN permisos_funciones.exclusiva_admin IS
  'HU #13944: solo el rol admin la tiene; no asignable a otro rol ni a un usuario, ni se le quita a admin. Copia de FUNCIONES_EXCLUSIVAS_ADMIN (catalogo-operaciones.ts).';

-- 2. Ningún rol distinto de `admin` conserva una exclusiva, y ningún usuario tiene excepción sobre ella.
DELETE FROM permisos_rol_funcion rf
 USING permisos_funciones f
 WHERE rf.funcion_codigo = f.codigo
   AND f.exclusiva_admin
   AND rf.rol_codigo <> 'admin';

DELETE FROM permisos_usuario_funcion uf
 USING permisos_funciones f
 WHERE uf.funcion_codigo = f.codigo
   AND f.exclusiva_admin;

-- 3. `admin` tiene todas las exclusivas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT 'admin', f.codigo
  FROM permisos_funciones f
 WHERE f.exclusiva_admin
   AND EXISTS (SELECT 1 FROM permisos_roles r WHERE r.codigo = 'admin')
ON CONFLICT DO NOTHING;
