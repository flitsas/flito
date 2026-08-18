-- 0153_flito_comparendos_indices_filtro.sql
-- Feature #11495 (17b) — Monitoreo de comparendos. HU #11555 (filtrar el listado por municipio
-- fuente y causal).
-- Autor: equipo FLITO. Motivo: los filtros que esta HU añade a `GET /registros` y a
-- `POST /registros/buscar` se apoyan en dos columnas que ningún índice de la 0150 ni de la 0152
-- cubre, y el listado los combina SIEMPRE con el orden del cursor.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CONSULTA SE ESTÁ SOSTENIENDO
-- ============================================================================
--
-- `flito-comparendos.registros.service.ts` (RN-32, RN-36) pagina así, una vez por página:
--
--     SELECT <columnas> FROM flito_comparendos_registros
--      WHERE municipio_fuente = $1
--        AND (created_at, id) < ($2::timestamptz, $3::uuid)     -- keyset del cursor
--      ORDER BY created_at DESC, id DESC
--      LIMIT 51;
--
-- El filtro y el orden son inseparables: el WHERE acota y el ORDER BY decide qué 50 filas de esa
-- selección salen en la página. Un índice solo por `municipio_fuente` acotaría, pero después habría
-- que ORDENAR el resultado entero para quedarse con las 50 primeras — y eso, en la tabla que más
-- crece del módulo (una fila por comparendo visto), es leer y ordenar el municipio completo en cada
-- página del recorrido.
--
-- Por eso los índices son COMPUESTOS y llevan detrás las mismas columnas del cursor, en el mismo
-- orden y con la misma dirección que el `ORDER BY`: con la igualdad delante, el btree ya está
-- ordenado por `(created_at DESC, id DESC)` dentro de cada municipio, así que el planner entra por
-- el corte del cursor, lee 51 entradas y para. El `EXPLAIN` pasa de `Seq Scan` + `Sort` a
-- `Index Scan` sin nodo de ordenación.
--
-- Ese SALTO depende de algo que no está en este archivo y conviene dejarlo escrito: el cursor tiene
-- que ir como COMPARACIÓN DE TUPLAS, `(created_at, id) < ($2, $3)`. Escrito como
-- `created_at < $2 OR (created_at = $3 AND id < $4)` —que es como nació en la #11502— selecciona las
-- mismas filas pero PostgreSQL NO lo reconoce como rango del índice: sale como `Filter`, y entonces
-- el índice ahorra el `Sort` pero no el recorrido. Medido sobre 200.000 filas, en la página ~200 del
-- filtro por municipio: con `OR`, `Rows Removed by Filter: 10000` y 10.105 buffers (8,9 ms); con la
-- tupla, `Index Cond` y 55 buffers (0,15 ms), y la distancia crece con la profundidad de la página.
-- La #11555 cambió `despuesDelCursor` a la forma de tupla por esto; si algún día se revierte, estos
-- índices siguen sirviendo el orden y dejan de servir el salto, sin que nada falle a la vista.
--
-- El desempate por `id` está en el índice y no es adorno: es la segunda mitad del keyset (RN-32).
-- Sin él, dos altas de la misma corrida —que comparten `created_at` al milisegundo— obligarían a
-- ordenar el empate fuera del índice, que es justo donde el cursor repite o salta filas.
--
-- ============================================================================
-- POR QUÉ ESTOS TRES Y NO CUATRO
-- ============================================================================
--
-- `causal_id` sí lo lleva —el filtro por causal de la pantalla de gestión es igual de selectivo que
-- el de municipio, y de paso el índice cubre la comprobación de la clave foránea contra
-- `flito_comparendos_causales`, que hasta hoy no tenía ninguno—.
--
-- `sinCausal=true` necesita un índice PROPIO, y parcial. La intuición dice que el de `causal_id`
-- debería bastar —un btree indexa los nulos y `IS NULL` entra por él—, y es cierto a medias: entra,
-- pero NO entrega el orden. Para que las columnas de detrás sirvan el `ORDER BY`, la primera tiene
-- que quedar fijada por una IGUALDAD, y `IS NULL` no lo es; el plan conserva el `Sort` y con él la
-- obligación de leer TODAS las filas sin causal antes de quedarse con 50. Medido sobre 200.000
-- filas, con el 85% sin clasificar:
--
--     natural ................ Seq Scan + top-N heapsort ......  6.343 buffers ....  43 ms
--     enable_seqscan=off ..... Bitmap Heap Scan + Sort ........  7.664 buffers ....  70 ms
--     + bitmapscan=off ....... Index Only Scan + Sort .........  1.417 buffers .... 25,7 ms
--     índice parcial ......... Index Only Scan, sin Sort ......      7 buffers ... 0,14 ms
--
-- Ni forzando el plan a mano desaparece el `Sort`: no es que el planner se equivoque de coste, es
-- que ese orden no está en ese índice. El parcial lo arregla sacando `causal_id` del cuerpo del
-- índice al `WHERE`: dentro ya no hay más que filas sin causal, así que `(created_at DESC, id DESC)`
-- manda desde la primera columna y el `LIMIT 51` para de leer al llenarse.
--
-- Y no es «la mitad menos útil de las dos»: es el filtro más usado de la pantalla de gestión —lo que
-- falta por mirar— y además el más barato de mantener, porque solo indexa su parte de la tabla
-- (6,8 MB contra los 12 MB del índice completo de la causal). El día que la gestión avance y queden
-- pocos sin clasificar, este índice se hace más pequeño y más rápido, no menos útil.
--
-- `origen_merge` NO. Son tres valores (`simit`, `municipal`, `ambos`) repartidos sobre la tabla
-- entera: un índice por una columna de tres valores no lo usa el planner —le sale más barato el
-- recorrido secuencial que el salto aleatorio a la tabla— y lo único que haría es encarecer cada
-- INSERT y cada UPDATE del sync, que es el proceso que más escribe del módulo. El filtro por fuente
-- se sirve, cuando hace falta acotar, del índice del municipio o del de la causal.
--
-- Tampoco se añade aquí el índice del listado SIN filtros (`created_at DESC, id DESC` a secas), que
-- hoy es un recorrido secuencial: no lo introduce esta HU —viene con la paginación de la #11502— y
-- decidirlo con la tabla ya poblada, mirando un `EXPLAIN` real, será mejor decisión que hacerlo
-- ahora de paso.
--
-- ============================================================================
-- POR QUÉ **SIN** `CONCURRENTLY`
-- ============================================================================
--
-- Por lo mismo que en la 0152: `CREATE INDEX CONCURRENTLY` no puede correr dentro de una
-- transacción y el runner envuelve cada archivo en una (ADR-DB-001) — el intento moriría con un
-- `25001` y dejaría la cadena parada. El bloqueo de escrituras del `CREATE INDEX` normal es
-- irrelevante mientras la tabla sea pequeña, y ese momento es AHORA y no el día en que el filtro
-- vaya lento.

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_municipio_creado
    ON flito_comparendos_registros (municipio_fuente, created_at DESC, id DESC);

COMMENT ON INDEX idx_flito_comparendos_municipio_creado IS
  'Filtro por municipio del listado (HU #11555) servido en el orden del cursor (RN-32): la igualdad '
  'delante y (created_at DESC, id DESC) detrás entregan la página ya ordenada, sin nodo de Sort.';

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_causal_creado
    ON flito_comparendos_registros (causal_id, created_at DESC, id DESC);

COMMENT ON INDEX idx_flito_comparendos_causal_creado IS
  'Filtro por causal del listado (HU #11555) en el orden del cursor. Sirve además a la validación '
  'de la clave foránea contra flito_comparendos_causales, que no tenía índice por el lado hijo.';

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_sin_causal_creado
    ON flito_comparendos_registros (created_at DESC, id DESC)
 WHERE causal_id IS NULL;

COMMENT ON INDEX idx_flito_comparendos_sin_causal_creado IS
  'Cola de trabajo de la pantalla de gestión (sinCausal=true, HU #11555). Es PARCIAL y no una '
  'repetición del índice de la causal: IS NULL no fija la primera columna por igualdad, así que '
  'aquel entrega el filtro pero no el orden y el plan conserva el Sort sobre todas las filas sin '
  'clasificar. Con causal_id en el WHERE, (created_at DESC, id DESC) manda desde la primera '
  'columna: 43 ms y 6.343 buffers pasan a 0,14 ms y 7.';
