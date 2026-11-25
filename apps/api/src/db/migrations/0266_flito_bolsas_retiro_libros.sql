-- 0266_flito_bolsas_retiro_libros.sql
-- HU #13911 (Feature #13887, ADR-0029) — retira los SEIS libros viejos de bolsas de `public` y los ARCHIVA
-- en el esquema `archivo_bolsas` (no DROP: decisión de David Chica 2026-10-26, para conservar el rollback).
-- Diseño: docs/arquitectura/feature-13886-13887-bolsa-unica.md (fila de la migración de retiro).
-- Runbook (pg_dump previo, rollback desde el archivo, DROP SCHEMA diferido):
--   docs/arquitectura/runbook-hu-13911-retiro-libros-bolsas.md
--
-- Libros: flito_bolsas, flito_bolsa_movimientos, flito_bolsa_cierres (cliente, copiados por la 0250) y
--         flito_bolsas_transito, flito_bolsa_transito_cobertura, flito_bolsa_transito_movimientos (tránsito, 0257).
--
-- Qué hace, TODO dentro de UN solo bloque DO (una sentencia = atómica también fuera del runner):
--   0. Idempotencia (AC5): si ninguno de los seis sigue en `public`, termina sin verificar ni tocar nada.
--      Si solo ALGUNOS siguen en `public`, falla: es un estado a medias que no produjo esta migración.
--   1. LOCK EXCLUSIVE de los seis: nadie escribe en ellos mientras se verifica y se mueven.
--   2. (AC4) Ninguna restricción FUERA de los seis libros puede referenciarlos. `SET SCHEMA` no rompe una
--      FK (sigue al OID), así que se busca explícitamente en `pg_constraint` y se falla ANTES de mover.
--   3. (AC1) El modelo único tiene, fielmente, lo que la 0250 y la 0257 copiaron. Tras esas migraciones el
--      modelo único sigue recibiendo movimientos NUEVOS que el libro viejo no tiene, así que NO se compara
--      el saldo actual del nuevo: se comparan los movimientos COPIADOS (mismo UUID). Por cada bolsa migrada
--      —cliente con movimientos o cierres (regla D5: las autocreadas vacías no se migraron) y TODAS las de
--      tránsito—:
--        · existe en `flito_bolsas_unicas` con el mismo id y alcance (y, la de cliente, la misma compañía);
--        · cada movimiento viejo existe en el libro único con mismo id, bolsa, tipo y valor;
--        · número de movimientos y suma con signo de los copiados = los del libro viejo;
--        · el saldo del libro viejo = la suma de su propio libro (el pre-flight de la 0250/0257, Q5).
--      Y cada cierre viejo de cliente existe con mismo id, bolsa, periodo y saldo final.
--      Si algo no cuadra → RAISE con SOLO ids e importes (sin NIT ni nombres) y no se mueve nada.
--   4. (AC3) Los seis salen a `archivo_bolsas` con `ALTER TABLE … SET SCHEMA`: datos, índices, secuencias y
--      FKs internas intactos. El modelo único no se toca.
--
-- Sin control de transacción propio (ADR-DB-001). Autor: backend-agent (HU #13911), revisión humana en el PR.

DO $m0266$
DECLARE
  libros constant text[] := ARRAY[
    'flito_bolsas', 'flito_bolsa_movimientos', 'flito_bolsa_cierres',
    'flito_bolsas_transito', 'flito_bolsa_transito_cobertura', 'flito_bolsa_transito_movimientos'];
  en_public integer;
  n integer;
  detalle text;
  t text;
BEGIN
  -- 0) Idempotencia.
  SELECT count(*) INTO en_public FROM unnest(libros) AS l(nombre)
  WHERE to_regclass(format('public.%I', l.nombre)) IS NOT NULL;
  IF en_public = 0 THEN
    RAISE NOTICE 'flito_bolsas retiro (0266): los libros viejos ya no están en public; nada que hacer';
    RETURN;
  END IF;
  IF en_public < array_length(libros, 1) THEN
    SELECT string_agg(l.nombre, ', ') INTO detalle FROM unnest(libros) AS l(nombre)
    WHERE to_regclass(format('public.%I', l.nombre)) IS NULL;
    RAISE EXCEPTION 'flito_bolsas retiro (0266): estado a medias, faltan en public: %. Revisa el runbook antes de reintentar', detalle;
  END IF;

  -- 1) Nadie escribe en los libros viejos mientras se verifica y se mueven.
  LOCK TABLE public.flito_bolsas, public.flito_bolsa_movimientos, public.flito_bolsa_cierres,
             public.flito_bolsas_transito, public.flito_bolsa_transito_cobertura,
             public.flito_bolsa_transito_movimientos
    IN EXCLUSIVE MODE;

  -- 2) AC4: restricciones de FUERA de los seis libros que aún los referencian.
  SELECT count(*), string_agg(format('%s → %s (%s)', con.conrelid::regclass, con.confrelid::regclass, con.conname), '; ')
    INTO n, detalle
  FROM pg_constraint con
  WHERE con.confrelid IN (SELECT format('public.%I', l.nombre)::regclass FROM unnest(libros) AS l(nombre))
    AND con.conrelid NOT IN (SELECT format('public.%I', l.nombre)::regclass FROM unnest(libros) AS l(nombre));
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas retiro (0266): % restricciones aún referencian un libro viejo: %. Re-apúntalas al modelo único antes de retirar', n, detalle;
  END IF;

  -- 3) AC1: el modelo único tiene, fielmente, lo copiado. Solo ids e importes en el mensaje.
  WITH viejas AS (
    SELECT b.id, 'compania'::text AS alcance, b.compania_id, b.saldo
    FROM public.flito_bolsas b
    WHERE EXISTS (SELECT 1 FROM public.flito_bolsa_movimientos m WHERE m.bolsa_id = b.id)
       OR EXISTS (SELECT 1 FROM public.flito_bolsa_cierres c WHERE c.bolsa_id = b.id)
    UNION ALL
    SELECT b.id, 'transito', NULL::integer, b.saldo
    FROM public.flito_bolsas_transito b
  ), movs_viejos AS (
    SELECT m.id, m.bolsa_id, m.tipo, m.valor FROM public.flito_bolsa_movimientos m
    UNION ALL
    SELECT m.id, m.bolsa_id, m.tipo, m.valor FROM public.flito_bolsa_transito_movimientos m
  ), por_bolsa AS (
    SELECT v.id, v.alcance, v.saldo,
      EXISTS (SELECT 1 FROM flito_bolsas_unicas u
              WHERE u.id = v.id AND u.alcance = v.alcance AND u.compania_id IS NOT DISTINCT FROM v.compania_id) AS migrada,
      (SELECT count(*) FROM movs_viejos m WHERE m.bolsa_id = v.id) AS n_viejo,
      (SELECT count(*) FROM movs_viejos m
         JOIN flito_bolsas_unicas_movimientos x
           ON x.id = m.id AND x.bolsa_id = m.bolsa_id AND x.tipo = m.tipo AND x.valor = m.valor
        WHERE m.bolsa_id = v.id) AS n_copia,
      (SELECT COALESCE(sum(CASE WHEN m.tipo = 'entrada' THEN m.valor ELSE -m.valor END), 0)
         FROM movs_viejos m WHERE m.bolsa_id = v.id) AS suma_vieja,
      (SELECT COALESCE(sum(CASE WHEN x.tipo = 'entrada' THEN x.valor ELSE -x.valor END), 0)
         FROM movs_viejos m JOIN flito_bolsas_unicas_movimientos x ON x.id = m.id AND x.bolsa_id = m.bolsa_id
        WHERE m.bolsa_id = v.id) AS suma_copia
    FROM viejas v
  ), descuadres AS (
    SELECT * FROM por_bolsa
    WHERE NOT migrada OR n_viejo <> n_copia OR suma_vieja <> suma_copia OR saldo <> suma_vieja
    ORDER BY alcance, id
  )
  SELECT count(*),
         string_agg(format('%s [%s] migrada=%s saldo_viejo=%s movimientos viejo/copia=%s/%s suma viejo/copia=%s/%s',
                           id, alcance, migrada, saldo, n_viejo, n_copia, suma_vieja, suma_copia), '; ')
    INTO n, detalle
  FROM descuadres;
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas retiro (0266): % bolsas no cuadran con el modelo único; no se retira nada: %', n, detalle;
  END IF;

  SELECT count(*), string_agg(format('%s [bolsa %s, %s, saldo_final %s]', c.id, c.bolsa_id, c.periodo, c.saldo_final), '; ')
    INTO n, detalle
  FROM public.flito_bolsa_cierres c
  WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_cierres x
                    WHERE x.id = c.id AND x.bolsa_id = c.bolsa_id AND x.periodo = c.periodo
                      AND x.saldo_final = c.saldo_final);
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas retiro (0266): % cierres de cliente sin copia fiel en el modelo único; no se retira nada: %', n, detalle;
  END IF;

  -- 4) AC3: al archivo. Datos, índices y FKs internas viajan con la tabla.
  CREATE SCHEMA IF NOT EXISTS archivo_bolsas;
  FOREACH t IN ARRAY libros LOOP
    EXECUTE format('ALTER TABLE IF EXISTS public.%I SET SCHEMA archivo_bolsas', t);
  END LOOP;
  COMMENT ON SCHEMA archivo_bolsas IS
    'HU #13911 (0266): libros viejos de bolsas, solo lectura para rollback. DROP SCHEMA archivo_bolsas CASCADE cuando PDN esté estable (runbook-hu-13911).';
END $m0266$;
