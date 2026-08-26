-- 0117 — Cierre mensual de la bolsa (HU #11126, Feature #11120 §8).
--
-- Cerrar es congelar: los movimientos del periodo dejan de admitir altas y correcciones, y el saldo
-- final se convierte en el saldo inicial del mes siguiente. El disparo es MANUAL —Financiera decide
-- cuándo, normalmente unos días después del corte, tras conciliar— así que no hay cron ni fecha
-- automática. Un cierre por cliente y periodo: cada bolsa se concilia por su cuenta.
--
-- Los totales se COPIAN aquí en vez de recalcularse al leer, por el mismo motivo que
-- flito_liquidaciones sella sus valores: un reporte de cierre de hace un año debe seguir diciendo lo
-- que dijo, aunque después entren movimientos rezagados imputados a otro periodo.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_bolsa_cierres (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id           uuid NOT NULL REFERENCES flito_bolsas(id) ON DELETE RESTRICT,
  compania_id        integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  -- Periodo contable 'YYYY-MM' que se cierra.
  periodo            varchar(7) NOT NULL,
  -- Snapshot del periodo. `saldo_inicial` es el saldo final del cierre anterior (0 en el primero).
  saldo_inicial      numeric(14,2) NOT NULL,
  total_entradas     numeric(14,2) NOT NULL,
  total_salidas      numeric(14,2) NOT NULL,
  saldo_final        numeric(14,2) NOT NULL,
  movimientos        integer NOT NULL,
  observaciones      text,
  cerrado_por_id     integer REFERENCES users(id) ON DELETE SET NULL,
  -- Se copia el nombre además del id: el documento de auditoría debe seguir diciendo quién cerró
  -- aunque el usuario se borre. Mismo criterio que flito_bolsa_movimientos.registrado_por_nombre.
  cerrado_por_nombre varchar(150) NOT NULL,
  cerrado_en         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_cierre_periodo_formato CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT flito_cierre_totales_no_negativos CHECK (total_entradas >= 0 AND total_salidas >= 0),
  CONSTRAINT flito_cierre_movimientos_no_negativos CHECK (movimientos >= 0)
);

-- Un cliente no puede cerrar dos veces el mismo periodo. Es lo que sostiene el AC4 y, sobre todo, lo
-- que impide que dos cierres simultáneos produzcan dos reportes distintos del mismo mes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsa_cierre_periodo
  ON flito_bolsa_cierres (compania_id, periodo);

-- La comprobación «¿está cerrado este periodo?» corre en CADA movimiento: es la consulta más
-- caliente de la tabla.
CREATE INDEX IF NOT EXISTS idx_flito_bolsa_cierres_compania
  ON flito_bolsa_cierres (compania_id, periodo);
