-- 0294_flito_logistica_permiso_dejar_pendiente.sql
-- Autor: David Chica
-- HU #14348 (Feature #14326, ADR-0039 §7.3, R20) — dejar una licencia pendiente al escanearla. Patrón de la 0286.
--   1. Función `logistica.documento.dejar_pendiente`, opcional de `accion.mi_ruta.escanear`.
--   2. Reparto: solo `admin`. El mensajero de FLITO deja de poder hacerlo; concedérsela es el panel, no un INSERT de rol.
-- Sin BEGIN/COMMIT. Sin ALTER. Idempotente.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.documento.dejar_pendiente', 'logistica', 'Dejar una licencia pendiente de trámite', 'Registrar una licencia sin elegir su trámite, cuando el vehículo tiene varios, para que Operaciones lo resuelva después.', 'operacion', 'accion.mi_ruta.escanear')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.documento.dejar_pendiente')
ON CONFLICT DO NOTHING;
