-- 0284_flito_logistica_motivos_permiso.sql
-- HU #14119 (Feature C3.1 #14093, Épica #13758, ADR-0030) — catálogo de motivos de llegada a FLIT.
-- La tabla `flito_logistica_motivos_llegada` + índice unique lower(nombre) + seed de 3 nombres
-- YA existen en 0275. Esta migración NO crea tabla. Solo:
--   1. Re-siembra idempotente de los tres nombres (AC5). ON CONFLICT no pisa orden/activo
--      si un admin los cambió; si falta el nombre, lo inserta.
--   2. Función `logistica.motivos.gestionar` (calco 0283): opcional de
--      `accion.logistica.ver_consola`. Reparto: solo `admin`.
-- Sin BEGIN/COMMIT. Idempotente.

INSERT INTO flito_logistica_motivos_llegada (nombre, orden, activo) VALUES
  ('Sin dirección de entrega al recoger', 10, true),
  ('Destino lejano (transportadora externa)', 20, true),
  ('Otro', 30, true)
ON CONFLICT (lower(nombre)) DO NOTHING;

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.motivos.gestionar', 'logistica', 'Gestionar motivos de llegada a FLIT', 'Crear, editar y activar o desactivar los motivos por los que un organismo llega a las instalaciones de FLIT. No se borra: el histórico conserva el motivo.', 'operacion', 'accion.logistica.ver_consola')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.motivos.gestionar')
ON CONFLICT DO NOTHING;
