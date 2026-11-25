-- 0316_flito_menu_areas_proximamente.sql
--
-- Épica #14678 «[ Menú ] Organizar FLITO por áreas de la empresa» (ADR-0048, enmienda 1), PR 4: las cinco áreas
-- sin pantallas. Diseño: docs/arquitectura/epica-14678-menu-por-areas.md §PR 4 (4.4). Autor: equipo FLITO.
-- Antecedente: 0315 (paso 1, mismo upsert). Ninguna ruta cambia y ninguna página se mueve.
--
-- En este orden:
--   1. Siembra las cinco opciones del menú que aún no tienen pantallas: Comercial, Diseño, Tecnología,
--      Infraestructura y Producto (nivel 1, sin padre, orden 3-7, el de `SECTION_ORDER`). Si un rol tiene marcada una,
--      el menú pinta el área con el aviso «Próximamente»; no da acceso a ninguna página (no cuelga ninguna de ellas).
--   2. Gerencial y Kyverum pasan detrás de las cinco (orden 8 y 9). Va en un UPDATE aparte, no en el INSERT, para
--      que el parser de `permisos-siembra-admin.test.ts` vea como sembrados solo los cinco nuevos.
-- DESVIACIÓN DECLARADA de ADR-0022 («admin recibe lo sembrado») y de ADR-0048 §9: los cinco se siembran SIN MARCA
-- para ningún rol, `admin` incluido (decisión de David del 2026-11-25, enmienda 1 de ADR-0048). Excepción con nombre
-- en `permisos-siembra-admin.test.ts` (`SIN_ADMIN_POR_DECISION_14678`); la regla sigue viva para el resto.
-- Sin `permisos_rol_funcion` ni `permisos_usuario_funcion`: pérdidas = 0 y ganancias = 0 (los códigos son nuevos y el
-- `orden` de `permisos_funciones` no entra en el resolutor). Sin fila en `permisos_auditoria`. Sin BEGIN/COMMIT (el
-- runner envuelve el archivo).
-- Idempotente: upsert y UPDATE con `IS DISTINCT FROM`; la 2.ª corrida no inserta ni actualiza filas.
-- Rollback: docs/arquitectura/epica-14678-0316-rollback.sql (va ANTES que el de la 0315 si se revierten las dos).
-- La imagen anterior arranca contra una base con esta migración: `verificarCatalogoAlArrancar` registra que «sobran»
-- los cinco y `server.ts` no tumba el proceso (mismo caso que la 0315).
-- No se aplica sola.

-- 1. Las cinco áreas sin pantallas (nivel 1, sin padre), orden 3-7. Sin marca para ningún rol, admin incluido.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, nivel, orden) VALUES
  ('menu.comercial', 'comercial', 'Comercial', 'Ver la sección «Comercial» del menú.', 'elemento', '1', '3'),
  ('menu.diseno', 'diseno', 'Diseño', 'Ver la sección «Diseño» del menú.', 'elemento', '1', '4'),
  ('menu.tecnologia', 'tecnologia', 'Tecnología', 'Ver la sección «Tecnología» del menú.', 'elemento', '1', '5'),
  ('menu.infraestructura', 'infraestructura', 'Infraestructura', 'Ver la sección «Infraestructura» del menú.', 'elemento', '1', '6'),
  ('menu.producto', 'producto', 'Producto', 'Ver la sección «Producto» del menú.', 'elemento', '1', '7')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio, descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion, permisos_funciones.tipo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion, EXCLUDED.tipo, EXCLUDED.nivel, EXCLUDED.orden);

-- 2. Gerencial y Kyverum pasan detrás de las cinco (orden del menú = SECTION_ORDER).
UPDATE permisos_funciones AS f SET orden = v.orden
  FROM (VALUES ('menu.gerencial', 8), ('menu.kyverum', 9)) AS v(codigo, orden)
 WHERE f.codigo = v.codigo AND f.orden IS DISTINCT FROM v.orden;
