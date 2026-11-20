-- Torre de Control Gerencial (Épica #14590, bloque B3) — área PRODUCTOS: SOAT, impuestos y derechos de tránsito.
--
-- 1. Umbral nuevo `dias_soat_por_vencer` (días antes del vencimiento de la póliza; defecto 30 = `UMBRALES_TORRE`). Se
--    cambia en Umbrales y alertas. `ON CONFLICT DO NOTHING`: un valor ya ajustado no se pisa.
-- 2. El ítem «Torre · Productos» (General) y su acción `torre.tablero_productos.ver` (lectura), con el reparto literal
--    de `REPARTO_TORRE` (`apps/api/src/modules/permisos/arbol/acciones-torre.ts`): admin y los roles que ven Operativa
--    (auditor y gerencia_general). La 0303 (ya aplicada) y la 0307 no se tocan.
-- Idempotente: `ON CONFLICT` en las tres tablas. Las operaciones nacen en el árbol (no se siembran).

-- ── 1. Umbral ───────────────────────────────────────────────────────────────────────────────────────
INSERT INTO flito_torre_umbrales (clave, valor, unidad, descripcion) VALUES
  ('dias_soat_por_vencer', 30, 'dias', 'Días antes del vencimiento de la póliza a partir de los cuales un SOAT se cuenta como por vencer.')
ON CONFLICT (clave) DO NOTHING;

-- ── 2. Permisos ─────────────────────────────────────────────────────────────────────────────────────
-- ÁRBOL GENERADO (inicio)
-- 1 ítems (nivel 2) y 1 acciones (nivel 3). Generado: no editar a mano.
-- Generado por `sqlSiembraTorre(catalogo, 'productos')` (`arbol/sql-torre.ts`).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.torre_productos', 'torre_de_control', 'Torre · Productos', 'Entrar a la pantalla «Torre · Productos».', 'pagina', 'menu.general', '2', '90'),
  ('accion.torre_productos.ver', 'torre_de_control', 'Ver el tablero de productos', 'Consultar el estado de los SOAT, los impuestos y los derechos de tránsito.', 'accion', 'pagina.torre_productos', '3', '10')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe la acción y el ítem (ADR-0022); auditor y gerencia_general (los que ven Operativa), su reparto
-- literal (`REPARTO_TORRE`). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.torre_productos.ver'),
  ('admin', 'pagina.torre_productos'),
  ('auditor', 'accion.torre_productos.ver'),
  ('auditor', 'pagina.torre_productos'),
  ('gerencia_general', 'accion.torre_productos.ver'),
  ('gerencia_general', 'pagina.torre_productos')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
