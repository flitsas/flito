-- 0215_flit2_lectura_incremental.sql
-- HU #13091 (Feature #13059, Épica #12736) — lectura incremental de trámites FLIT 2: identidad y
--   versión del trámite de FLIT 2 en `flito_tramites` (`id_flit2`, `sync_version`, índice único
--   parcial y dos CHECK que atan `fuente='flit2'` a esa identidad) y la posición de lectura del
--   feed (`flito_sync_flit2_lectura`, una sola fila). `atrasada` y `ultimo_error_codigo` los
--   consume la HU #13092; nacen aquí para no pedir otra migración.
-- Autor: equipo FLITO. Antecedentes: 0213 (columna `fuente`), 0214 (acceso a FLIT 2), diseño
--   `docs/diseno/hu-13091-lectura-incremental-flit2.md`, ADR-DB-001 (sin control de transacción propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING / pg_constraint; la 2a pasada no toca nada.

-- ── Paso 1 — Columnas del trámite ────────────────────────────────────────────────────────────────
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS id_flit2     uuid   NULL;
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS sync_version bigint NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_tramites_id_flit2
  ON flito_tramites (id_flit2) WHERE id_flit2 IS NOT NULL;

-- ── Paso 2 — CHECKs (pre-chequeo con mensaje legible antes de añadirlos) ─────────────────────────
DO $ck0215$
BEGIN
  IF EXISTS (SELECT 1 FROM flito_tramites
              WHERE (fuente = 'flit2') <> (id_flit2 IS NOT NULL)
                 OR (id_flit2 IS NOT NULL AND sync_version IS NULL)) THEN
    RAISE EXCEPTION '0215: hay filas que violarían los CHECK de fuente/id_flit2/sync_version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_tramites_fuente_id_flit2'
                   AND conrelid = 'flito_tramites'::regclass) THEN
    ALTER TABLE flito_tramites ADD CONSTRAINT ck_flito_tramites_fuente_id_flit2
      CHECK ((fuente = 'flit2') = (id_flit2 IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_tramites_flit2_sync_version'
                   AND conrelid = 'flito_tramites'::regclass) THEN
    ALTER TABLE flito_tramites ADD CONSTRAINT ck_flito_tramites_flit2_sync_version
      CHECK (id_flit2 IS NULL OR sync_version IS NOT NULL);
  END IF;
END $ck0215$;

-- ── Paso 3 — Posición de lectura del feed (una sola fila, id = 1) ────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_sync_flit2_lectura (
  id                   smallint PRIMARY KEY DEFAULT 1,
  cursor               text NULL,
  since_arranque       timestamptz NULL,
  ultima_exitosa_en    timestamptz NULL,
  ultimo_intento_en    timestamptz NULL,
  ultimo_error_codigo  varchar(40) NULL,
  atrasada             boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_flito_sync_flit2_lectura_una_fila CHECK (id = 1),
  CONSTRAINT ck_flito_sync_flit2_lectura_cursor_len CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 2000)
);

-- Nadie inserta desde el código: solo `UPDATE … WHERE id = 1`.
INSERT INTO flito_sync_flit2_lectura (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE flito_sync_flit2_lectura IS
  'HU #13091: posición de lectura del feed de FLIT 2 (una fila, id=1).';

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0215$
DECLARE n_indice int; n_checks int; n_fila int;
BEGIN
  SELECT count(*) INTO n_indice FROM pg_indexes
   WHERE tablename = 'flito_tramites' AND indexname = 'uq_flito_tramites_id_flit2';
  SELECT count(*) INTO n_checks FROM pg_constraint
   WHERE conrelid = 'flito_tramites'::regclass
     AND conname IN ('ck_flito_tramites_fuente_id_flit2', 'ck_flito_tramites_flit2_sync_version');
  SELECT count(*) INTO n_fila FROM flito_sync_flit2_lectura WHERE id = 1;
  IF n_indice <> 1 OR n_checks <> 2 OR n_fila <> 1 THEN
    RAISE EXCEPTION '0215: lectura FLIT 2 inconsistente (indice=%, checks=%, fila=%)', n_indice, n_checks, n_fila;
  END IF;
  RAISE NOTICE '0215: id_flit2/sync_version listos en flito_tramites; posición de lectura FLIT 2 sembrada';
END $resumen0215$;
