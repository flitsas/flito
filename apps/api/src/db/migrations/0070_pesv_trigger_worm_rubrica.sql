-- PESV Auto-diagnóstico PHVA · Rediseño Sprint UX — PARTE 2/2 (Res. 40595/2022)
--
-- Esta migración (estrategia A — split de rollout, parte 2/2) activa la
-- defensa en profundidad del rediseño. NO aplicar hasta que el frontend
-- nuevo (rúbrica radio group con 4 niveles) esté desplegado en producción
-- y validado E2E por VERONICA. Aplicar este SQL antes de ese deploy rompe
-- la UI actual (slider continuo envía score=85 → trigger rechaza con
-- ERRCODE=23514).
--
-- Lo que activa:
--   1. Trigger BEFORE INSERT/UPDATE/DELETE sobre pesv_diagnostico_items
--      que (a) bloquea mutaciones si el diagnóstico padre está cerrado
--      (WORM transversal, ADR-PESV-004), (b) rechaza score_pct fuera de
--      {0, 50, 75, 100} (decisión P2 + BRUNO D3).
--
-- Defensa en profundidad — el trigger es la última línea sobre:
--   - zod en backend (capa API).
--   - radio group en frontend (capa UI).
--   - middleware requireRole en rutas (capa autorización).
--
-- Pre-flight obligatorio antes de aplicar:
--   - SELECT score_pct, COUNT(*) FROM pesv_diagnostico_items GROUP BY 1;
--     Todos los valores deben estar en {0, 50, 75, 100}. Si hay legacy
--     fuera del subset, el primer PATCH posterior falla. Plan de cura:
--     UPDATE pesv_diagnostico_items SET score_pct = CASE
--       WHEN score_pct >= 100 THEN 100
--       WHEN score_pct >= 75  THEN 75
--       WHEN score_pct >= 50  THEN 50
--       ELSE 0
--     END WHERE score_pct NOT IN (0, 50, 75, 100);
--   - Validar en staging con la transacción de rollback (BEGIN; \i; ROLLBACK;).
--
-- Idempotencia:
--   - CREATE OR REPLACE FUNCTION.
--   - DROP TRIGGER IF EXISTS antes de CREATE TRIGGER.

BEGIN;

-- ============================================================================
-- 1. Función guard WORM + rúbrica
-- ============================================================================
-- FOR SHARE evita deadlock con el SELECT FOR UPDATE de la ruta
-- diagnostico.routes.ts:111 (que ya bloquea pesv_diagnosticos durante el
-- cierre). El guard se dispara BEFORE INSERT/UPDATE/DELETE en items.
CREATE OR REPLACE FUNCTION pesv_diag_items_worm_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_estado pesv_diag_estado;
  v_diag_id integer;
BEGIN
  v_diag_id := COALESCE(NEW.diagnostico_id, OLD.diagnostico_id);

  SELECT estado INTO v_estado
    FROM pesv_diagnosticos
   WHERE id = v_diag_id
   FOR SHARE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'WORM: diagnostico % no existe', v_diag_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_estado = 'cerrado' THEN
    RAISE EXCEPTION 'WORM: diagnostico % cerrado, items inmutables', v_diag_id
      USING ERRCODE = 'P0001';
  END IF;

  IF (TG_OP IN ('INSERT', 'UPDATE')) AND NEW.score_pct NOT IN (0, 50, 75, 100) THEN
    RAISE EXCEPTION 'rubrica: score_pct=% no permitido (valores válidos: 0, 50, 75, 100)', NEW.score_pct
      USING ERRCODE = '23514';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION pesv_diag_items_worm_guard() IS
  'Guard WORM + rúbrica para pesv_diagnostico_items. Rechaza mutaciones si el diagnóstico padre está cerrado y rechaza scores fuera de {0,50,75,100}. Activado en mig 0070 tras deploy del frontend nuevo (estrategia A).';

-- ============================================================================
-- 2. Trigger anti-bypass WORM + validación rúbrica
-- ============================================================================
DROP TRIGGER IF EXISTS trg_pesv_diag_items_worm ON pesv_diagnostico_items;
CREATE TRIGGER trg_pesv_diag_items_worm
  BEFORE INSERT OR UPDATE OR DELETE ON pesv_diagnostico_items
  FOR EACH ROW EXECUTE FUNCTION pesv_diag_items_worm_guard();

COMMIT;
