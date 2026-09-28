-- HU #12825 (Épica #12809, Feature #12821) — Impuestos: estado del análisis post-envío.
--
-- Al enviar un impuesto al gestor se encola un análisis en segundo plano (OCR de la factura,
-- consulta RUNT, semáforo: HUs 12826-12828). Estas columnas llevan su ciclo de vida:
--   analisis_estado       NULL = nunca encolado (histórico, sin backfill a propósito)
--   analisis_encolado_en  cuándo se encoló (envío, reintento manual o recuperación)
--   analisis_reencolados  cuántas veces lo re-encoló la recuperación de huérfanos (AC4: una sola)
--   analizado_en          cuándo corrió el análisis con al menos un paso (idempotencia, AC2)
--
-- Idempotente: se puede aplicar dos veces sin error.

DO $$ BEGIN
  CREATE TYPE flito_impuesto_analisis_estado AS ENUM ('en_curso', 'completado', 'error_analisis');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS analisis_estado      flito_impuesto_analisis_estado,
  ADD COLUMN IF NOT EXISTS analisis_encolado_en timestamptz,
  ADD COLUMN IF NOT EXISTS analisis_reencolados smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analizado_en         timestamptz;

-- El barrido de huérfanos (cada 5 min) solo mira los `en_curso`: índice parcial, diminuto.
CREATE INDEX IF NOT EXISTS idx_flito_impuestos_analisis_en_curso
  ON flito_impuestos (analisis_encolado_en) WHERE analisis_estado = 'en_curso';
