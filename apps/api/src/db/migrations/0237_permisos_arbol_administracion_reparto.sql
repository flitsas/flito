-- 0237_permisos_arbol_administracion_reparto.sql
--
-- HU #13428 (Feature #13416, Épica #13411) — Paso de los permisos de Administración, General, Perfil,
-- Clientes y proveedores y Bitácora al árbol.
-- ADR-0025 regla 4 · diseño docs/arquitectura/feature-13416-catalogo-tres-niveles.md §4.1 y §5-ter.
-- Autor: equipo FLITO. Antecedente: 0236 (la anterior, siembra las acciones que aquí se reparten).
--
-- Regla del paso (decisiones del PO, AC5 y 2026-10-13), para roles Y para excepciones por usuario:
--   · acción que MODIFICA → se concede a quien tenía TODOS los códigos de su grupo;
--   · acción de LECTURA (lista en `tmp_lectura_13428`) → basta ALGUNO. Opcionales del área: ninguno.
-- El grupo es el PREDECESOR de la acción (§5-ter.1 punto 2): el transitorio `clients.clientes.administrar`
-- y `parametrizacion.companias.editar` se partieron en operaciones nuevas (crear, editar, datos fiscales;
-- autogestión y «SOAT sin trámite» de la compañía), y quien tenía el código viejo recibe las acciones
-- que lo sustituyen. «Ver el tablero» absorbe `pagina.flito_tablero` (P-11).
--   Paso 1.  Roles: `INSERT … SELECT … GROUP BY … HAVING count >= k` (k = |grupo|, o 1 si es de lectura).
--   Paso 1b. P-22: «Ver mis datos», «Cambiar mi contraseña» y `pagina.perfil` a CADA rol de
--            `permisos_roles` (sin literales: un rol ausente = 0 filas), solo si ningún rol tenía la acción.
--   Paso 2.  Usuarios: conceder/revocar la acción según su conjunto efectivo viejo (rol ∪ conceder ∖ revocar).
--            Las de Perfil no pasan por aquí (no existían: nadie las tenía revocadas).
--   Paso 2b. AC7: `admin` recibe TODAS las acciones del área (JOIN a permisos_roles).
--   Paso 3.  Lo absorbido (los grupos que sobreviven al recorte) deja de concederse directo: fuera sus
--            marcas y su fila de `permisos_funciones`, incluidos el transitorio `clients.clientes.administrar`
--            y `pagina.flito_tablero`. Las guardas piden las operaciones; el resolutor las expande.
-- Anti-bloqueo: `usuarios.usuario.editar` y `permisos.cuadro.guardar` dejan de tener filas; el invariante
-- (`shared/permisos-anti-bloqueo.ts`) cuenta sobre el conjunto expandido desde esta HU.
-- Sin fila en `permisos_auditoria` (mismo motivo que la 0233: su CHECK de `origen` no admite 'migracion').
-- Idempotente: la segunda corrida no encuentra ningún grupo de operaciones entero (el paso 3 los borró),
-- el paso 1b no reparte porque los roles ya tienen las acciones de Perfil, y los INSERT llevan
-- ON CONFLICT DO NOTHING.

-- ÁRBOL GENERADO (inicio)
-- 36 pares acción → código de su grupo «todos». Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol administracion --reparto
DROP TABLE IF EXISTS tmp_arbol_13428;
CREATE TEMP TABLE tmp_arbol_13428 (accion varchar(80) NOT NULL, fn varchar(80) NOT NULL, PRIMARY KEY (accion, fn));
INSERT INTO tmp_arbol_13428 (accion, fn) VALUES
  ('accion.bitacora.ver', 'bitacora.bitacora.ver'),
  ('accion.bitacora.ver', 'bitacora.bitacora.ver_recurso'),
  ('accion.clientes.autogestion', 'parametrizacion.companias.editar'),
  ('accion.clientes.autogestion', 'tramites.autogestion.desbloquear'),
  ('accion.clientes.autogestion', 'tramites.autogestion.revocar'),
  ('accion.clientes.crear_editar_clientes', 'clients.clientes.administrar'),
  ('accion.clientes.crear_editar_clientes', 'parametrizacion.companias.editar'),
  ('accion.clientes.crear_editar_clientes', 'tramites.empresa.crear'),
  ('accion.clientes.crear_editar_proveedores', 'parametrizacion.proveedores.crear'),
  ('accion.clientes.crear_editar_proveedores', 'parametrizacion.proveedores.editar'),
  ('accion.clientes.datos_fiscales', 'clients.clientes.administrar'),
  ('accion.clientes.soat_sin_tramite', 'parametrizacion.companias.editar'),
  ('accion.clientes.ver', 'clients.clientes.ver'),
  ('accion.clientes.ver', 'parametrizacion.companias.listar'),
  ('accion.clientes.ver', 'parametrizacion.proveedores.listar'),
  ('accion.dashboard.ver', 'pagina.flito_tablero'),
  ('accion.dashboard.ver', 'tablero.tablero.ver'),
  ('accion.roles_permisos.asignar', 'permisos.cuadro.guardar'),
  ('accion.roles_permisos.crear', 'permisos.rol.crear'),
  ('accion.roles_permisos.editar', 'permisos.rol.editar'),
  ('accion.roles_permisos.eliminar', 'permisos.rol.borrar'),
  ('accion.roles_permisos.ver', 'permisos.catalogo.ver'),
  ('accion.roles_permisos.ver', 'permisos.cuadro.ver'),
  ('accion.roles_permisos.ver', 'permisos.rol.listar'),
  ('accion.usuarios.cambiar_contrasena', 'usuarios.contrasena.cambiar_ajena'),
  ('accion.usuarios.cerrar_sesiones', 'usuarios.sesiones.invalidar'),
  ('accion.usuarios.crear', 'usuarios.usuario.crear'),
  ('accion.usuarios.dar_de_baja', 'usuarios.usuario.baja'),
  ('accion.usuarios.dar_de_baja', 'usuarios.usuario.reactivar'),
  ('accion.usuarios.desactivar_reactivar', 'usuarios.usuario.activar'),
  ('accion.usuarios.editar', 'usuarios.usuario.editar'),
  ('accion.usuarios.exportar', 'usuarios.usuario.exportar'),
  ('accion.usuarios.ver', 'usuarios.usuario.listar'),
  ('accion.usuarios.ver', 'usuarios.usuario.ver_resumen'),
  ('accion.usuarios.ver_historial', 'usuarios.auditoria.filtrar'),
  ('accion.usuarios.ver_historial', 'usuarios.auditoria.ver');

-- Idempotencia: una acción se reparte solo si su grupo existe ENTERO. En la segunda corrida ya no
-- existe ninguno (paso 3) y no se reparte ni se revoca nada.
DELETE FROM tmp_arbol_13428 t WHERE t.accion IN (
  SELECT x.accion FROM tmp_arbol_13428 x
   WHERE NOT EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = x.fn));

-- Lo absorbido, DESPUÉS del recorte: solo los códigos de los grupos que sobreviven, y la operación de
-- una conjunción solo si sobreviven TODAS sus acciones. Un grupo incompleto no reparte su acción y
-- tampoco pierde ninguno de sus miembros (nota de db-review, 2026-10-13).
DROP TABLE IF EXISTS tmp_absorbidas_13428;
CREATE TEMP TABLE tmp_absorbidas_13428 (fn varchar(80) PRIMARY KEY);
INSERT INTO tmp_absorbidas_13428 (fn) SELECT DISTINCT fn FROM tmp_arbol_13428;

-- Acciones de LECTURA (decisión del PO del 2026-10-13): se reciben con ALGUNA operación del grupo.
DROP TABLE IF EXISTS tmp_lectura_13428;
CREATE TEMP TABLE tmp_lectura_13428 (accion varchar(80) PRIMARY KEY);
INSERT INTO tmp_lectura_13428 (accion) VALUES
  ('accion.bitacora.ver'),
  ('accion.clientes.ver'),
  ('accion.dashboard.ver'),
  ('accion.perfil.ver_datos'),
  ('accion.roles_permisos.ver'),
  ('accion.usuarios.ver'),
  ('accion.usuarios.ver_historial');

-- Umbral de cada acción viva: cuántos códigos del grupo hay que tener (todos; 1 si es de lectura).
DROP TABLE IF EXISTS tmp_umbral_13428;
CREATE TEMP TABLE tmp_umbral_13428 AS
SELECT t.accion, CASE WHEN l.accion IS NULL THEN count(*) ELSE 1 END AS k
  FROM tmp_arbol_13428 t LEFT JOIN tmp_lectura_13428 l ON l.accion = t.accion
 GROUP BY t.accion, l.accion;

-- Paso 1 — Roles: la acción, al rol que tenía TODOS los códigos de su grupo (ALGUNO si es de lectura).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT rf.rol_codigo, t.accion
  FROM permisos_rol_funcion rf
  JOIN tmp_arbol_13428 t ON t.fn = rf.funcion_codigo
 GROUP BY rf.rol_codigo, t.accion
HAVING count(DISTINCT rf.funcion_codigo) >= (SELECT u.k FROM tmp_umbral_13428 u WHERE u.accion = t.accion)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 1b — Reparto UNIVERSAL (HU #13428, P-22): la acción y la página de su ítem, a CADA rol de
-- permisos_roles (sin literales de rol: un rol ausente = 0 filas). Solo si la acción existe y aún no la
-- tiene ningún rol: en la segunda corrida (o tras quitársela a un rol desde el panel) no reparte nada.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT r.codigo, v.fn
  FROM permisos_roles r
 CROSS JOIN (VALUES
  ('accion.perfil.cambiar_contrasena', 'accion.perfil.cambiar_contrasena'),
  ('accion.perfil.cambiar_contrasena', 'pagina.perfil'),
  ('accion.perfil.ver_datos', 'accion.perfil.ver_datos'),
  ('accion.perfil.ver_datos', 'pagina.perfil')
 ) AS v(accion, fn)
 WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.accion)
   AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x WHERE x.funcion_codigo = v.accion)
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 2 — Usuarios: la misma regla (todos / alguno) sobre SU conjunto efectivo viejo, (rol ∪ conceder) \ revocar.
-- conceder si lo tenía todo y su rol (ya repartido) no da la acción; revocar si su rol la da y le
-- faltaba algo. Así cada persona queda con exactamente la regla «todos» (AC5).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
SELECT o.user_id, o.accion, CASE WHEN o.todos THEN 'conceder' ELSE 'revocar' END
  FROM (
    SELECT u.id AS user_id, a.accion,
           (SELECT count(*) FROM tmp_arbol_13428 t
             WHERE t.accion = a.accion
               AND (EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = t.fn)
                    OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = t.fn AND c.efecto = 'conceder'))
               AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion v WHERE v.user_id = u.id AND v.funcion_codigo = t.fn AND v.efecto = 'revocar')
           ) >= a.k AS todos,
           EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = u.role AND rf.funcion_codigo = a.accion) AS rol_tiene
      FROM users u
     CROSS JOIN tmp_umbral_13428 a
  ) o
 WHERE o.todos <> o.rol_tiene
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- Paso 2b — AC8 (decisión del PO del 2026-10-13): `admin` recibe TODAS las acciones, también las que
-- la regla «todos» no le daba (solicitar sin trámite: la 0226 le excluyó su grupo hasta la #12874).
-- Va DESPUÉS del paso 2 para que a sus usuarios no se les escriba un `revocar` por un grupo que el
-- rol no tenía entero. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas, no una FK rota.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.bitacora.ver'),
  ('admin', 'accion.clientes.autogestion'),
  ('admin', 'accion.clientes.crear_editar_clientes'),
  ('admin', 'accion.clientes.crear_editar_proveedores'),
  ('admin', 'accion.clientes.datos_fiscales'),
  ('admin', 'accion.clientes.soat_sin_tramite'),
  ('admin', 'accion.clientes.ver'),
  ('admin', 'accion.dashboard.ver'),
  ('admin', 'accion.perfil.cambiar_contrasena'),
  ('admin', 'accion.perfil.ver_datos'),
  ('admin', 'accion.roles_permisos.asignar'),
  ('admin', 'accion.roles_permisos.crear'),
  ('admin', 'accion.roles_permisos.editar'),
  ('admin', 'accion.roles_permisos.eliminar'),
  ('admin', 'accion.roles_permisos.ver'),
  ('admin', 'accion.usuarios.cambiar_contrasena'),
  ('admin', 'accion.usuarios.cerrar_sesiones'),
  ('admin', 'accion.usuarios.crear'),
  ('admin', 'accion.usuarios.dar_de_baja'),
  ('admin', 'accion.usuarios.desactivar_reactivar'),
  ('admin', 'accion.usuarios.editar'),
  ('admin', 'accion.usuarios.exportar'),
  ('admin', 'accion.usuarios.ver'),
  ('admin', 'accion.usuarios.ver_historial')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- Paso 3 — Lo absorbido deja de concederse directo: fuera sus marcas y su fila del catálogo.
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_13428);
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN (SELECT fn FROM tmp_absorbidas_13428);
DELETE FROM permisos_funciones WHERE codigo IN (SELECT fn FROM tmp_absorbidas_13428);

DROP TABLE tmp_umbral_13428;
DROP TABLE tmp_lectura_13428;
DROP TABLE tmp_absorbidas_13428;
DROP TABLE tmp_arbol_13428;
-- ÁRBOL GENERADO (fin)
