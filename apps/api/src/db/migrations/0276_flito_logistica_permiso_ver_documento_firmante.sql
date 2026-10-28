-- 0276_flito_logistica_permiso_ver_documento_firmante.sql
-- (enmendada en su lugar, ADR-0030 §17.4: ninguna HU de la Épica está en develop; también siembra `logistica.recogida.confirmar`)
-- HU #14110 (Feature #14091, Épica #13758, ADR-0030 §5/§9) — la función `logistica.actas.ver_documento_firmante`:
--   ver la cédula COMPLETA del funcionario que firmó un acta de organismo (PII, Ley 1581). Cada consulta
--   queda en `pii_access_log`. Calco de la 0228: solo siembra de datos, idempotente, sin BEGIN/COMMIT.
-- Es un OPCIONAL de `accion.logistica.ver_actas` (acciones-gestion.ts): por eso nace con su `padre_codigo`, como los de la 0238.
-- Reparto: SOLO `admin` (0226: admin = todo marcado). Cualquier otro rol o usuario la recibe desde el panel de permisos.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.recogida.confirmar', 'logistica', 'Confirmar la recogida con la firma del organismo', 'Registrar la firma del funcionario del organismo y generar un acta de organismo por compañía y consultar mis recogidas.', 'operacion', 'accion.mi_ruta.escanear'),
  ('logistica.actas.ver_documento_firmante', 'logistica', 'Ver la cédula del firmante de un acta', 'Consultar la cédula completa del funcionario que firmó el acta de organismo, cada consulta queda registrada.', 'operacion', 'accion.logistica.ver_actas')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.actas.ver_documento_firmante')
ON CONFLICT DO NOTHING;

-- `logistica.recogida.confirmar` (HU #14110, ADR-0030 §17.4): la ruta deja de pedir `logistica.documento.escanear`.
-- Se concede a todo rol y a toda excepción de usuario que hoy tenga el escaneo (el mensajero incluido), y a `admin`.
-- (Los roles van por VALUES —lo plegable por los tests de migraciones—; las excepciones de usuario por INSERT … SELECT.)
-- Un usuario al que se le REVOCÓ el escaneo hereda la revocación. Idempotente (ON CONFLICT DO NOTHING).
-- Roles que hoy tienen el escaneo (la foto de rutas: `admin` y `mensajero`; los roles son los 12 de USER_ROLES).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.recogida.confirmar'),
  ('mensajero', 'logistica.recogida.confirmar')
ON CONFLICT DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT user_id, 'logistica.recogida.confirmar', efecto FROM permisos_usuario_funcion WHERE funcion_codigo = 'logistica.documento.escanear'
ON CONFLICT DO NOTHING;
