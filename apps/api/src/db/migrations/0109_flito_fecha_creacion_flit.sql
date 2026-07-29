-- 0109 — Fecha real de creación del trámite en FLIT (HU #10959, Feature #10940).
--
-- Hasta ahora la única fecha disponible era `flito_tramites.created_at`, que es cuándo el sync
-- ingirió la fila: en la primera corrida masiva todos los históricos comparten esa fecha, así que
-- no sirve para ordenar cronológicamente ni para medir cuánto lleva algo detenido. FLIT sí entrega
-- la fecha real en el atributo `fechaCreacion` del reporte, pero hasta hoy solo quedaba enterrada
-- dentro del jsonb `flit_raw`.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.

ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS fecha_creacion_flit timestamptz;

-- Backfill desde el payload crudo ya almacenado. Tolerante a propósito: `flit_raw` es texto libre
-- de un tercero y una sola fecha malformada no puede abortar la migración entera, así que solo se
-- convierten los valores con forma ISO-8601 (la que usa el reporte) y el resto queda en NULL, que
-- el código ya sabe manejar cayendo a `created_at`.
--
-- El guarda es un regex y no `pg_input_is_valid` a propósito: esa función es de PostgreSQL 16 y el
-- proyecto declara soportar 15+.
UPDATE flito_tramites
   SET fecha_creacion_flit = (flit_raw ->> 'fechaCreacion')::timestamptz
 WHERE fecha_creacion_flit IS NULL
   AND flit_raw ->> 'fechaCreacion' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])([ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?)?';

-- Orden cronológico y filtros de antigüedad. `created_at` tampoco tenía índice pese a ser el
-- ORDER BY por defecto del listado desde siempre.
CREATE INDEX IF NOT EXISTS idx_flito_tramites_fecha_creacion_flit ON flito_tramites (fecha_creacion_flit);
CREATE INDEX IF NOT EXISTS idx_flito_tramites_created_at ON flito_tramites (created_at);

-- Saber cuándo un trámite entró a un estado exige filtrar el historial por campo, no solo por
-- trámite (lo usa el filtro «lleva N días en Borrador»).
CREATE INDEX IF NOT EXISTS idx_flito_tramite_historial_campo
  ON flito_tramite_historial (tramite_id, campo, created_at);
