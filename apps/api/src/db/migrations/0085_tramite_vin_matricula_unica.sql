-- 0085 — Unicidad VIN para matrícula inicial (trámites activos sin tipología).
--
-- Invariante: un VIN → un trámite activo (estado <> rechazado) cuando tipologia_codigo IS NULL.
-- Paso 1 consolida duplicados legacy; paso 2 crea índice parcial único.
-- ADR-DB-001: sin BEGIN/COMMIT.

-- Consolidar duplicados: conservar el más reciente (updated_at, paso, id).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY vin
      ORDER BY updated_at DESC, paso DESC, id DESC
    ) AS rn
  FROM tramites_digitales
  WHERE tipologia_codigo IS NULL
    AND vin IS NOT NULL
    AND btrim(vin) <> ''
    AND estado <> 'rechazado'
)
UPDATE tramites_digitales t
SET
  estado = 'rechazado',
  notas = COALESCE(notas, '') || E'\n[0085] Duplicado consolidado antes de índice único VIN (matrícula inicial).',
  updated_at = NOW()
FROM ranked r
WHERE t.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tramites_vin_matricula_activa
  ON tramites_digitales (vin)
  WHERE tipologia_codigo IS NULL
    AND vin IS NOT NULL
    AND btrim(vin) <> ''
    AND estado <> 'rechazado';

COMMENT ON INDEX idx_tramites_vin_matricula_activa IS
  'Un VIN solo puede tener un trámite activo de matrícula inicial (sin tipología). Rechazado libera el VIN.';
