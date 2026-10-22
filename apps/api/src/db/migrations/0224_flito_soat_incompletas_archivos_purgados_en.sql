-- 0224_flito_soat_incompletas_archivos_purgados_en.sql
-- Autor: backend-agent (HU #13409, Feature #13408, Épica #13201)
--
-- Retención y purga de los documentos de las solicitudes de SOAT por validar DESCARTADAS.
--
-- `archivos_purgados_en`: cuándo la corrida diaria de retención (`flito-soat-retencion.cron.ts`)
-- terminó de borrar del almacenamiento la factura de venta y los documentos adicionales de una
-- solicitud descartada hace 30 días o más. NULL = no purgada todavía (o purga incompleta por un
-- fallo del almacenamiento: la corrida siguiente reintenta solo lo pendiente).
--
-- La fila de la incompleta NO se borra (se conserva el descarte: motivo, cuándo, quién), y
-- `factura_storage_key` sigue NOT NULL como dato histórico: el objeto que nombra ya no existe.
--
-- Índice parcial: la consulta del cron lee SOLO descartadas no purgadas, ordenadas/filtradas por
-- `resuelta_en`. Las purgadas salen del índice, así que su tamaño es el de lo pendiente.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Sin BEGIN/COMMIT (el runner
-- envuelve cada archivo en su transacción).

ALTER TABLE flito_soat_incompletas
  ADD COLUMN IF NOT EXISTS archivos_purgados_en timestamptz;

COMMENT ON COLUMN flito_soat_incompletas.archivos_purgados_en IS
  'HU #13409: cuándo la retención borró del almacenamiento la factura y los adicionales de la descartada (30 días tras resuelta_en). NULL = pendiente.';

CREATE INDEX IF NOT EXISTS idx_flito_soat_incompletas_retencion_pendiente
  ON flito_soat_incompletas (resuelta_en)
  WHERE estado = 'descartada' AND archivos_purgados_en IS NULL;
