-- 0240_permisos_sueltos_a_su_item.sql
--
-- HU #13588 (Feature #13416, Épica #13411) — Ningún permiso suelto fuera del menú: las 5 operaciones TRANSVERSALES
-- de la #13429 (P-29) pasan a concederse con su ítem, sin casilla propia. Decisión de David del 2026-10-15
-- (P-35/P-36/P-37: «si un permiso está en varios módulos, debería aparecer en cada uno»).
-- Autor: equipo FLITO. Antecedente: 0239 (la anterior; reparto del árbol de tres niveles).
--
-- Qué concede cada ítem desde aquí (lo expande el resolutor, `arbol/expansion.ts`; las guardas no cambian):
--   · `vehicles.vehiculos.consultar` → Vehículos, SOAT (antiguo), Flota y Trámite Digital.
--   · `runt.persona.consultar`, `runt.cedula.leer`, `integraciones.fasecolda.buscar` → Trámite Digital.
--   · `rum.resumen.ver` → «Rendimiento», ítem NUEVO de Administración (`pagina.admin_rendimiento`, /admin/rendimiento).
--
-- En este orden:
--   1. Siembra el ítem «Rendimiento» (nivel 2, cuelga de `menu.administracion`, orden 60: tras Google Drive).
--   2. Roles: quien tiene hoy `rum.resumen.ver` recibe el ítem y su elemento (AC8: conserva el acceso); y `admin`,
--      como toda página sembrada (HU #13424), por `JOIN permisos_roles` (un ambiente sin el rol recibe 0 filas).
--   3. Usuarios: el `conceder` de `rum.resumen.ver` concede el ítem y el elemento que su rol no le da; el
--      `revocar` de `rum.resumen.ver` sobre un rol que la tiene pasa a `revocar` del ítem (sigue sin verlo).
--      3c (fallo cerrado, simétrico a 3b): el `revocar` de una de las 4 de ítems antiguos pasa a `revocar` de cada
--      ítem que ahora la concede y que el usuario tiene marcado por su rol o por un `conceder` propio (el
--      `conceder` se convierte). El usuario pierde la pantalla y NO recupera el dato (RUNT/Fasecolda/vehículos).
--   4. Las 5 operaciones dejan de concederse directo: fuera sus marcas (rol y usuario) y su fila del catálogo.
--      Quien tenía una de las 4 de ítems antiguos SIN el ítem la pierde, y quien tenía un `revocar` pierde la
--      pantalla (3c): pérdidas declaradas en el reporte en seco (`npm run permisos:en-seco -w apps/api -- --hu
--      13588`, que termina con exit ≠ 0 si hay alguna); por AC7 requieren la aprobación de David antes de aplicar
--      en cada ambiente.
-- Sin literales de rol: todo reparto es `INSERT … SELECT` desde filas existentes; el único rol nombrado es `admin`
-- (paso 2b) y va por `JOIN permisos_roles`, la forma de la 0227 corregida y de la 0239 (el CD de DEV cayó el
-- 2026-10-08 por un literal de rol SIN ese JOIN: FK a permisos_roles). Sin unaccent(). Sin fila en `permisos_auditoria` (su CHECK de
-- `origen` no admite 'migracion', como en la 0233/0237/0239).
-- Idempotente: upsert con `IS DISTINCT FROM`; los pasos 2 y 3 parten de filas de las 5 operaciones, que el paso 4 borra,
-- así que la 2.ª corrida no reparte nada; la marca de `admin` (2b) es `ON CONFLICT DO NOTHING`, como en la 0239.

-- 1. El ítem «Rendimiento».
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.admin_rendimiento', 'administracion', 'Rendimiento', 'Entrar a la pantalla «Rendimiento».', 'pagina', 'menu.administracion', '2', '60')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio, descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo, nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion, permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion, EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- 2. Roles (AC8): el ítem y su elemento a cada rol que hoy tiene el resumen RUM.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES ('pagina.admin_rendimiento'), ('menu.administracion')) AS v(fn)
 WHERE o.funcion_codigo = 'rum.resumen.ver'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- 2b. `admin` recibe la página sembrada y su elemento (HU #13424: toda siembra se le marca a `admin`).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'pagina.admin_rendimiento'), ('admin', 'menu.administracion')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- 3a. Usuarios: `conceder` de `rum.resumen.ver` → `conceder` del ítem y del elemento que su rol no le da y que el
--     usuario no tenga ya en una fila propia (si lo tiene revocado, la revocación explícita gana).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT DISTINCT k.user_id, v.fn, 'conceder'
  FROM permisos_usuario_funcion k
  JOIN users u ON u.id = k.user_id
 CROSS JOIN (VALUES ('pagina.admin_rendimiento'), ('menu.administracion')) AS v(fn)
 WHERE k.funcion_codigo = 'rum.resumen.ver' AND k.efecto = 'conceder'
   AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion rx WHERE rx.rol_codigo = u.role AND rx.funcion_codigo = v.fn)
   AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = k.user_id AND x.funcion_codigo = v.fn)
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- 3b. Usuarios: `revocar` de `rum.resumen.ver` cuyo rol la tenía (y ahora recibe el ítem) → `revocar` del ítem.
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT k.user_id, 'pagina.admin_rendimiento', 'revocar'
  FROM permisos_usuario_funcion k
  JOIN users u ON u.id = k.user_id
 WHERE k.funcion_codigo = 'rum.resumen.ver' AND k.efecto = 'revocar'
   AND EXISTS (SELECT 1 FROM permisos_rol_funcion rx WHERE rx.rol_codigo = u.role AND rx.funcion_codigo = 'rum.resumen.ver')
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- 3c. Usuarios: `revocar` de una de las 4 de ítems antiguos → `revocar` de cada ítem que ahora la concede y que el
--     usuario tiene marcado por su rol o por un `conceder` propio (que se convierte en `revocar`). Pares operación →
--     ítem: `OPERACIONES_INCORPORADAS_13588` (acciones-legado.ts). Sin el ítem no hay nada que revocar.
DROP TABLE IF EXISTS tmp_sueltas_13588;
CREATE TEMP TABLE tmp_sueltas_13588 (fn varchar(80) NOT NULL, item varchar(80) NOT NULL, PRIMARY KEY (fn, item));
INSERT INTO tmp_sueltas_13588 (fn, item) VALUES
  ('integraciones.fasecolda.buscar', 'pagina.tramite'),
  ('runt.cedula.leer', 'pagina.tramite'),
  ('runt.persona.consultar', 'pagina.tramite'),
  ('vehicles.vehiculos.consultar', 'pagina.fleet'),
  ('vehicles.vehiculos.consultar', 'pagina.soat'),
  ('vehicles.vehiculos.consultar', 'pagina.tramite'),
  ('vehicles.vehiculos.consultar', 'pagina.vehicles');
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT DISTINCT k.user_id, s.item, 'revocar'
  FROM permisos_usuario_funcion k
  JOIN users u ON u.id = k.user_id
  JOIN tmp_sueltas_13588 s ON s.fn = k.funcion_codigo
 WHERE k.efecto = 'revocar'
   AND (EXISTS (SELECT 1 FROM permisos_rol_funcion rx WHERE rx.rol_codigo = u.role AND rx.funcion_codigo = s.item)
        OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = k.user_id AND c.funcion_codigo = s.item AND c.efecto = 'conceder'))
ON CONFLICT (user_id, funcion_codigo) DO UPDATE SET efecto = 'revocar'
  WHERE permisos_usuario_funcion.efecto IS DISTINCT FROM 'revocar';
DROP TABLE tmp_sueltas_13588;

-- 4. Las 5 dejan de concederse directo (AC3: una fila heredada ya no da nada; el resolutor las niega por fallo
--    cerrado y el catálogo del código no las emite): fuera sus marcas y su fila.
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN ('integraciones.fasecolda.buscar', 'rum.resumen.ver', 'runt.cedula.leer', 'runt.persona.consultar', 'vehicles.vehiculos.consultar');
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('integraciones.fasecolda.buscar', 'rum.resumen.ver', 'runt.cedula.leer', 'runt.persona.consultar', 'vehicles.vehiculos.consultar');
DELETE FROM permisos_funciones WHERE codigo IN ('integraciones.fasecolda.buscar', 'rum.resumen.ver', 'runt.cedula.leer', 'runt.persona.consultar', 'vehicles.vehiculos.consultar');
