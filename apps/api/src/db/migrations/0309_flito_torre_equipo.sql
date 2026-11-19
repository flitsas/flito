-- Torre de Control Gerencial (Épica #14590, bloque B5) — Operativa › EQUIPO: la acción «Ver la operación del equipo»
-- (`torre.equipo.ver`).
--
-- NÚMERO PROVISIONAL: al integrar la pila con develop se renumera (como la 0306, la 0307 y la 0308).
--
-- La acción cuelga del ítem que ya existe `pagina.torre_operativa` (Equipo es una pestaña de Operativa, no una página:
-- no estrena PageSlug) y se reparte SOLO a `admin` y `gerencia_general` (decisión del humano del 2026-11-19), con el
-- reparto literal de `REPARTO_TORRE` (`apps/api/src/modules/permisos/arbol/acciones-torre.ts`). El auditor, que ve
-- Operativa, NO la recibe. La 0303, la 0306, la 0307 y la 0308 no se tocan.
-- Idempotente: `ON CONFLICT` en las dos tablas. La operación nace en el árbol (no se siembra). Sin umbral nuevo: el ANS
-- usa `horas_soat_impuesto_sin_soporte` y `dias_traslado_abierto`, que ya existen.
-- Índices: ninguno. Los candidatos del diseño (§12 B5) se midieron con EXPLAIN y no hacen falta (ver el PR).

-- ── Permisos ────────────────────────────────────────────────────────────────────────────────────────
-- ÁRBOL GENERADO (inicio)
-- 0 ítems (nivel 2) y 1 acciones (nivel 3). Generado: no editar a mano.
-- Generado por `sqlSiembraTorre(catalogo, 'equipo')` (`arbol/sql-torre.ts`).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.torre_operativa.ver_equipo', 'torre_de_control', 'Ver la operación del equipo', 'Consultar las gestiones, la carga abierta y los pendientes fuera de ANS de cada funcionario.', 'accion', 'pagina.torre_operativa', '3', '20')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe la acción (ADR-0022) y gerencia_general, su reparto literal (`REPARTO_TORRE`; decisión del
-- humano: nadie más ve el equipo). El ítem `pagina.torre_operativa` ya lo tienen los dos (la 0303).
-- JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.torre_operativa.ver_equipo'),
  ('gerencia_general', 'accion.torre_operativa.ver_equipo')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
