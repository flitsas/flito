-- 0303_flito_torre_fundacion.sql — Torre de Control Gerencial (Épica #14590), paso contract-first.
-- Escrita a mano e idempotente. NO drizzle-kit (AGENTS.md regla 6). Sin BEGIN/COMMIT (lo pone el runner).
--
--   1. `flito_torre_umbrales`: umbrales configurables de las alertas, con su semilla (`UMBRALES_TORRE` de
--      shared-types; los operativos salen de `ANS_OPERATIVO`). `ON CONFLICT DO NOTHING`: un valor ya ajustado
--      por `admin` no se pisa en la segunda corrida.
--   2. Roles `gerencia_comercial` y `gerencia_general` (tipo_enlace 'ninguno', internos, no de sistema). Sin
--      ALTER TYPE: la lista de roles es la tabla `permisos_roles` desde la 0178.
--   3. Permisos (ÁRBOL GENERADO, `npm run permisos:seed -w apps/api -- --arbol torre [--reparto]`): seis ítems
--      (cuatro tableros y el Explorador bajo General; los umbrales bajo Administración) y diez acciones. Las
--      operaciones `torre.*` NO se siembran: nacen absorbidas por su acción (como las de Dr. Flit, 0254).
--      Reparto: `admin` todo; `financiera` su tablero y el Explorador; `auditor` los cuatro tableros, consultar,
--      buscar placa y ver umbrales (SIN exportar: la auditoría no descarga); `gerencia_comercial` su tablero y el
--      Explorador; `gerencia_general` los cuatro tableros, el Explorador y ver umbrales. NADIE salvo `admin`
--      recibe `accion.torre_umbrales.editar`. «Ver las métricas de dinero» (`torre.metricas.dinero`, que el motor
--      exige a las métricas `requiereDinero`) la tienen admin, financiera, auditor y las dos gerencias; un admin
--      se la quita a un rol desde Roles y permisos sin tocar código. Los dos roles nuevos reciben además lo que `crearRol` da a todo rol
--      nuevo: Perfil y «Ver los manuales» de Dr. Flit, con su cadena (reparto universal, P-22).
--   4. Índices de lectura de la Torre (también declarados en el `index()` de su schema).

-- ── 1. Umbrales ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_torre_umbrales (
  clave           varchar(60)   PRIMARY KEY,
  valor           numeric(14,2) NOT NULL,
  unidad          varchar(12)   NOT NULL,
  descripcion     text          NOT NULL,
  actualizado_por integer       REFERENCES users(id) ON DELETE SET NULL,
  actualizado_en  timestamptz   DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_torre_umbrales_unidad_chk') THEN
    ALTER TABLE flito_torre_umbrales ADD CONSTRAINT flito_torre_umbrales_unidad_chk
      CHECK (unidad IN ('dias','horas','porcentaje','cop','conteo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_torre_umbrales_valor_chk') THEN
    ALTER TABLE flito_torre_umbrales ADD CONSTRAINT flito_torre_umbrales_valor_chk
      CHECK (valor >= 0 AND (unidad <> 'porcentaje' OR valor <= 100));
  END IF;
END $$;

COMMENT ON TABLE flito_torre_umbrales IS
  'Umbrales de las alertas de la Torre de Control (Épica #14590). Catálogo cerrado en shared-types (UMBRALES_TORRE); solo admin edita el valor.';

INSERT INTO flito_torre_umbrales (clave, valor, unidad, descripcion) VALUES
  ('horas_sin_gestion', 24, 'horas', 'Horas sin gestión a partir de las cuales un trámite se marca en riesgo.'),
  ('dias_borrador_abandonado', 5, 'dias', 'Días en borrador a partir de los cuales el trámite se considera abandonado.'),
  ('horas_soat_impuesto_sin_soporte', 24, 'horas', 'Horas que un SOAT o un impuesto solicitado puede esperar sin soporte.'),
  ('dias_respuesta_ot', 2, 'dias', 'Días que el organismo de tránsito tiene para responder antes de que el trámite se marque atrasado.'),
  ('pct_caida_volumen', 30, 'porcentaje', 'Caída de volumen de una compañía frente a su promedio que dispara la alerta comercial.'),
  ('dias_ventana_fuga', 30, 'dias', 'Días sin trámites a partir de los cuales una compañía se considera en fuga.'),
  ('dias_cobertura_amarillo', 15, 'dias', 'Días de cobertura de saldo por debajo de los cuales la bolsa se pinta en ámbar.'),
  ('dias_cobertura_rojo', 7, 'dias', 'Días de cobertura de saldo por debajo de los cuales la bolsa se pinta en rojo.'),
  ('meta_mensual_aprobados', 0, 'conteo', 'Meta mensual de trámites aprobados. 0 significa sin meta.')
ON CONFLICT (clave) DO NOTHING;

-- ── 2. Roles ────────────────────────────────────────────────────────────────────────────────────
INSERT INTO permisos_roles (codigo, nombre, descripcion, tipo_enlace, tipo_principal, es_sistema) VALUES
  ('gerencia_comercial', 'Gerencia Comercial', 'Lectura agregada de la Torre de Control: tablero comercial y Explorador.', 'ninguno', 'interno', false),
  ('gerencia_general', 'Gerencia General', 'Lectura agregada de la Torre de Control: los cuatro tableros, el Explorador y los umbrales (sin editarlos).', 'ninguno', 'interno', false)
ON CONFLICT (codigo) DO NOTHING;

-- ── 3. Permisos ─────────────────────────────────────────────────────────────────────────────────
-- ÁRBOL GENERADO (inicio)
-- 6 ítems (nivel 2) y 10 acciones (nivel 3). Generado: no editar a mano.
-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol torre
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('pagina.torre_360', 'torre_de_control', 'Torre · Vista 360°', 'Entrar a la pantalla «Torre · Vista 360°».', 'pagina', 'menu.general', '2', '30'),
  ('accion.torre_360.ver', 'torre_de_control', 'Ver la vista 360°', 'Consultar el tablero ejecutivo de la Torre de Control.', 'accion', 'pagina.torre_360', '3', '10'),
  ('pagina.torre_comercial', 'torre_de_control', 'Torre · Comercial', 'Entrar a la pantalla «Torre · Comercial».', 'pagina', 'menu.general', '2', '40'),
  ('accion.torre_comercial.ver', 'torre_de_control', 'Ver el tablero comercial', 'Consultar el volumen y la evolución por compañía.', 'accion', 'pagina.torre_comercial', '3', '10'),
  ('pagina.torre_operativa', 'torre_de_control', 'Torre · Operativa', 'Entrar a la pantalla «Torre · Operativa».', 'pagina', 'menu.general', '2', '50'),
  ('accion.torre_operativa.ver', 'torre_de_control', 'Ver el tablero operativo', 'Consultar los tiempos, el trabajo en curso y los trámites en riesgo.', 'accion', 'pagina.torre_operativa', '3', '10'),
  ('pagina.torre_financiera', 'torre_de_control', 'Torre · Financiera', 'Entrar a la pantalla «Torre · Financiera».', 'pagina', 'menu.general', '2', '60'),
  ('accion.torre_financiera.ver', 'torre_de_control', 'Ver el tablero financiero', 'Consultar costos, pagos, ingreso liquidado y lo pendiente de facturar.', 'accion', 'pagina.torre_financiera', '3', '10'),
  ('pagina.torre_explorador', 'torre_de_control', 'Torre · Explorador', 'Entrar a la pantalla «Torre · Explorador».', 'pagina', 'menu.general', '2', '70'),
  ('accion.torre_explorador.consultar', 'torre_de_control', 'Consultar métricas', 'Consultar cualquier métrica del catálogo con sus filtros y agrupaciones.', 'accion', 'pagina.torre_explorador', '3', '10'),
  ('accion.torre_explorador.exportar', 'torre_de_control', 'Exportar métricas', 'Descargar en Excel o PDF el resultado de una consulta agregada.', 'accion', 'pagina.torre_explorador', '3', '20'),
  ('accion.torre_explorador.buscar_placa', 'torre_de_control', 'Buscar una placa', 'Abrir la ficha de un trámite por su placa, sin datos personales del comprador.', 'accion', 'pagina.torre_explorador', '3', '30'),
  ('accion.torre_explorador.ver_dinero', 'torre_de_control', 'Ver las métricas de dinero', 'Consultar costos, impuestos, derechos, ingreso liquidado y lo pendiente de facturar.', 'accion', 'pagina.torre_explorador', '3', '40'),
  ('pagina.torre_umbrales', 'administracion', 'Torre · Umbrales', 'Entrar a la pantalla «Torre · Umbrales».', 'pagina', 'menu.administracion', '2', '70'),
  ('accion.torre_umbrales.ver', 'administracion', 'Ver los umbrales', 'Consultar los umbrales que usan las alertas de la Torre.', 'accion', 'pagina.torre_umbrales', '3', '10'),
  ('accion.torre_umbrales.editar', 'administracion', 'Editar los umbrales', 'Cambiar el valor de un umbral de la Torre.', 'accion', 'pagina.torre_umbrales', '3', '20')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe TODAS las acciones y su cadena (ADR-0022); financiera, auditor y las dos gerencias, su
-- reparto literal (`REPARTO_TORRE`); los dos roles nuevos, además, lo universal de todo rol nuevo (Perfil y
-- «Ver los manuales» de Dr. Flit, con su cadena). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES
  ('admin', 'accion.torre_360.ver'),
  ('admin', 'accion.torre_comercial.ver'),
  ('admin', 'accion.torre_explorador.buscar_placa'),
  ('admin', 'accion.torre_explorador.consultar'),
  ('admin', 'accion.torre_explorador.exportar'),
  ('admin', 'accion.torre_explorador.ver_dinero'),
  ('admin', 'accion.torre_financiera.ver'),
  ('admin', 'accion.torre_operativa.ver'),
  ('admin', 'accion.torre_umbrales.editar'),
  ('admin', 'accion.torre_umbrales.ver'),
  ('admin', 'menu.administracion'),
  ('admin', 'menu.general'),
  ('admin', 'pagina.torre_360'),
  ('admin', 'pagina.torre_comercial'),
  ('admin', 'pagina.torre_explorador'),
  ('admin', 'pagina.torre_financiera'),
  ('admin', 'pagina.torre_operativa'),
  ('admin', 'pagina.torre_umbrales'),
  ('auditor', 'accion.torre_360.ver'),
  ('auditor', 'accion.torre_comercial.ver'),
  ('auditor', 'accion.torre_explorador.buscar_placa'),
  ('auditor', 'accion.torre_explorador.consultar'),
  ('auditor', 'accion.torre_explorador.ver_dinero'),
  ('auditor', 'accion.torre_financiera.ver'),
  ('auditor', 'accion.torre_operativa.ver'),
  ('auditor', 'accion.torre_umbrales.ver'),
  ('auditor', 'menu.administracion'),
  ('auditor', 'menu.general'),
  ('auditor', 'pagina.torre_360'),
  ('auditor', 'pagina.torre_comercial'),
  ('auditor', 'pagina.torre_explorador'),
  ('auditor', 'pagina.torre_financiera'),
  ('auditor', 'pagina.torre_operativa'),
  ('auditor', 'pagina.torre_umbrales'),
  ('financiera', 'accion.torre_explorador.buscar_placa'),
  ('financiera', 'accion.torre_explorador.consultar'),
  ('financiera', 'accion.torre_explorador.exportar'),
  ('financiera', 'accion.torre_explorador.ver_dinero'),
  ('financiera', 'accion.torre_financiera.ver'),
  ('financiera', 'menu.general'),
  ('financiera', 'pagina.torre_explorador'),
  ('financiera', 'pagina.torre_financiera'),
  ('gerencia_comercial', 'accion.dr_flit.ver_manuales'),
  ('gerencia_comercial', 'accion.perfil.cambiar_contrasena'),
  ('gerencia_comercial', 'accion.perfil.ver_datos'),
  ('gerencia_comercial', 'accion.torre_comercial.ver'),
  ('gerencia_comercial', 'accion.torre_explorador.buscar_placa'),
  ('gerencia_comercial', 'accion.torre_explorador.consultar'),
  ('gerencia_comercial', 'accion.torre_explorador.exportar'),
  ('gerencia_comercial', 'accion.torre_explorador.ver_dinero'),
  ('gerencia_comercial', 'menu.general'),
  ('gerencia_comercial', 'menu.general'),
  ('gerencia_comercial', 'menu.perfil'),
  ('gerencia_comercial', 'pagina.flito_dr_flit'),
  ('gerencia_comercial', 'pagina.perfil'),
  ('gerencia_comercial', 'pagina.torre_comercial'),
  ('gerencia_comercial', 'pagina.torre_explorador'),
  ('gerencia_general', 'accion.dr_flit.ver_manuales'),
  ('gerencia_general', 'accion.perfil.cambiar_contrasena'),
  ('gerencia_general', 'accion.perfil.ver_datos'),
  ('gerencia_general', 'accion.torre_360.ver'),
  ('gerencia_general', 'accion.torre_comercial.ver'),
  ('gerencia_general', 'accion.torre_explorador.buscar_placa'),
  ('gerencia_general', 'accion.torre_explorador.consultar'),
  ('gerencia_general', 'accion.torre_explorador.exportar'),
  ('gerencia_general', 'accion.torre_explorador.ver_dinero'),
  ('gerencia_general', 'accion.torre_financiera.ver'),
  ('gerencia_general', 'accion.torre_operativa.ver'),
  ('gerencia_general', 'accion.torre_umbrales.ver'),
  ('gerencia_general', 'menu.administracion'),
  ('gerencia_general', 'menu.general'),
  ('gerencia_general', 'menu.general'),
  ('gerencia_general', 'menu.perfil'),
  ('gerencia_general', 'pagina.flito_dr_flit'),
  ('gerencia_general', 'pagina.perfil'),
  ('gerencia_general', 'pagina.torre_360'),
  ('gerencia_general', 'pagina.torre_comercial'),
  ('gerencia_general', 'pagina.torre_explorador'),
  ('gerencia_general', 'pagina.torre_financiera'),
  ('gerencia_general', 'pagina.torre_operativa'),
  ('gerencia_general', 'pagina.torre_umbrales')
) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
-- ÁRBOL GENERADO (fin)

-- ── 4. Índices de la Torre ──────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_flito_tramites_compania_aprobacion
  ON flito_tramites (compania_id, fecha_aprobacion) WHERE fecha_aprobacion IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_tramites_fecha_aprobacion
  ON flito_tramites (fecha_aprobacion) WHERE fecha_aprobacion IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_tramites_organismo
  ON flito_tramites (organismo_codigo);
CREATE INDEX IF NOT EXISTS idx_flito_tramites_inicio
  ON flito_tramites ((COALESCE(fecha_creacion_flit, created_at)));
CREATE INDEX IF NOT EXISTS idx_flito_tramites_placa_upper
  ON flito_tramites (upper(plate_complete));
CREATE INDEX IF NOT EXISTS idx_flito_tramite_historial_campo_fecha
  ON flito_tramite_historial (campo, created_at) INCLUDE (tramite_id);
CREATE INDEX IF NOT EXISTS idx_flito_impuestos_compania_pagado
  ON flito_impuestos (compania_id, pagado_en);
CREATE INDEX IF NOT EXISTS idx_flito_derechos_fecha_pago
  ON flito_derechos_tramite (fecha_pago) WHERE fecha_pago IS NOT NULL;
