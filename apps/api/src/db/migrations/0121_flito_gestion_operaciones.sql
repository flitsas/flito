-- 0121 — Contingencia: Operaciones asume la gestión del SOAT o del impuesto
--        (HU #11152 y #11155, Feature #11150).
--
-- Hasta ahora el SOAT lo adquiría un proveedor y el impuesto lo pagaba el gestor del organismo. Si
-- no hay proveedor que atienda el caso, o el gestor no puede, la operación se detenía: el envío de
-- un SOAT exige proveedor, y el destinatario del impuesto se deduce de organismo_codigo. Estas
-- columnas registran que la gestión la asume Operaciones.
--
-- OJO CON EL NOMBRE. `gestion_operaciones` NO es `excepcion_autogestion` ni
-- `clients.soat_autogestionable` / `impuestos_autogestionable`: esos dicen que la COMPAÑÍA se lo
-- gestiona sola, y entonces el registro ni siquiera debería estar en la cola. Este dice quién,
-- dentro de FLITO, trabaja el registro. Los dos conceptos conviven en estas mismas tablas.
--
-- Por qué la bandera y no `proveedor_soat_id IS NULL`: al asumir un SOAT que ya tenía proveedor, el
-- proveedor se CONSERVA — es lo que permite devolvérselo después y lo que deja el reporte por
-- proveedor contando de quién se retomó. Quien decide la visibilidad es la bandera.
--
-- En impuestos la bandera es imprescindible y no una comodidad: no hay columna de proveedor que
-- poner a null, así que es lo único capaz de sacar el registro de la cola de su gestor. Sin ella,
-- Operaciones y el gestor del organismo pueden pagar el mismo recibo — dinero real, dos veces.
--
-- Numeración: 0120 quedó reservada para la HU #11161 (bolsa del organismo), que se desarrolla en
-- paralelo. `db-apply.ts` decide qué está pendiente SOLO por nombre de archivo y nunca compara el
-- sha256 que guarda, así que dos migraciones homónimas harían que la segunda se saltara en silencio.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS gestion_operaciones        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gestion_operaciones_motivo text,
  ADD COLUMN IF NOT EXISTS gestion_operaciones_por_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS gestion_operaciones_en     timestamptz;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS gestion_operaciones        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gestion_operaciones_motivo text,
  ADD COLUMN IF NOT EXISTS gestion_operaciones_por_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS gestion_operaciones_en     timestamptz;

-- Índices parciales: lo gestionado por Operaciones es la excepción, no la norma. Un índice sobre
-- toda la columna sería casi todo `false` y no lo usaría el planner; el parcial solo indexa las
-- filas que buscan las consultas de contingencia. La frontera del gestor pregunta por
-- NOT gestion_operaciones, que se resuelve con los índices de estado ya existentes.
CREATE INDEX IF NOT EXISTS idx_flito_soat_gestion_operaciones
  ON flito_soat (estado) WHERE gestion_operaciones;

CREATE INDEX IF NOT EXISTS idx_flito_impuestos_gestion_operaciones
  ON flito_impuestos (estado) WHERE gestion_operaciones;

COMMENT ON COLUMN flito_soat.gestion_operaciones IS
  'Contingencia (HU #11152): Operaciones asume la gestion en vez del proveedor. No es autogestion de la compania.';
COMMENT ON COLUMN flito_impuestos.gestion_operaciones IS
  'Contingencia (HU #11155): Operaciones asume la gestion en vez del gestor del organismo. No es autogestion de la compania.';
