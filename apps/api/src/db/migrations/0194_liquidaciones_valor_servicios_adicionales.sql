-- 0194_liquidaciones_valor_servicios_adicionales.sql
-- Feature #12544 — Servicios adicionales por tramite. HU #12546 (liquidacion y reporte):
--   flito_liquidaciones gana valor_servicios_adicionales, la SUMA sellada de los servicios
--   adicionales del tramite en el instante de liquidar. El desglose por tipo no va en una columna:
--   va en detalle->'serviciosAdicionales'->'items' (tipoId, nombre, valor), que es el mismo jsonb
--   donde ya viven los otros cinco conceptos.
-- Autor: equipo FLITO. Antecedentes: 0193 (tabla puente flito_tramite_servicios_adicionales),
--   0191 (catalogo de tipos), ADR-0017 (snapshot y guarda transaccional), ADR-DB-001.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ADD COLUMN IF NOT EXISTS; la 2a pasada no cambia nada.
--   - SIN BACKFILL, a proposito. Poner 0 en las liquidaciones ya selladas diria «este tramite no
--     llevaba servicios», y eso no se sabe: la HU #12545 solo existe desde la 0193 y la columna
--     nace vacia para TODAS. NULL aqui significa «no aplica» (sin servicios o sellada antes de esta
--     HU), nunca cero; sumarla exige COALESCE(...,0) en quien la lee, igual que valor_logistica.
--   - Tampoco se toca ningun indice: el (tramite_id) de la 0193 se queda como esta.

-- ── Paso 1 — La columna ──────────────────────────────────────────────────────────────────────────
ALTER TABLE flito_liquidaciones
  ADD COLUMN IF NOT EXISTS valor_servicios_adicionales numeric(14,2);

COMMENT ON COLUMN flito_liquidaciones.valor_servicios_adicionales IS 'HU #12546: suma sellada de los servicios adicionales del trámite al liquidar. NULL = no aplica (el trámite se selló sin servicios adicionales, o se selló antes de esta HU); NUNCA cero implícito. El desglose por tipo va en detalle->''serviciosAdicionales''->''items''. Sin backfill: las liquidaciones anteriores a esta migración se quedan en NULL.';

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0194$
DECLARE n_col int; n_nulos bigint; n_tipo text;
BEGIN
  SELECT count(*) INTO n_col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flito_liquidaciones'
      AND column_name = 'valor_servicios_adicionales';
  IF n_col <> 1 THEN
    RAISE EXCEPTION '0194: flito_liquidaciones.valor_servicios_adicionales no quedo creada (columnas=%)', n_col;
  END IF;
  SELECT format('%s(%s,%s)', data_type, numeric_precision, numeric_scale) INTO n_tipo
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flito_liquidaciones'
      AND column_name = 'valor_servicios_adicionales';
  SELECT count(*) INTO n_nulos FROM flito_liquidaciones WHERE valor_servicios_adicionales IS NULL;
  RAISE NOTICE '0194: flito_liquidaciones.valor_servicios_adicionales lista (% ); % liquidaciones existentes quedan en NULL = no aplica (sin backfill)', n_tipo, n_nulos;
END $resumen0194$;
