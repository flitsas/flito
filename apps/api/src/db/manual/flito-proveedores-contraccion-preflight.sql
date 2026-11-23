-- Comprobación previa de la contracción de proveedores (HU #14355, Feature #14327, ADR-0039 §5.2). SOLO LECTURA.
--
-- Cuándo: antes del merge de la 0314 en DEV y antes de cada promoción, en QA y PDN. La 0314 es IRREVERSIBLE: elimina
-- las columnas duplicadas de los perfiles de proveedor. La API de PDN usa `strategy: Recreate`: si la migración se
-- detiene, PDN queda caída hasta corregir el dato o revertir el digest.
--
-- Cómo: psql -f apps/api/src/db/manual/flito-proveedores-contraccion-preflight.sql, o como script en DBeaver o
-- pgAdmin. El reporte sale en los mensajes (NOTICE). No usa metacomandos de psql. Corre igual antes y después de la
-- 0314; después no encuentra nada que comparar. Córralo en autocommit o cierre la transacción al terminar (COMMIT o
-- ROLLBACK): una transacción abierta retiene sus locks y haría esperar a la migración.
--
-- Lista lo mismo que la guarda de la 0314: el bloque marcado es idéntico en ambos archivos y el test
-- flito-proveedores-contraccion.centinela.test.ts lo exige. La transacción queda en solo lectura, así que Postgres
-- rechaza cualquier escritura. No crea ningún objeto. Nunca escribe un valor: solo identificadores y nombres de campo.
--
-- Qué hacer con cada caso:
--   · PERFIL DISTINTO en nombre, activo, nit, contacto o telefono: el padre manda desde la 0314. Si el valor bueno es
--     el del perfil, corríjalo en el proveedor desde la pantalla de proveedores; si es el del padre, no hay nada que
--     perder, pero la diferencia indica una escritura fuera de la API y se decide con el caso.
--   · PERFIL DISTINTO por «padre de baja»: el proveedor fue eliminado y el perfil sigue vigente. Retire el perfil o
--     restaure el proveedor, según el caso.
--   · USUARIO DISTINTO: asigne al usuario su proveedor desde la pantalla de usuarios.

DO $preflight$
DECLARE
  casos text[] := ARRAY[]::text[];
  fila record;
  sin_pwa bigint;
BEGIN
  PERFORM set_config('transaction_read_only', 'on', true);

  -- >>> DIFERENCIAS (idéntico en 0314 y en manual/flito-proveedores-contraccion-preflight.sql; el test exige la igualdad)
  -- `to_jsonb` lee cada columna vieja solo si existe: tras la 0314 no queda ninguna y no hay nada que comparar.
  -- La guarda protege lo que se va a eliminar, así que el padre de baja también se mira solo mientras exista.
  FOR fila IN
    SELECT 'SOAT'::text AS origen, s.id,
           array_to_string(array_remove(ARRAY[
             CASE WHEN p.deleted_at IS NOT NULL THEN 'padre de baja' END,
             CASE WHEN (x.j ->> 'nombre') IS DISTINCT FROM p.nombre THEN 'nombre' END,
             CASE WHEN (x.j ->> 'activo') IS DISTINCT FROM p.activo::text THEN 'activo' END
           ], NULL), ', ') AS campos
    FROM flito_proveedores_soat s
    JOIN flito_proveedores p ON p.id = s.id
    CROSS JOIN LATERAL (SELECT to_jsonb(s) AS j) x
    WHERE s.deleted_at IS NULL AND x.j ? 'nombre'
    UNION ALL
    SELECT 'Logística', l.id,
           array_to_string(array_remove(ARRAY[
             CASE WHEN p.deleted_at IS NOT NULL THEN 'padre de baja' END,
             CASE WHEN (x.j ->> 'nombre') IS DISTINCT FROM p.nombre THEN 'nombre' END,
             CASE WHEN (x.j ->> 'activo') IS DISTINCT FROM p.activo::text THEN 'activo' END,
             CASE WHEN NULLIF(btrim(x.j ->> 'nit'), '') IS DISTINCT FROM NULLIF(btrim(p.nit), '') THEN 'nit' END,
             CASE WHEN (x.j ->> 'contacto') IS DISTINCT FROM p.contacto THEN 'contacto' END,
             CASE WHEN (x.j ->> 'telefono') IS DISTINCT FROM p.telefono THEN 'telefono' END
           ], NULL), ', ')
    FROM flito_proveedores_logistica l
    JOIN flito_proveedores p ON p.id = l.id
    CROSS JOIN LATERAL (SELECT to_jsonb(l) AS j) x
    WHERE l.deleted_at IS NULL AND x.j ? 'nombre'
    ORDER BY 1, 2
  LOOP
    IF fila.campos <> '' THEN
      casos := casos || format('PERFIL DISTINTO: %s %s difiere de su proveedor padre en: %s.', fila.origen, fila.id, fila.campos);
    END IF;
  END LOOP;

  -- Usuario cuya pertenencia vieja no coincide con la nueva: al retirar la vieja cambiaría de proveedor sin aviso.
  FOR fila IN
    SELECT u.id
    FROM users u
    CROSS JOIN LATERAL (SELECT to_jsonb(u) ->> 'flito_proveedor_soat_id' AS vieja) x
    WHERE x.vieja IS NOT NULL AND x.vieja::uuid IS DISTINCT FROM u.flito_proveedor_id
    ORDER BY u.id
  LOOP
    casos := casos || format('USUARIO DISTINTO: el usuario %s tiene flito_proveedor_soat_id distinto de flito_proveedor_id.', fila.id);
  END LOOP;
  -- <<< DIFERENCIAS

  IF cardinality(casos) = 0 THEN
    RAISE NOTICE 'Preflight 0314: sin casos. La migración no se detendrá con los datos actuales.';
  ELSE
    RAISE NOTICE '%', format(E'Preflight 0314: %s caso(s) que detienen la migración:\n- %s',
      cardinality(casos), array_to_string(casos, E'\n- '));
  END IF;

  SELECT count(*) INTO sin_pwa
  FROM flito_proveedores_logistica l
  WHERE to_jsonb(l) ? 'estrategia' AND (to_jsonb(l) ->> 'estrategia') IS DISTINCT FROM 'pwa_propia';
  RAISE NOTICE 'Informativo: % perfil(es) de Logística con estrategia distinta de pwa_propia; la 0314 elimina ese dato.', sin_pwa;
END
$preflight$;
