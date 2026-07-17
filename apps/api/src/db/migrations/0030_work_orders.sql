-- Sprint 2B — Preorden + Orden de Trabajo (E4) + auditoría wo_close.
-- pre_orders: planificación previa, requiere aprobación.
-- work_orders: ejecución real. Estados: abierta → cerrada_tecnica → cerrada_final.
-- Cierre final descuenta inventario en transacción (idempotente vía wo_parts.aplicado_stock).

-- Acciones nuevas para audit (wo_close, wo_open, stock_adjust).
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'wo_close';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'wo_open';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'stock_adjust';

CREATE TABLE IF NOT EXISTS pre_orders (
  id serial PRIMARY KEY,
  numero varchar(20) NOT NULL UNIQUE,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  estado pre_order_estado NOT NULL DEFAULT 'borrador',
  observaciones text,
  creado_por integer REFERENCES users(id),
  aprobado_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_vehicle_estado ON pre_orders(vehicle_id, estado);
CREATE INDEX IF NOT EXISTS idx_po_fecha ON pre_orders(fecha DESC);

CREATE TABLE IF NOT EXISTS pre_order_jobs (
  pre_order_id integer NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
  job_id integer NOT NULL REFERENCES maintenance_jobs(id) ON DELETE RESTRICT,
  costo_estimado numeric(15, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (pre_order_id, job_id)
);

CREATE TABLE IF NOT EXISTS pre_order_parts (
  pre_order_id integer NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
  part_id integer NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  cantidad numeric(12, 3) NOT NULL DEFAULT 1,
  costo_estimado numeric(15, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (pre_order_id, part_id)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id serial PRIMARY KEY,
  numero varchar(20) NOT NULL UNIQUE,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  pre_order_id integer REFERENCES pre_orders(id) ON DELETE SET NULL,
  routine_id integer REFERENCES maintenance_routines(id) ON DELETE SET NULL,
  fecha_ingreso_taller timestamptz NOT NULL DEFAULT NOW(),
  fecha_orden date NOT NULL DEFAULT CURRENT_DATE,
  posible_cierre date,
  medicion_ingreso integer,
  proveedor_id integer REFERENCES users(id),
  tipo_trabajo wo_tipo NOT NULL DEFAULT 'preventivo',
  falla text,
  conductor_id integer REFERENCES users(id),
  observaciones text,
  estado wo_estado NOT NULL DEFAULT 'abierta',
  fecha_cierre_tecnica timestamptz,
  fecha_cierre_final timestamptz,
  garantia boolean NOT NULL DEFAULT false,
  metodo_pago varchar(20),
  costo_total_calculado numeric(15, 2),
  creado_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_vehicle_fecha ON work_orders(vehicle_id, fecha_ingreso_taller DESC);
CREATE INDEX IF NOT EXISTS idx_wo_estado ON work_orders(estado);
CREATE INDEX IF NOT EXISTS idx_wo_tipo_cierre ON work_orders(tipo_trabajo, fecha_cierre_final) WHERE fecha_cierre_final IS NOT NULL;

CREATE TABLE IF NOT EXISTS wo_jobs (
  id serial PRIMARY KEY,
  wo_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  job_id integer NOT NULL REFERENCES maintenance_jobs(id) ON DELETE RESTRICT,
  mechanic_id integer REFERENCES users(id),
  tiempo_real_horas numeric(6, 2),
  costo_mano_obra numeric(15, 2) NOT NULL DEFAULT 0,
  notas text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_jobs_wo ON wo_jobs(wo_id);

CREATE TABLE IF NOT EXISTS wo_parts (
  id serial PRIMARY KEY,
  wo_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  part_id integer NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  cantidad numeric(12, 3) NOT NULL,
  valor_unit numeric(15, 4),
  descuento numeric(15, 2) NOT NULL DEFAULT 0,
  ubicacion_id integer REFERENCES parts_locations(id) ON DELETE RESTRICT,
  aplicado_stock boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wo_parts_cant_pos CHECK (cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_wo_parts_wo ON wo_parts(wo_id);
CREATE INDEX IF NOT EXISTS idx_wo_parts_pendientes ON wo_parts(wo_id) WHERE aplicado_stock = false;

CREATE TABLE IF NOT EXISTS wo_seguimientos (
  id bigserial PRIMARY KEY,
  wo_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  texto text,
  archivos jsonb NOT NULL DEFAULT '[]'::jsonb,
  autor_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wo_seg_wo ON wo_seguimientos(wo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wo_otros_gastos (
  id serial PRIMARY KEY,
  wo_id integer NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  concepto varchar(150) NOT NULL,
  monto numeric(15, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pre_orders, pre_order_jobs, pre_order_parts,
  work_orders, wo_jobs, wo_parts, wo_seguimientos, wo_otros_gastos
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  pre_orders_id_seq, work_orders_id_seq, wo_jobs_id_seq, wo_parts_id_seq,
  wo_seguimientos_id_seq, wo_otros_gastos_id_seq
  TO operaciones_app;
