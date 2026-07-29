-- HU #10982 — la bandeja de pendientes deja de ser solo de derechos de tránsito.
--
-- Hasta ahora, un recibo de SOAT o de impuestos que no cruzaba con ningún registro se DESCARTABA:
-- el gestor tenía que volver a pedirlo. Los derechos, en cambio, ya archivaban el archivo y
-- reintentaban el cruce solos. Esta migración generaliza esa bandeja para los tres conceptos en vez
-- de crear dos tablas más con la misma maquinaria de reintento.
--
-- La tabla conserva su nombre (`flito_derechos_pendientes`): renombrarla obligaría a tocar el
-- índice, la FK y todo el módulo de derechos, y el nombre no es lo que hace daño.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001): el runner ya envuelve cada archivo en una transacción.

ALTER TABLE flito_derechos_pendientes
  ADD COLUMN IF NOT EXISTS concepto varchar(20) NOT NULL DEFAULT 'derecho';

-- Las filas que ya existían son todas de derechos, y el DEFAULT se las asigna: no hay backfill.
COMMENT ON COLUMN flito_derechos_pendientes.concepto IS
  'derecho | soat | impuesto — de qué carga viene el recibo que aún no cruza.';

-- Un recibo de impuestos del que no se pudo leer la placa también hay que guardarlo: es el caso en
-- el que más caro sale perder el archivo, porque nadie lo puede volver a buscar por placa. Se queda
-- en la bandeja para que una persona lo resuelva, así que la placa pasa a ser opcional.
ALTER TABLE flito_derechos_pendientes
  ALTER COLUMN placa DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flito_pendientes_concepto
  ON flito_derechos_pendientes (concepto, resuelto);
