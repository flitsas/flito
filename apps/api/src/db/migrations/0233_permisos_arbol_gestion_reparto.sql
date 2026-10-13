-- 0233_permisos_arbol_gestion_reparto.sql
--
-- HU #12873 (Feature #13416, Épica #13411) — Paso de los permisos de Gestión y Tránsito al árbol.
-- ADR-0025 regla 4 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §4.1.
-- Autor: equipo FLITO. Antecedente: 0232 (la anterior, siembra las acciones que aquí se reparten).
--
-- Regla del paso (decisiones del PO, P-1 y 2026-10-13), para roles Y para excepciones por usuario:
--   · acción que MODIFICA → se concede a quien tenía TODAS las operaciones de su grupo;
--   · acción de LECTURA (flag `lectura` del mapeo, lista en `tmp_lectura_12873`) → basta ALGUNA.
-- `logistica.actas.operar_ajenas` es OPCIONAL de «Despachar, entregar y devolver» (P-9 revisada): no
-- es grupo, la acción no la expande y no se retira; sus marcas y excepciones quedan como estaban.
--   Paso 1. Roles: `INSERT … SELECT … GROUP BY … HAVING count >= k` (k = |grupo|, o 1 si es de lectura).
--   Paso 2. Usuarios: conceder/revocar la acción según su conjunto efectivo viejo (rol ∪ conceder ∖ revocar).
--   Paso 3. Lo absorbido (los grupos, `pagina.flito_compuerta` y `tramites.solicitud.pedir_ambos`;
--           nunca los opcionales)
--           deja de concederse directo: fuera sus marcas y su fila de `permisos_funciones`. Las guardas
--           siguen pidiendo esas operaciones; el resolutor las expande desde las acciones.
--   Paso 2b. AC8 (decisión del PO del 2026-10-13): `admin` recibe TODAS las acciones, también
--           «Solicitar SOAT sin trámite», cuyo grupo la 0226 le excluyó hasta la #12874 (ya en DEV).
--           Las tres operaciones que agrupa (`soat.solicitud.crear`, `soat.runt.preconsultar`,
--           `soat.factura.leer`) no se marcan sueltas: el paso 3 las retira y la acción las expande.
-- Sin literales de rol sueltos: nada de `WHERE rol_codigo = '<rol>'` ni `VALUES ('<rol>', …)` sin JOIN.
-- El único literal (`admin`, paso 2b) va en la forma `JOIN permisos_roles` de la 0227 corregida: un
-- ambiente sin ese rol recibe 0 filas, nunca una FK rota.
-- Sin fila en `permisos_auditoria`: su CHECK de `origen` no admite 'migracion' y el de sujeto exige un
-- usuario o un rol por fila (Nota del diseño §4.1 punto 5). El rastro es este archivo y el reporte en seco.
-- Idempotente: la segunda corrida no encuentra ningún grupo entero (el paso 3 los borró) y no toca filas;
-- el paso 2b repite sus filas con ON CONFLICT DO NOTHING.

-- ÁRBOL GENERADO (inicio)
-- 125 pares acción → código de su grupo «todos». Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol gestion --reparto
DROP TABLE IF EXISTS tmp_arbol_12873;
CREATE TEMP TABLE tmp_arbol_12873 (accion varchar(80) NOT NULL, fn varchar(80) NOT NULL, PRIMARY KEY (accion, fn));
INSERT INTO tmp_arbol_12873 (accion, fn) VALUES
  ('accion.comparendos.configurar', 'comparendos.causales.crear'),
  ('accion.comparendos.configurar', 'comparendos.causales.editar'),
  ('accion.comparendos.configurar', 'comparendos.causales.listar'),
  ('accion.comparendos.configurar', 'comparendos.municipios.crear'),
  ('accion.comparendos.configurar', 'comparendos.municipios.editar'),
  ('accion.comparendos.configurar', 'comparendos.municipios.listar'),
  ('accion.comparendos.configurar', 'comparendos.nits.borrar'),
  ('accion.comparendos.configurar', 'comparendos.nits.crear'),
  ('accion.comparendos.configurar', 'comparendos.nits.editar'),
  ('accion.comparendos.configurar', 'comparendos.nits.listar'),
  ('accion.comparendos.configurar', 'comparendos.simit.guardar_token'),
  ('accion.comparendos.configurar', 'comparendos.simit.ver_token'),
  ('accion.comparendos.gestionar', 'comparendos.registro.gestionar'),
  ('accion.comparendos.sincronizar', 'comparendos.sync.lanzar'),
  ('accion.comparendos.sincronizar', 'comparendos.sync.ver_corrida'),
  ('accion.comparendos.sincronizar', 'comparendos.sync.ver_corridas'),
  ('accion.comparendos.ver_listado', 'comparendos.registro.ver'),
  ('accion.comparendos.ver_listado', 'comparendos.registro.ver_eventos'),
  ('accion.comparendos.ver_listado', 'comparendos.registros.buscar'),
  ('accion.comparendos.ver_listado', 'comparendos.registros.listar'),
  ('accion.derechos.cargar', 'derechos.candidatos.ver'),
  ('accion.derechos.cargar', 'derechos.recibos.cargar'),
  ('accion.derechos.procesar_drive', 'derechos.drive.listar'),
  ('accion.derechos.procesar_drive', 'derechos.drive.procesar'),
  ('accion.derechos.procesar_drive', 'derechos.drive.ver_registro'),
  ('accion.derechos.ver_listado', 'derechos.cola.filtrar'),
  ('accion.derechos.ver_listado', 'derechos.cola.ver'),
  ('accion.derechos.ver_soportes', 'derechos.soporte.descargar'),
  ('accion.impuestos.cargar_comprobantes', 'impuestos.recibos.cargar'),
  ('accion.impuestos.cargar_recibo_caja', 'impuestos.recibos.cargar_caja'),
  ('accion.impuestos.certificar_runt', 'impuestos.tramite.certificar'),
  ('accion.impuestos.certificar_runt', 'impuestos.tramite.certificar_lote'),
  ('accion.impuestos.corregir_direccion', 'impuestos.tramite.corregir_direccion'),
  ('accion.impuestos.descargar_certificado', 'impuestos.certificado.descargar'),
  ('accion.impuestos.descargar_zip', 'impuestos.soportes.descargar'),
  ('accion.impuestos.exportar', 'impuestos.excel.exportar'),
  ('accion.impuestos.exportar_pago', 'impuestos.excel.exportar_pago'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.asumir'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.devolver'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.enviar'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.reactivar'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.rechazar'),
  ('accion.impuestos.gestionar_solicitudes', 'impuestos.tramite.reversar'),
  ('accion.impuestos.reemplazar_comprobante', 'impuestos.recibos.reemplazar'),
  ('accion.impuestos.ver_listado', 'impuestos.cola.filtrar'),
  ('accion.impuestos.ver_listado', 'impuestos.cola.ver'),
  ('accion.impuestos.ver_listado', 'impuestos.factura.ver'),
  ('accion.impuestos.ver_listado', 'impuestos.tramite.ver'),
  ('accion.impuestos.ver_listado', 'impuestos.tramite.ver_historial'),
  ('accion.impuestos.ver_soportes', 'impuestos.tramite.ver_soportes'),
  ('accion.logistica.cerrar_lote', 'logistica.lote.cerrar'),
  ('accion.logistica.despachar_entregar_devolver', 'logistica.actas.devolver'),
  ('accion.logistica.despachar_entregar_devolver', 'logistica.actas.entregar'),
  ('accion.logistica.generar_actas', 'logistica.lt.validar'),
  ('accion.logistica.registrar_viajes', 'logistica.viajes.quitar'),
  ('accion.logistica.registrar_viajes', 'logistica.viajes.registrar'),
  ('accion.logistica.registrar_viajes', 'logistica.viajes.ver'),
  ('accion.logistica.reversar_paso', 'logistica.documento.reversar'),
  ('accion.logistica.ver_actas', 'logistica.actas.listar'),
  ('accion.logistica.ver_actas', 'logistica.actas.ver'),
  ('accion.logistica.ver_consola', 'logistica.consola.filtrar'),
  ('accion.logistica.ver_consola', 'logistica.consola.ver'),
  ('accion.logistica.ver_consola', 'logistica.documento.ver'),
  ('accion.mi_ruta.escanear', 'logistica.documento.escanear'),
  ('accion.mi_ruta.reportar_novedad', 'logistica.documento.reportar_novedad'),
  ('accion.mi_ruta.ver', 'logistica.ruta.ver'),
  ('accion.organismos_stt.editar', 'parametrizacion.organismos.editar'),
  ('accion.organismos_stt.editar', 'parametrizacion.organismos.fijar_modalidad'),
  ('accion.organismos_stt.editar', 'transito.checklist.editar'),
  ('accion.organismos_stt.editar', 'transito.config.editar'),
  ('accion.organismos_stt.editar', 'transito.logo.borrar'),
  ('accion.organismos_stt.editar', 'transito.logo.cargar'),
  ('accion.organismos_stt.ver', 'parametrizacion.organismos.listar'),
  ('accion.organismos_stt.ver', 'parametrizacion.organismos.ver_vigencias'),
  ('accion.organismos_stt.ver', 'transito.checklist.ver'),
  ('accion.organismos_stt.ver', 'transito.config.listar'),
  ('accion.organismos_stt.ver', 'transito.config.ver'),
  ('accion.organismos_stt.ver', 'transito.logo.ver'),
  ('accion.revisiones.revisar_lecturas', 'revisiones.revision.descartar'),
  ('accion.revisiones.revisar_lecturas', 'revisiones.revision.resolver'),
  ('accion.revisiones.ver', 'revisiones.campos.ver'),
  ('accion.revisiones.ver', 'revisiones.cola.ver'),
  ('accion.soat.cambiar_proveedor', 'soat.proveedor.cambiar'),
  ('accion.soat.cargar_comprobantes', 'soat.comprobante.cargar'),
  ('accion.soat.cargar_comprobantes', 'soat.masiva.cargar'),
  ('accion.soat.cargar_documentos_adicionales', 'soat.documentos_adicionales.cargar'),
  ('accion.soat.descargar_zip', 'soat.soportes.descargar'),
  ('accion.soat.eliminar_documentos_adicionales', 'soat.documentos_adicionales.eliminar'),
  ('accion.soat.exportar', 'soat.excel.exportar'),
  ('accion.soat.exportar_pago', 'soat.excel.exportar_pago'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.asumir'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.devolver'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.enviar'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.reactivar'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.rechazar'),
  ('accion.soat.gestionar_solicitudes', 'soat.solicitud.reversar'),
  ('accion.soat.solicitar_sin_tramite', 'soat.factura.leer'),
  ('accion.soat.solicitar_sin_tramite', 'soat.runt.preconsultar'),
  ('accion.soat.solicitar_sin_tramite', 'soat.solicitud.crear'),
  ('accion.soat.ver_documentos_adicionales', 'soat.documentos_adicionales.ver'),
  ('accion.soat.ver_listado', 'soat.cola.filtrar'),
  ('accion.soat.ver_listado', 'soat.cola.ver'),
  ('accion.soat.ver_listado', 'soat.solicitud.ver'),
  ('accion.soat.ver_listado', 'soat.solicitud.ver_historial'),
  ('accion.soat.ver_por_validar', 'soat.incompleta.ver'),
  ('accion.soat.ver_por_validar', 'soat.incompletas.buscar'),
  ('accion.soat.ver_soportes', 'soat.solicitud.ver_soportes'),
  ('accion.tramites.configurar_sincronizacion', 'tramites.flit2.guardar_acceso'),
  ('accion.tramites.configurar_sincronizacion', 'tramites.flit2.ver_acceso'),
  ('accion.tramites.configurar_sincronizacion', 'tramites.sincronizacion.configurar'),
  ('accion.tramites.crear_demo', 'tramites.demo.sembrar'),
  ('accion.tramites.descargar_soportes', 'tramites.soportes.descargar'),
  ('accion.tramites.descargar_soportes', 'tramites.tramite.ver_soportes'),
  ('accion.tramites.entregar', 'compuerta.cola.ver'),
  ('accion.tramites.entregar', 'compuerta.tramite.entregar'),
  ('accion.tramites.entregar', 'compuerta.tramite.ver'),
  ('accion.tramites.entregar', 'pagina.flito_compuerta'),
  ('accion.tramites.entregar', 'tramites.tramite.entregar'),
  ('accion.tramites.sincronizar', 'sync.sync.lanzar'),
  ('accion.tramites.sincronizar', 'sync.sync.ver_estado'),
  ('accion.tramites.solicitar_impuestos', 'tramites.solicitud.pedir_impuestos'),
  ('accion.tramites.solicitar_soat', 'tramites.solicitud.pedir_soat'),
  ('accion.tramites.ver_listado', 'tramites.cola.filtrar'),
  ('accion.tramites.ver_listado', 'tramites.cola.ver'),
  ('accion.tramites.ver_listado', 'tramites.tramite.ver_historial');

-- Idempotencia: una acción se reparte solo si su grupo existe ENTERO. En la segunda corrida ya no
-- existe ninguno (paso 3) y no se reparte ni se revoca nada.
DELETE FROM tmp_arbol_12873 t WHERE t.accion IN (
  SELECT x.accion FROM tmp_arbol_12873 x
   WHERE NOT EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = x.fn));

-- Lo absorbido, DESPUÉS del recorte: solo los códigos de los grupos que sobreviven, y la operación de
-- una conjunción solo si sobreviven TODAS sus acciones. Un grupo incompleto no reparte su acción y
-- tampoco pierde ninguno de sus miembros (nota de db-review, 2026-10-13).
DROP TABLE IF EXISTS tmp_absorbidas_12873;
CREATE TEMP TABLE tmp_absorbidas_12873 (fn varchar(80) PRIMARY KEY);
INSERT INTO tmp_absorbidas_12873 (fn) SELECT DISTINCT fn FROM tmp_arbol_12873;
INSERT INTO tmp_absorbidas_12873 (fn)
SELECT c.fn FROM (VALUES
  ('tramites.solicitud.pedir_ambos', 'accion.tramites.solicitar_impuestos'),
  ('tramites.solicitud.pedir_ambos', 'accion.tramites.solicitar_soat')
) AS c(fn, accion)
 GROUP BY c.fn
HAVING bool_and(EXISTS (SELECT 1 FROM tmp_arbol_12873 t WHERE t.accion = c.accion))
ON CONFLICT (fn) DO NOTHING;

-- Acciones de LECTURA (decisión del PO del 2026-10-13): se reciben con ALGUNA operación del grupo.
DROP TABLE IF EXISTS tmp_lectura_12873;
CREATE TEMP TABLE tmp_lectura_12873 (accion varchar(80) PRIMARY KEY);
INSERT INTO tmp_lectura_12873 (accion) VALUES
  ('accion.comparendos.ver_listado'),
  ('accion.derechos.ver_listado'),
  ('accion.impuestos.ver_listado'),
  ('accion.impuestos.ver_soportes'),
  ('accion.logistica.ver_actas'),
  ('accion.logistica.ver_consola'),
  ('accion.mi_ruta.ver'),
  ('accion.organismos_stt.ver'),
  ('accion.revisiones.ver'),
  ('accion.soat.ver_documentos_adicionales'),
  ('accion.soat.ver_listado'),
  ('accion.soat.ver_por_validar'),
  ('accion.soat.ver_soportes'),
  ('accion.tramites.ver_listado');

-- Umbral de cada acción viva: cuántos códigos del grupo hay que tener (todos; 1 si es de lectura).
DROP TABLE IF EXISTS tmp_umbral_12873;
CREATE TEMP TABLE tmp_umbral_12873 AS
SELECT t.accion, CASE WHEN l.accion IS NULL THEN count(*) ELSE 1 END AS k
  FROM tmp_arbol_12873 t LEFT JOIN tmp_lectura_12873 l ON l.accion = t.accion
 GROUP BY t.accion, l.accion;

-- Paso 1 — Roles: la acción, al rol que tenía TODOS los códigos de su grupo (ALGUNO si es de lectura).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, t.accion
  FROM permisos_rol_funcion rf
  JOIN tmp_arbol_12873 t ON t.fn = rf.funcion_codigo
 GROUP BY rf.rol_codigo, t.accion
HAVING count(DISTINCT rf.funcion_codigo) >= (SELECT u.k FROM tmp_umbral_12873 u WHERE u.accion = t.accion)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 2 — Usuarios: la misma regla (todos / alguno) sobre SU conjunto efectivo viejo, (rol ∪ conceder) \ revocar.
-- conceder si lo tenía todo y su rol (ya repartido) no da la acción; revocar si su rol la da y le
-- faltaba algo. Así cada persona queda con exactamente la regla «todos» (AC5).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT o.user_id, o.accion, CASE WHEN o.todos THEN 'conceder' ELSE 'revocar' END
  FROM (
    SELECT u.id AS user_id, a.accion,
           (SELECT count(*) FROM tmp_arbol_12873 t
             WHERE t.accion = a.accion
               AND (EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = t.fn)
                    OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = t.fn AND c.efecto = 'conceder'))
               AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion v WHERE v.user_id = u.id AND v.funcion_codigo = t.fn AND v.efecto = 'revocar')
           ) >= a.k AS todos,
           EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = a.accion) AS rol_tiene
      FROM users u
     CROSS JOIN tmp_umbral_12873 a
  ) o
 WHERE o.todos <> o.rol_tiene
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- Paso 2b — AC8 (decisión del PO del 2026-10-13): `admin` recibe TODAS las acciones, también las que
-- la regla «todos» no le daba (solicitar sin trámite: la 0226 le excluyó su grupo hasta la #12874).
-- Va DESPUÉS del paso 2 para que a sus usuarios no se les escriba un `revocar` por un grupo que el
-- rol no tenía entero. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas, no una FK rota.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.comparendos.configurar'),
  ('admin', 'accion.comparendos.gestionar'),
  ('admin', 'accion.comparendos.sincronizar'),
  ('admin', 'accion.comparendos.ver_listado'),
  ('admin', 'accion.derechos.cargar'),
  ('admin', 'accion.derechos.procesar_drive'),
  ('admin', 'accion.derechos.ver_listado'),
  ('admin', 'accion.derechos.ver_soportes'),
  ('admin', 'accion.impuestos.cargar_comprobantes'),
  ('admin', 'accion.impuestos.cargar_recibo_caja'),
  ('admin', 'accion.impuestos.certificar_runt'),
  ('admin', 'accion.impuestos.corregir_direccion'),
  ('admin', 'accion.impuestos.descargar_certificado'),
  ('admin', 'accion.impuestos.descargar_zip'),
  ('admin', 'accion.impuestos.exportar'),
  ('admin', 'accion.impuestos.exportar_pago'),
  ('admin', 'accion.impuestos.gestionar_solicitudes'),
  ('admin', 'accion.impuestos.reemplazar_comprobante'),
  ('admin', 'accion.impuestos.ver_listado'),
  ('admin', 'accion.impuestos.ver_soportes'),
  ('admin', 'accion.logistica.cerrar_lote'),
  ('admin', 'accion.logistica.despachar_entregar_devolver'),
  ('admin', 'accion.logistica.generar_actas'),
  ('admin', 'accion.logistica.registrar_viajes'),
  ('admin', 'accion.logistica.reversar_paso'),
  ('admin', 'accion.logistica.ver_actas'),
  ('admin', 'accion.logistica.ver_consola'),
  ('admin', 'accion.mi_ruta.escanear'),
  ('admin', 'accion.mi_ruta.reportar_novedad'),
  ('admin', 'accion.mi_ruta.ver'),
  ('admin', 'accion.organismos_stt.editar'),
  ('admin', 'accion.organismos_stt.ver'),
  ('admin', 'accion.revisiones.revisar_lecturas'),
  ('admin', 'accion.revisiones.ver'),
  ('admin', 'accion.soat.cambiar_proveedor'),
  ('admin', 'accion.soat.cargar_comprobantes'),
  ('admin', 'accion.soat.cargar_documentos_adicionales'),
  ('admin', 'accion.soat.descargar_zip'),
  ('admin', 'accion.soat.eliminar_documentos_adicionales'),
  ('admin', 'accion.soat.exportar'),
  ('admin', 'accion.soat.exportar_pago'),
  ('admin', 'accion.soat.gestionar_solicitudes'),
  ('admin', 'accion.soat.solicitar_sin_tramite'),
  ('admin', 'accion.soat.ver_documentos_adicionales'),
  ('admin', 'accion.soat.ver_listado'),
  ('admin', 'accion.soat.ver_por_validar'),
  ('admin', 'accion.soat.ver_soportes'),
  ('admin', 'accion.tramites.configurar_sincronizacion'),
  ('admin', 'accion.tramites.crear_demo'),
  ('admin', 'accion.tramites.descargar_soportes'),
  ('admin', 'accion.tramites.entregar'),
  ('admin', 'accion.tramites.sincronizar'),
  ('admin', 'accion.tramites.solicitar_impuestos'),
  ('admin', 'accion.tramites.solicitar_soat'),
  ('admin', 'accion.tramites.ver_listado')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 3 — Lo absorbido deja de concederse directo: fuera sus marcas y su fila del catálogo.
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_12873);
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_12873);
DELETE FROM permisos_funciones WHERE codigo IN (SELECT fn FROM tmp_absorbidas_12873);

DROP TABLE tmp_umbral_12873;
DROP TABLE tmp_lectura_12873;
DROP TABLE tmp_absorbidas_12873;
DROP TABLE tmp_arbol_12873;
-- ÁRBOL GENERADO (fin)
