-- Comprobación previa de proveedores repetidos (HU #14328, Feature #14323, ADR-0039 §5.3). SOLO LECTURA.
--
-- Cuándo: antes del merge de la 0289 en DEV y antes de cada promoción, en QA y PDN. La API de PDN usa
-- `strategy: Recreate`: si la migración se detiene, PDN queda caída hasta corregir el dato o revertir el digest.
--
-- Cómo: psql -f apps/api/src/db/manual/flito-proveedores-preflight.sql, o como script en DBeaver o pgAdmin. El
-- reporte sale en los mensajes (NOTICE). No usa metacomandos de psql. Corre igual antes y después de la 0289.
--
-- Lista lo mismo que las paradas de la 0289: el bloque marcado es idéntico en ambos archivos y el test
-- flito-proveedores-migracion.test.ts lo exige. La transacción queda en solo lectura, así que Postgres rechaza
-- cualquier escritura. No crea ningún objeto. Nunca escribe un NIT: solo nombres e identificadores.
--
-- Qué hacer con cada caso:
--   · NOMBRE REPETIDO, empresas distintas: renombrar uno desde la pantalla actual. Quedan dos proveedores separados.
--   · NIT REPETIDO: corregir el NIT. Renombrar no basta.
--   · IDENTIFICADOR REPETIDO, o la misma empresa repetida: no hay unión automática (R22). Se decide con el caso.

DO $preflight$
DECLARE
  casos text[] := ARRAY[]::text[];
  fila record;
  otra_estrategia bigint;
BEGIN
  PERFORM set_config('transaction_read_only', 'on', true);

  -- >>> PARADAS (idéntico en 0289 y en manual/flito-proveedores-preflight.sql; el test exige la igualdad)
  -- Nombre: SOAT vigentes y Logística, con la normalización del índice único del padre. `to_jsonb` lee
  -- `deleted_at` de Logística solo si la columna existe: antes de la 0289 no existe y ninguna fila está de baja.
  FOR fila IN
    WITH vigentes AS (
      SELECT 'SOAT'::text AS origen, s.id, s.nombre FROM flito_proveedores_soat s WHERE s.deleted_at IS NULL
      UNION ALL
      SELECT 'Logística', l.id, l.nombre FROM flito_proveedores_logistica l WHERE to_jsonb(l) ->> 'deleted_at' IS NULL
    )
    SELECT string_agg(format('"%s" (%s %s)', v.nombre, v.origen, v.id), ', ' ORDER BY v.origen, v.id) AS detalle
    FROM vigentes v
    GROUP BY lower(btrim(regexp_replace(v.nombre, '\s+', ' ', 'g')))
    HAVING count(DISTINCT v.id) > 1
    ORDER BY 1
  LOOP
    casos := casos || format('NOMBRE REPETIDO: %s. Renombre uno desde la pantalla de proveedores.', fila.detalle);
  END LOOP;

  -- NIT sin dígito de verificación, con la expresión del índice único del padre. Nunca se escribe el valor: el
  -- de una persona natural equivale a su cédula y este texto termina en el log del initContainer.
  FOR fila IN
    SELECT string_agg(format('"%s" (%s)', l.nombre, l.id), ', ' ORDER BY l.id) AS detalle
    FROM flito_proveedores_logistica l
    WHERE to_jsonb(l) ->> 'deleted_at' IS NULL AND NULLIF(btrim(l.nit), '') IS NOT NULL
    GROUP BY split_part(btrim(l.nit), '-', 1)
    HAVING count(DISTINCT l.id) > 1
    ORDER BY 1
  LOOP
    casos := casos || format('NIT REPETIDO: %s. Corrija el NIT desde la pantalla de proveedores; renombrar no basta.', fila.detalle);
  END LOOP;

  -- Identificador en ambas tablas sin registro padre. Con padre es un proveedor legítimo con los dos servicios.
  IF to_regclass('flito_proveedores') IS NULL THEN
    FOR fila IN
      SELECT s.id FROM flito_proveedores_soat s JOIN flito_proveedores_logistica l ON l.id = s.id ORDER BY s.id
    LOOP
      casos := casos || format('IDENTIFICADOR REPETIDO: %s está en SOAT y en Logística sin registro padre. No se unen automáticamente.', fila.id);
    END LOOP;
  ELSE
    FOR fila IN
      SELECT s.id FROM flito_proveedores_soat s JOIN flito_proveedores_logistica l ON l.id = s.id
      WHERE NOT EXISTS (SELECT 1 FROM flito_proveedores p WHERE p.id = s.id) ORDER BY s.id
    LOOP
      casos := casos || format('IDENTIFICADOR REPETIDO: %s está en SOAT y en Logística sin registro padre. No se unen automáticamente.', fila.id);
    END LOOP;
  END IF;
  -- <<< PARADAS

  IF cardinality(casos) = 0 THEN
    RAISE NOTICE 'Preflight 0289: sin casos. La migración no se detendrá con los datos actuales.';
  ELSE
    RAISE NOTICE '%', format(E'Preflight 0289: %s caso(s) que detienen la migración:\n- %s',
      cardinality(casos), array_to_string(casos, E'\n- '));
  END IF;

  -- Informativo, no detiene: la estrategia se conserva hasta F5 y el código de viajes no la lee (ADR-0039 §16).
  SELECT count(*) INTO otra_estrategia FROM flito_proveedores_logistica l WHERE l.estrategia <> 'pwa_propia';
  RAISE NOTICE 'Informativo: % proveedor(es) de Logística con estrategia distinta de pwa_propia.', otra_estrategia;
END
$preflight$;
