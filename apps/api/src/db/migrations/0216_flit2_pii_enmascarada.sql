-- 0216_flit2_pii_enmascarada.sql
-- HU #13094 (Feature #13059, Épica #12736) — defensa ante datos personales enmascarados de FLIT 2:
--   marca del trámite leído sin el scope `external.tramites.pii.read` (`flito_tramites.flit2_pii_enmascarada`,
--   con índice parcial para que la relectura los encuentre), y en la posición de lectura desde cuándo la
--   lectura llega enmascarada (`pii_enmascarada_desde`) y el cursor propio de la relectura de recuperación
--   (`cursor_relectura`), aparte del cursor normal para que este no se mueva.
-- Autor: equipo FLITO. Antecedentes: 0215 (lectura incremental), diseño
--   `docs/diseno/hu-13094-pii-enmascarada-flit2.md`, ADR-DB-001 (sin control de transacción propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / pg_constraint; la 2a pasada no toca nada.

-- ── Paso 1 — Marca del trámite (ADD COLUMN con DEFAULT constante: sin reescritura de la tabla) ────
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS flit2_pii_enmascarada boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_flito_tramites_flit2_pii_enmascarada
  ON flito_tramites (id) WHERE flit2_pii_enmascarada;

-- ── Paso 2 — Posición de lectura: desde cuándo llega enmascarada y cursor de la relectura ────────
ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS pii_enmascarada_desde timestamptz NULL;
ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS cursor_relectura      text        NULL;

DO $ck0216$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_sync_flit2_lectura_cursor_relectura_len'
                   AND conrelid = 'flito_sync_flit2_lectura'::regclass) THEN
    ALTER TABLE flito_sync_flit2_lectura ADD CONSTRAINT ck_flito_sync_flit2_lectura_cursor_relectura_len
      CHECK (cursor_relectura IS NULL OR length(cursor_relectura) BETWEEN 1 AND 2000);
  END IF;
END $ck0216$;

COMMENT ON COLUMN flito_tramites.flit2_pii_enmascarada IS
  'HU #13094: el trámite de FLIT 2 se leyó sin el scope de datos personales; espera la relectura.';
COMMENT ON COLUMN flito_sync_flit2_lectura.pii_enmascarada_desde IS
  'HU #13094: primera lectura enmascarada pendiente de recuperar; null = nada que recuperar.';
COMMENT ON COLUMN flito_sync_flit2_lectura.cursor_relectura IS
  'HU #13094: posición de la relectura de recuperación en curso; null = empieza desde el arranque.';

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0216$
DECLARE n_col_tramite int; n_indice int; n_col_lectura int; n_check int; n_marcados int;
BEGIN
  SELECT count(*) INTO n_col_tramite FROM information_schema.columns
   WHERE table_name = 'flito_tramites' AND column_name = 'flit2_pii_enmascarada';
  SELECT count(*) INTO n_indice FROM pg_indexes
   WHERE tablename = 'flito_tramites' AND indexname = 'idx_flito_tramites_flit2_pii_enmascarada';
  SELECT count(*) INTO n_col_lectura FROM information_schema.columns
   WHERE table_name = 'flito_sync_flit2_lectura' AND column_name IN ('pii_enmascarada_desde', 'cursor_relectura');
  SELECT count(*) INTO n_check FROM pg_constraint
   WHERE conrelid = 'flito_sync_flit2_lectura'::regclass AND conname = 'ck_flito_sync_flit2_lectura_cursor_relectura_len';
  IF n_col_tramite <> 1 OR n_indice <> 1 OR n_col_lectura <> 2 OR n_check <> 1 THEN
    RAISE EXCEPTION '0216: PII enmascarada de FLIT 2 inconsistente (col=%, indice=%, lectura=%, check=%)',
      n_col_tramite, n_indice, n_col_lectura, n_check;
  END IF;
  SELECT count(*) INTO n_marcados FROM flito_tramites WHERE flit2_pii_enmascarada;
  RAISE NOTICE '0216: marca de PII enmascarada de FLIT 2 lista (% trámites marcados)', n_marcados;
END $resumen0216$;
