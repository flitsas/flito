-- 0229_permisos_operacion_por_item.sql
-- Feature #13413 «Modulos antiguos por permiso, sin nombres de rol» (Epica #13411). HU #13422 (pieza
--   backend): Mantenimiento, Vehiculos, Flota, RNDC, Rutas, Liquidacion, Finanzas y Clientes piden
--   permiso, no rol. Cada item del menu Mantenimiento estrena su pagina (`pagina.maintenance_<item>`);
--   `pagina.maintenance` deja de proteger rutas e items (se conserva). Lo que hoy exigia `admin` va
--   detras de un permiso TRANSITORIO «Administrar <item>» (sufijo `.administrar`, lo retira la HU
--   #13429); las dos lecturas por rol (reporte de costos y clientes) y el documento completo del
--   propietario en el listado de vehiculos, detras de operaciones permanentes.
-- Autor: equipo FLITO. Antecedentes: 0227 (receta, ADR-0023), 0226/ADR-0022 (admin explicito en el
--   mismo archivo), 0228 (la anterior).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--     Sin tablas temporales: tambien es seguro en autocommit, pero se verifica con
--     `psql -1 -v ON_ERROR_STOP=1 -f <archivo>` o dentro de BEGIN ... ROLLBACK.
--   - Idempotente en sentido fuerte: todo INSERT con ON CONFLICT DO NOTHING; ni UPDATE ni DELETE. La
--     segunda pasada no toca una fila.
--   - Paridad (AC5): el reparto de cada pagina nueva es COPIA VIVA del de `pagina.maintenance` (roles y
--     excepciones por usuario, `efecto` incluido): vale en cada ambiente aunque el panel lo haya
--     editado. Las operaciones llevan la lista LITERAL de su `requireRole` (que solo miraba el rol):
--     `admin` en todas; ademas `auditor` y `financiera` en las dos lecturas.
--   - Rutas: sus rutas pasan de `pagina.pesv` a `pagina.pesv_rutas` / `pagina.pesv_pernocta`, que la 0227
--     sembro como copia viva de `pagina.pesv`: no hay reparto nuevo que sembrar.
--   - Roles literales SOLO por JOIN con permisos_roles (leccion del CD de DEV con la 0227): una fila
--     entra si el rol existe en ese ambiente. Un rol sin fila en permisos_roles no concede nada hoy (la
--     FK lo impide), asi que omitirla no cambia ningun acceso efectivo.
--   - `admin` recibe explicitamente cada funcion nueva (AC7, ADR-0022).
--   - Formas parseables por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — Las 3 paginas nuevas (una por item del menu Mantenimiento) ───────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.maintenance_inicio', 'mantenimiento', 'Mantenimiento — Mantenimiento', 'Entrar a la pantalla «Mantenimiento — Mantenimiento».', 'pagina'),
  ('pagina.maintenance_ordenes', 'mantenimiento', 'Mantenimiento — Órdenes de trabajo', 'Entrar a la pantalla «Mantenimiento — Órdenes de trabajo».', 'pagina'),
  ('pagina.maintenance_indicadores', 'mantenimiento', 'Mantenimiento — Indicadores mant.', 'Entrar a la pantalla «Mantenimiento — Indicadores mant.».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto de las paginas nuevas: copia viva de `pagina.maintenance` (roles y excepciones) ─
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT o.rol_codigo, v.fn FROM permisos_rol_funcion o CROSS JOIN (VALUES
  ('pagina.maintenance_inicio'),
  ('pagina.maintenance_ordenes'),
  ('pagina.maintenance_indicadores')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.maintenance'
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT o.user_id, v.fn, o.efecto FROM permisos_usuario_funcion o CROSS JOIN (VALUES
  ('pagina.maintenance_inicio'),
  ('pagina.maintenance_ordenes'),
  ('pagina.maintenance_indicadores')
  ) AS v(fn)
  WHERE o.funcion_codigo = 'pagina.maintenance'
ON CONFLICT (user_id, funcion_codigo) DO NOTHING;

-- ── Paso 3 — Las 13 operaciones: 10 transitorios «Administrar <item>» y 3 permanentes ─────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('clients.clientes.administrar', 'clientes', 'Administrar Clientes y proveedores', 'Transitorio (retira la HU #13429): acciones administrativas de «Clientes y proveedores».', 'operacion'),
  ('clients.clientes.ver', 'clientes', 'Ver clientes y proveedores', 'Leer el listado de clientes y proveedores.', 'operacion'),
  ('finanzas.reporte_costos.ver', 'liquidacion', 'Ver el reporte de costos', 'Leer y exportar el reporte de costos, su consolidado, su facturación electrónica y los soportes y viajes de un trámite.', 'operacion'),
  ('fleet.flota.administrar', 'flota', 'Administrar Flota', 'Transitorio (retira la HU #13429): acciones administrativas de «Flota».', 'operacion'),
  ('liquidacion.pago_manual.administrar', 'mantenimiento', 'Administrar Órdenes de trabajo — liquidación y pago manual', 'Transitorio (retira la HU #13429): liquidar y confirmar el pago manual de una orden de «Órdenes de trabajo».', 'operacion'),
  ('maintenance.inicio.administrar', 'mantenimiento', 'Administrar Mantenimiento', 'Transitorio (retira la HU #13429): acciones administrativas de «Mantenimiento».', 'operacion'),
  ('maintenance.ordenes.administrar', 'mantenimiento', 'Administrar Órdenes de trabajo', 'Transitorio (retira la HU #13429): acciones administrativas de «Órdenes de trabajo».', 'operacion'),
  ('rndc.credenciales.administrar', 'rndc', 'Administrar Credenciales RNDC', 'Transitorio (retira la HU #13429): acciones administrativas de «Credenciales RNDC».', 'operacion'),
  ('rndc.manifiestos.administrar', 'rndc', 'Administrar Manifiestos', 'Transitorio (retira la HU #13429): encolar y reintentar el envío al RNDC (y recibir el aviso del envío fallido) de «Manifiestos».', 'operacion'),
  ('rutas.pernocta.administrar', 'pesv', 'Administrar Zonas de pernocta', 'Transitorio (retira la HU #13429): acciones administrativas de «Zonas de pernocta».', 'operacion'),
  ('rutas.rutas.administrar', 'pesv', 'Administrar Rutas operativas', 'Transitorio (retira la HU #13429): acciones administrativas de «Rutas operativas».', 'operacion'),
  ('vehicles.propietario.ver_documento', 'operaciones', 'Ver el documento completo del propietario', 'En el listado de vehículos, ver el número de documento del propietario sin enmascarar.', 'operacion'),
  ('vehicles.vehiculos.administrar', 'operaciones', 'Administrar Vehículos', 'Transitorio (retira la HU #13429): acciones administrativas de «Vehículos».', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 4 — Reparto literal: admin en TODO lo nuevo (AC7) + la lista de cada `requireRole` ─────────
-- Solo a roles que existen en este ambiente (JOIN con permisos_roles).
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'clients.clientes.administrar'),
  ('admin', 'clients.clientes.ver'),
  ('auditor', 'clients.clientes.ver'),
  ('financiera', 'clients.clientes.ver'),
  ('admin', 'finanzas.reporte_costos.ver'),
  ('auditor', 'finanzas.reporte_costos.ver'),
  ('financiera', 'finanzas.reporte_costos.ver'),
  ('admin', 'fleet.flota.administrar'),
  ('admin', 'liquidacion.pago_manual.administrar'),
  ('admin', 'maintenance.inicio.administrar'),
  ('admin', 'maintenance.ordenes.administrar'),
  ('admin', 'pagina.maintenance_indicadores'),
  ('admin', 'pagina.maintenance_inicio'),
  ('admin', 'pagina.maintenance_ordenes'),
  ('admin', 'rndc.credenciales.administrar'),
  ('admin', 'rndc.manifiestos.administrar'),
  ('admin', 'rutas.pernocta.administrar'),
  ('admin', 'rutas.rutas.administrar'),
  ('admin', 'vehicles.propietario.ver_documento'),
  ('admin', 'vehicles.vehiculos.administrar')
  ) AS v(rol, fn)
  JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen y control de paridad, dentro de la transaccion del runner ─────────────────────────────
DO $resumen0229$
DECLARE
  n_paginas int; n_ops int; n_sin_admin int; n_rol_raiz int; n_usr_raiz int; n_cortas int; n_rol_nuevas int;
BEGIN
  SELECT count(*) INTO n_paginas FROM permisos_funciones WHERE tipo = 'pagina' AND codigo IN ('pagina.maintenance_inicio','pagina.maintenance_ordenes','pagina.maintenance_indicadores');
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion'
    AND codigo IN ('clients.clientes.administrar','clients.clientes.ver','finanzas.reporte_costos.ver','fleet.flota.administrar','liquidacion.pago_manual.administrar','maintenance.inicio.administrar','maintenance.ordenes.administrar','rndc.credenciales.administrar','rndc.manifiestos.administrar','rutas.pernocta.administrar','rutas.rutas.administrar','vehicles.propietario.ver_documento','vehicles.vehiculos.administrar');
  IF n_paginas <> 3 OR n_ops <> 13 THEN
    RAISE EXCEPTION '0229: catalogo incompleto (paginas=% de 3, operaciones=% de 13)', n_paginas, n_ops;
  END IF;
  SELECT count(*) INTO n_sin_admin FROM permisos_funciones f
    WHERE (f.codigo IN ('pagina.maintenance_inicio','pagina.maintenance_ordenes','pagina.maintenance_indicadores') OR f.codigo IN ('clients.clientes.administrar','clients.clientes.ver','finanzas.reporte_costos.ver','fleet.flota.administrar','liquidacion.pago_manual.administrar','maintenance.inicio.administrar','maintenance.ordenes.administrar','rndc.credenciales.administrar','rndc.manifiestos.administrar','rutas.pernocta.administrar','rutas.rutas.administrar','vehicles.propietario.ver_documento','vehicles.vehiculos.administrar'))
      AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion rf WHERE rf.rol_codigo = 'admin' AND rf.funcion_codigo = f.codigo);
  IF n_sin_admin <> 0 THEN
    RAISE EXCEPTION '0229: % funciones nuevas sin admin (AC7)', n_sin_admin;
  END IF;
  SELECT count(*) INTO n_rol_raiz FROM permisos_rol_funcion WHERE funcion_codigo = 'pagina.maintenance';
  SELECT count(*) INTO n_usr_raiz FROM permisos_usuario_funcion WHERE funcion_codigo = 'pagina.maintenance';
  SELECT count(*) INTO n_cortas FROM (VALUES ('pagina.maintenance_inicio'),('pagina.maintenance_ordenes'),('pagina.maintenance_indicadores')) AS v(fn)
    WHERE (SELECT count(*) FROM permisos_rol_funcion o
            WHERE o.funcion_codigo = v.fn AND o.rol_codigo IN (SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = 'pagina.maintenance')) < n_rol_raiz
       OR (SELECT count(*) FROM permisos_usuario_funcion u
            JOIN permisos_usuario_funcion r ON r.user_id = u.user_id AND r.funcion_codigo = 'pagina.maintenance' AND r.efecto = u.efecto
            WHERE u.funcion_codigo = v.fn) < n_usr_raiz;
  IF n_cortas <> 0 THEN
    RAISE EXCEPTION '0229: % paginas nuevas con MENOS reparto que pagina.maintenance (paridad)', n_cortas;
  END IF;
  SELECT count(*) INTO n_rol_nuevas FROM permisos_rol_funcion WHERE funcion_codigo IN ('pagina.maintenance_inicio','pagina.maintenance_ordenes','pagina.maintenance_indicadores');
  RAISE NOTICE '0229: % paginas y % operaciones; pagina.maintenance con % roles y % excepciones, copiadas (% filas de rol en las nuevas)',
    n_paginas, n_ops, n_rol_raiz, n_usr_raiz, n_rol_nuevas;
END $resumen0229$;
