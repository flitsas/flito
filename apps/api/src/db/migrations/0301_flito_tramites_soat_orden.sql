-- 0301_flito_tramites_soat_orden.sql — ADR-0041 §13.8 (Épica #13763).
-- C3 (costo de proveedor): el SOAT compartido cuenta en el primer trámite por (created_at, id) entre
-- todos los que tienen ese soat_id. La subconsulta corre por fila del reporte; sin índice sería un seq
-- scan de flito_tramites por fila. Parcial: los trámites sin SOAT no entran.
-- Sin CONCURRENTLY: el runner envuelve cada migración en una transacción. Idempotente.
CREATE INDEX IF NOT EXISTS idx_flito_tramites_soat_orden
  ON flito_tramites (soat_id, created_at, id) WHERE soat_id IS NOT NULL;
