-- 0291_flito_proveedores_permiso_historial.sql
-- Autor: David Chica
-- HU #14335 (Feature #14324, ADR-0039 §7.3) — consultar el historial de un proveedor. Patrón de la 0286.
--   1. Función `parametrizacion.proveedores.historial`, opcional de `accion.clientes.ver`.
--   2. Reparto: solo `admin` y `auditor`. Concederla a otro rol es el panel, no un INSERT de rol.
-- Sin BEGIN/COMMIT. Sin ALTER. Idempotente.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('parametrizacion.proveedores.historial', 'clientes', 'Ver el historial de un proveedor', 'Consultar quién cambió un proveedor, cuándo y qué valor tenía, con los datos personales enmascarados.', 'operacion', 'accion.clientes.ver')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'parametrizacion.proveedores.historial'),
  ('auditor', 'parametrizacion.proveedores.historial')
ON CONFLICT DO NOTHING;
