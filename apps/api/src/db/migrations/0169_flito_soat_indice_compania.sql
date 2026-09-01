-- 0169_flito_soat_indice_compania.sql
-- Feature #11912 — canal Cliente. HU #11914 (alta con RUNT y bloqueo RN-01).
-- Autor: equipo FLITO. Diseño y tradeoffs: docs/adr/ADR-0008-flito-soat-canal-cliente.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada no crea nada ni cambia una fila.
--
-- ============================================================================
-- POR QUÉ ESTA MIGRACIÓN NO TIENE TABLAS NI COLUMNAS
-- ============================================================================
--
-- Todo el modelo del canal Cliente lo dejó puesto la 0167 —`flito_soat.origen`, los dos estados
-- nuevos del enum, `flito_soat_solicitud`, `flito_soat_causales_rechazo`, el segundo padre de
-- `flito_compradores` y el índice parcial de la factura de venta— y la 0168 su CHECK. La HU #11914
-- ESCRIBE en todo eso y no necesita ni una columna más: marca, línea, modelo, clase, servicio y
-- cilindraje del RUNT caben en `vehicles` (`brand`, `model`, `year`, `vehicle_class`,
-- `tipo_servicio`, `cilindraje`, de la 0166) y el organismo en `flito_soat.organismo_codigo`.
--
-- Lo único que falta es un índice, y lo pidió la auditoría de esquema de la cadena.
--
-- ============================================================================
-- EL ÍNDICE, Y POR QUÉ NO ES UN «POR SI ACASO»
-- ============================================================================
--
-- Desde la HU #11913, `flito_soat.compania_id` dejó de ser un dato denormalizado más y pasó a ser el
-- PREDICADO DE AISLAMIENTO del rol `cliente`: `condicionesCola()` añade `compania_id = $1` a las
-- condiciones que comparten la página, el conteo y las facetas, y `buscarConAcceso()` compara esa
-- misma columna para sostener el 404-no-403 del detalle, el historial y los soportes. Es decir: la
-- columna entra en el WHERE de CADA petición que hace un usuario de una compañía cliente, y en tres
-- consultas por cada carga de la pantalla.
--
-- Sin índice, esas tres consultas son un recorrido secuencial de `flito_soat` que descarta lo ajeno
-- DESPUÉS de haberlo leído. Hoy la tabla es pequeña y no se nota; el canal Cliente es justo lo que
-- la hace crecer, y el momento de ponerlo es antes de que entre la primera compañía.
--
-- Y era la única `compania_id` del esquema sin índice: `flito_derechos`, `flito_logistica_actas`,
-- `flito_bolsa_movimientos` y las demás ya tenían el suyo, así que esto además cierra una asimetría
-- que nadie sabría explicar.
--
-- No es `CONCURRENTLY`, y es deliberado: `CREATE INDEX CONCURRENTLY` no puede correr dentro de una
-- transacción y el runner envuelve cada archivo en una (ADR-DB-001). Con el tamaño de esta tabla el
-- bloqueo de escritura dura milisegundos; el día que no sea así, el índice concurrente va en un
-- runbook y no en la cadena de migraciones.
CREATE INDEX IF NOT EXISTS idx_flito_soat_compania ON flito_soat (compania_id);

COMMENT ON INDEX idx_flito_soat_compania IS
  'Aislamiento por compania del rol cliente (Feature #11912, HU #11914). No es un indice de reporte: '
  'compania_id es el predicado que condicionesCola() y buscarConAcceso() aplican en CADA peticion de '
  'un usuario cliente —pagina, conteo, facetas, detalle, historial y soportes—, asi que sin el cada '
  'pantalla del canal recorre flito_soat entera para descartar lo ajeno despues de leerlo.';

-- ── Permisos ────────────────────────────────────────────────────────────────
--
-- Nada que conceder: un índice no tiene privilegios propios y esta migración no crea ninguna tabla
-- ni ninguna secuencia. Las tablas que la HU #11914 escribe (`flito_soat`, `flito_compradores`,
-- `flito_soportes`, `flito_soat_solicitud`) ya tienen sus GRANT desde la 0167 y las anteriores.
-- Se dice explícitamente para que nadie añada un bloque DO vacío «por simetría» con la 0167.
