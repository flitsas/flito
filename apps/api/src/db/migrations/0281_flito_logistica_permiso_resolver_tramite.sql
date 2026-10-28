-- 0281_flito_logistica_permiso_resolver_tramite.sql
-- HU #14143 (Feature #14091, Épica #13758, ADR-0030 §17.3) — la función `logistica.documento.resolver_tramite`:
--   elegir a qué trámite corresponde una LT pendiente (escaneada por vehículo sin trámite) y consultar la bandeja
--   de pendientes. Solo siembra de datos, idempotente, sin BEGIN/COMMIT (calco de la 0280).
-- Es un OPCIONAL de `accion.logistica.reversar_paso` (acciones-gestion.ts): nace con su `padre_codigo`.
-- Reparto: SOLO `admin` (Operaciones es `admin`). El mensajero NO la recibe. Otros roles/usuarios, desde el panel de permisos.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.documento.resolver_tramite', 'logistica', 'Resolver el trámite de una LT pendiente', 'Elegir a qué trámite corresponde una LT escaneada sin trámite y consultar la bandeja de pendientes.', 'operacion', 'accion.logistica.reversar_paso')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.documento.resolver_tramite')
ON CONFLICT DO NOTHING;
