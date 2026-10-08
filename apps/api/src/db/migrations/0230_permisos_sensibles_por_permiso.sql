-- 0230_permisos_sensibles_por_permiso.sql
-- Feature #13413 «Modulos antiguos por permiso, sin nombres de rol» (Epica #13411). HU #13423 (pieza
--   backend): LAFT, Privacidad, Firma, Drive, SOAT antiguo y Siigo piden permiso, no rol; y las cuatro
--   operaciones que hoy solo exigen sesion (/api/vehicles, /api/runt/consulta-persona, ocr-cedula y
--   fasecolda) piden un permiso nuevo. Cierra la reconduccion: ningun `requireRole(` en apps/api/src/modules.
-- Autor: equipo FLITO. Antecedentes: 0229 (la anterior, misma receta), 0227 (ADR-0023), 0226/ADR-0022
--   (admin explicito en el mismo archivo).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--     Sin tablas temporales. Se verifica con `psql -1 -v ON_ERROR_STOP=1 -f <archivo>` (dos veces).
--   - Idempotente en sentido fuerte: todo INSERT con ON CONFLICT DO NOTHING; ni UPDATE ni DELETE.
--   - Paridad (AC6): cada operacion de los seis directorios lleva la lista LITERAL del `requireRole`
--     que la decidia (o de la fila de su accion en la vieja tabla de roles por accion de Siigo). Un
--     permiso que agrupa varias guardas solo agrupa guardas con la MISMA lista: nadie gana.
--   - Las cuatro de solo sesion: COPIA VIVA del reparto (roles y excepciones por usuario, `efecto`
--     incluido) de las paginas cuyas pantallas las llaman, medidas con grep sobre apps/web/src:
--       vehicles.vehiculos.consultar   <- pagina.vehicles, pagina.soat, pagina.fleet, pagina.tramite
--       runt.persona.consultar         <- pagina.tramite
--       runt.cedula.leer               <- pagina.tramite
--       integraciones.fasecolda.buscar <- pagina.tramite
--     Quien no tiene ninguna de esas paginas deja de alcanzarlas: lo lista el reporte en seco
--     (`npm run permisos:en-seco -w apps/api -- --hu 13423`) y lo aprueba el PO antes de DEV (AC7).
--   - Roles literales SOLO por JOIN con permisos_roles (leccion del CD de DEV con la 0227).
--   - `admin` recibe explicitamente cada funcion nueva (AC8, ADR-0022).
--   - Formas parseables por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — Las 42 operaciones nuevas ────────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('drive.archivos.administrar', 'derechos', 'Administrar Google Drive', 'Transitorio (retira la HU #13429): acciones administrativas de «Google Drive».', 'operacion'),
  ('firma.estado.ver', 'tramite', 'Ver el estado de la firma', 'Leer el estado de las firmas digitales de un trámite.', 'operacion'),
  ('firma.solicitud.administrar', 'tramite', 'Administrar Trámite Digital — firma', 'Transitorio (retira la HU #13429): solicitar la firma digital de un trámite de «Trámite Digital».', 'operacion'),
  ('integraciones.fasecolda.buscar', 'tramite', 'Buscar en Fasecolda', 'Buscar el valor de referencia de un vehículo en Fasecolda.', 'operacion'),
  ('laft.bitacora.ver', 'cumplimiento_laft', 'Ver la bitácora LAFT', 'Leer la bitácora de auditoría de Cumplimiento LAFT.', 'operacion'),
  ('laft.capacitaciones.operar', 'cumplimiento_laft', 'Gestionar capacitaciones LAFT', 'Ver y crear capacitaciones LAFT y registrar su asistencia.', 'operacion'),
  ('laft.contrapartes.operar', 'cumplimiento_laft', 'Gestionar contrapartes LAFT', 'Ver, crear, editar y cambiar el estado de las contrapartes de Cumplimiento LAFT.', 'operacion'),
  ('laft.efectivo.operar', 'cumplimiento_laft', 'Gestionar operaciones en efectivo', 'Ver y registrar operaciones en efectivo y generar y descargar los reportes RTE y AROS.', 'operacion'),
  ('laft.empleados.operar', 'cumplimiento_laft', 'Gestionar el conocimiento de empleados (KYC)', 'Ver y actualizar el KYC, los antecedentes y la re-verificación de empleados.', 'operacion'),
  ('laft.inusuales.operar', 'cumplimiento_laft', 'Gestionar operaciones inusuales', 'Ver, registrar y actualizar operaciones inusuales.', 'operacion'),
  ('laft.listas.administrar', 'cumplimiento_laft', 'Administrar Cumplimiento LAFT — listas restrictivas', 'Transitorio (retira la HU #13429): sincronizar una lista y cargarla desde CSV de «Cumplimiento LAFT».', 'operacion'),
  ('laft.listas.operar', 'cumplimiento_laft', 'Consultar y cotejar listas restrictivas', 'Ver las listas restrictivas, cotejar una contraparte contra ellas y leer sus coincidencias.', 'operacion'),
  ('laft.manual.administrar', 'cumplimiento_laft', 'Administrar Manual SARLAFT', 'Transitorio (retira la HU #13429): crear y publicar versiones de «Manual SARLAFT».', 'operacion'),
  ('laft.manual.firmar', 'cumplimiento_laft', 'Firmar el manual SARLAFT', 'Firmar una versión del manual SARLAFT.', 'operacion'),
  ('laft.oficial.administrar', 'cumplimiento_laft', 'Administrar Oficial cumplimiento', 'Transitorio (retira la HU #13429): designar y revocar al oficial de «Oficial cumplimiento».', 'operacion'),
  ('laft.plan_auditoria.administrar', 'cumplimiento_laft', 'Administrar Plan de auditorías', 'Transitorio (retira la HU #13429): acciones administrativas de «Plan de auditorías».', 'operacion'),
  ('laft.retencion.administrar', 'cumplimiento_laft', 'Administrar Cumplimiento LAFT — retención', 'Transitorio (retira la HU #13429): anonimizar registros vencidos de «Cumplimiento LAFT».', 'operacion'),
  ('laft.ros.exportar', 'cumplimiento_laft', 'Exportar ROS para SIREL', 'Generar y descargar el PDF y el CSV de un ROS para SIREL.', 'operacion'),
  ('laft.ros.operar', 'cumplimiento_laft', 'Gestionar reportes de operación sospechosa (ROS)', 'Ver, crear, clasificar, enviar y radicar en SIREL los ROS.', 'operacion'),
  ('laft.sincronizacion.administrar', 'cumplimiento_laft', 'Administrar Cumplimiento LAFT — sincronización', 'Transitorio (retira la HU #13429): disparar a mano la sincronización de una lista de «Cumplimiento LAFT».', 'operacion'),
  ('laft.sincronizacion.ver', 'cumplimiento_laft', 'Ver la sincronización de listas', 'Leer los trabajos de sincronización de listas restrictivas.', 'operacion'),
  ('laft.tablero.ver', 'cumplimiento_laft', 'Ver el tablero LAFT', 'Leer los indicadores del tablero de Cumplimiento LAFT.', 'operacion'),
  ('privacy.accesos_pii.ver', 'administracion', 'Ver el log de accesos a datos personales', 'Leer el registro de accesos a datos personales y sus estadísticas.', 'operacion'),
  ('privacy.olvido.administrar', 'administracion', 'Administrar Privacidad y datos — olvido', 'Transitorio (retira la HU #13429): anonimizar los datos de un titular de «Privacidad y datos».', 'operacion'),
  ('privacy.titulares.operar', 'administracion', 'Previsualizar los datos de un titular', 'Ver qué datos guarda FLITO de un titular antes de atender su solicitud (Ley 1581).', 'operacion'),
  ('runt.cedula.leer', 'tramite', 'Leer una cédula con OCR', 'Extraer los datos de la foto de un documento de identidad.', 'operacion'),
  ('runt.persona.consultar', 'tramite', 'Consultar una persona en el RUNT', 'Consultar en el RUNT los datos de una persona por su documento.', 'operacion'),
  ('siigo.conceptos.confirmar', 'finanzas', 'Confirmar el mapeo de un concepto', 'Confirmar el producto Siigo de un concepto de facturación.', 'operacion'),
  ('siigo.emision.ver', 'finanzas', 'Ver la configuración de emisión', 'Leer la copia local de los catálogos de emisión de Siigo.', 'operacion'),
  ('siigo.factura.anular', 'finanzas', 'Anular una factura electrónica', 'Anular una factura electrónica.', 'operacion'),
  ('siigo.factura.consultar', 'finanzas', 'Consultar facturas electrónicas', 'Ver la bandeja, la línea de tiempo y el estado de una factura electrónica.', 'operacion'),
  ('siigo.factura.corregir', 'finanzas', 'Corregir una factura electrónica', 'Corregir los datos de una factura electrónica.', 'operacion'),
  ('siigo.factura.emitir', 'finanzas', 'Emitir factura electrónica', 'Emitir una factura electrónica en Siigo (y sincronizar sus terceros).', 'operacion'),
  ('siigo.factura.marcar_fallido', 'finanzas', 'Marcar una factura como fallida', 'Marcar como fallida una factura electrónica.', 'operacion'),
  ('siigo.factura.reactivar', 'finanzas', 'Reactivar una factura electrónica', 'Reactivar una factura electrónica marcada como fallida.', 'operacion'),
  ('siigo.factura.reenviar_correo', 'finanzas', 'Reenviar el correo de una factura', 'Reenviar al cliente el correo de una factura electrónica.', 'operacion'),
  ('siigo.factura.reintentar', 'finanzas', 'Reintentar factura electrónica', 'Reintentar el envío de una factura electrónica fallida.', 'operacion'),
  ('siigo.parametrizacion.administrar', 'finanzas', 'Administrar Facturación electrónica · Parametrización', 'Transitorio (retira la HU #13429): credenciales, sincronización de catálogos, mapeos, ciudades, freno y validación de clientes de «Facturación electrónica · Parametrización».', 'operacion'),
  ('siigo.parametrizacion.ver', 'finanzas', 'Ver la parametrización de facturación electrónica', 'Leer la compuerta, el mapeo de conceptos, las ciudades, el freno y la validación de clientes de Siigo.', 'operacion'),
  ('soat.antiguo.administrar', 'operaciones', 'Administrar SOAT', 'Transitorio (retira la HU #13429): acciones administrativas de «SOAT».', 'operacion'),
  ('soat.antiguo.operar', 'operaciones', 'Gestionar solicitudes SOAT (módulo anterior)', 'Ver las solicitudes SOAT del módulo anterior, registrar su compra y rechazarlas.', 'operacion'),
  ('vehicles.vehiculos.consultar', 'operaciones', 'Consultar vehículos', 'Leer el listado de vehículos y el pasaporte de un vehículo (historial, sincronizarlo y certificado).', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto literal: admin en TODO lo nuevo (AC8) + la lista de cada guarda vieja ──────────
-- Solo a roles que existen en este ambiente (JOIN con permisos_roles).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'drive.archivos.administrar'),
  ('admin', 'firma.estado.ver'),
  ('transito', 'firma.estado.ver'),
  ('admin', 'firma.solicitud.administrar'),
  ('admin', 'integraciones.fasecolda.buscar'),
  ('admin', 'laft.bitacora.ver'),
  ('compliance', 'laft.bitacora.ver'),
  ('admin', 'laft.capacitaciones.operar'),
  ('compliance', 'laft.capacitaciones.operar'),
  ('admin', 'laft.contrapartes.operar'),
  ('compliance', 'laft.contrapartes.operar'),
  ('admin', 'laft.efectivo.operar'),
  ('compliance', 'laft.efectivo.operar'),
  ('admin', 'laft.empleados.operar'),
  ('compliance', 'laft.empleados.operar'),
  ('admin', 'laft.inusuales.operar'),
  ('compliance', 'laft.inusuales.operar'),
  ('admin', 'laft.listas.administrar'),
  ('admin', 'laft.listas.operar'),
  ('compliance', 'laft.listas.operar'),
  ('admin', 'laft.manual.administrar'),
  ('admin', 'laft.manual.firmar'),
  ('compliance', 'laft.manual.firmar'),
  ('admin', 'laft.oficial.administrar'),
  ('admin', 'laft.plan_auditoria.administrar'),
  ('compliance', 'laft.plan_auditoria.administrar'),
  ('admin', 'laft.retencion.administrar'),
  ('admin', 'laft.ros.exportar'),
  ('compliance', 'laft.ros.exportar'),
  ('admin', 'laft.ros.operar'),
  ('compliance', 'laft.ros.operar'),
  ('admin', 'laft.sincronizacion.administrar'),
  ('admin', 'laft.sincronizacion.ver'),
  ('compliance', 'laft.sincronizacion.ver'),
  ('admin', 'laft.tablero.ver'),
  ('auditor', 'laft.tablero.ver'),
  ('compliance', 'laft.tablero.ver'),
  ('admin', 'privacy.accesos_pii.ver'),
  ('compliance', 'privacy.accesos_pii.ver'),
  ('admin', 'privacy.olvido.administrar'),
  ('admin', 'privacy.titulares.operar'),
  ('compliance', 'privacy.titulares.operar'),
  ('admin', 'runt.cedula.leer'),
  ('admin', 'runt.persona.consultar'),
  ('admin', 'siigo.conceptos.confirmar'),
  ('financiera', 'siigo.conceptos.confirmar'),
  ('admin', 'siigo.emision.ver'),
  ('financiera', 'siigo.emision.ver'),
  ('admin', 'siigo.factura.anular'),
  ('financiera', 'siigo.factura.anular'),
  ('admin', 'siigo.factura.consultar'),
  ('auditor', 'siigo.factura.consultar'),
  ('financiera', 'siigo.factura.consultar'),
  ('admin', 'siigo.factura.corregir'),
  ('financiera', 'siigo.factura.corregir'),
  ('admin', 'siigo.factura.emitir'),
  ('financiera', 'siigo.factura.emitir'),
  ('admin', 'siigo.factura.marcar_fallido'),
  ('financiera', 'siigo.factura.marcar_fallido'),
  ('admin', 'siigo.factura.reactivar'),
  ('financiera', 'siigo.factura.reactivar'),
  ('admin', 'siigo.factura.reenviar_correo'),
  ('financiera', 'siigo.factura.reenviar_correo'),
  ('admin', 'siigo.factura.reintentar'),
  ('financiera', 'siigo.factura.reintentar'),
  ('admin', 'siigo.parametrizacion.administrar'),
  ('admin', 'siigo.parametrizacion.ver'),
  ('auditor', 'siigo.parametrizacion.ver'),
  ('financiera', 'siigo.parametrizacion.ver'),
  ('admin', 'soat.antiguo.administrar'),
  ('admin', 'soat.antiguo.operar'),
  ('proveedor', 'soat.antiguo.operar'),
  ('admin', 'vehicles.vehiculos.consultar')
  ) AS v(rol, fn)
  JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 3 — Las cuatro de solo sesion: copia viva de las paginas que las usan (roles y excepciones) ─
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.fleet'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.fleet'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.soat'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.soat'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('integraciones.fasecolda.buscar'),
  ('runt.cedula.leer'),
  ('runt.persona.consultar'),
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.tramite'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('integraciones.fasecolda.buscar'),
  ('runt.cedula.leer'),
  ('runt.persona.consultar'),
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.tramite'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.vehicles'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('vehicles.vehiculos.consultar')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.vehicles'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- ── Resumen y control, dentro de la transaccion del runner ─────────────────────────────────────────
-- Un rol no-admin que falte en el ambiente NO aborta: el JOIN ya lo omitio y no concede nada hoy.
DO $resumen0230$
DECLARE
  n_ops int; n_sin_admin int; n_cortas int; n_rol_nuevas int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN ('drive.archivos.administrar','firma.estado.ver','firma.solicitud.administrar','integraciones.fasecolda.buscar','laft.bitacora.ver','laft.capacitaciones.operar','laft.contrapartes.operar','laft.efectivo.operar','laft.empleados.operar','laft.inusuales.operar','laft.listas.administrar','laft.listas.operar','laft.manual.administrar','laft.manual.firmar','laft.oficial.administrar','laft.plan_auditoria.administrar','laft.retencion.administrar','laft.ros.exportar','laft.ros.operar','laft.sincronizacion.administrar','laft.sincronizacion.ver','laft.tablero.ver','privacy.accesos_pii.ver','privacy.olvido.administrar','privacy.titulares.operar','runt.cedula.leer','runt.persona.consultar','siigo.conceptos.confirmar','siigo.emision.ver','siigo.factura.anular','siigo.factura.consultar','siigo.factura.corregir','siigo.factura.emitir','siigo.factura.marcar_fallido','siigo.factura.reactivar','siigo.factura.reenviar_correo','siigo.factura.reintentar','siigo.parametrizacion.administrar','siigo.parametrizacion.ver','soat.antiguo.administrar','soat.antiguo.operar','vehicles.vehiculos.consultar');
  IF n_ops <> 42 THEN
    RAISE EXCEPTION '0230: catalogo incompleto (operaciones=% de 42)', n_ops;
  END IF;
  IF EXISTS (SELECT 1 FROM permisos_roles WHERE codigo = 'admin') THEN
    SELECT count(*) INTO n_sin_admin FROM permisos_funciones f
      WHERE f.codigo IN ('drive.archivos.administrar','firma.estado.ver','firma.solicitud.administrar','integraciones.fasecolda.buscar','laft.bitacora.ver','laft.capacitaciones.operar','laft.contrapartes.operar','laft.efectivo.operar','laft.empleados.operar','laft.inusuales.operar','laft.listas.administrar','laft.listas.operar','laft.manual.administrar','laft.manual.firmar','laft.oficial.administrar','laft.plan_auditoria.administrar','laft.retencion.administrar','laft.ros.exportar','laft.ros.operar','laft.sincronizacion.administrar','laft.sincronizacion.ver','laft.tablero.ver','privacy.accesos_pii.ver','privacy.olvido.administrar','privacy.titulares.operar','runt.cedula.leer','runt.persona.consultar','siigo.conceptos.confirmar','siigo.emision.ver','siigo.factura.anular','siigo.factura.consultar','siigo.factura.corregir','siigo.factura.emitir','siigo.factura.marcar_fallido','siigo.factura.reactivar','siigo.factura.reenviar_correo','siigo.factura.reintentar','siigo.parametrizacion.administrar','siigo.parametrizacion.ver','soat.antiguo.administrar','soat.antiguo.operar','vehicles.vehiculos.consultar')
        AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = 'admin' AND rf.funcion_codigo = f.codigo);
    IF n_sin_admin <> 0 THEN
      RAISE EXCEPTION '0230: % funciones nuevas sin admin (AC8)', n_sin_admin;
    END IF;
  END IF;
  -- Paridad de la copia viva: cada rol (y excepcion de usuario) de una pagina de origen tiene su destino.
  SELECT count(*) INTO n_cortas FROM (VALUES
    ('pagina.fleet', 'vehicles.vehiculos.consultar'),
    ('pagina.soat', 'vehicles.vehiculos.consultar'),
    ('pagina.tramite', 'integraciones.fasecolda.buscar'),
    ('pagina.tramite', 'runt.cedula.leer'),
    ('pagina.tramite', 'runt.persona.consultar'),
    ('pagina.tramite', 'vehicles.vehiculos.consultar'),
    ('pagina.vehicles', 'vehicles.vehiculos.consultar')
  ) AS v(origen, fn)
    WHERE EXISTS (SELECT 1 FROM permisos_rol_funcion o WHERE o.funcion_codigo = v.origen
                    AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion d WHERE d.rol_codigo = o.rol_codigo AND d.funcion_codigo = v.fn))
       OR EXISTS (SELECT 1 FROM permisos_usuario_funcion o WHERE o.funcion_codigo = v.origen
                    AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion d WHERE d.user_id = o.user_id AND d.funcion_codigo = v.fn));
  IF n_cortas <> 0 THEN
    RAISE EXCEPTION '0230: % copias con MENOS reparto que su pagina de origen (paridad)', n_cortas;
  END IF;
  SELECT count(*) INTO n_rol_nuevas FROM permisos_rol_funcion WHERE funcion_codigo IN ('drive.archivos.administrar','firma.estado.ver','firma.solicitud.administrar','integraciones.fasecolda.buscar','laft.bitacora.ver','laft.capacitaciones.operar','laft.contrapartes.operar','laft.efectivo.operar','laft.empleados.operar','laft.inusuales.operar','laft.listas.administrar','laft.listas.operar','laft.manual.administrar','laft.manual.firmar','laft.oficial.administrar','laft.plan_auditoria.administrar','laft.retencion.administrar','laft.ros.exportar','laft.ros.operar','laft.sincronizacion.administrar','laft.sincronizacion.ver','laft.tablero.ver','privacy.accesos_pii.ver','privacy.olvido.administrar','privacy.titulares.operar','runt.cedula.leer','runt.persona.consultar','siigo.conceptos.confirmar','siigo.emision.ver','siigo.factura.anular','siigo.factura.consultar','siigo.factura.corregir','siigo.factura.emitir','siigo.factura.marcar_fallido','siigo.factura.reactivar','siigo.factura.reenviar_correo','siigo.factura.reintentar','siigo.parametrizacion.administrar','siigo.parametrizacion.ver','soat.antiguo.administrar','soat.antiguo.operar','vehicles.vehiculos.consultar');
  RAISE NOTICE '0230: % operaciones; % filas de rol en las nuevas', n_ops, n_rol_nuevas;
END $resumen0230$;
