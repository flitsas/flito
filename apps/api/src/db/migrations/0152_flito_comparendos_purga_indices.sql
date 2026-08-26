-- 0152_flito_comparendos_purga_indices.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11511 (poda de PII, retención y acceso).
-- Autor: equipo FLITO. Motivo: cerrar el hallazgo del gate de base de datos sobre la 0151 — la purga
-- por retención que esa HU introduce consulta por dos columnas que NINGÚN índice cubre.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CONSULTA SE ESTÁ ARREGLANDO
-- ============================================================================
--
-- `flito-comparendos-purga.cron.ts` elige a sus candidatos así, una vez por lote y hasta 20 veces
-- por tabla y pasada:
--
--     SELECT id FROM flito_comparendos_registros
--      WHERE ultimo_visto_en < $1 ORDER BY ultimo_visto_en LIMIT 500;
--
--     SELECT id FROM flito_comparendos_sync_runs
--      WHERE iniciado_en < $1 ORDER BY iniciado_en LIMIT 500;
--
-- Y desde la HU #11511 hay además, una vez por pasada, un `count(*)` con ese mismo `WHERE` (el
-- `dryRun` de verdad y el freno por porcentaje).
--
-- El `EXPLAIN` sobre la base actual da recorrido secuencial + ordenación en las dos: los índices que
-- la 0150 creó sobre `registros` son por `nit_monitoreado`, `placa` y `estado`, y `sync_runs` no
-- tiene ninguno más allá de su PK. Ninguna de esas columnas aparece en el filtro de la purga.
--
-- El coste no es el de una consulta: es el de veinte por tabla y pasada sobre las dos tablas que más
-- crecen del módulo —una fila por comparendo visto y una por disparo de sync—, y justo cuando la
-- purga tiene trabajo de verdad, que es cuando la tabla es grande. Con el índice, el `ORDER BY
-- ultimo_visto_en LIMIT 500` se sirve recorriendo el btree por su extremo y para; sin él, cada lote
-- vuelve a leer y a ordenar la tabla entera para quedarse con 500 filas.
--
-- ============================================================================
-- POR QUÉ **SIN** `CONCURRENTLY`
-- ============================================================================
--
-- `CREATE INDEX CONCURRENTLY` no puede correr dentro de una transacción y el runner de migraciones
-- envuelve cada archivo en una (ADR-DB-001): el intento moriría con `25001 CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block` y dejaría la cadena parada. La contrapartida —el `CREATE
-- INDEX` normal toma un `SHARE` lock que bloquea escrituras mientras construye— es irrelevante hoy:
-- las dos tablas se estrenaron con la 0150 y están vacías o casi. Este índice hay que crearlo AHORA,
-- que es gratis, y no el día en que la purga sea lenta y la tabla tenga millones de filas.

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_ultimo_visto
    ON flito_comparendos_registros (ultimo_visto_en);

COMMENT ON INDEX idx_flito_comparendos_ultimo_visto IS
  'Purga por retención (HU #11511): el WHERE/ORDER BY de la selección de candidatos y el count(*) '
  'del dryRun y del freno. `ultimo_visto_en` es el reloj de la retención (RN-26), no `created_at`.';

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_sync_runs_iniciado
    ON flito_comparendos_sync_runs (iniciado_en);

COMMENT ON INDEX idx_flito_comparendos_sync_runs_iniciado IS
  'Purga por retención (HU #11511): candidatos por antigüedad de la corrida. Sirve además al '
  'heartbeat de la purga (la última corrida ok) y al listado de corridas más recientes de 17b.';
