-- 0064: LAFT v2 F3 — Transacciones en efectivo + parámetros configurables + reportes UIAF.
--
-- Dec. 1497/2002 + Res. UIAF 122/2021 obligan a transportadores a reportar:
--   • RTE (Reporte Transacciones en Efectivo) — operaciones > umbral.
--   • AROS (Reporte de Ausencia de ROS) — trimestral si no hubo ROS ni operaciones inusuales.
--   • ROS — ya cubierto por laft_ros_drafts.
--
-- Decisiones del PO (4-may-2026):
--   • Umbral RTE individual: $10.000.000 COP (antes $20M era criterio interno; bajamos a 10M
--     para alinear con UIAF guía 2024 transportadores).
--   • Umbral RTE acumulado mensual por contraparte: $50.000.000 COP.
--   • Conservación 10 años (Ley 1121/2006 art. 2).
--
-- Patrón: replica el de F1/F2 (0062/0063): WORM-light con REVOKE DELETE; tabla
-- de idempotencia dedicada (igual que jornadas / rndc) en lugar de Map en memoria.

-- =============================================================================
-- 1) Parámetros LAFT configurables (no más hardcodes — el Empleado de Cumplimiento
--    puede ajustarlos vía UI sin redeploy).
-- =============================================================================
CREATE TABLE IF NOT EXISTS laft_parametros (
  clave VARCHAR(60) PRIMARY KEY,
  valor TEXT NOT NULL,
  descripcion TEXT,
  actualizado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO laft_parametros (clave, valor, descripcion) VALUES
  ('rte_umbral_individual_cop', '10000000',
   'Umbral COP en transacción individual en efectivo (Dec 1497/2002)'),
  ('rte_umbral_acumulado_mensual_cop', '50000000',
   'Umbral COP acumulado mensual por contraparte para reporte RTE'),
  ('aros_trimestral_dia_corte', '10',
   'Día del mes 10-Ene/10-Abr/10-Jul/10-Oct para verificar y generar AROS'),
  ('ros_sla_horas', '24',
   'Horas máximas desde clasificación a envío SIREL (Res. UIAF 122/2021)')
ON CONFLICT (clave) DO NOTHING;

-- =============================================================================
-- 2) Transacciones en efectivo
-- =============================================================================
CREATE TABLE IF NOT EXISTS laft_cash_txns (
  id BIGSERIAL PRIMARY KEY,
  counterparty_id INTEGER NOT NULL REFERENCES laft_counterparties(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('efectivo','cheque','transferencia','otro')),
  fecha DATE NOT NULL,
  descripcion TEXT,
  numero_recibo VARCHAR(60),
  threshold_individual_breached BOOLEAN NOT NULL DEFAULT FALSE,
  threshold_acumulado_breached BOOLEAN NOT NULL DEFAULT FALSE,
  unusual_operation_id INTEGER REFERENCES laft_unusual_operations(id) ON DELETE SET NULL,
  ros_draft_id INTEGER REFERENCES laft_ros_drafts(id) ON DELETE SET NULL,
  registrado_por INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  registrado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cash_amount_pos CHECK (amount > 0),
  CONSTRAINT chk_cash_currency_3 CHECK (length(currency) = 3)
);

CREATE INDEX IF NOT EXISTS idx_laft_cash_cp_fecha
  ON laft_cash_txns(counterparty_id, fecha DESC);
-- Índice parcial: solo filas con breach. Acelera RTE mensual (donde scaneamos breaches).
CREATE INDEX IF NOT EXISTS idx_laft_cash_breach
  ON laft_cash_txns(fecha)
  WHERE threshold_individual_breached OR threshold_acumulado_breached;
CREATE INDEX IF NOT EXISTS idx_laft_cash_kind ON laft_cash_txns(kind);
CREATE INDEX IF NOT EXISTS idx_laft_cash_unusual ON laft_cash_txns(unusual_operation_id)
  WHERE unusual_operation_id IS NOT NULL;

-- WORM-light: la BD permite UPDATE solo desde la app (necesita actualizar vínculos
-- a unusual_operation_id / ros_draft_id post-creación). DELETE bloqueado siempre.
REVOKE DELETE ON laft_cash_txns FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE DELETE ON laft_cash_txns FROM operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON laft_cash_txns TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_cash_txns_id_seq TO operaciones_app;
  END IF;
END $$;

-- =============================================================================
-- 3) Reportes UIAF generados (RTE / AROS / ROS) — bitácora WORM-strict
-- =============================================================================
CREATE TABLE IF NOT EXISTS laft_reportes_uiaf (
  id BIGSERIAL PRIMARY KEY,
  tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('RTE','AROS','ROS')),
  periodo_anio INT,
  periodo_mes INT CHECK (periodo_mes IS NULL OR (periodo_mes BETWEEN 1 AND 12)),
  periodo_trimestre INT CHECK (periodo_trimestre IS NULL OR (periodo_trimestre BETWEEN 1 AND 4)),
  generado_por INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  generado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_operaciones INT NOT NULL DEFAULT 0,
  total_monto_cop NUMERIC(18,2),
  formato VARCHAR(10) NOT NULL CHECK (formato IN ('PDF','CSV','XML')),
  storage_key TEXT,
  sha256 VARCHAR(64) NOT NULL,
  enviado_a_uiaf_at TIMESTAMPTZ,
  acuse_uiaf TEXT
);

-- Idempotencia de generación: un único reporte por tipo/periodo/formato.
-- Trimestre y mes pueden ser NULL según el tipo, así que usamos COALESCE-índice
-- en lugar de UNIQUE constraint (los NULLs en UNIQUE no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS uq_laft_reportes_periodo
  ON laft_reportes_uiaf (
    tipo,
    formato,
    COALESCE(periodo_anio, 0),
    COALESCE(periodo_mes, 0),
    COALESCE(periodo_trimestre, 0)
  );

CREATE INDEX IF NOT EXISTS idx_laft_reportes_periodo
  ON laft_reportes_uiaf(periodo_anio DESC, tipo);

REVOKE UPDATE, DELETE ON laft_reportes_uiaf FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE UPDATE, DELETE ON laft_reportes_uiaf FROM operaciones_app;
    -- Excepción: app puede UPDATE solo enviado_a_uiaf_at + acuse_uiaf via column-grant.
    GRANT SELECT, INSERT ON laft_reportes_uiaf TO operaciones_app;
    GRANT UPDATE (enviado_a_uiaf_at, acuse_uiaf) ON laft_reportes_uiaf TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_reportes_uiaf_id_seq TO operaciones_app;
  END IF;
END $$;

-- WORM-strict trigger: solo se permite UPDATE de las columnas acuse/enviado_at.
-- Cualquier otra modificación (cambiar sha, renombrar storage_key) = bloqueada.
CREATE OR REPLACE FUNCTION laft_reportes_uiaf_worm_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'laft_reportes_uiaf es append-only — DELETE bloqueado';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tipo <> NEW.tipo
       OR OLD.formato <> NEW.formato
       OR OLD.sha256 <> NEW.sha256
       OR COALESCE(OLD.storage_key,'') <> COALESCE(NEW.storage_key,'')
       OR OLD.total_operaciones <> NEW.total_operaciones
       OR COALESCE(OLD.periodo_anio, -1) <> COALESCE(NEW.periodo_anio, -1)
       OR COALESCE(OLD.periodo_mes, -1) <> COALESCE(NEW.periodo_mes, -1)
       OR COALESCE(OLD.periodo_trimestre, -1) <> COALESCE(NEW.periodo_trimestre, -1)
    THEN
      RAISE EXCEPTION 'laft_reportes_uiaf WORM: solo se permite actualizar enviado_a_uiaf_at y acuse_uiaf (id=%)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_laft_reportes_uiaf_worm ON laft_reportes_uiaf;
CREATE TRIGGER trg_laft_reportes_uiaf_worm
  BEFORE UPDATE OR DELETE ON laft_reportes_uiaf
  FOR EACH ROW EXECUTE FUNCTION laft_reportes_uiaf_worm_guard();

-- =============================================================================
-- 4) Idempotencia persistente para POSTs LAFT cash. Mismo patrón que
--    jornadas_idempotency_keys / rndc_idempotency_keys.
-- =============================================================================
CREATE TABLE IF NOT EXISTS laft_cash_idempotency_keys (
  key VARCHAR(80) NOT NULL,
  scope VARCHAR(20) NOT NULL,                       -- 'cash_txn' | 'rte_generate' | 'aros_generate'
  cash_txn_id BIGINT REFERENCES laft_cash_txns(id) ON DELETE SET NULL,
  reporte_id BIGINT REFERENCES laft_reportes_uiaf(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, scope)
);

CREATE INDEX IF NOT EXISTS idx_laft_cash_idemp_created
  ON laft_cash_idempotency_keys(created_at DESC);

REVOKE DELETE ON laft_cash_idempotency_keys FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT ON laft_cash_idempotency_keys TO operaciones_app;
    -- DELETE solo para limpieza (cron retention >30d). Dejamos abierto a admin.
    GRANT DELETE ON laft_cash_idempotency_keys TO operaciones_app;
  END IF;
END $$;
