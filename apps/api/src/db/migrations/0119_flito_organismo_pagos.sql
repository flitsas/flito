-- 0119 — Pagos de FLIT a un Organismo de Tránsito (HU #11124, Feature #11120 §4.1).
--
-- La «bolsa simbólica» del organismo NO tiene saldo propio: es una vista agregada sobre
-- flito_bolsa_movimientos que responde «cuánto le hemos cobrado al cliente por cuenta de este
-- organismo». Lo único que le falta a esa vista para cerrar la conciliación es el otro lado: cuánto
-- le ha pagado FLIT al organismo. Eso es esta tabla, y es lo ÚNICO que se persiste del estado de
-- cuenta del OT.
--
-- Estos pagos NO tocan la bolsa del cliente. Son dinero que sale de FLIT hacia el organismo, no del
-- saldo prepago: mezclarlos descuadraría el saldo del cliente contra sus propios movimientos.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_organismo_pagos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organismo_codigo   varchar(5) NOT NULL REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  valor              numeric(14,2) NOT NULL,
  fecha              date NOT NULL,
  observacion        text,
  soporte_id         uuid REFERENCES flito_soportes(id) ON DELETE RESTRICT,
  registrado_por_id  integer REFERENCES users(id) ON DELETE SET NULL,
  registrado_por_nombre varchar(150) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_org_pago_valor_positivo CHECK (valor > 0)
);

-- El estado de cuenta siempre se lee por organismo y en orden cronológico.
CREATE INDEX IF NOT EXISTS idx_flito_organismo_pagos_organismo
  ON flito_organismo_pagos (organismo_codigo, fecha);
