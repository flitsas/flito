-- 0282_flito_logistica_permiso_traslado_registrar.sql
-- HU #14114 (Feature C2 #14092, Épica #13758, ADR-0030 §5) — la función `logistica.traslado.registrar`:
--   registrar el viaje a cliente de las LT de una compañía (precio congelado). Calco de la 0280:
--   solo siembra de datos, idempotente, sin BEGIN/COMMIT.
-- Es un OPCIONAL de `accion.mi_ruta.escanear` (acciones-gestion.ts): nace con su `padre_codigo`.
-- Reparto: `admin` y `mensajero` (como `logistica.recogida.confirmar`). Otros roles/usuarios, desde el panel.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.traslado.registrar', 'logistica', 'Registrar un viaje de logística', 'Registrar el viaje a cliente de las LT de una compañía, con el precio congelado.', 'operacion', 'accion.mi_ruta.escanear')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.traslado.registrar'),
  ('mensajero', 'logistica.traslado.registrar')
ON CONFLICT DO NOTHING;
