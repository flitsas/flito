-- 0279_flito_tarifas_logistica_cliente_flit.sql
-- HU #14106 (Feature B #14090, Epica #13758): la tarifa de logistica se parte en dos conceptos,
--   `logistica_cliente` («entrega a cliente») y `logistica_flit` («entrega a FLIT»). Contrato:
--   ADR-0030 §6. Autor: equipo FLITO.
--
-- Que hace:
--   1. Amplia los CHECK de concepto y de tipo de `flito_tarifas_vigencias` (DROP IF EXISTS + ADD).
--      `logistica` SE CONSERVA en el CHECK de forma transitoria: durante un rollout un pod con el
--      binario viejo aun puede escribir `logistica`; sin eso recibiria 23514. Una migracion
--      posterior lo retira cuando ningun pod viejo pueda correr.
--   2. Mueve las filas `logistica` a `logistica_cliente` (abiertas y cerradas: el historial de
--      vigencias se conserva entero; el UPDATE no toca valores, rangos ni ids). `logistica_flit`
--      arranca sin filas.
--
-- Reglas:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo.
--   - Idempotente: la 2a pasada no encuentra filas `logistica` (0 filas movidas). Si un pod viejo
--     escribio una `logistica` DESPUES de la 1a pasada y su rango solapa con una `logistica_cliente`
--     de la misma compania, esa fila se OMITE (no duplica ni viola la EXCLUDE) y se avisa.

ALTER TABLE flito_tarifas_vigencias DROP CONSTRAINT IF EXISTS flito_tarifas_vigencias_concepto_chk;
ALTER TABLE flito_tarifas_vigencias DROP CONSTRAINT IF EXISTS flito_tarifas_vigencias_tipo_chk;

ALTER TABLE flito_tarifas_vigencias ADD CONSTRAINT flito_tarifas_vigencias_concepto_chk
  CHECK (concepto IN ('tramite_digital', 'logistica', 'logistica_cliente', 'logistica_flit'));

ALTER TABLE flito_tarifas_vigencias ADD CONSTRAINT flito_tarifas_vigencias_tipo_chk CHECK (
  (concepto = 'tramite_digital' AND tipo_tramite IS NOT NULL AND tipo_tramite IN ('MATRICULA', 'TRASPASO', 'OTROS'))
  OR (concepto IN ('logistica', 'logistica_cliente', 'logistica_flit') AND tipo_tramite IS NULL));

DO $logisticacliente0279$
DECLARE
  n int;
  omitidas int;
BEGIN
  UPDATE flito_tarifas_vigencias l
     SET concepto = 'logistica_cliente'
   WHERE l.concepto = 'logistica'
     AND NOT EXISTS (
       SELECT 1 FROM flito_tarifas_vigencias c
        WHERE c.compania_id = l.compania_id
          AND c.concepto = 'logistica_cliente'
          AND tstzrange(c.vigente_desde, c.vigente_hasta, '[)') && tstzrange(l.vigente_desde, l.vigente_hasta, '[)')
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO omitidas FROM flito_tarifas_vigencias WHERE concepto = 'logistica';
  RAISE NOTICE '0279: % vigencia(s) logistica -> logistica_cliente; % omitida(s) por solape', n, omitidas;
END $logisticacliente0279$;

COMMENT ON COLUMN flito_tarifas_vigencias.concepto IS
  'tramite_digital | logistica_cliente | logistica_flit (logistica = legado transitorio, alias de logistica_cliente).';
