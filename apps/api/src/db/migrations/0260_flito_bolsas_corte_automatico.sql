-- 0260_flito_bolsas_corte_automatico.sql
-- HU #13965 (Feature #13886) — corte del descuento por comprobante FIJADO AL DESPLEGAR. Reemplaza ADR-0029 D12
-- (variable de entorno `FLITO_BOLSAS_CORTE_COMPROBANTES`, eliminada).
--
-- El corte es el INSTANTE (timestamptz, `now()`) en que esta migración se aplica en cada ambiente:
--   · comprobante de pago con `aplicado_en >= corte_en` → descuenta la bolsa (compañía y tránsito);
--   · la liquidación deja de mover la bolsa cuando ahora >= corte_en;
--   · el backfill toma los comprobantes con `aplicado_en < corte_en`.
-- La comparación es por instante, no por día de Colombia.
--
-- Una sola fila (PK fija con CHECK). Idempotente: re-aplicarla NO sobrescribe el corte
-- (`CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING`). El corte no se edita después.
-- Sin la fila (o sin la tabla) el código se comporta como antes del corte (fallo cerrado).

CREATE TABLE IF NOT EXISTS flito_bolsas_corte (
  id            smallint    PRIMARY KEY DEFAULT 1 CONSTRAINT ck_flito_bolsas_corte_fila_unica CHECK (id = 1),
  corte_en      timestamptz NOT NULL,
  registrado_en timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flito_bolsas_corte IS
  'HU #13965: instante en que se aplicó la 0260; desde él el comprobante de pago descuenta la bolsa. Una fila, no se edita.';

INSERT INTO flito_bolsas_corte (id, corte_en) VALUES (1, now())
ON CONFLICT (id) DO NOTHING;
