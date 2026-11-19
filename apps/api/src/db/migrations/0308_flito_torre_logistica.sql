-- Torre de Control Gerencial (Épica #14590, bloque B4) — área LOGÍSTICA (Traslados · Entregas). Las subvistas nuevas
-- de Financiera (Facturación · Bolsas) usan la función que ya existe (`torre.tablero_financiero.ver`): no siembran nada.
--
-- NÚMERO PROVISIONAL: al integrar la pila con develop se renumera (como la 0306 y la 0307).
--
-- 1. Umbral nuevo `dias_traslado_abierto` (días desde el registro a partir de los cuales un traslado abierto se cuenta
--    como demorado; defecto 3 = `UMBRALES_TORRE`). Se cambia en Umbrales y alertas. `ON CONFLICT DO NOTHING`: un valor
--    ya ajustado no se pisa.
-- 2. El ítem «Torre · Logística» (General) y su acción `torre.tablero_logistica.ver` (lectura), con el reparto literal
--    de `REPARTO_TORRE` (`apps/api/src/modules/permisos/arbol/acciones-torre.ts`): admin y los roles que ven Operativa
--    (auditor y gerencia_general), el mismo de Productos. La 0303, la 0306 y la 0307 no se tocan.
-- Idempotente: `ON CONFLICT` en las tres tablas. Las operaciones nacen en el árbol (no se siembran).
-- Índices: ninguno. Los candidatos del diseño (§12 B4) se midieron con EXPLAIN y no hacen falta (ver el PR).

-- ── 1. Umbral ───────────────────────────────────────────────────────────────────────────────────────
INSERT INTO flito_torre_umbrales (clave, valor, unidad, descripcion) VALUES
  ('dias_traslado_abierto', 3, 'dias', 'Días desde el registro a partir de los cuales un traslado abierto se cuenta como demorado.')
ON CONFLICT (clave) DO NOTHING;

-- ── 2. Permisos ─────────────────────────────────────────────────────────────────────────────────────
-- ÁRBOL GENERADO (inicio)
-- 1 ítems (nivel 2) y 1 acciones (nivel 3). Generado: no editar a mano.
-- Generado por `sqlSiembraTorre(catalogo, 'logistica')` (`arbol/sql-torre.ts`).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.torre_logistica', 'torre_de_control', 'Torre · Logística', 'Entrar a la pantalla «Torre · Logística».', 'pagina', 'menu.general', '2', '100'),
  ('accion.torre_logistica.ver', 'torre_de_control', 'Ver el tablero de logística', 'Consultar los traslados de documentos, las actas de entrega y los viajes adicionales.', 'accion', 'pagina.torre_logistica', '3', '10')
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
  ('admin', 'accion.torre_logistica.ver'),
  ('admin', 'pagina.torre_logistica'),
  ('auditor', 'accion.torre_logistica.ver'),
  ('auditor', 'pagina.torre_logistica'),
  ('gerencia_general', 'accion.torre_logistica.ver'),
  ('gerencia_general', 'pagina.torre_logistica')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
