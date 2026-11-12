-- 0300_flito_tarifas_proveedor.sql — ADR-0041 (Épica #13763). Costo que el proveedor le cobra a FLIT.
-- Solo DDL nuevo; no toca flito_tarifas_vigencias ni ningún lector. Sin backfill (R8): los proveedores
-- nacen sin valor. Idempotente: se puede correr dos veces sin error ni cambio. Sin BEGIN/COMMIT (lo pone el runner).

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- ya creada por la 0182; aquí es no-op

CREATE TABLE IF NOT EXISTS flito_tarifas_proveedor_vigencias (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id    uuid NOT NULL REFERENCES flito_proveedores(id) ON DELETE RESTRICT,
  servicio        varchar(20) NOT NULL,
  concepto        varchar(30) NOT NULL,
  valor           numeric(14,2) NOT NULL,
  vigente_desde   timestamptz NOT NULL DEFAULT now(),
  vigente_hasta   timestamptz,
  fijado_por_id   integer REFERENCES users(id) ON DELETE RESTRICT,
  fijado_en       timestamptz NOT NULL DEFAULT now(),
  cerrado_por_id  integer REFERENCES users(id) ON DELETE RESTRICT,
  cerrado_en      timestamptz
);

-- Constraints con nombre en bloques DO: una tabla creada a medias por otra vía también queda completa.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_concepto_chk') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_concepto_chk CHECK (
      (servicio = 'logistica' AND concepto = 'logistica')
      OR (servicio = 'soat' AND concepto IN ('soat_con_tramite', 'soat_sin_tramite')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_valor_chk') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_valor_chk CHECK (valor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_rango_chk') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_rango_chk
      CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_cierre_chk') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_cierre_chk
      CHECK ((vigente_hasta IS NULL) = (cerrado_en IS NULL));
  END IF;
  -- Cerrar exige quién: una cerrada sin actor no tiene «quién cerró» en el historial (R4).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_cerrado_por_chk') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_cerrado_por_chk
      CHECK (cerrado_en IS NULL OR cerrado_por_id IS NOT NULL);
  END IF;
  -- Sin solapes por (proveedor, concepto): btree_gist da el operador = para uuid y varchar.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_tarifas_prov_sin_solape') THEN
    ALTER TABLE flito_tarifas_proveedor_vigencias ADD CONSTRAINT flito_tarifas_prov_sin_solape EXCLUDE USING gist (
      proveedor_id WITH =, concepto WITH =, tstzrange(vigente_desde, vigente_hasta, '[)') WITH &&);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_tarifas_prov_abierta
  ON flito_tarifas_proveedor_vigencias (proveedor_id, concepto) WHERE vigente_hasta IS NULL;
CREATE INDEX IF NOT EXISTS idx_flito_tarifas_prov_proveedor_concepto
  ON flito_tarifas_proveedor_vigencias (proveedor_id, concepto, vigente_desde);

COMMENT ON TABLE flito_tarifas_proveedor_vigencias IS
  'Costo que el proveedor cobra a FLIT por concepto (ADR-0041). No es la tarifa al cliente. Nunca se borra.';
