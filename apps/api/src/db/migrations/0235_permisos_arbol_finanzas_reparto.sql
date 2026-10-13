-- 0235_permisos_arbol_finanzas_reparto.sql
--
-- HU #13427 (Feature #13416, Épica #13411) — Paso de los permisos de Finanzas al árbol.
-- ADR-0025 regla 4 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §4.1 y §5-bis.
-- Autor: equipo FLITO. Antecedente: 0234 (la anterior, siembra las acciones que aquí se reparten).
--
-- Regla del paso (decisiones del PO, AC5 y 2026-10-13), para roles Y para excepciones por usuario:
--   · acción que MODIFICA → se concede a quien tenía TODOS los códigos de su grupo;
--   · acción de LECTURA (lista en `tmp_lectura_13427`) → basta ALGUNO.
-- El grupo es el PREDECESOR de la acción (§5-bis.1): las guardas que se partieron
-- (`finanzas.reporte_costos.ver` y el transitorio `siigo.parametrizacion.administrar`) son el grupo de
-- las acciones que las sustituyen, así quien tenía el código viejo las recibe todas. «Ver los gastos
-- diarios» tiene por predecesor la página `pagina.finanzas_gastos_diarios` (P-19), que NO se absorbe.
-- OPCIONALES (ni grupo, ni expansión, ni retiro; quien los tiene los conserva): `siigo.conceptos.confirmar`
-- (P-16), `siigo.factura.corregir` y `siigo.factura.anular` (P-17), y en las de lectura las descargas
-- `bolsas.soporte.descargar`, `comprobantes.archivo.descargar`, `conciliacion.comprobante.descargar`.
-- `liquidacion.pago_manual.administrar` no se toca (Órdenes de trabajo, P-14: lo retira la HU #13429).
--   Paso 1. Roles: `INSERT … SELECT … GROUP BY … HAVING count >= k` (k = |grupo|, o 1 si es de lectura).
--   Paso 2. Usuarios: conceder/revocar la acción según su conjunto efectivo viejo (rol ∪ conceder ∖ revocar).
--   Paso 2b. AC7: `admin` recibe TODAS las acciones del área (JOIN a permisos_roles).
--   Paso 3. Lo absorbido (los grupos que sobreviven al recorte, menos la página de gastos diarios) deja
--           de concederse directo: fuera sus marcas y su fila de `permisos_funciones`, incluido el
--           transitorio `siigo.parametrizacion.administrar`. Las guardas piden las operaciones; el
--           resolutor las expande desde las acciones.
-- Sin literales de rol sueltos: el único (`admin`, paso 2b) va en la forma `JOIN permisos_roles`: un
-- ambiente sin ese rol recibe 0 filas, nunca una FK rota.
-- Sin fila en `permisos_auditoria` (mismo motivo que la 0233: su CHECK de `origen` no admite 'migracion').
-- Idempotente: la segunda corrida no encuentra ningún grupo de operaciones entero (el paso 3 los borró);
-- «Ver los gastos diarios» (predecesor = la página, que sigue) se recalcula y no cambia nada; los INSERT
-- llevan ON CONFLICT DO NOTHING.

-- ÁRBOL GENERADO (inicio)
-- 70 pares acción → código de su grupo «todos». Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol finanzas --reparto
DROP TABLE IF EXISTS tmp_arbol_13427;
CREATE TEMP TABLE tmp_arbol_13427 (accion varchar(80) NOT NULL, fn varchar(80) NOT NULL, PRIMARY KEY (accion, fn));
INSERT INTO tmp_arbol_13427 (accion, fn) VALUES
  ('accion.bolsas.cerrar_periodo', 'bolsas.cierre.crear'),
  ('accion.bolsas.cerrar_periodo', 'bolsas.extracto.descargar'),
  ('accion.bolsas.crear', 'bolsas.transito.crear'),
  ('accion.bolsas.editar', 'bolsas.transito.editar'),
  ('accion.bolsas.movimientos_manuales', 'bolsas.movimiento.corregir'),
  ('accion.bolsas.movimientos_manuales', 'bolsas.movimiento.registrar'),
  ('accion.bolsas.registrar_recargas', 'bolsas.recarga.registrar'),
  ('accion.bolsas.registrar_recargas', 'bolsas.transito.cargar'),
  ('accion.bolsas.ver_alertas', 'bolsas.alertas.ver'),
  ('accion.bolsas.ver_alertas', 'bolsas.riesgo.ver'),
  ('accion.bolsas.ver_clientes', 'bolsas.bolsa.ver'),
  ('accion.bolsas.ver_clientes', 'bolsas.cierres.ver'),
  ('accion.bolsas.ver_clientes', 'bolsas.consolidado.ver'),
  ('accion.bolsas.ver_clientes', 'bolsas.movimientos.ver'),
  ('accion.bolsas.ver_transito', 'bolsas.transito.listar'),
  ('accion.bolsas.ver_transito', 'bolsas.transito.ver'),
  ('accion.bolsas.ver_transito', 'bolsas.transito.ver_movimientos'),
  ('accion.comprobantes.asociar', 'comprobantes.comprobante.aplicar'),
  ('accion.comprobantes.asociar', 'comprobantes.tramites.buscar'),
  ('accion.comprobantes.cargar', 'comprobantes.lote.cargar'),
  ('accion.comprobantes.resolver', 'comprobantes.comprobante.descartar'),
  ('accion.comprobantes.resolver', 'comprobantes.comprobante.releer'),
  ('accion.comprobantes.resolver', 'comprobantes.diferencia.aceptar'),
  ('accion.comprobantes.ver_cola', 'comprobantes.cola.ver'),
  ('accion.comprobantes.ver_cola', 'comprobantes.comprobante.ver'),
  ('accion.conciliacion.cargar_boleta', 'conciliacion.boleta.cargar'),
  ('accion.conciliacion.comprobante', 'conciliacion.comprobante.cargar'),
  ('accion.conciliacion.comprobante', 'conciliacion.comprobante.reemplazar'),
  ('accion.conciliacion.conciliar', 'conciliacion.boleta.conciliar'),
  ('accion.conciliacion.conciliar', 'conciliacion.boleta.descartar'),
  ('accion.conciliacion.conciliar', 'conciliacion.boleta.recruzar'),
  ('accion.conciliacion.ver_boletas', 'conciliacion.boleta.ver'),
  ('accion.conciliacion.ver_boletas', 'conciliacion.boletas.listar'),
  ('accion.facturacion_operacion.freno', 'siigo.parametrizacion.administrar'),
  ('accion.facturacion_operacion.gestionar', 'siigo.factura.marcar_fallido'),
  ('accion.facturacion_operacion.gestionar', 'siigo.factura.reactivar'),
  ('accion.facturacion_operacion.gestionar', 'siigo.factura.reenviar_correo'),
  ('accion.facturacion_operacion.gestionar', 'siigo.factura.reintentar'),
  ('accion.facturacion_operacion.ver_facturas', 'siigo.factura.consultar'),
  ('accion.facturacion_parametrizacion.mapeo_conceptos', 'siigo.parametrizacion.administrar'),
  ('accion.facturacion_parametrizacion.terceros', 'siigo.parametrizacion.administrar'),
  ('accion.facturacion_parametrizacion.ver', 'siigo.emision.ver'),
  ('accion.facturacion_parametrizacion.ver', 'siigo.parametrizacion.ver'),
  ('accion.gastos_diarios.ver', 'pagina.finanzas_gastos_diarios'),
  ('accion.integracion_siigo.credenciales_produccion', 'siigo.parametrizacion.administrar'),
  ('accion.integracion_siigo.credenciales_pruebas', 'siigo.parametrizacion.administrar'),
  ('accion.integracion_siigo.probar_conexion', 'siigo.parametrizacion.administrar'),
  ('accion.reporte_costos.asignar_servicios_adicionales', 'finanzas.servicios_adicionales.asignar'),
  ('accion.reporte_costos.asignar_servicios_adicionales', 'finanzas.servicios_adicionales.quitar'),
  ('accion.reporte_costos.enviar_siigo', 'siigo.factura.emitir'),
  ('accion.reporte_costos.exportar', 'finanzas.reporte_costos.ver'),
  ('accion.reporte_costos.facturar', 'liquidacion.liquidacion.facturar'),
  ('accion.reporte_costos.liquidar', 'liquidacion.liquidacion.liquidar'),
  ('accion.reporte_costos.liquidar', 'liquidacion.liquidacion.liquidar_lote'),
  ('accion.reporte_costos.reversar_liquidacion', 'liquidacion.liquidacion.reversar'),
  ('accion.reporte_costos.ver_listado', 'finanzas.reporte_costos.ver'),
  ('accion.reporte_costos.ver_listado', 'finanzas.servicios_adicionales.ver'),
  ('accion.reporte_costos.ver_listado', 'liquidacion.liquidacion.ver'),
  ('accion.reporte_costos.ver_listado', 'liquidacion.liquidacion.ver_eventos'),
  ('accion.reporte_costos.ver_soportes', 'finanzas.reporte_costos.ver'),
  ('accion.reporte_costos.ver_viajes_adicionales', 'finanzas.reporte_costos.ver'),
  ('accion.servicios_adicionales.crear', 'parametrizacion.servicios_adicionales.crear'),
  ('accion.servicios_adicionales.dar_de_baja', 'parametrizacion.servicios_adicionales.dar_de_baja'),
  ('accion.servicios_adicionales.editar', 'parametrizacion.servicios_adicionales.editar'),
  ('accion.servicios_adicionales.ver', 'parametrizacion.servicios_adicionales.listar'),
  ('accion.tarifas.crear_modificar', 'parametrizacion.tarifas.crear'),
  ('accion.tarifas.crear_modificar', 'parametrizacion.tarifas.editar'),
  ('accion.tarifas.ver', 'parametrizacion.tarifas.historial'),
  ('accion.tarifas.ver', 'parametrizacion.tarifas.listar'),
  ('accion.tarifas.ver', 'parametrizacion.tarifas.ver_por_cliente');

-- Idempotencia: una acción se reparte solo si su grupo existe ENTERO. En la segunda corrida ya no
-- existe ninguno (paso 3) y no se reparte ni se revoca nada.
DELETE FROM tmp_arbol_13427 t WHERE t.accion IN (
  SELECT x.accion FROM tmp_arbol_13427 x
   WHERE NOT EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = x.fn));

-- Lo absorbido, DESPUÉS del recorte: solo los códigos de los grupos que sobreviven, y la operación de
-- una conjunción solo si sobreviven TODAS sus acciones. Un grupo incompleto no reparte su acción y
-- tampoco pierde ninguno de sus miembros (nota de db-review, 2026-10-13).
DROP TABLE IF EXISTS tmp_absorbidas_13427;
CREATE TEMP TABLE tmp_absorbidas_13427 (fn varchar(80) PRIMARY KEY);
-- La página que es predecesor sin que la acción la conceda NO se absorbe: sigue siendo el ítem.
INSERT INTO tmp_absorbidas_13427 (fn) SELECT DISTINCT fn FROM tmp_arbol_13427
 WHERE fn NOT IN ('pagina.finanzas_gastos_diarios');

-- Acciones de LECTURA (decisión del PO del 2026-10-13): se reciben con ALGUNA operación del grupo.
DROP TABLE IF EXISTS tmp_lectura_13427;
CREATE TEMP TABLE tmp_lectura_13427 (accion varchar(80) PRIMARY KEY);
INSERT INTO tmp_lectura_13427 (accion) VALUES
  ('accion.bolsas.ver_alertas'),
  ('accion.bolsas.ver_clientes'),
  ('accion.bolsas.ver_transito'),
  ('accion.comprobantes.ver_cola'),
  ('accion.conciliacion.ver_boletas'),
  ('accion.facturacion_operacion.ver_facturas'),
  ('accion.facturacion_parametrizacion.ver'),
  ('accion.gastos_diarios.ver'),
  ('accion.reporte_costos.ver_listado'),
  ('accion.reporte_costos.ver_soportes'),
  ('accion.reporte_costos.ver_viajes_adicionales'),
  ('accion.servicios_adicionales.ver'),
  ('accion.tarifas.ver');

-- Umbral de cada acción viva: cuántos códigos del grupo hay que tener (todos; 1 si es de lectura).
DROP TABLE IF EXISTS tmp_umbral_13427;
CREATE TEMP TABLE tmp_umbral_13427 AS
SELECT t.accion, CASE WHEN l.accion IS NULL THEN count(*) ELSE 1 END AS k
  FROM tmp_arbol_13427 t LEFT JOIN tmp_lectura_13427 l ON l.accion = t.accion
 GROUP BY t.accion, l.accion;

-- Paso 1 — Roles: la acción, al rol que tenía TODOS los códigos de su grupo (ALGUNO si es de lectura).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, t.accion
  FROM permisos_rol_funcion rf
  JOIN tmp_arbol_13427 t ON t.fn = rf.funcion_codigo
 GROUP BY rf.rol_codigo, t.accion
HAVING count(DISTINCT rf.funcion_codigo) >= (SELECT u.k FROM tmp_umbral_13427 u WHERE u.accion = t.accion)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 2 — Usuarios: la misma regla (todos / alguno) sobre SU conjunto efectivo viejo, (rol ∪ conceder) \ revocar.
-- conceder si lo tenía todo y su rol (ya repartido) no da la acción; revocar si su rol la da y le
-- faltaba algo. Así cada persona queda con exactamente la regla «todos» (AC5).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT o.user_id, o.accion, CASE WHEN o.todos THEN 'conceder' ELSE 'revocar' END
  FROM (
    SELECT u.id AS user_id, a.accion,
           (SELECT count(*) FROM tmp_arbol_13427 t
             WHERE t.accion = a.accion
               AND (EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = t.fn)
                    OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = t.fn AND c.efecto = 'conceder'))
               AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion v WHERE v.user_id = u.id AND v.funcion_codigo = t.fn AND v.efecto = 'revocar')
           ) >= a.k AS todos,
           EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = a.accion) AS rol_tiene
      FROM users u
     CROSS JOIN tmp_umbral_13427 a
  ) o
 WHERE o.todos <> o.rol_tiene
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- Paso 2b — AC8 (decisión del PO del 2026-10-13): `admin` recibe TODAS las acciones, también las que
-- la regla «todos» no le daba (solicitar sin trámite: la 0226 le excluyó su grupo hasta la #12874).
-- Va DESPUÉS del paso 2 para que a sus usuarios no se les escriba un `revocar` por un grupo que el
-- rol no tenía entero. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas, no una FK rota.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.bolsas.cerrar_periodo'),
  ('admin', 'accion.bolsas.crear'),
  ('admin', 'accion.bolsas.editar'),
  ('admin', 'accion.bolsas.movimientos_manuales'),
  ('admin', 'accion.bolsas.registrar_recargas'),
  ('admin', 'accion.bolsas.ver_alertas'),
  ('admin', 'accion.bolsas.ver_clientes'),
  ('admin', 'accion.bolsas.ver_transito'),
  ('admin', 'accion.comprobantes.asociar'),
  ('admin', 'accion.comprobantes.cargar'),
  ('admin', 'accion.comprobantes.resolver'),
  ('admin', 'accion.comprobantes.ver_cola'),
  ('admin', 'accion.conciliacion.cargar_boleta'),
  ('admin', 'accion.conciliacion.comprobante'),
  ('admin', 'accion.conciliacion.conciliar'),
  ('admin', 'accion.conciliacion.ver_boletas'),
  ('admin', 'accion.facturacion_operacion.freno'),
  ('admin', 'accion.facturacion_operacion.gestionar'),
  ('admin', 'accion.facturacion_operacion.ver_facturas'),
  ('admin', 'accion.facturacion_parametrizacion.mapeo_conceptos'),
  ('admin', 'accion.facturacion_parametrizacion.terceros'),
  ('admin', 'accion.facturacion_parametrizacion.ver'),
  ('admin', 'accion.gastos_diarios.ver'),
  ('admin', 'accion.integracion_siigo.credenciales_produccion'),
  ('admin', 'accion.integracion_siigo.credenciales_pruebas'),
  ('admin', 'accion.integracion_siigo.probar_conexion'),
  ('admin', 'accion.reporte_costos.asignar_servicios_adicionales'),
  ('admin', 'accion.reporte_costos.enviar_siigo'),
  ('admin', 'accion.reporte_costos.exportar'),
  ('admin', 'accion.reporte_costos.facturar'),
  ('admin', 'accion.reporte_costos.liquidar'),
  ('admin', 'accion.reporte_costos.reversar_liquidacion'),
  ('admin', 'accion.reporte_costos.ver_listado'),
  ('admin', 'accion.reporte_costos.ver_soportes'),
  ('admin', 'accion.reporte_costos.ver_viajes_adicionales'),
  ('admin', 'accion.servicios_adicionales.crear'),
  ('admin', 'accion.servicios_adicionales.dar_de_baja'),
  ('admin', 'accion.servicios_adicionales.editar'),
  ('admin', 'accion.servicios_adicionales.ver'),
  ('admin', 'accion.tarifas.crear_modificar'),
  ('admin', 'accion.tarifas.ver')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 3 — Lo absorbido deja de concederse directo: fuera sus marcas y su fila del catálogo.
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_13427);
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_13427);
DELETE FROM permisos_funciones WHERE codigo IN (SELECT fn FROM tmp_absorbidas_13427);

DROP TABLE tmp_umbral_13427;
DROP TABLE tmp_lectura_13427;
DROP TABLE tmp_absorbidas_13427;
DROP TABLE tmp_arbol_13427;
-- ÁRBOL GENERADO (fin)
