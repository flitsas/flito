-- 0251_flito_comprobantes_sa_valor_previo.sql
-- HU #13903 (Feature #13886) — AC11: desaplicar / reemplazar un PAGO de servicios adicionales devuelve la
-- puente `flito_tramite_servicios_adicionales` al estado que tenía antes de aplicar el comprobante.
-- `fijarDesdeComprobante` hace un upsert por (tramite_id, tipo_id) que pierde ese estado, así que `aplicar`
-- lo guarda en la propia fila del comprobante, dentro de su tx:
--   · sa_asignacion_previa: ¿existía la fila de la puente? false → al desaplicar se BORRA; true → vuelve a
--     sa_valor_previo. NULL = pago aplicado antes de esta migración (o no es un pago de SA): desaplicarlo
--     responde 409 `servicio_no_reversible` sin tocar nada (decisión de David, 2026-10-24).
--   · sa_valor_previo: el valor que tenía la fila (solo si existía).
-- Escrita a mano e idempotente (ADD COLUMN IF NOT EXISTS; el CHECK solo si no existe). NO drizzle-kit.
-- Sin backfill: lo ya aplicado queda en NULL a propósito (no hay dato del que derivarlo).
-- Autor: backend-agent (HU #13903). Espejo: src/db/schema/flito-comprobantes.ts. Sin BEGIN/COMMIT (ADR-DB-001).

ALTER TABLE flito_comprobantes ADD COLUMN IF NOT EXISTS sa_asignacion_previa boolean;
ALTER TABLE flito_comprobantes ADD COLUMN IF NOT EXISTS sa_valor_previo numeric(14,2);

DO $m0251$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_comprobantes_sa_previo_chk') THEN
    -- Solo en un pago de servicios adicionales con su tipo, y el valor previo va si y solo si la fila existía.
    ALTER TABLE flito_comprobantes ADD CONSTRAINT flito_comprobantes_sa_previo_chk CHECK (
      (sa_asignacion_previa IS NULL OR (servicio_tipo_id IS NOT NULL AND es_pago = true AND concepto = 'servicios_adicionales'))
      AND (sa_valor_previo IS NOT NULL) = COALESCE(sa_asignacion_previa, false)
    );
  END IF;
END $m0251$;
