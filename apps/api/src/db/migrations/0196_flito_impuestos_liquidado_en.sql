-- 0196_flito_impuestos_liquidado_en.sql
-- Feature #12589 — Impuestos: liquidacion del impuesto y pago con marca. HU #12590 (regla de fases):
--   flito_impuestos gana liquidado_en, la fecha-hora en que se cargo la LIQUIDACION DEL IMPUESTO (el
--   documento de la hacienda sin marca). Es una marca sobre `solicitado`: el estado no cambia; solo
--   el pago con marca (sello PAGADO) lleva el impuesto a `pagado`.
--   Y se unifica el literal del soporte sin marca: flito-recibos.service.ts escribia
--   'recibo_impuesto_sin_marca' mientras el catalogo (TipoSoporte) y soportes-zip.ts buscan
--   'recibo_impuesto_sin_marca_agua'. Con dos literales, el ZIP de soportes no encontraba la copia
--   limpia de los impuestos cargados por la API.
-- Autor: equipo FLITO. Antecedentes: 0194 y 0195 (patron ADD COLUMN IF NOT EXISTS + resumen),
--   ADR-DB-001.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ADD COLUMN IF NOT EXISTS; el UPDATE solo alcanza filas con el literal viejo, asi
--     que la 2a pasada no cambia nada (0 filas).
--   - SIN BACKFILL de liquidado_en, a proposito (decision R6): un impuesto con copia sin marca
--     historica no queda «liquidado» por esta migracion. NULL = «no se ha cargado la liquidacion»
--     desde que existe la fase; lo anterior no se reinterpreta.
--   - NO es flito_liquidaciones.liquidado_en (esa es la Liquidacion de FLITO, el total a cobrar).
--     Mismo nombre de columna, tablas y significados distintos (decision R7).
--   - UN indice nuevo, y no para liquidado_en (el filtro «liquidado pendiente de pago» va AND con
--     estado, que ya lo tiene): idx_flito_soportes_impuesto_tipo, porque la cola de impuestos lee
--     ahora los documentos por pagina con `impuesto_id IN (...) AND tipo IN (...)` y flito_soportes
--     no tenia ningun indice por impuesto_id (calcado de idx_flito_soportes_soat_tipo, 0177).

-- ── Paso 1 — La columna ──────────────────────────────────────────────────────────────────────────
ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS liquidado_en timestamptz;

COMMENT ON COLUMN flito_impuestos.liquidado_en IS 'HU #12590: fecha-hora de la carga de la liquidación del impuesto (documento de la hacienda sin marca). Marca «liquidado» sobre estado=solicitado; el estado NO cambia con ella. NULL = liquidación no cargada. NO es flito_liquidaciones.liquidado_en (Liquidación de FLITO, total a cobrar). Sin backfill.';

-- ── Paso 2 — Indice para la cola de impuestos ───────────────────────────────────────────────────
-- La cola de impuestos (ensamblar) lee los documentos de cada pagina con impuesto_id IN (...) AND tipo
-- IN (...) AND descartado = false, y flito_soportes no tenia indice por impuesto_id: calcado del de SOAT en la 0177.
CREATE INDEX IF NOT EXISTS idx_flito_soportes_impuesto_tipo
  ON flito_soportes (impuesto_id, tipo)
  WHERE impuesto_id IS NOT NULL AND descartado = false;

-- ── Paso 3 — Un solo literal para la copia sin marca, y resumen para el log del CD ───────────────
-- El UPDATE va dentro del bloque para que el NOTICE diga cuantas filas renombro ESTA pasada
-- (la segunda dice 0).
DO $resumen0196$
DECLARE n_col int; n_nullable text; n_idx int; n_renombrados bigint; n_viejos bigint; n_nuevos bigint;
BEGIN
  UPDATE flito_soportes
     SET tipo = 'recibo_impuesto_sin_marca_agua'
   WHERE tipo = 'recibo_impuesto_sin_marca';
  GET DIAGNOSTICS n_renombrados = ROW_COUNT;

  SELECT count(*), max(is_nullable) INTO n_col, n_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flito_impuestos'
      AND column_name = 'liquidado_en';
  IF n_col <> 1 THEN
    RAISE EXCEPTION '0196: flito_impuestos.liquidado_en no quedo creada (columnas=%)', n_col;
  END IF;
  IF n_nullable <> 'YES' THEN
    RAISE EXCEPTION '0196: flito_impuestos.liquidado_en debe admitir NULL (is_nullable=%)', n_nullable;
  END IF;
  SELECT count(*) INTO n_idx FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'flito_soportes'
      AND indexname = 'idx_flito_soportes_impuesto_tipo';
  IF n_idx <> 1 THEN
    RAISE EXCEPTION '0196: idx_flito_soportes_impuesto_tipo no quedo creado (indices=%)', n_idx;
  END IF;
  SELECT count(*) INTO n_viejos FROM flito_soportes WHERE tipo = 'recibo_impuesto_sin_marca';
  IF n_viejos <> 0 THEN
    RAISE EXCEPTION '0196: quedan % soportes con el literal viejo recibo_impuesto_sin_marca', n_viejos;
  END IF;
  SELECT count(*) INTO n_nuevos FROM flito_soportes WHERE tipo = 'recibo_impuesto_sin_marca_agua';
  RAISE NOTICE '0196: flito_impuestos.liquidado_en lista (timestamptz NULL, sin backfill); idx_flito_soportes_impuesto_tipo presente; % soportes renombrados en esta pasada, % en total con recibo_impuesto_sin_marca_agua, 0 con el literal viejo', n_renombrados, n_nuevos;
END $resumen0196$;
