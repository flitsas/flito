-- Torre de Control Gerencial (Épica #14590, ADR-0047, bloque B1) — permisos del DETALLE UNIVERSAL.
--
-- Siembra el ítem «Torre · Detalle» (General) y sus dos acciones: ver los registros de una cifra
-- (`torre.detalle.ver`, lectura) y exportarlos (`torre.detalle.exportar`, NO es lectura: el auditor no descarga).
-- Reparto literal de `REPARTO_TORRE` (`apps/api/src/modules/permisos/arbol/acciones-torre.ts`): admin, financiera,
-- gerencia_comercial y gerencia_general ven y exportan; auditor solo ve. La 0303 (ya aplicada) no se toca.
-- Idempotente: `ON CONFLICT` en las dos tablas. Las operaciones nacen en el árbol (no se siembran).

-- ÁRBOL GENERADO (inicio)
-- 1 ítems (nivel 2) y 2 acciones (nivel 3). Generado: no editar a mano.
-- Generado por `sqlSiembraTorre(catalogo, 'detalle')` (`arbol/sql-torre.ts`).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.torre_detalle', 'torre_de_control', 'Torre · Detalle', 'Entrar a la pantalla «Torre · Detalle».', 'pagina', 'menu.general', '2', '80'),
  ('accion.torre_detalle.ver', 'torre_de_control', 'Ver los registros de una cifra', 'Abrir la lista de registros (placa, compañía y estado) detrás de una cifra de la Torre.', 'accion', 'pagina.torre_detalle', '3', '10'),
  ('accion.torre_detalle.exportar', 'torre_de_control', 'Exportar los registros de una cifra', 'Descargar en Excel los registros detrás de una cifra de la Torre.', 'accion', 'pagina.torre_detalle', '3', '20')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe las dos acciones y el ítem (ADR-0022); financiera, auditor y las dos gerencias, su reparto
-- literal (`REPARTO_TORRE`: el auditor NO exporta). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.torre_detalle.exportar'),
  ('admin', 'accion.torre_detalle.ver'),
  ('admin', 'pagina.torre_detalle'),
  ('auditor', 'accion.torre_detalle.ver'),
  ('auditor', 'pagina.torre_detalle'),
  ('financiera', 'accion.torre_detalle.exportar'),
  ('financiera', 'accion.torre_detalle.ver'),
  ('financiera', 'pagina.torre_detalle'),
  ('gerencia_comercial', 'accion.torre_detalle.exportar'),
  ('gerencia_comercial', 'accion.torre_detalle.ver'),
  ('gerencia_comercial', 'pagina.torre_detalle'),
  ('gerencia_general', 'accion.torre_detalle.exportar'),
  ('gerencia_general', 'accion.torre_detalle.ver'),
  ('gerencia_general', 'pagina.torre_detalle')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
