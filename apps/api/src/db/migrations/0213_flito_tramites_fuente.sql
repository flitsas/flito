-- 0213 — Fuente del trámite (HU #13070, Feature #13058, Épica #12736).
--
-- Desde la Épica #12736 los trámites llegan de dos sistemas: FLIT (FLIT 1, el sync histórico) y
-- FLIT 2. `fuente` lo registra. Todas las filas existentes vienen del sync de FLIT, así que el
-- DEFAULT 'flit' las rellena al añadir la columna, y el sync de FLIT (que no escribe la columna)
-- sigue creando trámites con esa fuente.
--
-- CHECK y no enum de Postgres a propósito: añadir un valor a un enum no se puede hacer dentro de
-- una transacción en todas las versiones y quitarlo exige recrearlo; un CHECK se reemplaza sin más.
-- Los valores deben coincidir con FUENTES_TRAMITE de packages/shared-types.
--
-- Idempotente: aplicarla dos veces no cambia nada ni falla.

ALTER TABLE flito_tramites
  ADD COLUMN IF NOT EXISTS fuente varchar(10) NOT NULL DEFAULT 'flit';

DO $fuente_0213$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flito_tramites_fuente_chk'
      AND conrelid = 'flito_tramites'::regclass
  ) THEN
    ALTER TABLE flito_tramites
      ADD CONSTRAINT flito_tramites_fuente_chk CHECK (fuente IN ('flit', 'flit2'));
  END IF;
END $fuente_0213$;
