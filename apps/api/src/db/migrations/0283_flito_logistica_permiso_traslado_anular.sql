-- 0283_flito_logistica_permiso_traslado_anular.sql
-- HU #14115 (Feature C2 #14092, Épica #13758, ADR-0030 C2.2) — la función `logistica.traslado.anular`:
--   anular un viaje a cliente aún `registrado` (líneas a `anulado`, precio congelado intacto).
-- Calco de la 0282: solo siembra de datos, idempotente, sin BEGIN/COMMIT.
-- Es un OPCIONAL de `accion.logistica.reversar_paso` (acciones-gestion.ts): nace con su `padre_codigo`.
-- Reparto: solo `admin`. Otros roles/usuarios, desde el panel.

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo) VALUES
  ('logistica.traslado.anular', 'logistica', 'Anular un viaje de logística', 'Anular un viaje a cliente que aún no se ha despachado. El precio congelado se conserva.', 'operacion', 'accion.logistica.reversar_paso')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.traslado.anular')
ON CONFLICT DO NOTHING;
