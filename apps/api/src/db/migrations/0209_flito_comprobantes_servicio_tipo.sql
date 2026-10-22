-- 0209_flito_comprobantes_servicio_tipo.sql
-- Autor: David Chica (backend-agent)
-- Bug #12913 (Feature #12607, Épica #12245; ADR-0018, addendum «Bug #12913»).
-- El comprobante de pago de SERVICIOS ADICIONALES entra a la puente `flito_tramite_servicios_adicionales`
-- por TIPO de servicio. Para eso el comprobante recuerda qué tipo pagó (`servicio_tipo_id`), y el índice
-- único de la fila documental se parte en dos:
--   · trámite digital / logística: ≤ 1 pago aplicado por (trámite, concepto) — como hasta ahora.
--   · servicios adicionales: ≤ 1 pago aplicado por (trámite, tipo de servicio) — varios por trámite.
-- Los SA ya aplicados sin tipo (anteriores a este bug) quedan fuera del índice nuevo y como están.
--
-- Idempotente (se puede correr dos veces). Sin BEGIN/COMMIT: el runner envuelve (ADR-DB-001).

ALTER TABLE flito_comprobantes
  ADD COLUMN IF NOT EXISTS servicio_tipo_id uuid NULL
  REFERENCES flito_servicios_adicionales_tipos(id) ON DELETE RESTRICT;

DO $servicio_tipo_0209$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flito_comprobantes_servicio_tipo_chk'
      AND conrelid = 'flito_comprobantes'::regclass
  ) THEN
    ALTER TABLE flito_comprobantes
      ADD CONSTRAINT flito_comprobantes_servicio_tipo_chk
      CHECK (servicio_tipo_id IS NULL OR (concepto = 'servicios_adicionales' AND es_pago = true));
  END IF;
END $servicio_tipo_0209$;

DROP INDEX IF EXISTS idx_flito_comprobantes_valor_documental;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_td_lg
  ON flito_comprobantes (tramite_id, concepto)
  WHERE estado = 'aplicado' AND es_pago = true AND concepto IN ('tramite_digital', 'logistica');

CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_sa
  ON flito_comprobantes (tramite_id, servicio_tipo_id)
  WHERE estado = 'aplicado' AND es_pago = true AND concepto = 'servicios_adicionales'
    AND servicio_tipo_id IS NOT NULL;
