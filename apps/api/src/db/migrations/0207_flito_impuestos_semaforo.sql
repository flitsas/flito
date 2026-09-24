-- HU #12827 (Épica #12809, Feature #12822) — semáforo factura de venta vs RUNT del análisis post-envío.
--
-- `semaforo`: verde | naranja | rojo; NULL = sin calcular (análisis pendiente, histórico o fallo técnico).
-- `comparacion_factura_runt`: detalle campo a campo + `motivo` del rojo (ComparacionFacturaRunt en
-- shared-types). El motivo vive solo en el jsonb: el preset «Con alertas» filtra por color.
-- Sin índice: `semaforo` tiene 3 valores y la consulta del preset la diseña la HU 12830.
-- Sin backfill. Idempotente: se puede correr dos veces.

DO $$ BEGIN
  CREATE TYPE flito_impuesto_semaforo AS ENUM ('verde', 'naranja', 'rojo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS semaforo                 flito_impuesto_semaforo,
  ADD COLUMN IF NOT EXISTS comparacion_factura_runt jsonb;
