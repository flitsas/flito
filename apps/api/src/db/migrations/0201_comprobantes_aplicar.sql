-- 0201_comprobantes_aplicar.sql
-- Epica #12245 — Modulo universal de comprobantes (ADR-0018). F2 (HU #12629): las TRES operaciones
--   de asociar (buscar tramites, aplicar o adjuntar, descartar) del modulo `comprobantes`, repartidas
--   a admin + financiera. NO toca flito_comprobantes: todas sus columnas existen desde la 0198.
-- Autor: equipo FLITO. Antecedentes: 0198 (calco literal de la siembra operacion + reparto),
--   0197/0192 (una tupla por linea, byte a byte con catalogo-operaciones.ts), ADR-DB-001 (sin
--   control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. La anterior es la 0200_ (Feature #12621, sesion paralela).

-- ── Paso 1 — Las tres operaciones de F2 (byte a byte con catalogo-operaciones.ts) ─────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('comprobantes.tramites.buscar',        'comprobantes', 'Buscar trámites para un comprobante',  'Buscar por ID FLIT, placa o VIN el trámite al que asociar un comprobante.', 'operacion'),
  ('comprobantes.comprobante.aplicar',    'comprobantes', 'Aplicar o adjuntar un comprobante',    'Asociar un comprobante a un trámite y concepto: como pago o como documentación.', 'operacion'),
  ('comprobantes.comprobante.descartar',  'comprobantes', 'Descartar un comprobante',             'Sacar de la cola un comprobante que no corresponde, dejando el motivo.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto en VALUES explicitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'comprobantes.tramites.buscar'),
  ('admin', 'comprobantes.comprobante.aplicar'),
  ('admin', 'comprobantes.comprobante.descartar'),
  ('financiera', 'comprobantes.tramites.buscar'),
  ('financiera', 'comprobantes.comprobante.aplicar'),
  ('financiera', 'comprobantes.comprobante.descartar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0201$
DECLARE n_ops int; n_reparto int;
BEGIN
  -- Por codigo exacto y NO por modulo/prefijo: `comprobantes.*` ya tiene las cinco de la 0198 y F3 sembrara otra.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN
    ('comprobantes.tramites.buscar', 'comprobantes.comprobante.aplicar', 'comprobantes.comprobante.descartar');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE rol_codigo IN ('admin', 'financiera') AND funcion_codigo IN
    ('comprobantes.tramites.buscar', 'comprobantes.comprobante.aplicar', 'comprobantes.comprobante.descartar');
  IF n_ops <> 3 OR n_reparto <> 6 THEN
    RAISE EXCEPTION '0201: operaciones de comprobantes F2 inconsistentes (ops=%, reparto=%)', n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0201: 3 operaciones de comprobantes F2 sembradas (% filas de reparto: admin y financiera)', n_reparto;
END $resumen0201$;
