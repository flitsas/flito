-- 0212_permiso_soat_reintentar_runt.sql
-- HU #12998 (Feature #12841, diseño §11 Q2 y §11.1) — la función `soat.solicitud.reintentar_runt`,
--   que guarda SOLO `POST /api/flito/soat/cliente/incompletas/:id/reintentar`: reintentar a mano la
--   consulta al RUNT de una solicitud «Por validar». Es una ACCIÓN (completa, descarta o suma un
--   intento), así que se siembra SOLO a admin (P-8 del UX): el administrador la reparte desde el panel.
-- Autor: equipo FLITO. Antecedentes: 0203 (calco literal: operación + reparto solo a admin),
--   0211 (lectura de las incompletas), ADR-DB-001 (sin control de transacción propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. La anterior es la 0211_ (HU #12997, lectura de incompletas).

-- ── Paso 1 — La operación (byte a byte con catalogo-operaciones.ts) ──────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('soat.solicitud.reintentar_runt', 'soat', 'Reintentar la consulta al RUNT de una solicitud de SOAT por validar', 'Volver a consultar el RUNT para completar, descartar o dejar por validar una solicitud que se guardó porque el RUNT no respondió.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto en VALUES explícitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'soat.solicitud.reintentar_runt')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0212$
DECLARE n_ops int; n_reparto int;
BEGIN
  -- Por código exacto y NO por módulo/prefijo: `soat.*` tiene decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'soat.solicitud.reintentar_runt';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE rol_codigo = 'admin' AND funcion_codigo = 'soat.solicitud.reintentar_runt';
  IF n_ops <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0212: función de reintento RUNT inconsistente (ops=%, reparto=%)', n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0212: función soat.solicitud.reintentar_runt sembrada (% fila de reparto: solo admin)', n_reparto;
END $resumen0212$;
