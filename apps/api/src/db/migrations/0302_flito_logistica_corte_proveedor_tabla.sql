-- 0302_flito_logistica_corte_proveedor_tabla.sql
-- Autor: David Chica
-- Épica #13763 (tarifas de proveedor). Crea la tabla del corte de proveedor si falta, sin registrar ningún corte.
--
-- Por qué existe: `finanzas.costos-proveedor.ts` (reporte de costos y `liquidar()`) lee `flito_logistica_corte_proveedor`,
-- que solo crea la 0298 (Épica de proveedores #13757, F4). La #13763 se promueve a staging SIN la 0298, y allí esa
-- consulta fallaría con 42P01. Esta migración deja la tabla creada para que el código de la #13763 funcione solo.
--
--   · Ambiente con la 0298 ya aplicada (DEV, local): la tabla existe y esto no hace nada.
--   · Staging sin la 0298: la tabla queda VACÍA. El código lo tolera: sin fila de corte, el `COALESCE(..., '-infinity')`
--     toma todo como posterior al corte.
--   · Cuando la 0298 llegue a ese ambiente: su `CREATE TABLE IF NOT EXISTS` no hace nada y su
--     `INSERT … ON CONFLICT DO NOTHING` siembra la fila del corte ese día (y corre su reparto de licencias), como si esta
--     migración no hubiera existido. Por eso aquí NO hay INSERT ni UPDATE: sembrar el corte adelantaría la fecha y la 0298
--     se saltaría el reparto.
--
-- DDL idéntico al de la 0298 (la 0298 no añade COMMENT ni índices aparte: la PK es el único índice). Sin control de
-- transacción propio (ADR-DB-001): lo pone el runner. Idempotente: se puede aplicar dos veces.
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS flito_logistica_corte_proveedor (
  unica boolean PRIMARY KEY DEFAULT true CONSTRAINT ck_flito_log_corte_proveedor_unica CHECK (unica),
  corte_en timestamptz NOT NULL DEFAULT now()
);
