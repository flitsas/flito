-- epica-14678-0315-rollback.sql — INVERSO de lo VISIBLE de la migración 0315_flito_menu_por_areas.sql.
--
-- NO ES UNA MIGRACIÓN: no va en apps/api/src/db/migrations/ y ningún runner la aplica. Se corre a mano, solo si se
-- decide revertir la imagen de la API a una sin la 0315 (Épica #14678, ADR-0048), y con el «sí» humano.
--
-- Cuándo y en qué orden (verificado en código):
--   1. ANTES de revertir la imagen. Si la 0315 sigue en el ledger sin su archivo en disco (huérfana), el initContainer
--      `db-apply` de la imagen anterior HOY registra `[drift] huerfana` y continúa (`DRIFT_ABORTA=false` en
--      `apps/api/src/scripts/db-apply.ts`, ADR-0035 §A); abortará con EXIT_DERIVA cuando el PR 2 de ADR-0035 retire esa
--      constante. Este script borra esa fila del ledger.
--   2. Correrlo con: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/arquitectura/epica-14678-0315-rollback.sql
--      (en PDN, con el pg_dump previo de siempre).
--   3. Revertir la imagen (commit de flit-gitops). Entre 2 y 3 los pods con la 0315, que siguen corriendo, pierden lo que
--      solo daban los cuatro `menu.*` nuevos (sus páginas vuelven a colgar de los elementos viejos, que su código no usa
--      como padre): la ventana debe ser corta.
--   4. Roll-forward: al volver a desplegar la imagen con la 0315, el initContainer la aplica de nuevo (ya no está en el
--      ledger); es idempotente.
--
-- Qué restaura: lo VISIBLE, no las filas. Devuelve padre y orden de las 75 páginas y quita los cuatro elementos con sus
-- marcas de rol y de usuario. NO repone las marcas dormidas que borró el paso 6 de la 0315 ni deshace los
-- `conceder`/`revocar` de usuario de los pasos 7 y 8: con el árbol viejo ninguno cambia lo efectivo (lo dormido seguía
-- sin dar nada, y lo revocado no era efectivo). `menu.administracion` NO se borra (es un elemento de antes): quien lo
-- recibió en la 0315 por Organismos STT lo conserva, sin ganar nada (pasos 6 y 8b, arreglo N1).
-- Probado en BEGIN/ROLLBACK sobre la base local con la 0315 aplicada.
BEGIN;
UPDATE permisos_funciones AS f SET padre_codigo = v.viejo, orden = v.orden::integer FROM (VALUES
  -- menu.gestion
  ('menu.gestion', 'pagina.clients', 90), ('menu.gestion', 'pagina.flito_bitacora', 100), ('menu.gestion', 'pagina.flito_comparendos', 80), ('menu.gestion', 'pagina.flito_derechos', 40), ('menu.gestion', 'pagina.flito_impuestos', 30), ('menu.gestion', 'pagina.flito_logistica', 60), ('menu.gestion', 'pagina.flito_logistica_ruta', 70), ('menu.gestion', 'pagina.flito_revisiones', 50), ('menu.gestion', 'pagina.flito_soat', 20), ('menu.gestion', 'pagina.flito_tramites', 10), ('menu.gestion', 'pagina.soat', 130), ('menu.gestion', 'pagina.tax_reader', 140), ('menu.gestion', 'pagina.tramite', 120), ('menu.gestion', 'pagina.vehicles', 110),
  -- menu.general
  ('menu.general', 'pagina.dashboard', 10), ('menu.general', 'pagina.torre_360', 30), ('menu.general', 'pagina.torre_comercial', 40), ('menu.general', 'pagina.torre_detalle', 80), ('menu.general', 'pagina.torre_explorador', 70), ('menu.general', 'pagina.torre_financiera', 60), ('menu.general', 'pagina.torre_logistica', 100), ('menu.general', 'pagina.torre_operativa', 50), ('menu.general', 'pagina.torre_productos', 90),
  -- menu.finanzas
  ('menu.finanzas', 'pagina.finanzas_gastos_diarios', 20), ('menu.finanzas', 'pagina.finanzas_reporte_costos', 10), ('menu.finanzas', 'pagina.flito_bolsas', 30), ('menu.finanzas', 'pagina.flito_comprobantes', 60), ('menu.finanzas', 'pagina.flito_conciliacion', 70), ('menu.finanzas', 'pagina.flito_servicios_adicionales', 50), ('menu.finanzas', 'pagina.flito_tarifas', 40), ('menu.finanzas', 'pagina.siigo_operacion', 90), ('menu.finanzas', 'pagina.siigo_parametrizacion', 80),
  -- menu.flota
  ('menu.flota', 'pagina.fleet', 10),
  -- menu.laft
  ('menu.laft', 'pagina.laft', 10), ('menu.laft', 'pagina.laft_audit_plan', 60), ('menu.laft', 'pagina.laft_dashboard', 70), ('menu.laft', 'pagina.laft_manual', 40), ('menu.laft', 'pagina.laft_oficial', 50), ('menu.laft', 'pagina.laft_trainings', 30), ('menu.laft', 'pagina.laft_unusual', 20),
  -- menu.mantenimiento
  ('menu.mantenimiento', 'pagina.maintenance', 40), ('menu.mantenimiento', 'pagina.maintenance_indicadores', 30), ('menu.mantenimiento', 'pagina.maintenance_inicio', 10), ('menu.mantenimiento', 'pagina.maintenance_ordenes', 20),
  -- menu.pesv
  ('menu.pesv', 'pagina.pesv', 10), ('menu.pesv', 'pagina.pesv_alcoholimetria', 70), ('menu.pesv', 'pagina.pesv_auditorias', 160), ('menu.pesv', 'pagina.pesv_capacitaciones', 30), ('menu.pesv', 'pagina.pesv_checklists', 60), ('menu.pesv', 'pagina.pesv_comite', 110), ('menu.pesv', 'pagina.pesv_comunicaciones', 170), ('menu.pesv', 'pagina.pesv_conductores', 20), ('menu.pesv', 'pagina.pesv_contratistas', 180), ('menu.pesv', 'pagina.pesv_diagnostico', 130), ('menu.pesv', 'pagina.pesv_emergencias', 80), ('menu.pesv', 'pagina.pesv_incidentes', 40), ('menu.pesv', 'pagina.pesv_indicadores_operacion', 90), ('menu.pesv', 'pagina.pesv_jornadas', 190), ('menu.pesv', 'pagina.pesv_mi_jornada', 200), ('menu.pesv', 'pagina.pesv_normativa', 240), ('menu.pesv', 'pagina.pesv_pernocta', 220), ('menu.pesv', 'pagina.pesv_plan', 120), ('menu.pesv', 'pagina.pesv_politica', 100), ('menu.pesv', 'pagina.pesv_raci', 230), ('menu.pesv', 'pagina.pesv_reportar_incidente', 150), ('menu.pesv', 'pagina.pesv_retencion', 250), ('menu.pesv', 'pagina.pesv_rutas', 210), ('menu.pesv', 'pagina.pesv_siniestralidad', 50), ('menu.pesv', 'pagina.pesv_tablero_ejecutivo', 140),
  -- menu.rndc
  ('menu.rndc', 'pagina.rndc', 10), ('menu.rndc', 'pagina.rndc_admin', 20),
  -- menu.administracion
  ('menu.administracion', 'pagina.siigo_credenciales', 30), ('menu.administracion', 'pagina.torre_umbrales', 70),
  -- menu.transito
  ('menu.transito', 'pagina.transito', 20), ('menu.transito', 'pagina.transito_organismos', 10)
) AS v(viejo, pagina, orden) WHERE f.codigo = v.pagina;
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('menu.operaciones', 'menu.financiera', 'menu.gerencial', 'menu.kyverum');
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN ('menu.operaciones', 'menu.financiera', 'menu.gerencial', 'menu.kyverum');
DELETE FROM permisos_funciones WHERE codigo IN ('menu.operaciones', 'menu.financiera', 'menu.gerencial', 'menu.kyverum');
DELETE FROM _kyverum_applied_migrations WHERE filename = '0315_flito_menu_por_areas.sql'; -- para que el roll-forward la vuelva a aplicar
COMMIT;
