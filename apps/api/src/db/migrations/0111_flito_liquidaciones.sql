-- 0111 — Liquidación sellada del trámite (HU #10965, Feature #10939 §2.3).
--
-- Sellar significa congelar: si mañana cambia la tarifa negociada con la compañía o la tasa del
-- GMF, un trámite ya liquidado debe seguir mostrando exactamente lo que se cobró. Por eso los
-- valores se COPIAN a esta tabla en vez de recalcularse al leer.
--
-- Los valores son nullable a propósito. NULL = «no aplica» (p. ej. logística de una compañía que
-- la autogestiona), y NO cero. Es la misma distinción que la compuerta ya mantiene deliberadamente
-- para poder calcular la base del 4x1000 (ver flito-compuerta.service.ts).
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_liquidaciones (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: un trámite tiene una liquidación vigente o ninguna. El historial vive en los eventos.
  tramite_id             uuid NOT NULL UNIQUE REFERENCES flito_tramites(id) ON DELETE CASCADE,
  estado                 varchar(20) NOT NULL,          -- 'liquidado' | 'facturado'
  valor_soat             numeric(14,2),
  valor_impuesto         numeric(14,2),
  valor_derecho          numeric(14,2),
  valor_tramite_digital  numeric(14,2),
  valor_logistica        numeric(14,2),
  -- Base y tasa se guardan junto al resultado: una liquidación de hace un año debe poder explicar
  -- su propio GMF sin depender de la constante que rija hoy.
  base_gmf               numeric(14,2) NOT NULL,
  tasa_gmf               numeric(6,5)  NOT NULL DEFAULT 0.004,
  valor_gmf              numeric(14,2) NOT NULL,
  total                  numeric(14,2) NOT NULL,
  -- Origen de cada valor y tarifa aplicada, para poder auditar el cálculo años después.
  detalle                jsonb,
  liquidado_por_id       integer REFERENCES users(id),
  liquidado_en           timestamptz NOT NULL DEFAULT now(),
  facturado_por_id       integer REFERENCES users(id),
  facturado_en           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_liq_estado_valido CHECK (estado IN ('liquidado', 'facturado')),
  -- Facturado sin fecha sería un estado a medias que nadie podría auditar.
  CONSTRAINT flito_liq_facturado_con_fecha CHECK (estado <> 'facturado' OR facturado_en IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_flito_liquidaciones_estado ON flito_liquidaciones (estado);

-- Bitácora append-only. El reverso BORRA la fila de arriba (el UNIQUE lo exige) y deja aquí el
-- snapshot completo, así que nada se pierde y volver a liquidar queda limpio.
CREATE TABLE IF NOT EXISTS flito_liquidacion_eventos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id  uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  accion      varchar(20) NOT NULL,        -- 'liquidar' | 'reversar' | 'facturar'
  motivo      text,
  usuario_id  integer REFERENCES users(id),
  snapshot    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_liq_evento_accion_valida CHECK (accion IN ('liquidar', 'reversar', 'facturar'))
);

CREATE INDEX IF NOT EXISTS idx_flito_liquidacion_eventos_tramite
  ON flito_liquidacion_eventos (tramite_id, created_at);
