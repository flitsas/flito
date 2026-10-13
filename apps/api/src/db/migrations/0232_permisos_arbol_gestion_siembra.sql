-- 0232_permisos_arbol_gestion_siembra.sql
--
-- HU #12873 (Feature #13416, Épica #13411) — Catálogo nuevo de Gestión y Tránsito: la base del árbol.
-- ADR-0025 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §2.3 y §4.1.
-- Autor: equipo FLITO. Antecedente: 0231 (la anterior). Le sigue la 0233 (reparto «todos»).
--
-- Qué hace:
--   1. `permisos_funciones` gana el árbol: `padre_codigo` (FK a sí misma, RESTRICT al borrar),
--      `nivel` (1 elemento · 2 ítem · 3 acción; NULL = operación aún concedible) y `orden`. El CHECK
--      de `tipo` admite `elemento` y `accion`.
--   2. Siembra las acciones (nivel 3) de los 9 ítems de Gestión y Tránsito y marca `nivel`/`orden` de
--      esas 9 páginas. Los `menu.*` y el padre de cada página llegan con la HU #13429.
--   NO reparte nada ni retira nada: eso es la 0233 (aquí no hay ni una fila de `permisos_rol_funcion`).
-- Idempotente: DDL con IF [NOT] EXISTS, upsert y UPDATE con `IS DISTINCT FROM` (2.ª pasada sin cambios).

ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS padre_codigo varchar(80);
ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS nivel smallint;
ALTER TABLE permisos_funciones ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 0;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permisos_funciones_padre_codigo_permisos_funciones_codigo_fk') THEN
    ALTER TABLE permisos_funciones ADD CONSTRAINT permisos_funciones_padre_codigo_permisos_funciones_codigo_fk
      FOREIGN KEY (padre_codigo) REFERENCES permisos_funciones(codigo) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS permisos_funciones_padre_idx ON permisos_funciones (padre_codigo);

ALTER TABLE permisos_funciones DROP CONSTRAINT IF EXISTS permisos_funciones_tipo_chk;
ALTER TABLE permisos_funciones ADD CONSTRAINT permisos_funciones_tipo_chk
  CHECK (tipo IN ('pagina', 'operacion', 'elemento', 'accion'));

ALTER TABLE permisos_funciones DROP CONSTRAINT IF EXISTS permisos_funciones_nivel_chk;
ALTER TABLE permisos_funciones ADD CONSTRAINT permisos_funciones_nivel_chk
  CHECK (nivel IS NULL OR nivel BETWEEN 1 AND 3);

-- ÁRBOL GENERADO (inicio)
-- 55 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol gestion
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.comparendos.configurar', 'comparendos', 'Configurar', 'Administrar NIT, municipios, causales y el token de SIMIT.', 'accion', 'pagina.flito_comparendos', '3', '40'),
  ('accion.comparendos.gestionar', 'comparendos', 'Gestionar comparendos', 'Registrar la gestión de un comparendo.', 'accion', 'pagina.flito_comparendos', '3', '20'),
  ('accion.comparendos.sincronizar', 'comparendos', 'Sincronizar', 'Lanzar la sincronización y ver sus corridas.', 'accion', 'pagina.flito_comparendos', '3', '30'),
  ('accion.comparendos.ver_listado', 'comparendos', 'Ver el listado', 'Listar, buscar y exportar comparendos, y ver cada registro y sus eventos.', 'accion', 'pagina.flito_comparendos', '3', '10'),
  ('accion.derechos.cargar', 'derechos', 'Cargar recibos', 'Cargar recibos de derechos y ver los candidatos de una placa.', 'accion', 'pagina.flito_derechos', '3', '20'),
  ('accion.derechos.procesar_drive', 'derechos', 'Procesar desde Drive', 'Listar y procesar los archivos de Drive y ver su registro.', 'accion', 'pagina.flito_derechos', '3', '30'),
  ('accion.derechos.ver_listado', 'derechos', 'Ver el listado', 'Consultar la cola de derechos y filtrarla.', 'accion', 'pagina.flito_derechos', '3', '10'),
  ('accion.derechos.ver_soportes', 'derechos', 'Ver soportes', 'Descargar el soporte de un derecho.', 'accion', 'pagina.flito_derechos', '3', '40'),
  ('accion.impuestos.cargar_comprobantes', 'impuestos', 'Cargar comprobantes', 'Cargar los recibos de pago.', 'accion', 'pagina.flito_impuestos', '3', '30'),
  ('accion.impuestos.cargar_recibo_caja', 'impuestos', 'Cargar recibo de caja', 'Cargar el recibo de caja de un trámite.', 'accion', 'pagina.flito_impuestos', '3', '80'),
  ('accion.impuestos.certificar_runt', 'impuestos', 'Certificar en el RUNT', 'Certificar un trámite o un lote en el RUNT.', 'accion', 'pagina.flito_impuestos', '3', '70'),
  ('accion.impuestos.corregir_direccion', 'impuestos', 'Corregir dirección', 'Corregir la dirección del trámite.', 'accion', 'pagina.flito_impuestos', '3', '100'),
  ('accion.impuestos.descargar_certificado', 'impuestos', 'Descargar certificado', 'Descargar el certificado del trámite.', 'accion', 'pagina.flito_impuestos', '3', '110'),
  ('accion.impuestos.descargar_zip', 'impuestos', 'Descargar soportes en ZIP', 'Descargar en un ZIP los soportes de varios trámites.', 'accion', 'pagina.flito_impuestos', '3', '50'),
  ('accion.impuestos.exportar', 'impuestos', 'Exportar a Excel', 'Descargar la cola en Excel.', 'accion', 'pagina.flito_impuestos', '3', '40'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos', 'Gestionar solicitudes', 'Enviar, asumir, devolver, reactivar, reversar y rechazar trámites.', 'accion', 'pagina.flito_impuestos', '3', '60'),
  ('accion.impuestos.reemplazar_comprobante', 'impuestos', 'Reemplazar comprobante', 'Reemplazar el recibo de pago de un trámite.', 'accion', 'pagina.flito_impuestos', '3', '90'),
  ('accion.impuestos.ver_listado', 'impuestos', 'Ver el listado', 'Consultar la cola de impuestos, filtrarla y ver el detalle, el historial y la factura de venta.', 'accion', 'pagina.flito_impuestos', '3', '10'),
  ('accion.impuestos.ver_soportes', 'impuestos', 'Ver soportes', 'Abrir los soportes de un trámite.', 'accion', 'pagina.flito_impuestos', '3', '20'),
  ('accion.logistica.cerrar_lote', 'logistica', 'Cerrar lote', 'Cerrar el lote de documentos.', 'accion', 'pagina.flito_logistica', '3', '60'),
  ('accion.logistica.despachar_entregar_devolver', 'logistica', 'Despachar, entregar y devolver', 'Despachar, entregar (también actas de otros mensajeros) y devolver actas.', 'accion', 'pagina.flito_logistica', '3', '50'),
  ('accion.logistica.generar_actas', 'logistica', 'Generar actas', 'Validar la LT y generar las actas.', 'accion', 'pagina.flito_logistica', '3', '30'),
  ('accion.logistica.registrar_viajes', 'logistica', 'Registrar viajes adicionales', 'Ver, registrar y quitar viajes adicionales de un trámite.', 'accion', 'pagina.flito_logistica', '3', '20'),
  ('accion.logistica.reversar_paso', 'logistica', 'Reversar paso', 'Reversar el último paso de un documento.', 'accion', 'pagina.flito_logistica', '3', '70'),
  ('accion.logistica.ver_actas', 'logistica', 'Ver actas', 'Listar, ver y descargar actas.', 'accion', 'pagina.flito_logistica', '3', '40'),
  ('accion.logistica.ver_consola', 'logistica', 'Ver la consola', 'Consultar la consola de logística, filtrarla y ver cada documento.', 'accion', 'pagina.flito_logistica', '3', '10'),
  ('accion.mi_ruta.escanear', 'logistica', 'Escanear documentos', 'Escanear los documentos de la ruta.', 'accion', 'pagina.flito_logistica_ruta', '3', '20'),
  ('accion.mi_ruta.reportar_novedad', 'logistica', 'Reportar novedad', 'Reportar una novedad sobre un documento.', 'accion', 'pagina.flito_logistica_ruta', '3', '30'),
  ('accion.mi_ruta.ver', 'logistica', 'Ver mi ruta', 'Ver la ruta del día y sus documentos.', 'accion', 'pagina.flito_logistica_ruta', '3', '10'),
  ('accion.organismos_stt.editar', 'transito', 'Editar organismos', 'Editar organismos, su modalidad, configuración, logo y checklist.', 'accion', 'pagina.transito_organismos', '3', '20'),
  ('accion.organismos_stt.ver', 'transito', 'Ver organismos', 'Consultar los organismos de tránsito, su configuración, logo, checklist y vigencias.', 'accion', 'pagina.transito_organismos', '3', '10'),
  ('accion.revisiones.revisar_lecturas', 'revisiones', 'Revisar lecturas OCR', 'Resolver o descartar las lecturas pendientes.', 'accion', 'pagina.flito_revisiones', '3', '20'),
  ('accion.revisiones.ver', 'revisiones', 'Ver revisiones', 'Consultar la cola de revisiones, sus campos y sus soportes.', 'accion', 'pagina.flito_revisiones', '3', '10'),
  ('accion.soat.cambiar_proveedor', 'soat', 'Cambiar proveedor', 'Cambiar el proveedor de SOAT de una solicitud.', 'accion', 'pagina.flito_soat', '3', '50'),
  ('accion.soat.cargar_comprobantes', 'soat', 'Cargar comprobantes', 'Cargar la factura de una solicitud o varias a la vez.', 'accion', 'pagina.flito_soat', '3', '30'),
  ('accion.soat.cargar_documentos_adicionales', 'soat', 'Cargar documentos adicionales', 'Cargar documentos adicionales a una solicitud.', 'accion', 'pagina.flito_soat', '3', '110'),
  ('accion.soat.descargar_zip', 'soat', 'Descargar soportes en ZIP', 'Descargar en un ZIP los soportes de varias solicitudes.', 'accion', 'pagina.flito_soat', '3', '90'),
  ('accion.soat.eliminar_documentos_adicionales', 'soat', 'Eliminar documentos adicionales', 'Eliminar documentos adicionales de una solicitud.', 'accion', 'pagina.flito_soat', '3', '120'),
  ('accion.soat.exportar', 'soat', 'Exportar a Excel', 'Descargar la cola en Excel.', 'accion', 'pagina.flito_soat', '3', '40'),
  ('accion.soat.gestionar_solicitudes', 'soat', 'Gestionar solicitudes', 'Enviar, asumir, devolver, reactivar, reversar y rechazar solicitudes.', 'accion', 'pagina.flito_soat', '3', '70'),
  ('accion.soat.solicitar_sin_tramite', 'soat', 'Solicitar SOAT sin trámite', 'Radicar un SOAT sin trámite previo, con la preconsulta RUNT y la lectura de la factura.', 'accion', 'pagina.flito_soat', '3', '60'),
  ('accion.soat.ver_documentos_adicionales', 'soat', 'Ver documentos adicionales', 'Ver los documentos adicionales de una solicitud.', 'accion', 'pagina.flito_soat', '3', '100'),
  ('accion.soat.ver_listado', 'soat', 'Ver el listado', 'Consultar la cola de SOAT, filtrarla y ver el detalle y el historial de cada solicitud.', 'accion', 'pagina.flito_soat', '3', '10'),
  ('accion.soat.ver_por_validar', 'soat', 'Ver solicitudes por validar', 'Buscar las solicitudes incompletas, verlas y reintentar el RUNT.', 'accion', 'pagina.flito_soat', '3', '80'),
  ('accion.soat.ver_soportes', 'soat', 'Ver soportes', 'Abrir los soportes de una solicitud.', 'accion', 'pagina.flito_soat', '3', '20'),
  ('accion.tramites.configurar_sincronizacion', 'tramites', 'Configurar la sincronización', 'Encender o apagar fuentes y gestionar el acceso a FLIT 2.', 'accion', 'pagina.flito_tramites', '3', '60'),
  ('accion.tramites.crear_demo', 'tramites', 'Crear trámites de demostración', 'Sembrar trámites de prueba en el ambiente.', 'accion', 'pagina.flito_tramites', '3', '70'),
  ('accion.tramites.descargar_soportes', 'tramites', 'Descargar soportes', 'Ver y descargar los soportes de los trámites.', 'accion', 'pagina.flito_tramites', '3', '40'),
  ('accion.tramites.entregar', 'tramites', 'Entregar trámites', 'Marcar trámites como entregados y usar la compuerta de entrega.', 'accion', 'pagina.flito_tramites', '3', '80'),
  ('accion.tramites.sincronizar', 'tramites', 'Sincronizar trámites', 'Traer los trámites nuevos de las fuentes y ver el estado de la sincronización.', 'accion', 'pagina.flito_tramites', '3', '50'),
  ('accion.tramites.solicitar_impuestos', 'tramites', 'Solicitar impuestos', 'Pedir el pago de impuestos de los trámites seleccionados.', 'accion', 'pagina.flito_tramites', '3', '30'),
  ('accion.tramites.solicitar_soat', 'tramites', 'Solicitar SOAT', 'Pedir el SOAT de los trámites seleccionados.', 'accion', 'pagina.flito_tramites', '3', '20'),
  ('accion.tramites.ver_listado', 'tramites', 'Ver el listado de trámites', 'Consultar la cola de trámites, filtrarla y ver el historial de cada uno.', 'accion', 'pagina.flito_tramites', '3', '10'),
  ('accion.impuestos.exportar_pago', 'impuestos', 'Exportar con datos de pago y trazabilidad', 'Incluir en el Excel las columnas de pago y de trazabilidad.', 'accion', 'accion.impuestos.exportar', '3', '10'),
  ('accion.soat.exportar_pago', 'soat', 'Exportar con datos de pago y trazabilidad', 'Incluir en el Excel las columnas de pago y de trazabilidad.', 'accion', 'accion.soat.exportar', '3', '10')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- 9 páginas que son ítem (nivel 2). Su padre (`menu.*`) lo pone la HU #13429.
UPDATE permisos_funciones AS f
   SET nivel = v.nivel::smallint, orden = v.orden::integer
  FROM (VALUES
    ('pagina.flito_comparendos', '2', '80'),
    ('pagina.flito_derechos', '2', '40'),
    ('pagina.flito_impuestos', '2', '30'),
    ('pagina.flito_logistica', '2', '60'),
    ('pagina.flito_logistica_ruta', '2', '70'),
    ('pagina.flito_revisiones', '2', '50'),
    ('pagina.flito_soat', '2', '20'),
    ('pagina.flito_tramites', '2', '10'),
    ('pagina.transito_organismos', '2', '10')
  ) AS v(codigo, nivel, orden)
 WHERE f.codigo = v.codigo
   AND (f.nivel, f.orden) IS DISTINCT FROM (v.nivel::smallint, v.orden::integer);
-- ÁRBOL GENERADO (fin)
