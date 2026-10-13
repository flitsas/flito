-- 0234_permisos_arbol_finanzas_siembra.sql
--
-- HU #13427 (Feature #13416, Épica #13411) — Catálogo nuevo de Finanzas (y Administración · Integración con Siigo).
-- ADR-0025 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §5-bis.
-- Autor: equipo FLITO. Antecedente: 0233 (la anterior, reparto de Gestión). Le sigue la 0235 (reparto de Finanzas).
--
-- Qué hace: siembra las acciones (nivel 3) de los 10 ítems del área —los 9 de Finanzas y «Integración con
-- Siigo» de Administración (P-3)— y marca `nivel`/`orden` de esas 10 páginas. Las columnas del árbol ya las
-- creó la 0232. Los `menu.*` y el padre de cada página llegan con la HU #13429.
-- NO reparte ni retira nada: eso es la 0235 (aquí no hay ni una fila de `permisos_rol_funcion`).
-- Idempotente: upsert y UPDATE con `IS DISTINCT FROM` (2.ª pasada sin cambios).

-- ÁRBOL GENERADO (inicio)
-- 41 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol finanzas
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.bolsas.cerrar_periodo', 'bolsas', 'Cerrar periodo y descargar extracto', 'Cerrar el periodo de una bolsa y descargar su extracto.', 'accion', 'pagina.flito_bolsas', '3', '70'),
  ('accion.bolsas.crear', 'bolsas', 'Crear bolsas', 'Crear bolsas de tránsito.', 'accion', 'pagina.flito_bolsas', '3', '30'),
  ('accion.bolsas.editar', 'bolsas', 'Editar bolsas', 'Editar bolsas de tránsito.', 'accion', 'pagina.flito_bolsas', '3', '40'),
  ('accion.bolsas.movimientos_manuales', 'bolsas', 'Registrar y corregir movimientos manuales', 'Registrar y corregir movimientos manuales de una bolsa.', 'accion', 'pagina.flito_bolsas', '3', '60'),
  ('accion.bolsas.registrar_recargas', 'bolsas', 'Registrar recargas y cargar saldo', 'Registrar recargas y cargar saldo a las bolsas.', 'accion', 'pagina.flito_bolsas', '3', '50'),
  ('accion.bolsas.ver_alertas', 'bolsas', 'Ver alertas y riesgo de saldo', 'Consultar las alertas y el riesgo de saldo de las bolsas.', 'accion', 'pagina.flito_bolsas', '3', '80'),
  ('accion.bolsas.ver_clientes', 'bolsas', 'Ver bolsas de clientes', 'Consultar el consolidado, las bolsas de clientes, sus movimientos y sus cierres.', 'accion', 'pagina.flito_bolsas', '3', '10'),
  ('accion.bolsas.ver_transito', 'bolsas', 'Ver bolsas de tránsito', 'Consultar las bolsas de tránsito y sus movimientos.', 'accion', 'pagina.flito_bolsas', '3', '20'),
  ('accion.comprobantes.asociar', 'comprobantes', 'Asociar manualmente', 'Buscar el trámite y aplicarle un comprobante a mano.', 'accion', 'pagina.flito_comprobantes', '3', '20'),
  ('accion.comprobantes.cargar', 'comprobantes', 'Cargar comprobantes', 'Cargar lotes de comprobantes.', 'accion', 'pagina.flito_comprobantes', '3', '10'),
  ('accion.comprobantes.resolver', 'comprobantes', 'Descartar, releer o aceptar una diferencia', 'Descartar un comprobante, volver a leerlo o aceptar una diferencia.', 'accion', 'pagina.flito_comprobantes', '3', '40'),
  ('accion.comprobantes.ver_cola', 'comprobantes', 'Ver la cola de comprobantes', 'Consultar la cola de comprobantes y el detalle de cada uno.', 'accion', 'pagina.flito_comprobantes', '3', '30'),
  ('accion.conciliacion.cargar_boleta', 'conciliacion', 'Cargar boleta', 'Cargar una boleta.', 'accion', 'pagina.flito_conciliacion', '3', '20'),
  ('accion.conciliacion.comprobante', 'conciliacion', 'Cargar o reemplazar el comprobante de la boleta', 'Cargar o reemplazar el comprobante de una boleta.', 'accion', 'pagina.flito_conciliacion', '3', '40'),
  ('accion.conciliacion.conciliar', 'conciliacion', 'Conciliar, descartar o volver a cruzar', 'Conciliar, descartar o volver a cruzar una boleta.', 'accion', 'pagina.flito_conciliacion', '3', '30'),
  ('accion.conciliacion.ver_boletas', 'conciliacion', 'Ver las boletas cargadas', 'Consultar las boletas cargadas y su detalle.', 'accion', 'pagina.flito_conciliacion', '3', '10'),
  ('accion.facturacion_operacion.freno', 'finanzas', 'Quitar el freno de emisión', 'Reactivar la emisión de facturas cuando el freno se activó.', 'accion', 'pagina.siigo_operacion', '3', '30'),
  ('accion.facturacion_operacion.gestionar', 'finanzas', 'Reintentar, reenviar el correo, marcar como fallida y reactivar', 'Reintentar, reenviar el correo, marcar como fallida y reactivar una factura electrónica.', 'accion', 'pagina.siigo_operacion', '3', '20'),
  ('accion.facturacion_operacion.ver_facturas', 'finanzas', 'Ver las facturas emitidas', 'Consultar la bandeja, la línea de tiempo y el estado de las facturas, y el estado del freno.', 'accion', 'pagina.siigo_operacion', '3', '10'),
  ('accion.facturacion_parametrizacion.mapeo_conceptos', 'finanzas', 'Mapeo de conceptos', 'Crear, editar, revalidar y borrar el mapeo de conceptos y sincronizar los catálogos de Siigo.', 'accion', 'pagina.siigo_parametrizacion', '3', '20'),
  ('accion.facturacion_parametrizacion.terceros', 'finanzas', 'Configuración de terceros', 'Cargar ciudades, confirmar la ciudad de un cliente y recalcular duplicados.', 'accion', 'pagina.siigo_parametrizacion', '3', '30'),
  ('accion.facturacion_parametrizacion.ver', 'finanzas', 'Ver la parametrización', 'Consultar la compuerta, el mapeo de conceptos, las ciudades, la validación de clientes y los catálogos de emisión.', 'accion', 'pagina.siigo_parametrizacion', '3', '10'),
  ('accion.gastos_diarios.ver', 'finanzas', 'Ver los gastos diarios', 'Consultar los gastos diarios.', 'accion', 'pagina.finanzas_gastos_diarios', '3', '10'),
  ('accion.integracion_siigo.credenciales_produccion', 'administracion', 'Registrar credenciales de producción', 'Registrar y borrar las credenciales de Siigo del ambiente de producción.', 'accion', 'pagina.siigo_credenciales', '3', '20'),
  ('accion.integracion_siigo.credenciales_pruebas', 'administracion', 'Registrar credenciales de pruebas', 'Registrar y borrar las credenciales de Siigo del ambiente de pruebas.', 'accion', 'pagina.siigo_credenciales', '3', '10'),
  ('accion.integracion_siigo.probar_conexion', 'administracion', 'Probar la conexión', 'Probar la conexión con Siigo con las credenciales registradas.', 'accion', 'pagina.siigo_credenciales', '3', '30'),
  ('accion.reporte_costos.asignar_servicios_adicionales', 'liquidacion', 'Asignar servicios adicionales', 'Asignar y quitar servicios adicionales a un trámite.', 'accion', 'pagina.finanzas_reporte_costos', '3', '50'),
  ('accion.reporte_costos.enviar_siigo', 'liquidacion', 'Enviar a Siigo', 'Emitir la factura electrónica en Siigo y sincronizar sus terceros.', 'accion', 'pagina.finanzas_reporte_costos', '3', '80'),
  ('accion.reporte_costos.exportar', 'liquidacion', 'Exportar a Excel', 'Descargar el reporte de costos y su consolidado en Excel.', 'accion', 'pagina.finanzas_reporte_costos', '3', '20'),
  ('accion.reporte_costos.facturar', 'liquidacion', 'Facturar', 'Marcar como facturados los trámites liquidados.', 'accion', 'pagina.finanzas_reporte_costos', '3', '70'),
  ('accion.reporte_costos.liquidar', 'liquidacion', 'Liquidar (incluye en lote)', 'Liquidar trámites, uno a uno o en lote.', 'accion', 'pagina.finanzas_reporte_costos', '3', '60'),
  ('accion.reporte_costos.reversar_liquidacion', 'liquidacion', 'Reversar una liquidación', 'Deshacer la liquidación de un trámite.', 'accion', 'pagina.finanzas_reporte_costos', '3', '90'),
  ('accion.reporte_costos.ver_listado', 'liquidacion', 'Ver el listado de trámites', 'Consultar el reporte de costos, sus filtros, el consolidado, la facturación electrónica y los eventos de liquidación.', 'accion', 'pagina.finanzas_reporte_costos', '3', '10'),
  ('accion.reporte_costos.ver_soportes', 'liquidacion', 'Ver soportes', 'Abrir los soportes de un trámite desde el reporte.', 'accion', 'pagina.finanzas_reporte_costos', '3', '30'),
  ('accion.reporte_costos.ver_viajes_adicionales', 'liquidacion', 'Ver viajes adicionales', 'Ver los viajes de logística de un trámite desde el reporte.', 'accion', 'pagina.finanzas_reporte_costos', '3', '40'),
  ('accion.servicios_adicionales.crear', 'servicios_adicionales', 'Crear', 'Crear servicios adicionales.', 'accion', 'pagina.flito_servicios_adicionales', '3', '20'),
  ('accion.servicios_adicionales.dar_de_baja', 'servicios_adicionales', 'Dar de baja', 'Dar de baja servicios adicionales.', 'accion', 'pagina.flito_servicios_adicionales', '3', '40'),
  ('accion.servicios_adicionales.editar', 'servicios_adicionales', 'Editar', 'Editar servicios adicionales.', 'accion', 'pagina.flito_servicios_adicionales', '3', '30'),
  ('accion.servicios_adicionales.ver', 'servicios_adicionales', 'Ver', 'Consultar el catálogo de servicios adicionales.', 'accion', 'pagina.flito_servicios_adicionales', '3', '10'),
  ('accion.tarifas.crear_modificar', 'tarifas', 'Crear y modificar tarifas', 'Crear y editar tarifas.', 'accion', 'pagina.flito_tarifas', '3', '20'),
  ('accion.tarifas.ver', 'tarifas', 'Ver las tarifas (incluye historial)', 'Consultar las tarifas, las de cada cliente y su historial.', 'accion', 'pagina.flito_tarifas', '3', '10')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- 10 páginas que son ítem (nivel 2). Su padre (`menu.*`) lo pone la HU #13429.
UPDATE permisos_funciones AS f
   SET nivel = v.nivel::smallint, orden = v.orden::integer
  FROM (VALUES
    ('pagina.finanzas_gastos_diarios', '2', '20'),
    ('pagina.finanzas_reporte_costos', '2', '10'),
    ('pagina.flito_bolsas', '2', '30'),
    ('pagina.flito_comprobantes', '2', '60'),
    ('pagina.flito_conciliacion', '2', '70'),
    ('pagina.flito_servicios_adicionales', '2', '50'),
    ('pagina.flito_tarifas', '2', '40'),
    ('pagina.siigo_credenciales', '2', '30'),
    ('pagina.siigo_operacion', '2', '90'),
    ('pagina.siigo_parametrizacion', '2', '80')
  ) AS v(codigo, nivel, orden)
 WHERE f.codigo = v.codigo
   AND (f.nivel, f.orden) IS DISTINCT FROM (v.nivel::smallint, v.orden::integer);
-- ÁRBOL GENERADO (fin)
