-- 0162_flito_concil_resultado_cobrado_otro_cliente.sql
-- Bug #11773 (Feature #11623) — un SOAT ya descontado de la bolsa de OTRO cliente no se concilia
-- aquí ni se adopta. Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CAMBIA Y QUÉ NO
-- ============================================================================
--
-- El cruce de una boleta de A puede encontrar un SOAT de A cuya llave `salida:soat:<id>` YA está
-- ocupada en el libro de B (liquidación o conciliación ajena: el índice único es GLOBAL). Antes
-- eso salía `ok` y `adoptar()` reescribía el `origen` del asiento de B: dinero de A «cuadrado»
-- contra un movimiento que nunca salió de su bolsa.
--
-- Esta migración solo ENSANCHA el CHECK `flito_concil_linea_resultado_chk` con el octavo desenlace
-- `cobrado_otro_cliente` (20 caracteres; la columna es varchar(24)). El unique global
-- `idx_flito_bolsa_mov_llave` NO se toca: `asentarMovimiento` sigue resolviendo por llave sola
-- (duplicado, sin INSERT) para que liquidar no explote. La 0157 queda congelada.
--
-- El CHECK viejo rechazaría el valor nuevo con un 23514 al persistir el cruce. Por eso va aquí y
-- no «en código»: el vocabulario de `ResultadoCruce` y el de la base tienen que decir lo mismo.

ALTER TABLE flito_conciliacion_lineas
  DROP CONSTRAINT IF EXISTS flito_concil_linea_resultado_chk;
ALTER TABLE flito_conciliacion_lineas
  ADD CONSTRAINT flito_concil_linea_resultado_chk CHECK (resultado IN
    ('ok','no_encontrada','no_pagado','valor_distinto','poliza_duplicada','otra_compania','ya_conciliada','cobrado_otro_cliente'));
