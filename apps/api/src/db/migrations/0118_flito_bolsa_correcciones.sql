-- 0118 — Corrección de un movimiento manual (HU #11123, Feature #11120 §5).
--
-- El libro es append-only: corregir un movimiento NO es un UPDATE de su valor, es un movimiento
-- nuevo que lo referencia. Así el histórico sigue mostrando qué se registró primero, quién lo
-- corrigió y por qué — que es justo lo que un UPDATE borraría.
--
-- La columna es autorreferente y nullable: solo la llevan los ajustes de corrección.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

ALTER TABLE flito_bolsa_movimientos
  ADD COLUMN IF NOT EXISTS corrige_movimiento_id uuid
    REFERENCES flito_bolsa_movimientos(id) ON DELETE RESTRICT;

-- Para poder responder «¿qué correcciones tiene este movimiento?» sin barrer el libro entero.
-- Parcial: la inmensa mayoría de los movimientos no corrigen nada.
CREATE INDEX IF NOT EXISTS idx_flito_bolsa_mov_corrige
  ON flito_bolsa_movimientos (corrige_movimiento_id)
  WHERE corrige_movimiento_id IS NOT NULL;

-- Un movimiento no puede corregirse a sí mismo: sería un ciclo que ninguna lectura sabría deshacer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsa_mov_correccion_no_circular'
  ) THEN
    ALTER TABLE flito_bolsa_movimientos
      ADD CONSTRAINT flito_bolsa_mov_correccion_no_circular
      CHECK (corrige_movimiento_id IS NULL OR corrige_movimiento_id <> id);
  END IF;
END $$;
