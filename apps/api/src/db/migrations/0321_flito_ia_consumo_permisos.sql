-- Épica #14548 (ADR-0051) — Permisos del VISOR DE SOLO LECTURA de los registros de consumo de IA (bloque A).
--
-- Siembra el ítem «Consumo de IA» (Administración, orden 70) y sus tres acciones: ver los registros
-- (`accion.ia_consumo.ver`, de lectura), exportarlos en CSV (`accion.ia_consumo.exportar`, NO es lectura) y ver el
-- contenido de un registro (`accion.ia_consumo.ver_contenido`, NO es lectura: deja rastro). Reparto: solo `admin`
-- (ADR-0022, D4); el resto de roles lo recibe desde el panel de permisos.
-- Solo INSERT idempotentes (`ON CONFLICT`) en `permisos_funciones` y `permisos_rol_funcion`. Las tablas `ia_consumo_*`
-- no se tocan (D2). Las operaciones nacen en el árbol (no se siembran). El runner aplica este fichero en una
-- transacción (`migrations/README.md`): no abre ninguna propia.

-- ÁRBOL GENERADO (inicio)
-- 1 ítems (nivel 2) y 3 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol ia-consumo
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.ia_consumo', 'administracion', 'Consumo de IA', 'Entrar a la pantalla «Consumo de IA».', 'pagina', 'menu.administracion', '2', '70'),
  ('accion.ia_consumo.ver', 'administracion', 'Ver los registros de consumo de IA', 'Consultar la lista y el detalle de los registros de consumo de IA, sin su contenido.', 'accion', 'pagina.ia_consumo', '3', '10'),
  ('accion.ia_consumo.exportar', 'administracion', 'Exportar los registros de consumo de IA', 'Descargar en CSV los metadatos de los registros de consumo de IA, sin su contenido.', 'accion', 'pagina.ia_consumo', '3', '20'),
  ('accion.ia_consumo.ver_contenido', 'administracion', 'Ver el contenido de un registro de consumo de IA', 'Leer el prompt y la respuesta de un registro, con un motivo, dejando rastro en la auditoría.', 'accion', 'pagina.ia_consumo', '3', '30')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe las tres acciones y su cadena (ADR-0022, D4). Ningún otro rol: el resto lo concede el panel de
-- permisos. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.ia_consumo.exportar'),
  ('admin', 'accion.ia_consumo.ver'),
  ('admin', 'accion.ia_consumo.ver_contenido'),
  ('admin', 'menu.administracion'),
  ('admin', 'pagina.ia_consumo')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)
