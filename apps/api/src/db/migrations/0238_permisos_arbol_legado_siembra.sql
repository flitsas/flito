-- 0238_permisos_arbol_legado_siembra.sql
--
-- HU #13429 (Feature #13416, Épica #13411) — Árbol de tres niveles: elementos del menú, la cadena de cada página
-- y los ítems antiguos en el nivel 2.
-- ADR-0025 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §5-quater.6.
-- Autor: equipo FLITO. Antecedente: 0237 (la anterior). Le sigue la 0239 (reparto y retiro de transitorios).
--
-- Qué hace (sin tocar el esquema: `padre_codigo`, `nivel` y `orden` existen desde la 0232):
--   1. Siembra los 11 elementos `menu.*` (nivel 1). «Ayuda» NO: es derivada (decisión del PO), sin permiso propio.
--   2. Toda `pagina.*` pasa a ítem (nivel 2) con su elemento como padre: las FLITO y las 46 antiguas.
--   3. Siembra la acción «Administrar» (nivel 3) de los 20 ítems PESV con operaciones (P-24, alternativa A1).
--   4. Cuelga cada opcional de su acción o de su ítem antiguo (`nivel` NULL: no son nodos). Los transversales
--      (P-29) no se tocan.
--   NO reparte ni retira nada: eso es la 0239 (aquí no hay ni una fila de `permisos_rol_funcion`).
-- Idempotente: upserts y UPDATE con `IS DISTINCT FROM` (la 2.ª pasada no cambia nada).

-- ÁRBOL GENERADO (inicio)
-- 11 elementos (nivel 1; «Ayuda» no: es derivada). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol legado
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, nivel, orden) VALUES
  ('menu.general', 'general', 'General', 'Ver la sección «General» del menú.', 'elemento', '1', '10'),
  ('menu.gestion', 'gestion', 'Gestión', 'Ver la sección «Gestión» del menú.', 'elemento', '1', '20'),
  ('menu.transito', 'transito', 'Tránsito', 'Ver la sección «Tránsito» del menú.', 'elemento', '1', '30'),
  ('menu.flota', 'flota', 'Flota', 'Ver la sección «Flota» del menú.', 'elemento', '1', '40'),
  ('menu.mantenimiento', 'mantenimiento', 'Mantenimiento', 'Ver la sección «Mantenimiento» del menú.', 'elemento', '1', '50'),
  ('menu.pesv', 'pesv', 'PESV', 'Ver la sección «PESV» del menú.', 'elemento', '1', '60'),
  ('menu.rndc', 'rndc', 'RNDC', 'Ver la sección «RNDC» del menú.', 'elemento', '1', '70'),
  ('menu.laft', 'laft', 'LAFT', 'Ver la sección «LAFT» del menú.', 'elemento', '1', '80'),
  ('menu.finanzas', 'finanzas', 'Finanzas', 'Ver la sección «Finanzas» del menú.', 'elemento', '1', '90'),
  ('menu.administracion', 'administracion', 'Administración', 'Ver la sección «Administración» del menú.', 'elemento', '1', '100'),
  ('menu.perfil', 'perfil', 'Perfil', 'Ver la sección «Perfil» del menú.', 'elemento', '1', '120')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio, descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion, permisos_funciones.tipo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion, EXCLUDED.tipo, EXCLUDED.nivel, EXCLUDED.orden);

-- 71 páginas: todas son ítem (nivel 2) y cuelgan de su elemento.
UPDATE permisos_funciones AS f
   SET padre_codigo = v.padre, nivel = v.nivel::smallint, orden = v.orden::integer
  FROM (VALUES
    ('pagina.clients', 'menu.gestion', '2', '90'),
    ('pagina.dashboard', 'menu.general', '2', '10'),
    ('pagina.drive', 'menu.administracion', '2', '50'),
    ('pagina.finanzas_gastos_diarios', 'menu.finanzas', '2', '20'),
    ('pagina.finanzas_reporte_costos', 'menu.finanzas', '2', '10'),
    ('pagina.fleet', 'menu.flota', '2', '10'),
    ('pagina.flito_bitacora', 'menu.gestion', '2', '100'),
    ('pagina.flito_bolsas', 'menu.finanzas', '2', '30'),
    ('pagina.flito_comparendos', 'menu.gestion', '2', '80'),
    ('pagina.flito_comprobantes', 'menu.finanzas', '2', '60'),
    ('pagina.flito_conciliacion', 'menu.finanzas', '2', '70'),
    ('pagina.flito_derechos', 'menu.gestion', '2', '40'),
    ('pagina.flito_impuestos', 'menu.gestion', '2', '30'),
    ('pagina.flito_logistica', 'menu.gestion', '2', '60'),
    ('pagina.flito_logistica_ruta', 'menu.gestion', '2', '70'),
    ('pagina.flito_revisiones', 'menu.gestion', '2', '50'),
    ('pagina.flito_servicios_adicionales', 'menu.finanzas', '2', '50'),
    ('pagina.flito_soat', 'menu.gestion', '2', '20'),
    ('pagina.flito_tarifas', 'menu.finanzas', '2', '40'),
    ('pagina.flito_tramites', 'menu.gestion', '2', '10'),
    ('pagina.laft', 'menu.laft', '2', '10'),
    ('pagina.laft_audit_plan', 'menu.laft', '2', '60'),
    ('pagina.laft_dashboard', 'menu.laft', '2', '70'),
    ('pagina.laft_manual', 'menu.laft', '2', '40'),
    ('pagina.laft_oficial', 'menu.laft', '2', '50'),
    ('pagina.laft_trainings', 'menu.laft', '2', '30'),
    ('pagina.laft_unusual', 'menu.laft', '2', '20'),
    ('pagina.maintenance', 'menu.mantenimiento', '2', '40'),
    ('pagina.maintenance_indicadores', 'menu.mantenimiento', '2', '30'),
    ('pagina.maintenance_inicio', 'menu.mantenimiento', '2', '10'),
    ('pagina.maintenance_ordenes', 'menu.mantenimiento', '2', '20'),
    ('pagina.perfil', 'menu.perfil', '2', '10'),
    ('pagina.pesv', 'menu.pesv', '2', '10'),
    ('pagina.pesv_alcoholimetria', 'menu.pesv', '2', '70'),
    ('pagina.pesv_auditorias', 'menu.pesv', '2', '160'),
    ('pagina.pesv_capacitaciones', 'menu.pesv', '2', '30'),
    ('pagina.pesv_checklists', 'menu.pesv', '2', '60'),
    ('pagina.pesv_comite', 'menu.pesv', '2', '110'),
    ('pagina.pesv_comunicaciones', 'menu.pesv', '2', '170'),
    ('pagina.pesv_conductores', 'menu.pesv', '2', '20'),
    ('pagina.pesv_contratistas', 'menu.pesv', '2', '180'),
    ('pagina.pesv_diagnostico', 'menu.pesv', '2', '130'),
    ('pagina.pesv_emergencias', 'menu.pesv', '2', '80'),
    ('pagina.pesv_incidentes', 'menu.pesv', '2', '40'),
    ('pagina.pesv_indicadores_operacion', 'menu.pesv', '2', '90'),
    ('pagina.pesv_jornadas', 'menu.pesv', '2', '190'),
    ('pagina.pesv_mi_jornada', 'menu.pesv', '2', '200'),
    ('pagina.pesv_normativa', 'menu.pesv', '2', '240'),
    ('pagina.pesv_pernocta', 'menu.pesv', '2', '220'),
    ('pagina.pesv_plan', 'menu.pesv', '2', '120'),
    ('pagina.pesv_politica', 'menu.pesv', '2', '100'),
    ('pagina.pesv_raci', 'menu.pesv', '2', '230'),
    ('pagina.pesv_reportar_incidente', 'menu.pesv', '2', '150'),
    ('pagina.pesv_retencion', 'menu.pesv', '2', '250'),
    ('pagina.pesv_rutas', 'menu.pesv', '2', '210'),
    ('pagina.pesv_siniestralidad', 'menu.pesv', '2', '50'),
    ('pagina.pesv_tablero_ejecutivo', 'menu.pesv', '2', '140'),
    ('pagina.privacy', 'menu.administracion', '2', '40'),
    ('pagina.rndc', 'menu.rndc', '2', '10'),
    ('pagina.rndc_admin', 'menu.rndc', '2', '20'),
    ('pagina.roles_permisos', 'menu.administracion', '2', '20'),
    ('pagina.siigo_credenciales', 'menu.administracion', '2', '30'),
    ('pagina.siigo_operacion', 'menu.finanzas', '2', '90'),
    ('pagina.siigo_parametrizacion', 'menu.finanzas', '2', '80'),
    ('pagina.soat', 'menu.gestion', '2', '130'),
    ('pagina.tax_reader', 'menu.gestion', '2', '140'),
    ('pagina.tramite', 'menu.gestion', '2', '120'),
    ('pagina.transito', 'menu.transito', '2', '20'),
    ('pagina.transito_organismos', 'menu.transito', '2', '10'),
    ('pagina.users', 'menu.administracion', '2', '10'),
    ('pagina.vehicles', 'menu.gestion', '2', '110')
  ) AS v(codigo, padre, nivel, orden)
 WHERE f.codigo = v.codigo
   AND (f.padre_codigo, f.nivel, f.orden) IS DISTINCT FROM (v.padre, v.nivel::smallint, v.orden::integer);

-- 20 acciones «Administrar» de los ítems PESV con operaciones (P-24, A1).
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.pesv_alcoholimetria.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_alcoholimetria', '3', '10'),
  ('accion.pesv_auditorias.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_auditorias', '3', '10'),
  ('accion.pesv_capacitaciones.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_capacitaciones', '3', '10'),
  ('accion.pesv_checklists.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_checklists', '3', '10'),
  ('accion.pesv_comite.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_comite', '3', '10'),
  ('accion.pesv_comunicaciones.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_comunicaciones', '3', '10'),
  ('accion.pesv_conductores.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_conductores', '3', '10'),
  ('accion.pesv_contratistas.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_contratistas', '3', '10'),
  ('accion.pesv_diagnostico.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_diagnostico', '3', '10'),
  ('accion.pesv_emergencias.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_emergencias', '3', '10'),
  ('accion.pesv_incidentes.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_incidentes', '3', '10'),
  ('accion.pesv_jornadas.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_jornadas', '3', '10'),
  ('accion.pesv_normativa.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_normativa', '3', '10'),
  ('accion.pesv_pernocta.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_pernocta', '3', '10'),
  ('accion.pesv_plan.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_plan', '3', '10'),
  ('accion.pesv_politica.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_politica', '3', '10'),
  ('accion.pesv_raci.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_raci', '3', '10'),
  ('accion.pesv_retencion.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_retencion', '3', '10'),
  ('accion.pesv_rutas.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_rutas', '3', '10'),
  ('accion.pesv_tablero_ejecutivo.administrar', 'pesv', 'Administrar', 'Crear, editar y gestionar los registros de esta pantalla.', 'accion', 'pagina.pesv_tablero_ejecutivo', '3', '10')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio, descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo, nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion, permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion, EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- 18 opcionales: cuelgan de su acción o de su ítem antiguo (nivel NULL: no son nodos).
UPDATE permisos_funciones AS f
   SET padre_codigo = v.padre
  FROM (VALUES
    ('bolsas.soporte.descargar', 'accion.bolsas.ver_clientes'),
    ('comparendos.registros.exportar', 'accion.comparendos.ver_listado'),
    ('comprobantes.archivo.descargar', 'accion.comprobantes.ver_cola'),
    ('conciliacion.comprobante.descargar', 'accion.conciliacion.ver_boletas'),
    ('impuestos.factura.ver', 'accion.impuestos.ver_listado'),
    ('laft.manual.firmar', 'pagina.laft_manual'),
    ('logistica.actas.descargar', 'accion.logistica.ver_actas'),
    ('logistica.actas.despachar', 'accion.logistica.despachar_entregar_devolver'),
    ('logistica.actas.operar_ajenas', 'accion.logistica.despachar_entregar_devolver'),
    ('parametrizacion.companias.listar', 'accion.clientes.ver'),
    ('parametrizacion.proveedores.listar', 'accion.clientes.ver'),
    ('revisiones.soporte.descargar', 'accion.revisiones.ver'),
    ('siigo.conceptos.confirmar', 'accion.facturacion_parametrizacion.ver'),
    ('siigo.factura.anular', 'accion.facturacion_operacion.gestionar'),
    ('siigo.factura.corregir', 'accion.facturacion_operacion.gestionar'),
    ('soat.antiguo.operar', 'pagina.soat'),
    ('soat.solicitud.reintentar_runt', 'accion.soat.ver_por_validar'),
    ('vehicles.propietario.ver_documento', 'pagina.vehicles')
  ) AS v(codigo, padre)
 WHERE f.codigo = v.codigo
   AND f.padre_codigo IS DISTINCT FROM v.padre;
-- ÁRBOL GENERADO (fin)
