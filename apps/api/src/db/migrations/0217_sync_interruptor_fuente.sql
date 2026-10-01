-- 0217_sync_interruptor_fuente.sql
-- HU #13237 (Feature #13236, Épica #12736) — interruptor por fuente de la sincronización FLIT: la tabla
--   `flito_sync_interruptor` (una fila por fuente, flit1 y flit2, sembradas ENCENDIDAS: sin cambio de
--   comportamiento al desplegar) y la función `tramites.sincronizacion.configurar`, sembrada SOLO a admin.
--   El interruptor es propio de cada ambiente: vive en la base, no en una variable.
-- Autor: equipo FLITO. Antecedentes: 0214 (calco: tabla + operación + reparto solo a admin), 0215 (fila
--   de lectura de FLIT 2, que NO se reutiliza: su `updated_at` lo mueve cada página), ADR-DB-001 (sin
--   control de transacción propio). Diseño: docs/diseno/hu-13237-interruptor-sincronizacion.md.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING. La 2a pasada NO re-enciende una fuente que
--     alguien apagó entre pasadas.

-- ── Paso 1 — La tabla ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_sync_interruptor (
  fuente      varchar(10) PRIMARY KEY,
  encendido   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NULL,
  updated_by  integer NULL REFERENCES users(id),
  CONSTRAINT ck_flito_sync_interruptor_fuente CHECK (fuente IN ('flit1', 'flit2'))
);

COMMENT ON TABLE flito_sync_interruptor IS
  'HU #13237: interruptor por fuente de la sincronización FLIT, propio de cada ambiente. Sembrado encendido; updated_at/updated_by null = nadie lo ha cambiado.';

-- ── Paso 2 — Siembra encendida. DO NOTHING: nunca pisa lo que alguien apagó ──────────────────────
INSERT INTO flito_sync_interruptor (fuente) VALUES
  ('flit1'),
  ('flit2')
ON CONFLICT (fuente) DO NOTHING;

-- ── Paso 3 — La operación (byte a byte con catalogo-operaciones.ts) ──────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('tramites.sincronizacion.configurar', 'tramites', 'Configurar la sincronización con FLIT', 'Encender o apagar, en este ambiente, la entrada de trámites desde FLIT 1 y desde FLIT 2.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 4 — Reparto en VALUES explícitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'tramites.sincronizacion.configurar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0217$
DECLARE n_fuentes int; n_apagadas int; n_ops int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_fuentes FROM flito_sync_interruptor WHERE fuente IN ('flit1', 'flit2');
  SELECT count(*) INTO n_apagadas FROM flito_sync_interruptor WHERE NOT encendido;
  -- Por código exacto y NO por módulo/prefijo: `tramites.*` tiene decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones
   WHERE tipo = 'operacion' AND codigo = 'tramites.sincronizacion.configurar';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin' AND funcion_codigo = 'tramites.sincronizacion.configurar';
  IF n_fuentes <> 2 OR n_ops <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0217: interruptor de sincronización inconsistente (fuentes=%, ops=%, reparto=%)', n_fuentes, n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0217: flito_sync_interruptor lista con % fuentes (% apagadas); función de configurar sembrada (solo admin)', n_fuentes, n_apagadas;
END $resumen0217$;
