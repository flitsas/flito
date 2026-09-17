-- 0202_comprobantes_diferencia.sql
-- Epica #12245 — Modulo universal de comprobantes (ADR-0018). F3 (HU #12654): la operacion de
--   ACEPTAR la diferencia entre el valor documental y la tarifa de referencia de un comprobante
--   aplicado como pago (modulo `comprobantes`), repartida a admin + financiera. NO toca
--   flito_comprobantes: las columnas diferencia_aceptada_* existen desde la 0198.
-- Autor: equipo FLITO. Antecedentes: 0201 (calco literal de la siembra operacion + reparto),
--   0198/0197/0192 (una tupla por linea, byte a byte con catalogo-operaciones.ts), ADR-DB-001 (sin
--   control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. Sin unaccent. La anterior es la 0201_ (HU #12629).

-- ── Paso 1 — La operacion de F3 (byte a byte con catalogo-operaciones.ts) ────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('comprobantes.diferencia.aceptar',     'comprobantes', 'Aceptar la diferencia de un comprobante', 'Aceptar con motivo la diferencia entre el valor del comprobante y la tarifa de referencia.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto en VALUES explicitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'comprobantes.diferencia.aceptar'),
  ('financiera', 'comprobantes.diferencia.aceptar')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0202$
DECLARE n_ops int; n_reparto int;
BEGIN
  -- Por codigo exacto y NO por modulo/prefijo: `comprobantes.*` ya tiene las cinco de la 0198 y las tres de la 0201.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'comprobantes.diferencia.aceptar';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE rol_codigo IN ('admin', 'financiera') AND funcion_codigo = 'comprobantes.diferencia.aceptar';
  IF n_ops <> 1 OR n_reparto <> 2 THEN
    RAISE EXCEPTION '0202: operacion de aceptar diferencia inconsistente (ops=%, reparto=%)', n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0202: 1 operacion de comprobantes F3 sembrada (% filas de reparto: admin y financiera)', n_reparto;
END $resumen0202$;
