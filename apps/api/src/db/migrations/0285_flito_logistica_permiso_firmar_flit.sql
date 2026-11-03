-- 0285_flito_logistica_permiso_firmar_flit.sql
-- HU #14122 (Feature C3 #14093, Épica #13758, ADR-0030) — firma de la llegada a FLIT.
-- No crea tabla ni altera 0274/0275. Solo:
--   1. Función `logistica.actas.firmar_flit`, opcional de
--      `accion.logistica.despachar_entregar_devolver` (el mensajero recibe entregar/devolver
--      y no este opcional).
--   2. Reparto: solo `admin`. Concederla a Logística es el panel, no un INSERT de rol.
-- Sin BEGIN/COMMIT. Sin ALTER. Idempotente.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.actas.firmar_flit', 'logistica', 'Firmar la llegada a FLIT', 'Registrar la firma de quien recibe el viaje en las instalaciones de FLIT. No lleva cédula: el nombre y el usuario salen de la sesión.', 'operacion', 'accion.logistica.despachar_entregar_devolver')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.actas.firmar_flit')
ON CONFLICT DO NOTHING;
