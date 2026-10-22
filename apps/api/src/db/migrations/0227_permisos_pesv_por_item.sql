-- 0227_permisos_pesv_por_item.sql
-- Feature #13413 «Modulos antiguos por permiso, sin nombres de rol» (Epica #13411). HU #13421 (pieza
--   backend): PESV, Jornadas, Conductores y RUM piden permiso, no rol. Cada item del menu PESV estrena
--   su pagina (`pagina.pesv_<item>`) y `pagina.pesv` pasa a ser el item raiz «Tablero PESV»; lo que
--   hoy exigia rol va detras de un permiso TRANSITORIO «Administrar <item>» (sufijo `.administrar`,
--   lo retira la HU #13429) y el resumen RUM detras de una operacion permanente (`rum.resumen.ver`).
-- Autor: equipo FLITO. Antecedentes: ADR-0023 (receta), ADR-0022 (admin explicito en el mismo archivo),
--   0184/0218 (pagina sembrada por migracion), 0211 (reparto condicionado), ADR-DB-001.
-- Numerada 0227 en el rebase sobre develop 696fbb9a: la 0226 es de la HU #13424 (admin con todo marcado).
-- SOLO DENTRO DE UNA TRANSACCION: el Paso 3b usa CREATE TEMP TABLE ... ON COMMIT DROP. En autocommit
--   cada sentencia se confirma sola, la tabla temporal desaparece tras crearse y el archivo falla A
--   MEDIAS (paginas sembradas, recorte sin hacer). `npm run db:apply` (y db-apply.js en el contenedor)
--   envuelve el archivo en una transaccion. Verificacion manual: `psql -1 -v ON_ERROR_STOP=1 -f <archivo>`
--   o dentro de BEGIN ... ROLLBACK. Nunca `psql -f` a secas.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: todo INSERT con ON CONFLICT DO NOTHING; el UPDATE solo escribe
--     si el nombre difiere. La segunda pasada no toca una fila.
--   - Paridad (AC5): el reparto de cada pagina nueva es COPIA VIVA del de `pagina.pesv` (roles y
--     excepciones por usuario, `efecto` incluido): vale en cada ambiente aunque el panel lo haya
--     editado. Los transitorios llevan la lista LITERAL de su `requireRole` (que solo miraba el rol).
--   - `admin` recibe explicitamente cada funcion nueva (AC7, ADR-0022).
--   - Formas parseables por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).
--   - Paso 3b (security-agent, pre-PR): raci, normativa y retencion pedian TAMBIEN pagina.pesv (la
--     guarda de router de tablero/huerfanos en /api/pesv se ejecutaba antes). Al quitarla, su reparto
--     se recorta a la interseccion: quien tenga una de esas tres paginas tenia pagina.pesv efectiva.
--   - Roles literales (admin, lider_pesv, supervisor_flota, compliance) en el Paso 5: cada fila pasa
--     por JOIN con permisos_roles y solo entra si el rol EXISTE en ese ambiente. Un rol sin fila en
--     permisos_roles no concede nada hoy (la FK lo impide), asi que omitir su fila no cambia ningun
--     acceso efectivo: no hay perdida de paridad.
-- Correccion del 2026-10-08 tras el fallo del CD en DEV (FK permisos_rol_funcion_rol_codigo_fkey: el
--   Paso 5 nombraba lider_pesv/supervisor_flota/compliance, que DEV no tiene). Editada en su sitio
--   porque nunca se aplico en un ambiente compartido (el runner la revirtio entera).

-- ── Paso 1 — Las 21 paginas nuevas (una por item del menu PESV) ───────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.pesv_conductores', 'pesv', 'PESV — Conductores', 'Entrar a la pantalla «PESV — Conductores».', 'pagina'),
  ('pagina.pesv_capacitaciones', 'pesv', 'PESV — Capacitaciones', 'Entrar a la pantalla «PESV — Capacitaciones».', 'pagina'),
  ('pagina.pesv_incidentes', 'pesv', 'PESV — Incidentes', 'Entrar a la pantalla «PESV — Incidentes».', 'pagina'),
  ('pagina.pesv_siniestralidad', 'pesv', 'PESV — Estadística siniestros', 'Entrar a la pantalla «PESV — Estadística siniestros».', 'pagina'),
  ('pagina.pesv_checklists', 'pesv', 'PESV — Checklists', 'Entrar a la pantalla «PESV — Checklists».', 'pagina'),
  ('pagina.pesv_alcoholimetria', 'pesv', 'PESV — Alcoholimetría', 'Entrar a la pantalla «PESV — Alcoholimetría».', 'pagina'),
  ('pagina.pesv_emergencias', 'pesv', 'PESV — Emergencias', 'Entrar a la pantalla «PESV — Emergencias».', 'pagina'),
  ('pagina.pesv_indicadores_operacion', 'pesv', 'PESV — Indicadores op.', 'Entrar a la pantalla «PESV — Indicadores op.».', 'pagina'),
  ('pagina.pesv_politica', 'pesv', 'PESV — Política PSV', 'Entrar a la pantalla «PESV — Política PSV».', 'pagina'),
  ('pagina.pesv_comite', 'pesv', 'PESV — Comité Seguridad Vial', 'Entrar a la pantalla «PESV — Comité Seguridad Vial».', 'pagina'),
  ('pagina.pesv_plan', 'pesv', 'PESV — Plan Anual PESV', 'Entrar a la pantalla «PESV — Plan Anual PESV».', 'pagina'),
  ('pagina.pesv_diagnostico', 'pesv', 'PESV — Diagnóstico PESV', 'Entrar a la pantalla «PESV — Diagnóstico PESV».', 'pagina'),
  ('pagina.pesv_tablero_ejecutivo', 'pesv', 'PESV — Tablero ejecutivo PESV', 'Entrar a la pantalla «PESV — Tablero ejecutivo PESV».', 'pagina'),
  ('pagina.pesv_reportar_incidente', 'pesv', 'PESV — Reportar incidente', 'Entrar a la pantalla «PESV — Reportar incidente».', 'pagina'),
  ('pagina.pesv_auditorias', 'pesv', 'PESV — Auditorías PESV', 'Entrar a la pantalla «PESV — Auditorías PESV».', 'pagina'),
  ('pagina.pesv_comunicaciones', 'pesv', 'PESV — Comunicaciones', 'Entrar a la pantalla «PESV — Comunicaciones».', 'pagina'),
  ('pagina.pesv_contratistas', 'pesv', 'PESV — Contratistas', 'Entrar a la pantalla «PESV — Contratistas».', 'pagina'),
  ('pagina.pesv_jornadas', 'pesv', 'PESV — Control Jornada (admin)', 'Entrar a la pantalla «PESV — Control Jornada (admin)».', 'pagina'),
  ('pagina.pesv_mi_jornada', 'pesv', 'PESV — Mi Jornada', 'Entrar a la pantalla «PESV — Mi Jornada».', 'pagina'),
  ('pagina.pesv_rutas', 'pesv', 'PESV — Rutas operativas', 'Entrar a la pantalla «PESV — Rutas operativas».', 'pagina'),
  ('pagina.pesv_pernocta', 'pesv', 'PESV — Zonas de pernocta', 'Entrar a la pantalla «PESV — Zonas de pernocta».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — `pagina.pesv` ya no es «todo PESV»: es el item raiz «Tablero PESV» ─────────────────
UPDATE permisos_funciones SET nombre_negocio = 'PESV — Tablero PESV', descripcion = 'Entrar a la pantalla «PESV — Tablero PESV».'
  WHERE codigo = 'pagina.pesv' AND (nombre_negocio, descripcion) IS DISTINCT FROM ('PESV — Tablero PESV', 'Entrar a la pantalla «PESV — Tablero PESV».');

-- ── Paso 3 — Reparto de las paginas nuevas: copia viva de `pagina.pesv` (roles y excepciones) ──
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('pagina.pesv_conductores'),
  ('pagina.pesv_capacitaciones'),
  ('pagina.pesv_incidentes'),
  ('pagina.pesv_siniestralidad'),
  ('pagina.pesv_checklists'),
  ('pagina.pesv_alcoholimetria'),
  ('pagina.pesv_emergencias'),
  ('pagina.pesv_indicadores_operacion'),
  ('pagina.pesv_politica'),
  ('pagina.pesv_comite'),
  ('pagina.pesv_plan'),
  ('pagina.pesv_diagnostico'),
  ('pagina.pesv_tablero_ejecutivo'),
  ('pagina.pesv_reportar_incidente'),
  ('pagina.pesv_auditorias'),
  ('pagina.pesv_comunicaciones'),
  ('pagina.pesv_contratistas'),
  ('pagina.pesv_jornadas'),
  ('pagina.pesv_mi_jornada'),
  ('pagina.pesv_rutas'),
  ('pagina.pesv_pernocta')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.pesv'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('pagina.pesv_conductores'),
  ('pagina.pesv_capacitaciones'),
  ('pagina.pesv_incidentes'),
  ('pagina.pesv_siniestralidad'),
  ('pagina.pesv_checklists'),
  ('pagina.pesv_alcoholimetria'),
  ('pagina.pesv_emergencias'),
  ('pagina.pesv_indicadores_operacion'),
  ('pagina.pesv_politica'),
  ('pagina.pesv_comite'),
  ('pagina.pesv_plan'),
  ('pagina.pesv_diagnostico'),
  ('pagina.pesv_tablero_ejecutivo'),
  ('pagina.pesv_reportar_incidente'),
  ('pagina.pesv_auditorias'),
  ('pagina.pesv_comunicaciones'),
  ('pagina.pesv_contratistas'),
  ('pagina.pesv_jornadas'),
  ('pagina.pesv_mi_jornada'),
  ('pagina.pesv_rutas'),
  ('pagina.pesv_pernocta')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.pesv'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- ── Paso 3b — raci, normativa y retencion: su reparto pasa a la INTERSECCION con pagina.pesv ────
-- Hoy esas rutas exigian su pagina Y pagina.pesv. Se calcula, ANTES de tocar nada, el objetivo por
-- usuario con la regla del motor (R union C) menos V: tiene la pagina hoy Y tiene pagina.pesv hoy.
-- Luego se recortan las filas para que la pagina efectiva sea exactamente ese objetivo.
CREATE TEMP TABLE m0227_objetivo ON COMMIT DROP AS
  SELECT u.id AS user_id, u.role AS rol, v.fn,
    (
      (EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = u.role AND r.funcion_codigo = 'pagina.pesv')
        OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = 'pagina.pesv' AND c.efecto = 'conceder'))
      AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = u.id AND x.funcion_codigo = 'pagina.pesv' AND x.efecto = 'revocar')
    ) AND (
      (EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = u.role AND r.funcion_codigo = v.fn)
        OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = v.fn AND c.efecto = 'conceder'))
      AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = u.id AND x.funcion_codigo = v.fn AND x.efecto = 'revocar')
    ) AS objetivo
  FROM users u CROSS JOIN (VALUES ('pagina.pesv_raci'), ('pagina.pesv_normativa'), ('pagina.pesv_retencion')) AS v(fn);

-- (a.1) Un ROL que no tiene pagina.pesv deja de conceder estas tres paginas.
DELETE FROM permisos_rol_funcion rf
  WHERE rf.funcion_codigo = ANY (ARRAY['pagina.pesv_raci', 'pagina.pesv_normativa', 'pagina.pesv_retencion'])
    AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion o WHERE o.rol_codigo = rf.rol_codigo AND o.funcion_codigo = 'pagina.pesv');

-- (a.2) Un `conceder` de usuario sin pagina.pesv efectiva se retira.
DELETE FROM permisos_usuario_funcion p
  USING m0227_objetivo t
  WHERE p.user_id = t.user_id AND p.funcion_codigo = t.fn AND p.efecto = 'conceder' AND NOT t.objetivo;

-- (a.3) Las revocaciones de pagina.pesv se copian a las tres (quien no ve PESV no ve estas paginas).
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, 'revocar' FROM permisos_usuario_funcion o
    CROSS JOIN (VALUES ('pagina.pesv_raci'), ('pagina.pesv_normativa'), ('pagina.pesv_retencion')) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.pesv' AND o.efecto = 'revocar'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- (a.4) Si el rol aun la concede y el objetivo es NO, se revoca al usuario.
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT t.user_id, t.fn, 'revocar' FROM m0227_objetivo t
  WHERE NOT t.objetivo
    AND EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = t.rol AND r.funcion_codigo = t.fn)
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- (a.5) Paridad hacia abajo: quien SI pasaba (pagina.pesv por excepcion propia) y perdio la pagina
-- porque su rol dejo de concederla, la conserva como excepcion propia.
INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT t.user_id, t.fn, 'conceder' FROM m0227_objetivo t
  WHERE t.objetivo
    AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = t.rol AND r.funcion_codigo = t.fn)
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- ── Paso 4 — Las 25 operaciones: 24 transitorios «Administrar <item>» y `rum.resumen.ver` ──────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('drivers.alcoholimetria.administrar', 'pesv', 'Administrar Alcoholimetría', 'Transitorio (retira la HU #13429): acciones administrativas de «Alcoholimetría».', 'operacion'),
  ('drivers.capacitaciones.administrar', 'pesv', 'Administrar Capacitaciones', 'Transitorio (retira la HU #13429): acciones administrativas de «Capacitaciones».', 'operacion'),
  ('drivers.checklists.administrar', 'pesv', 'Administrar Checklists', 'Transitorio (retira la HU #13429): acciones administrativas de «Checklists».', 'operacion'),
  ('drivers.conductores.administrar', 'pesv', 'Administrar Conductores', 'Transitorio (retira la HU #13429): acciones administrativas de «Conductores».', 'operacion'),
  ('drivers.emergencias.administrar', 'pesv', 'Administrar Emergencias', 'Transitorio (retira la HU #13429): acciones administrativas de «Emergencias».', 'operacion'),
  ('drivers.incidentes_registro.administrar', 'pesv', 'Administrar Incidentes — registrar', 'Transitorio (retira la HU #13429): registrar un incidente desde la consola de «Incidentes».', 'operacion'),
  ('drivers.incidentes.administrar', 'pesv', 'Administrar Incidentes', 'Transitorio (retira la HU #13429): acciones administrativas de «Incidentes».', 'operacion'),
  ('jornadas.control.administrar', 'pesv', 'Administrar Control Jornada (admin)', 'Transitorio (retira la HU #13429): acciones administrativas de «Control Jornada (admin)».', 'operacion'),
  ('pesv.auditorias.administrar', 'pesv', 'Administrar Auditorías PESV', 'Transitorio (retira la HU #13429): acciones administrativas de «Auditorías PESV».', 'operacion'),
  ('pesv.comite.administrar', 'pesv', 'Administrar Comité Seguridad Vial', 'Transitorio (retira la HU #13429): acciones administrativas de «Comité Seguridad Vial».', 'operacion'),
  ('pesv.comunicaciones.administrar', 'pesv', 'Administrar Comunicaciones', 'Transitorio (retira la HU #13429): acciones administrativas de «Comunicaciones».', 'operacion'),
  ('pesv.contratistas.administrar', 'pesv', 'Administrar Contratistas', 'Transitorio (retira la HU #13429): acciones administrativas de «Contratistas».', 'operacion'),
  ('pesv.diagnostico_consulta.administrar', 'pesv', 'Administrar Diagnóstico PESV — consultar', 'Transitorio (retira la HU #13429): el preflight, el historial por estándar, las evidencias y los expedientes exportados de «Diagnóstico PESV».', 'operacion'),
  ('pesv.diagnostico.administrar', 'pesv', 'Administrar Diagnóstico PESV', 'Transitorio (retira la HU #13429): acciones administrativas de «Diagnóstico PESV».', 'operacion'),
  ('pesv.incidentes_causa_raiz.administrar', 'pesv', 'Administrar Incidentes — causa raíz', 'Transitorio (retira la HU #13429): registrar la causa raíz de un incidente de «Incidentes».', 'operacion'),
  ('pesv.normativa_edicion.administrar', 'pesv', 'Administrar Tracker normativo — crear, editar y revisar', 'Transitorio (retira la HU #13429): crear, editar y marcar como revisada una norma de «Tracker normativo».', 'operacion'),
  ('pesv.normativa.administrar', 'pesv', 'Administrar Tracker normativo', 'Transitorio (retira la HU #13429): acciones administrativas de «Tracker normativo».', 'operacion'),
  ('pesv.plan.administrar', 'pesv', 'Administrar Plan Anual PESV', 'Transitorio (retira la HU #13429): acciones administrativas de «Plan Anual PESV».', 'operacion'),
  ('pesv.politica_edicion.administrar', 'pesv', 'Administrar Política PSV — crear, editar y firmar', 'Transitorio (retira la HU #13429): crear, editar y firmar la política de «Política PSV».', 'operacion'),
  ('pesv.politica.administrar', 'pesv', 'Administrar Política PSV', 'Transitorio (retira la HU #13429): acciones administrativas de «Política PSV».', 'operacion'),
  ('pesv.raci.administrar', 'pesv', 'Administrar Matriz RACI', 'Transitorio (retira la HU #13429): acciones administrativas de «Matriz RACI».', 'operacion'),
  ('pesv.retencion_edicion.administrar', 'pesv', 'Administrar Retención documental — crear y editar políticas', 'Transitorio (retira la HU #13429): crear y editar políticas de retención de «Retención documental».', 'operacion'),
  ('pesv.retencion.administrar', 'pesv', 'Administrar Retención documental', 'Transitorio (retira la HU #13429): acciones administrativas de «Retención documental».', 'operacion'),
  ('pesv.tablero_ejecutivo.administrar', 'pesv', 'Administrar Tablero ejecutivo PESV', 'Transitorio (retira la HU #13429): acciones administrativas de «Tablero ejecutivo PESV».', 'operacion'),
  ('rum.resumen.ver', 'rum', 'Ver el resumen de rendimiento web (RUM)', 'Leer las métricas Web Vitals agregadas (p75 por métrica, ruta y dispositivo) que reportan los navegadores.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 5 — Reparto literal: admin en TODO lo nuevo (AC7) + la lista de cada `requireRole` ─────
-- Solo a roles que existen en este ambiente (JOIN con permisos_roles; correccion del 2026-10-08).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'pagina.pesv_conductores'),
  ('admin', 'pagina.pesv_capacitaciones'),
  ('admin', 'pagina.pesv_incidentes'),
  ('admin', 'pagina.pesv_siniestralidad'),
  ('admin', 'pagina.pesv_checklists'),
  ('admin', 'pagina.pesv_alcoholimetria'),
  ('admin', 'pagina.pesv_emergencias'),
  ('admin', 'pagina.pesv_indicadores_operacion'),
  ('admin', 'pagina.pesv_politica'),
  ('admin', 'pagina.pesv_comite'),
  ('admin', 'pagina.pesv_plan'),
  ('admin', 'pagina.pesv_diagnostico'),
  ('admin', 'pagina.pesv_tablero_ejecutivo'),
  ('admin', 'pagina.pesv_reportar_incidente'),
  ('admin', 'pagina.pesv_auditorias'),
  ('admin', 'pagina.pesv_comunicaciones'),
  ('admin', 'pagina.pesv_contratistas'),
  ('admin', 'pagina.pesv_jornadas'),
  ('admin', 'pagina.pesv_mi_jornada'),
  ('admin', 'pagina.pesv_rutas'),
  ('admin', 'pagina.pesv_pernocta'),
  ('admin', 'drivers.alcoholimetria.administrar'),
  ('admin', 'drivers.capacitaciones.administrar'),
  ('admin', 'drivers.checklists.administrar'),
  ('admin', 'drivers.conductores.administrar'),
  ('admin', 'drivers.emergencias.administrar'),
  ('admin', 'drivers.incidentes_registro.administrar'),
  ('lider_pesv', 'drivers.incidentes_registro.administrar'),
  ('supervisor_flota', 'drivers.incidentes_registro.administrar'),
  ('admin', 'drivers.incidentes.administrar'),
  ('admin', 'jornadas.control.administrar'),
  ('admin', 'pesv.auditorias.administrar'),
  ('lider_pesv', 'pesv.auditorias.administrar'),
  ('admin', 'pesv.comite.administrar'),
  ('lider_pesv', 'pesv.comite.administrar'),
  ('admin', 'pesv.comunicaciones.administrar'),
  ('lider_pesv', 'pesv.comunicaciones.administrar'),
  ('admin', 'pesv.contratistas.administrar'),
  ('lider_pesv', 'pesv.contratistas.administrar'),
  ('admin', 'pesv.diagnostico_consulta.administrar'),
  ('compliance', 'pesv.diagnostico_consulta.administrar'),
  ('lider_pesv', 'pesv.diagnostico_consulta.administrar'),
  ('admin', 'pesv.diagnostico.administrar'),
  ('lider_pesv', 'pesv.diagnostico.administrar'),
  ('admin', 'pesv.incidentes_causa_raiz.administrar'),
  ('lider_pesv', 'pesv.incidentes_causa_raiz.administrar'),
  ('supervisor_flota', 'pesv.incidentes_causa_raiz.administrar'),
  ('admin', 'pesv.normativa_edicion.administrar'),
  ('lider_pesv', 'pesv.normativa_edicion.administrar'),
  ('admin', 'pesv.normativa.administrar'),
  ('admin', 'pesv.plan.administrar'),
  ('lider_pesv', 'pesv.plan.administrar'),
  ('admin', 'pesv.politica_edicion.administrar'),
  ('lider_pesv', 'pesv.politica_edicion.administrar'),
  ('admin', 'pesv.politica.administrar'),
  ('admin', 'pesv.raci.administrar'),
  ('lider_pesv', 'pesv.raci.administrar'),
  ('admin', 'pesv.retencion_edicion.administrar'),
  ('lider_pesv', 'pesv.retencion_edicion.administrar'),
  ('admin', 'pesv.retencion.administrar'),
  ('admin', 'pesv.tablero_ejecutivo.administrar'),
  ('admin', 'rum.resumen.ver')
  ) AS v(rol, fn)
  JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen y control de paridad, dentro de la transaccion del runner ─────────────────────────────
DO $resumen0227$
DECLARE
  n_paginas int; n_ops int; n_sin_admin int; n_rol_raiz int; n_usr_raiz int; n_cortas int; n_rol_nuevas int;
  n_sin_pesv int; n_difieren int;
BEGIN
  SELECT count(*) INTO n_paginas FROM permisos_funciones WHERE tipo = 'pagina' AND codigo IN ('pagina.pesv_conductores','pagina.pesv_capacitaciones','pagina.pesv_incidentes','pagina.pesv_siniestralidad','pagina.pesv_checklists','pagina.pesv_alcoholimetria','pagina.pesv_emergencias','pagina.pesv_indicadores_operacion','pagina.pesv_politica','pagina.pesv_comite','pagina.pesv_plan','pagina.pesv_diagnostico','pagina.pesv_tablero_ejecutivo','pagina.pesv_reportar_incidente','pagina.pesv_auditorias','pagina.pesv_comunicaciones','pagina.pesv_contratistas','pagina.pesv_jornadas','pagina.pesv_mi_jornada','pagina.pesv_rutas','pagina.pesv_pernocta');
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion'
    AND codigo IN ('drivers.alcoholimetria.administrar','drivers.capacitaciones.administrar','drivers.checklists.administrar','drivers.conductores.administrar','drivers.emergencias.administrar','drivers.incidentes_registro.administrar','drivers.incidentes.administrar','jornadas.control.administrar','pesv.auditorias.administrar','pesv.comite.administrar','pesv.comunicaciones.administrar','pesv.contratistas.administrar','pesv.diagnostico_consulta.administrar','pesv.diagnostico.administrar','pesv.incidentes_causa_raiz.administrar','pesv.normativa_edicion.administrar','pesv.normativa.administrar','pesv.plan.administrar','pesv.politica_edicion.administrar','pesv.politica.administrar','pesv.raci.administrar','pesv.retencion_edicion.administrar','pesv.retencion.administrar','pesv.tablero_ejecutivo.administrar','rum.resumen.ver');
  IF n_paginas <> 21 OR n_ops <> 25 THEN
    RAISE EXCEPTION '0227: catalogo incompleto (paginas=% de 21, operaciones=% de 25)', n_paginas, n_ops;
  END IF;
  SELECT count(*) INTO n_sin_admin FROM permisos_funciones f
    WHERE (f.codigo IN ('pagina.pesv_conductores','pagina.pesv_capacitaciones','pagina.pesv_incidentes','pagina.pesv_siniestralidad','pagina.pesv_checklists','pagina.pesv_alcoholimetria','pagina.pesv_emergencias','pagina.pesv_indicadores_operacion','pagina.pesv_politica','pagina.pesv_comite','pagina.pesv_plan','pagina.pesv_diagnostico','pagina.pesv_tablero_ejecutivo','pagina.pesv_reportar_incidente','pagina.pesv_auditorias','pagina.pesv_comunicaciones','pagina.pesv_contratistas','pagina.pesv_jornadas','pagina.pesv_mi_jornada','pagina.pesv_rutas','pagina.pesv_pernocta') OR f.codigo IN ('drivers.alcoholimetria.administrar','drivers.capacitaciones.administrar','drivers.checklists.administrar','drivers.conductores.administrar','drivers.emergencias.administrar','drivers.incidentes_registro.administrar','drivers.incidentes.administrar','jornadas.control.administrar','pesv.auditorias.administrar','pesv.comite.administrar','pesv.comunicaciones.administrar','pesv.contratistas.administrar','pesv.diagnostico_consulta.administrar','pesv.diagnostico.administrar','pesv.incidentes_causa_raiz.administrar','pesv.normativa_edicion.administrar','pesv.normativa.administrar','pesv.plan.administrar','pesv.politica_edicion.administrar','pesv.politica.administrar','pesv.raci.administrar','pesv.retencion_edicion.administrar','pesv.retencion.administrar','pesv.tablero_ejecutivo.administrar','rum.resumen.ver'))
      AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = 'admin' AND rf.funcion_codigo = f.codigo);
  IF n_sin_admin <> 0 THEN
    RAISE EXCEPTION '0227: % funciones nuevas sin admin (AC7)', n_sin_admin;
  END IF;
  SELECT count(*) INTO n_rol_raiz FROM permisos_rol_funcion WHERE funcion_codigo = 'pagina.pesv';
  SELECT count(*) INTO n_usr_raiz FROM permisos_usuario_funcion WHERE funcion_codigo = 'pagina.pesv';
  SELECT count(*) INTO n_cortas FROM (VALUES ('pagina.pesv_conductores'),('pagina.pesv_capacitaciones'),('pagina.pesv_incidentes'),('pagina.pesv_siniestralidad'),('pagina.pesv_checklists'),('pagina.pesv_alcoholimetria'),('pagina.pesv_emergencias'),('pagina.pesv_indicadores_operacion'),('pagina.pesv_politica'),('pagina.pesv_comite'),('pagina.pesv_plan'),('pagina.pesv_diagnostico'),('pagina.pesv_tablero_ejecutivo'),('pagina.pesv_reportar_incidente'),('pagina.pesv_auditorias'),('pagina.pesv_comunicaciones'),('pagina.pesv_contratistas'),('pagina.pesv_jornadas'),('pagina.pesv_mi_jornada'),('pagina.pesv_rutas'),('pagina.pesv_pernocta')) AS v(fn)
    WHERE (SELECT count(*) FROM permisos_rol_funcion o
            WHERE o.funcion_codigo = v.fn AND o.rol_codigo IN (SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = 'pagina.pesv')) < n_rol_raiz
       OR (SELECT count(*) FROM permisos_usuario_funcion u
            JOIN permisos_usuario_funcion r ON r.user_id = u.user_id AND r.funcion_codigo = 'pagina.pesv' AND r.efecto = u.efecto
            WHERE u.funcion_codigo = v.fn) < n_usr_raiz;
  IF n_cortas <> 0 THEN
    RAISE EXCEPTION '0227: % paginas nuevas con MENOS reparto que pagina.pesv (paridad)', n_cortas;
  END IF;
  -- (b) Nadie puede quedar con raci, normativa o retencion efectiva sin pagina.pesv efectiva, y la
  -- pagina efectiva de cada usuario es EXACTAMENTE el objetivo calculado antes de tocar nada.
  SELECT count(*) INTO n_sin_pesv FROM users u
    CROSS JOIN (VALUES ('pagina.pesv_raci'), ('pagina.pesv_normativa'), ('pagina.pesv_retencion')) AS v(fn)
    WHERE ((EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = u.role AND r.funcion_codigo = v.fn)
            OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = v.fn AND c.efecto = 'conceder'))
           AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = u.id AND x.funcion_codigo = v.fn AND x.efecto = 'revocar'))
      AND NOT ((EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = u.role AND r.funcion_codigo = 'pagina.pesv')
                OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = 'pagina.pesv' AND c.efecto = 'conceder'))
               AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = u.id AND x.funcion_codigo = 'pagina.pesv' AND x.efecto = 'revocar'));
  IF n_sin_pesv <> 0 THEN
    RAISE EXCEPTION '0227: % accesos a raci/normativa/retencion sin pagina.pesv efectiva (ganancia)', n_sin_pesv;
  END IF;
  SELECT count(*) INTO n_difieren FROM m0227_objetivo t JOIN users u ON u.id = t.user_id
    WHERE t.objetivo IS DISTINCT FROM (
      (EXISTS (SELECT 1 FROM permisos_rol_funcion r WHERE r.rol_codigo = u.role AND r.funcion_codigo = t.fn)
        OR EXISTS (SELECT 1 FROM permisos_usuario_funcion c WHERE c.user_id = u.id AND c.funcion_codigo = t.fn AND c.efecto = 'conceder'))
      AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion x WHERE x.user_id = u.id AND x.funcion_codigo = t.fn AND x.efecto = 'revocar'));
  IF n_difieren <> 0 THEN
    RAISE EXCEPTION '0227: % accesos a raci/normativa/retencion distintos del objetivo (paridad)', n_difieren;
  END IF;
  SELECT count(*) INTO n_rol_nuevas FROM permisos_rol_funcion WHERE funcion_codigo IN ('pagina.pesv_conductores','pagina.pesv_capacitaciones','pagina.pesv_incidentes','pagina.pesv_siniestralidad','pagina.pesv_checklists','pagina.pesv_alcoholimetria','pagina.pesv_emergencias','pagina.pesv_indicadores_operacion','pagina.pesv_politica','pagina.pesv_comite','pagina.pesv_plan','pagina.pesv_diagnostico','pagina.pesv_tablero_ejecutivo','pagina.pesv_reportar_incidente','pagina.pesv_auditorias','pagina.pesv_comunicaciones','pagina.pesv_contratistas','pagina.pesv_jornadas','pagina.pesv_mi_jornada','pagina.pesv_rutas','pagina.pesv_pernocta');
  RAISE NOTICE '0227: % paginas y % operaciones; pagina.pesv con % roles y % excepciones, copiadas (% filas de rol en las nuevas); raci/normativa/retencion recortadas a pagina.pesv (0 sin ella)',
    n_paginas, n_ops, n_rol_raiz, n_usr_raiz, n_rol_nuevas;
END $resumen0227$;
