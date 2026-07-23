-- FLITO — Fase 7 (endurecimiento): activación por organismo de la diferencia de valor
-- de impuestos (CA-09 / D-5). Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §7 y D-5.
--
-- La diferencia de valor está APAGADA por defecto: el valorLiquidado de FLIT no siempre es
-- fiable y el total pagado incluye el servicio de FLITO. Se activa por organismo (donde la
-- fuente sí es fiable, p.ej. consulta Caldas); al conciliar, si |pagado - liquidado| supera
-- la tolerancia de la compañía, se MARCA para revisión sin bloquear el pago.
-- Sin control de transacción propio (ADR-DB-001: el runner envuelve el archivo en sql.begin()).

ALTER TABLE organismos_transito_config
  ADD COLUMN IF NOT EXISTS flito_diferencia_valor_activa BOOLEAN NOT NULL DEFAULT false;
