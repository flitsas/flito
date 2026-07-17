-- 0091 — TRAM-INNOV-B5-MVP: liquidación + pago MANUAL (sin pasarela, sin PCI).
-- Liga a OT (work_orders) y/o trámite. ADR-DB-001: sin BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS liquidaciones (
  id BIGSERIAL PRIMARY KEY,
  wo_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
  tramite_id INTEGER REFERENCES tramites_digitales(id) ON DELETE SET NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'borrador',  -- borrador | confirmada | anulada
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  nota TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmada_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_liquidaciones_wo ON liquidaciones(wo_id);
CREATE INDEX IF NOT EXISTS idx_liquidaciones_tramite ON liquidaciones(tramite_id);

CREATE TABLE IF NOT EXISTS liquidacion_items (
  id BIGSERIAL PRIMARY KEY,
  liquidacion_id BIGINT NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
  descripcion VARCHAR(200) NOT NULL,
  cantidad NUMERIC(12,2) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(15,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_liquidacion_items_liq ON liquidacion_items(liquidacion_id);

-- Pago MANUAL (estado manual_confirmado). NO almacena datos de tarjeta (no PCI).
CREATE TABLE IF NOT EXISTS pagos (
  id BIGSERIAL PRIMARY KEY,
  liquidacion_id BIGINT NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
  metodo VARCHAR(20) NOT NULL DEFAULT 'manual',
  estado VARCHAR(20) NOT NULL DEFAULT 'manual_confirmado',
  monto NUMERIC(15,2) NOT NULL,
  referencia VARCHAR(120),
  nota TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagos_liquidacion ON pagos(liquidacion_id);
