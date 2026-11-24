-- 0315_flito_menu_por_areas.sql
--
-- Épica #14678 «[ Menú ] Organizar FLITO por áreas de la empresa» (ADR-0048, expand → contract). Diseño:
-- docs/arquitectura/epica-14678-menu-por-areas.md. Autor: equipo FLITO. Antecedentes: 0238/0239 (cadena del árbol),
-- 0240 (forma del upsert y de la marca a `admin`), 0303 (Torre). Ninguna ruta cambia: cambia de qué opción del menú
-- (`menu.*`) cuelga cada página.
--
-- En este orden:
--   1. Siembra las cuatro opciones nuevas del menú: Operaciones, Financiera, Gerencial y Kyverum (nivel 1).
--      `menu.administracion` se REUTILIZA. Los ocho elementos viejos (gestion, transito, flota, mantenimiento, pesv,
--      rndc, laft, finanzas) quedan DEPRECADOS en el código (`deprecado` en el árbol): no se borran ni se les quitan
--      las marcas; quedan sin hijos. `menu.general` sigue vivo (Dr. Flit), fuera de las áreas.
--   2. El mapa página → elemento nuevo (`tmp_menu_areas_14678`, = `MENU_POR_AREAS` de `arbol/menu-por-areas.ts`). El
--      «antes» que usan los pasos siguientes es el padre REAL de la base, no la columna `viejo` (que documenta el árbol
--      de develop): así una base con deriva tampoco gana ni pierde.
--   3. Foto de ANTES (páginas efectivas por rol y por usuario) de las páginas que se mueven y de las que ya cuelgan
--      de un elemento que gana hijos (`menu.administracion` recibe Organismos STT). Efectiva = marcada y con su
--      elemento marcado; en el usuario, sobre (R ∪ C) \ V, como el resolutor (`arbol/expansion.ts`).
--   4. Roles (R-R1): el elemento nuevo a cada rol que tenía la página efectiva. (R-R2, ADR-0022) `admin` recibe los
--      cuatro elementos sembrados, por `JOIN permisos_roles` como en la 0240 (paso 2b).
--   5. Re-padre (y orden) de las 75 páginas del mapa.
--   6. Ganancias = 0 en el rol: una página marcada que NO era efectiva (su elemento viejo no estaba marcado: marca
--      dormida) y cuyo elemento nuevo sí lo está tras el paso 4 despertaría. Se borra esa marca dormida: no daba nada
--      antes y sigue sin darlo. Lo que el rol veía no cambia.
--      Igual si lo marcado ahora es el elemento de ANTES (N1: `menu.administracion`, viejo y nuevo a la vez).
--   7. Pérdidas = 0 en el usuario (R-U1): si una página efectiva antes ya no lo es, se le concede la página (si el
--      paso 6 se la quitó al rol y él la veía por un `conceder` del elemento viejo) y el elemento nuevo que le falte.
--      Si el usuario tiene `revocar` del elemento nuevo, NO se toca: pérdida que la migración no evita (caso 3.6
--      del diseño, consulta D), declarada para el PO.
--   8. Ganancias = 0 en el usuario (R-U2): una página efectiva ahora que antes no lo era recibe `revocar` (un
--      `conceder` de esa página pasa a `revocar`); con la página caen sus acciones (la cadena).
--      8b: lo mismo contra el elemento de ANTES (N1), para que tampoco haya ganancia con el árbol viejo.
-- Sin literales de rol: todo reparto es `INSERT … SELECT` desde filas existentes; el único rol nombrado es `admin`
-- (paso 4b), por `JOIN permisos_roles`. Sin fila en `permisos_auditoria` (su CHECK de `origen` no admite
-- 'migracion', como en la 0239/0240). Sin BEGIN/COMMIT (el runner envuelve el archivo).
-- Idempotente: upsert con `IS DISTINCT FROM`; los pasos 3-8 parten de las páginas cuyo padre en la base aún no es
-- el nuevo (`tmp_mov_14678`), que el paso 5 deja vacío: la 2.ª corrida no reparte ni borra nada.
-- Rollback (verificado en código; detalle y SQL en docs/arquitectura/epica-14678-0315-rollback.sql):
--   · El PROCESO de la API anterior sí arranca contra esta base: `verificarCatalogoAlArrancar` solo registra «CATÁLOGO
--     DE PERMISOS INCOHERENTE» (los cuatro `menu.*` nuevos sobran) y `server.ts` (l. 74-76) no tumba el proceso.
--   · En GitOps, el initContainer `db-apply` de la imagen anterior ve esta migración en el ledger sin su archivo
--     (huérfana). HOY registra `[drift] huerfana` y continúa (`DRIFT_ABORTA=false`, `src/scripts/db-apply.ts`,
--     ADR-0035 §A); abortará con EXIT_DERIVA cuando el PR 2 de ADR-0035 retire esa constante. En los dos casos el
--     inverso corre ANTES de revertir la imagen (borra su fila del ledger), con `psql -v ON_ERROR_STOP=1`.
--     En esa ventana los pods nuevos, que siguen corriendo, pierden lo que solo daban los `menu.*` nuevos.
--   · El inverso restaura lo VISIBLE, no las filas: no repone las marcas dormidas borradas en el paso 6 ni deshace los
--     `conceder`/`revocar` de los pasos 7 y 8 (con el árbol viejo ninguno cambia lo efectivo).
--   · Con el arreglo N1 (pasos 6 y 8b) tampoco se gana nada con el árbol viejo.
-- No se aplica sola.

-- 1. Las cuatro opciones nuevas del menú (nivel 1, sin padre). Orden 1-4: van antes de todo (los deprecados conservan el suyo).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, nivel, orden) VALUES
  ('menu.operaciones', 'operaciones', 'Operaciones', 'Ver la sección «Operaciones» del menú.', 'elemento', '1', '1'),
  ('menu.financiera', 'financiera', 'Financiera', 'Ver la sección «Financiera» del menú.', 'elemento', '1', '2'),
  ('menu.gerencial', 'gerencial', 'Gerencial', 'Ver la sección «Gerencial» del menú.', 'elemento', '1', '3'),
  ('menu.kyverum', 'kyverum', 'Kyverum', 'Ver la sección «Kyverum» del menú.', 'elemento', '1', '4')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio, descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion, permisos_funciones.tipo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion, EXCLUDED.tipo, EXCLUDED.nivel, EXCLUDED.orden);

-- 2. El mapa: 75 páginas (11 a Operaciones, 10 a Financiera, 10 a Gerencial, 43 a Kyverum, 1 a Administración).
DROP TABLE IF EXISTS tmp_menu_areas_14678;
CREATE TEMP TABLE tmp_menu_areas_14678 (pagina varchar(80) PRIMARY KEY, viejo varchar(80) NOT NULL, nuevo varchar(80) NOT NULL, orden integer NOT NULL);
INSERT INTO tmp_menu_areas_14678 (pagina, viejo, nuevo, orden) VALUES
  ('pagina.clients', 'menu.gestion', 'menu.operaciones', '90'),
  ('pagina.dashboard', 'menu.general', 'menu.gerencial', '10'),
  ('pagina.finanzas_gastos_diarios', 'menu.finanzas', 'menu.financiera', '20'),
  ('pagina.finanzas_reporte_costos', 'menu.finanzas', 'menu.financiera', '10'),
  ('pagina.fleet', 'menu.flota', 'menu.kyverum', '20'),
  ('pagina.flito_bitacora', 'menu.gestion', 'menu.operaciones', '100'),
  ('pagina.flito_bolsas', 'menu.finanzas', 'menu.financiera', '30'),
  ('pagina.flito_comparendos', 'menu.gestion', 'menu.operaciones', '80'),
  ('pagina.flito_comprobantes', 'menu.finanzas', 'menu.financiera', '60'),
  ('pagina.flito_conciliacion', 'menu.finanzas', 'menu.financiera', '70'),
  ('pagina.flito_derechos', 'menu.gestion', 'menu.operaciones', '40'),
  ('pagina.flito_impuestos', 'menu.gestion', 'menu.operaciones', '30'),
  ('pagina.flito_logistica', 'menu.gestion', 'menu.operaciones', '60'),
  ('pagina.flito_logistica_ruta', 'menu.gestion', 'menu.operaciones', '70'),
  ('pagina.flito_revisiones', 'menu.gestion', 'menu.operaciones', '50'),
  ('pagina.flito_servicios_adicionales', 'menu.finanzas', 'menu.financiera', '50'),
  ('pagina.flito_soat', 'menu.gestion', 'menu.operaciones', '20'),
  ('pagina.flito_tarifas', 'menu.finanzas', 'menu.financiera', '40'),
  ('pagina.flito_tramites', 'menu.gestion', 'menu.operaciones', '10'),
  ('pagina.laft', 'menu.laft', 'menu.kyverum', '340'),
  ('pagina.laft_audit_plan', 'menu.laft', 'menu.kyverum', '390'),
  ('pagina.laft_dashboard', 'menu.laft', 'menu.kyverum', '400'),
  ('pagina.laft_manual', 'menu.laft', 'menu.kyverum', '370'),
  ('pagina.laft_oficial', 'menu.laft', 'menu.kyverum', '380'),
  ('pagina.laft_trainings', 'menu.laft', 'menu.kyverum', '360'),
  ('pagina.laft_unusual', 'menu.laft', 'menu.kyverum', '350'),
  ('pagina.maintenance', 'menu.mantenimiento', 'menu.kyverum', '60'),
  ('pagina.maintenance_indicadores', 'menu.mantenimiento', 'menu.kyverum', '50'),
  ('pagina.maintenance_inicio', 'menu.mantenimiento', 'menu.kyverum', '30'),
  ('pagina.maintenance_ordenes', 'menu.mantenimiento', 'menu.kyverum', '40'),
  ('pagina.pesv', 'menu.pesv', 'menu.kyverum', '70'),
  ('pagina.pesv_alcoholimetria', 'menu.pesv', 'menu.kyverum', '130'),
  ('pagina.pesv_auditorias', 'menu.pesv', 'menu.kyverum', '220'),
  ('pagina.pesv_capacitaciones', 'menu.pesv', 'menu.kyverum', '90'),
  ('pagina.pesv_checklists', 'menu.pesv', 'menu.kyverum', '120'),
  ('pagina.pesv_comite', 'menu.pesv', 'menu.kyverum', '170'),
  ('pagina.pesv_comunicaciones', 'menu.pesv', 'menu.kyverum', '230'),
  ('pagina.pesv_conductores', 'menu.pesv', 'menu.kyverum', '80'),
  ('pagina.pesv_contratistas', 'menu.pesv', 'menu.kyverum', '240'),
  ('pagina.pesv_diagnostico', 'menu.pesv', 'menu.kyverum', '190'),
  ('pagina.pesv_emergencias', 'menu.pesv', 'menu.kyverum', '140'),
  ('pagina.pesv_incidentes', 'menu.pesv', 'menu.kyverum', '100'),
  ('pagina.pesv_indicadores_operacion', 'menu.pesv', 'menu.kyverum', '150'),
  ('pagina.pesv_jornadas', 'menu.pesv', 'menu.kyverum', '250'),
  ('pagina.pesv_mi_jornada', 'menu.pesv', 'menu.kyverum', '260'),
  ('pagina.pesv_normativa', 'menu.pesv', 'menu.kyverum', '300'),
  ('pagina.pesv_pernocta', 'menu.pesv', 'menu.kyverum', '280'),
  ('pagina.pesv_plan', 'menu.pesv', 'menu.kyverum', '180'),
  ('pagina.pesv_politica', 'menu.pesv', 'menu.kyverum', '160'),
  ('pagina.pesv_raci', 'menu.pesv', 'menu.kyverum', '290'),
  ('pagina.pesv_reportar_incidente', 'menu.pesv', 'menu.kyverum', '210'),
  ('pagina.pesv_retencion', 'menu.pesv', 'menu.kyverum', '310'),
  ('pagina.pesv_rutas', 'menu.pesv', 'menu.kyverum', '270'),
  ('pagina.pesv_siniestralidad', 'menu.pesv', 'menu.kyverum', '110'),
  ('pagina.pesv_tablero_ejecutivo', 'menu.pesv', 'menu.kyverum', '200'),
  ('pagina.rndc', 'menu.rndc', 'menu.kyverum', '320'),
  ('pagina.rndc_admin', 'menu.rndc', 'menu.kyverum', '330'),
  ('pagina.siigo_credenciales', 'menu.administracion', 'menu.financiera', '100'),
  ('pagina.siigo_operacion', 'menu.finanzas', 'menu.financiera', '90'),
  ('pagina.siigo_parametrizacion', 'menu.finanzas', 'menu.financiera', '80'),
  ('pagina.soat', 'menu.gestion', 'menu.kyverum', '420'),
  ('pagina.tax_reader', 'menu.gestion', 'menu.kyverum', '430'),
  ('pagina.torre_360', 'menu.general', 'menu.gerencial', '30'),
  ('pagina.torre_comercial', 'menu.general', 'menu.gerencial', '40'),
  ('pagina.torre_detalle', 'menu.general', 'menu.gerencial', '80'),
  ('pagina.torre_explorador', 'menu.general', 'menu.gerencial', '70'),
  ('pagina.torre_financiera', 'menu.general', 'menu.gerencial', '60'),
  ('pagina.torre_logistica', 'menu.general', 'menu.gerencial', '100'),
  ('pagina.torre_operativa', 'menu.general', 'menu.gerencial', '50'),
  ('pagina.torre_productos', 'menu.general', 'menu.gerencial', '90'),
  ('pagina.torre_umbrales', 'menu.administracion', 'menu.gerencial', '110'),
  ('pagina.tramite', 'menu.gestion', 'menu.kyverum', '410'),
  ('pagina.transito', 'menu.transito', 'menu.kyverum', '10'),
  ('pagina.transito_organismos', 'menu.transito', 'menu.administracion', '80'),
  ('pagina.vehicles', 'menu.gestion', 'menu.operaciones', '110');

-- 3a. Lo que se mueve en ESTA base (padre real distinto del nuevo) y las páginas afectadas, con su padre antes y después.
DROP TABLE IF EXISTS tmp_mov_14678;
CREATE TEMP TABLE tmp_mov_14678 AS
SELECT m.pagina, m.nuevo
  FROM tmp_menu_areas_14678 m JOIN permisos_funciones f ON f.codigo = m.pagina
 WHERE f.padre_codigo IS DISTINCT FROM m.nuevo;
DROP TABLE IF EXISTS tmp_pag_14678;
CREATE TEMP TABLE tmp_pag_14678 AS
SELECT f.codigo AS pagina, f.padre_codigo AS antes, COALESCE(mv.nuevo, f.padre_codigo) AS despues
  FROM permisos_funciones f LEFT JOIN tmp_mov_14678 mv ON mv.pagina = f.codigo
 WHERE f.tipo = 'pagina' AND f.padre_codigo IS NOT NULL
   AND (mv.pagina IS NOT NULL OR f.padre_codigo IN (SELECT nuevo FROM tmp_mov_14678));

-- 3b. M del usuario = (R ∪ C) \ V sobre los códigos que importan aquí (las páginas afectadas y sus dos elementos).
DROP VIEW IF EXISTS tmp_m_usuario_14678;
CREATE TEMP VIEW tmp_m_usuario_14678 AS
  (SELECT u.id AS user_id, r.funcion_codigo AS codigo
     FROM users u JOIN permisos_rol_funcion r ON r.rol_codigo = u.role
    WHERE r.funcion_codigo IN (SELECT pagina FROM tmp_pag_14678 UNION SELECT antes FROM tmp_pag_14678 UNION SELECT despues FROM tmp_pag_14678)
   UNION
   SELECT k.user_id, k.funcion_codigo FROM permisos_usuario_funcion k
    WHERE k.efecto = 'conceder'
      AND k.funcion_codigo IN (SELECT pagina FROM tmp_pag_14678 UNION SELECT antes FROM tmp_pag_14678 UNION SELECT despues FROM tmp_pag_14678))
  EXCEPT
  SELECT k.user_id, k.funcion_codigo FROM permisos_usuario_funcion k WHERE k.efecto = 'revocar';

-- 3c. Foto de ANTES: páginas efectivas por rol y por usuario.
DROP TABLE IF EXISTS tmp_ef_rol_antes_14678;
CREATE TEMP TABLE tmp_ef_rol_antes_14678 AS
SELECT p.rol_codigo AS rol, t.pagina
  FROM tmp_pag_14678 t JOIN permisos_rol_funcion p ON p.funcion_codigo = t.pagina
 WHERE EXISTS (SELECT 1 FROM permisos_rol_funcion e WHERE e.rol_codigo = p.rol_codigo AND e.funcion_codigo = t.antes);
DROP TABLE IF EXISTS tmp_m_antes_14678;
CREATE TEMP TABLE tmp_m_antes_14678 AS SELECT user_id, codigo FROM tmp_m_usuario_14678;
DROP TABLE IF EXISTS tmp_ef_usr_antes_14678;
CREATE TEMP TABLE tmp_ef_usr_antes_14678 AS
SELECT m.user_id, t.pagina, t.despues
  FROM tmp_pag_14678 t
  JOIN tmp_m_antes_14678 m ON m.codigo = t.pagina
  JOIN tmp_m_antes_14678 e ON e.user_id = m.user_id AND e.codigo = t.antes;

-- 4a. Roles (R-R1): el elemento nuevo a cada rol que tenía la página efectiva.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT DISTINCT a.rol, t.despues
  FROM tmp_ef_rol_antes_14678 a JOIN tmp_pag_14678 t ON t.pagina = a.pagina
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- 4b. `admin` recibe los elementos sembrados (ADR-0022, como el paso 2b de la 0240).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'menu.operaciones'), ('admin', 'menu.financiera'), ('admin', 'menu.gerencial'), ('admin', 'menu.kyverum')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- 5. Re-padre y orden de las páginas del mapa.
UPDATE permisos_funciones AS f
   SET padre_codigo = m.nuevo, orden = m.orden
  FROM tmp_menu_areas_14678 m
 WHERE f.codigo = m.pagina
   AND (f.padre_codigo, f.orden) IS DISTINCT FROM (m.nuevo, m.orden);

-- 6. Roles (ganancias = 0): fuera la marca dormida que el elemento nuevo despertaría. También con el elemento de ANTES
--    marcado ahora (db-review N1): `menu.administracion` es viejo y nuevo a la vez; quien lo recibe en 4a por Organismos
--    STT y tenía dormida Siigo credenciales o Torre · Umbrales (que salen de Administración) las ganaría con el árbol
--    viejo (código anterior o inverso aplicado). Solo toca marcas que ya eran dormidas.
DELETE FROM permisos_rol_funcion p
 USING tmp_pag_14678 t
 WHERE p.funcion_codigo = t.pagina
   AND (EXISTS (SELECT 1 FROM permisos_rol_funcion e WHERE e.rol_codigo = p.rol_codigo AND e.funcion_codigo = t.despues)
        OR EXISTS (SELECT 1 FROM permisos_rol_funcion e WHERE e.rol_codigo = p.rol_codigo AND e.funcion_codigo = t.antes))
   AND NOT EXISTS (SELECT 1 FROM tmp_ef_rol_antes_14678 a WHERE a.rol = p.rol_codigo AND a.pagina = t.pagina);

-- 7. Usuarios (pérdidas = 0): la página y el elemento nuevo que le falten (salvo elemento revocado: caso 3.6).
DROP TABLE IF EXISTS tmp_m_despues_14678;
CREATE TEMP TABLE tmp_m_despues_14678 AS SELECT user_id, codigo FROM tmp_m_usuario_14678;
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT a.user_id, a.pagina, 'conceder'
  FROM tmp_ef_usr_antes_14678 a
 WHERE NOT EXISTS (SELECT 1 FROM tmp_m_despues_14678 m WHERE m.user_id = a.user_id AND m.codigo = a.pagina)
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT DISTINCT a.user_id, a.despues, 'conceder'
  FROM tmp_ef_usr_antes_14678 a
 WHERE NOT EXISTS (SELECT 1 FROM tmp_m_despues_14678 m WHERE m.user_id = a.user_id AND m.codigo = a.despues)
   AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion k WHERE k.user_id = a.user_id AND k.funcion_codigo = a.despues AND k.efecto = 'revocar')
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- 8. Usuarios (ganancias = 0): `revocar` de la página que ahora sería efectiva y antes no lo era.
DROP TABLE IF EXISTS tmp_m_final_14678;
CREATE TEMP TABLE tmp_m_final_14678 AS SELECT user_id, codigo FROM tmp_m_usuario_14678;
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT m.user_id, t.pagina, 'revocar'
  FROM tmp_pag_14678 t
  JOIN tmp_m_final_14678 m ON m.codigo = t.pagina
  JOIN tmp_m_final_14678 e ON e.user_id = m.user_id AND e.codigo = t.despues
 WHERE NOT EXISTS (SELECT 1 FROM tmp_ef_usr_antes_14678 a WHERE a.user_id = m.user_id AND a.pagina = t.pagina)
ON CONFLICT (user_id, funcion_codigo) DO UPDATE SET efecto = 'revocar'
  WHERE permisos_usuario_funcion.efecto IS DISTINCT FROM 'revocar';
-- 8b. Lo mismo con el elemento de ANTES (db-review N1, simétrico al paso 6): sin ganancia tampoco con el árbol viejo.
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT m.user_id, t.pagina, 'revocar'
  FROM tmp_pag_14678 t
  JOIN tmp_m_final_14678 m ON m.codigo = t.pagina
  JOIN tmp_m_final_14678 e ON e.user_id = m.user_id AND e.codigo = t.antes
 WHERE NOT EXISTS (SELECT 1 FROM tmp_ef_usr_antes_14678 a WHERE a.user_id = m.user_id AND a.pagina = t.pagina)
ON CONFLICT (user_id, funcion_codigo) DO UPDATE SET efecto = 'revocar'
  WHERE permisos_usuario_funcion.efecto IS DISTINCT FROM 'revocar';

DROP TABLE tmp_m_final_14678;
DROP TABLE tmp_m_despues_14678;
DROP TABLE tmp_ef_usr_antes_14678;
DROP TABLE tmp_m_antes_14678;
DROP TABLE tmp_ef_rol_antes_14678;
DROP VIEW tmp_m_usuario_14678;
DROP TABLE tmp_pag_14678;
DROP TABLE tmp_mov_14678;
DROP TABLE tmp_menu_areas_14678;
