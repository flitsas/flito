-- 0276_flito_logistica_permiso_ver_documento_firmante.sql
-- HU #14110 (Feature #14091, Épica #13758, ADR-0030 §5/§9) — la función `logistica.actas.ver_documento_firmante`:
--   ver la cédula COMPLETA del funcionario que firmó un acta de organismo (PII, Ley 1581). Cada consulta
--   queda en `pii_access_log`. Calco de la 0228: solo siembra de datos, idempotente, sin BEGIN/COMMIT.
-- Reparto: SOLO `admin` (0226: admin = todo marcado). Cualquier otro rol o usuario la recibe desde el panel de permisos.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('logistica.actas.ver_documento_firmante', 'logistica', 'Ver la cédula del firmante de un acta', 'Consultar la cédula completa del funcionario que firmó el acta de organismo; cada consulta queda registrada.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.actas.ver_documento_firmante')
ON CONFLICT DO NOTHING;
