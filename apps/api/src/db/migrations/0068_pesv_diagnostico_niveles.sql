-- PESV Auto-diagnóstico PHVA · Rediseño Sprint UX — PARTE 1/2 (Res. 40595/2022 anexo técnico)
--
-- Esta migración (estrategia A — split de rollout) añade SOLO el esqueleto
-- aditivo necesario para que backend y frontend puedan evolucionar sin
-- romper la UI actual:
--   1. Nivel de empresa (básico / estándar / avanzado) — Res. 40595/2022 anexo
--      técnico clasifica el PESV por tamaño de flota y misionalidad. Aunque
--      MOLANO aún verifica el conteo literal (seed pendiente), la columna se añade
--      en 0068 para que la UI cree diagnósticos con nivel desde el día 1.
--   2. Nivel rúbrica por estándar (4 niveles: No implementado / En desarrollo /
--      Implementado / Sostenido) — elimina la autodeclaración subjetiva del
--      slider 0–100 actual. Decisión P2 del plan UX aprobado.
--   3. Justificación de autoclasificación del nivel — texto libre opcional
--      requerido por MOLANO para trazabilidad Ley 1581 (no fuerza valor pero
--      permite auditoría posterior). Decisión PO usuario 2026-05-12.
--   4. Índice parcial para auditoría PESV (audit_logs).
--
-- ESTA MIGRACIÓN ES INTENCIONALMENTE PERMISIVA (NO incluye trigger anti-bypass
-- ni CHECK estricto sobre score_pct). El trigger se activa en migración
-- separada `0070_pesv_trigger_worm_rubrica.sql` (parte 2/2) coordinada con
-- el deploy del frontend nuevo, para no romper el slider continuo actual.
-- Backfill defensivo de nivel_rubrica desde score_pct legacy es idempotente.
-- El seed catalog para etiquetado básico/estándar queda pendiente del
-- concepto MOLANO Fase 2 (3-5 d hábiles, próximo número libre disponible).
--
-- Verificación previa BD viva (psql readonly 2026-05-12):
--   - PK compuesta (diagnostico_id, estandar_id) YA existe (mig 0053).
--   - CHECK score_pct ∈ [0,100] YA existe (no estorba el subset {0,50,75,100}).
--   - 24 estándares vigentes (catálogo limpio).
--   - 1 diagnóstico de prueba (id=1, año 2027, borrador). Score 0 en 24 items.
--   - Cero evidencias subidas históricamente (cero huérfanos MinIO).
--
-- Idempotencia:
--   - CREATE TYPE protegidos con DO $$ ... END $$ guards.
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
--   - CREATE INDEX IF NOT EXISTS para el índice parcial nuevo.
--   - UPDATE backfill es idempotente (CASE determinista sobre score_pct actual).
--
-- Restricciones del runner db-apply.ts:
--   - Transaccional + forward-only + SHA-256.
--   - NO usar CONCURRENTLY (incompatible con transacción explícita).
--   - El BEGIN/COMMIT está implícito en la transacción del runner; aquí lo
--     dejamos explícito para que también corra bien con psql -f.

BEGIN;

-- ============================================================================
-- 1. Enums de nivel (empresa + rúbrica)
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pesv_nivel_empresa') THEN
    CREATE TYPE pesv_nivel_empresa AS ENUM ('basico', 'estandar', 'avanzado');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pesv_nivel_rubrica') THEN
    CREATE TYPE pesv_nivel_rubrica AS ENUM (
      'no_implementado',
      'en_desarrollo',
      'implementado',
      'sostenido'
    );
  END IF;
END $$;

-- ============================================================================
-- 2. Columnas nuevas en tablas PESV
-- ============================================================================
-- Cabecera del diagnóstico: nivel del cliente + justificación opcional.
ALTER TABLE pesv_diagnosticos
  ADD COLUMN IF NOT EXISTS nivel_empresa pesv_nivel_empresa NOT NULL DEFAULT 'avanzado';

ALTER TABLE pesv_diagnosticos
  ADD COLUMN IF NOT EXISTS nivel_criterio_justificacion text;

COMMENT ON COLUMN pesv_diagnosticos.nivel_empresa IS
  'Autoclasificación del nivel PESV (Res. 40595/2022 anexo técnico). Default avanzado mientras MOLANO Fase 2 valida conteo literal y libera seed catalog niveles.';
COMMENT ON COLUMN pesv_diagnosticos.nivel_criterio_justificacion IS
  'Texto libre opcional con justificación de la autoclasificación de nivel — trazabilidad Ley 1581 según MOLANO. Decisión PO 2026-05-12.';

-- Catálogo: nivel mínimo requerido para que el estándar aplique al diagnóstico.
ALTER TABLE pesv_estandares_catalogo
  ADD COLUMN IF NOT EXISTS nivel_minimo pesv_nivel_empresa NOT NULL DEFAULT 'avanzado';

COMMENT ON COLUMN pesv_estandares_catalogo.nivel_minimo IS
  'Nivel de empresa mínimo en el que aplica el estándar. Default avanzado (los 24 estándares actuales son nivel avanzado). El seed catalog niveles (MOLANO Fase 2) ajustará básico/estándar tras concepto.';

-- Detalle del item: nivel rúbrica de 4 valores que reemplaza el slider continuo.
ALTER TABLE pesv_diagnostico_items
  ADD COLUMN IF NOT EXISTS nivel_rubrica pesv_nivel_rubrica NOT NULL DEFAULT 'no_implementado';

COMMENT ON COLUMN pesv_diagnostico_items.nivel_rubrica IS
  'Rúbrica de 4 niveles (Res. 40595/2022 anexo metodológico). Mapeo canónico: no_implementado=0%, en_desarrollo=50%, implementado=75%, sostenido=100%.';

-- ============================================================================
-- 3. Backfill defensivo (BD viva: 0 datos sucios, pero la regla es idempotente)
-- ============================================================================
-- Mapea cualquier score_pct legacy al nivel_rubrica derivado. Si el item ya
-- está con score_pct=0 (caso actual), termina en 'no_implementado'.
UPDATE pesv_diagnostico_items
SET nivel_rubrica = CASE
    WHEN score_pct >= 100 THEN 'sostenido'::pesv_nivel_rubrica
    WHEN score_pct >= 75  THEN 'implementado'::pesv_nivel_rubrica
    WHEN score_pct >= 50  THEN 'en_desarrollo'::pesv_nivel_rubrica
    ELSE 'no_implementado'::pesv_nivel_rubrica
  END
WHERE TRUE;

-- ============================================================================
-- 4. Índice parcial nuevo para auditoría PESV (BRUNO D6)
-- ============================================================================
-- Acelera la lectura de audit_logs en la vista auditoría sin afectar
-- escrituras en el caso general. SIN CONCURRENTLY (db-apply.ts es
-- transaccional). Bajo costo: BD viva tiene cero filas con resource pesv_*.
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_pesv
  ON audit_logs (resource, resource_id, created_at DESC)
  WHERE resource IN ('pesv_diag', 'pesv_diag_item', 'pesv_evidence');

COMMENT ON INDEX idx_audit_logs_resource_pesv IS
  'Índice parcial para consultas de auditoría del módulo PESV (historial por item, evidencia y diagnóstico). Bajo costo de escritura por la cláusula WHERE.';

COMMIT;
