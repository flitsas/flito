-- 0183_tarifas_vigencias_desde_siempre.sql
-- Feature #12365 — Tarifas como vigencias con historial. HU #12374 (eslabon 2 de 2): el reporte de
--   costos y la compuerta de liquidacion pasan a resolver la tarifa por la vigencia que CONTIENE la
--   fecha de aprobacion del tramite (RN-07). Las vigencias que la 0182 desdoblo del modelo viejo
--   arrancan en `created_at` de la tarifa vieja; el modelo viejo era ATEMPORAL (una tarifa activa
--   valia para todo tramite sin liquidar, tuviera la fecha que tuviera), asi que ese inicio es un
--   invento de la migracion y con la resolucion por fecha dejaria «sin configurar» todo tramite
--   aprobado antes de que alguien pulsara Guardar (medido en la base local el 2026-09-10: 3.133
--   tramites sin liquidar de la compania 3, aprobados antes del 2026-08-12, sin ruta para abrir una
--   vigencia retroactiva). RN-10 del Feature: las vigencias MIGRADAS rigen «desde siempre».
-- Autor: equipo FLITO. Antecedentes: 0182 (desdoble; vigente_desde = created_at), ADR-DB-001 (sin
--   control de transaccion propio).
--
-- Que hace: lleva `vigente_desde` a 2000-01-01T00:00:00Z («desde siempre» finito: `aTarifa` e
--   `historial` hacen `toISOString()`, y `-infinity` no es un Date valido en la API) en la vigencia
--   MAS ANTIGUA de cada llave (compania, concepto, tipo) que fue creada antes del corte.
--
-- El corte: el instante en que la 0182 se aplico EN ESTA BASE (`applied_at` de su fila en
--   _kyverum_applied_migrations; el runner la inserta dentro de la misma transaccion del archivo con
--   `now()`, que es el inicio de esa transaccion). Toda tarifa vieja tiene `created_at` anterior a
--   ese instante (el desdoble corre en esa misma transaccion y la tabla vieja cae ahi), y toda
--   vigencia abierta por la API nueva (`fijarTarifa`/`cambiarOCerrar` usan `now()`) nace despues del
--   commit, con el binario nuevo. Asi la condicion separa migradas de nuevas sin marcar filas, y
--   vale en QA y PDN aunque la 0182 se aplique dias despues y el codigo viejo haya seguido creando
--   tarifas hasta ese deploy (un literal fijo las saltaria en silencio: sin ruta de reparacion).
--   Respaldo 2026-09-10T18:00:00Z (merge de la 0182, ab11984) SOLO si la 0182 no esta registrada:
--   tests en transaccion que la corren sin registrarla, o una base marcada con `--mark-all`.
--
-- Por que solo la MAS ANTIGUA por llave: la EXCLUDE de la 0182 prohibe solapes dentro de una llave.
--   Mover hacia atras el inicio de la vigencia mas antigua no puede crear un solape (no hay nada
--   antes); mover cualquier otra si podria. La 0182 crea a lo sumo UNA vigencia por llave, asi que
--   en la practica es la unica candidata, pero el NOT EXISTS lo garantiza aunque el dato no venga
--   como se espera. Si una llave tuviera una migrada CERRADA y, encima, una abierta por la API
--   nueva, se mueve la cerrada (la mas antigua) y la abierta queda como esta: sin solape.
-- Rangos vacios `[t, t)` (tarifa creada inactiva y nunca activada) NO se tocan: en el modelo viejo
--   nunca resolvieron nada, y abrirlos hacia el pasado les daria un cobro que no existio.
-- `fijado_en` no se toca: es cuando se fijo, no desde cuando rige.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Un solo bloque DO con dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: la 2a pasada no toca una fila (`vigente_desde <> 2000-01-01`).

DO $desdesiempre0183$
DECLARE
  n int;
BEGIN
  UPDATE flito_tarifas_vigencias v
     SET vigente_desde = '2000-01-01T00:00:00Z'
   WHERE v.vigente_desde < COALESCE(
           (SELECT m.applied_at FROM _kyverum_applied_migrations m
             WHERE m.filename = '0182_tarifas_vigencias.sql'),
           '2026-09-10T18:00:00Z')
     AND v.vigente_desde <> '2000-01-01T00:00:00Z'
     AND (v.vigente_hasta IS NULL OR v.vigente_hasta > v.vigente_desde)
     -- Misma exclusion de rangos vacios que arriba: una [t, t) mas antigua no cuenta como «algo antes».
     AND NOT EXISTS (
       SELECT 1 FROM flito_tarifas_vigencias o
        WHERE o.compania_id = v.compania_id
          AND o.concepto = v.concepto
          AND COALESCE(o.tipo_tramite, '') = COALESCE(v.tipo_tramite, '')
          AND (o.vigente_hasta IS NULL OR o.vigente_hasta > o.vigente_desde)
          AND o.vigente_desde < v.vigente_desde);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0183: % vigencia(s) migrada(s) pasan a regir desde siempre (2000-01-01)', n;
END $desdesiempre0183$;
