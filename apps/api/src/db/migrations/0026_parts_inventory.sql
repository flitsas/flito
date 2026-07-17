-- Sprint 2A — Inventario de repuestos con costo promedio ponderado (CPP).
-- El trigger tg_apply_movement actualiza parts_stock y parts.valor_promedio
-- automáticamente al insertar un parts_movement.
-- CPP elegido sobre FIFO: NIIF Sec.13 lo admite, no requiere lotes, suficiente para FLIT.

CREATE TABLE IF NOT EXISTS parts (
  id serial PRIMARY KEY,
  codigo varchar(30) NOT NULL UNIQUE,
  nombre varchar(150) NOT NULL,
  unidad_medida varchar(10) NOT NULL DEFAULT 'und',
  inventariable boolean NOT NULL DEFAULT true,
  existencia_min numeric(12, 2) NOT NULL DEFAULT 0,
  existencia_max numeric(12, 2),
  system_id integer REFERENCES maintenance_systems(id) ON DELETE SET NULL,
  valor_promedio numeric(15, 4) NOT NULL DEFAULT 0,
  activo boolean NOT NULL DEFAULT true,
  observaciones text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_parts_min_max CHECK (existencia_max IS NULL OR existencia_max >= existencia_min)
);

CREATE INDEX IF NOT EXISTS idx_parts_activo ON parts(activo) WHERE activo = true;
CREATE INDEX IF NOT EXISTS idx_parts_codigo_trgm ON parts USING gin (codigo gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_nombre_trgm ON parts USING gin (nombre gin_trgm_ops);

CREATE TABLE IF NOT EXISTS parts_stock (
  id serial PRIMARY KEY,
  part_id integer NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  location_id integer NOT NULL REFERENCES parts_locations(id) ON DELETE RESTRICT,
  cantidad numeric(14, 3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_stock_part_location UNIQUE (part_id, location_id),
  CONSTRAINT chk_stock_no_negativo CHECK (cantidad >= 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_part ON parts_stock(part_id);

CREATE TABLE IF NOT EXISTS parts_movements (
  id bigserial PRIMARY KEY,
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  tipo movement_type NOT NULL,
  part_id integer NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  cantidad numeric(14, 3) NOT NULL,
  valor_unit numeric(15, 4),
  ubicacion_origen_id integer REFERENCES parts_locations(id) ON DELETE RESTRICT,
  ubicacion_destino_id integer REFERENCES parts_locations(id) ON DELETE RESTRICT,
  factura varchar(50),
  remision varchar(50),
  wo_id integer,
  observaciones text,
  usuario_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mov_cantidad_pos CHECK (cantidad > 0),
  CONSTRAINT chk_mov_ubicaciones CHECK (
    (tipo = 'entrada' AND ubicacion_destino_id IS NOT NULL) OR
    (tipo = 'salida' AND ubicacion_origen_id IS NOT NULL) OR
    (tipo = 'traslado' AND ubicacion_origen_id IS NOT NULL AND ubicacion_destino_id IS NOT NULL AND ubicacion_origen_id <> ubicacion_destino_id) OR
    (tipo = 'ajuste' AND ubicacion_destino_id IS NOT NULL) OR
    (tipo = 'reverso_ot' AND ubicacion_destino_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_movs_part_fecha ON parts_movements(part_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_movs_wo ON parts_movements(wo_id) WHERE wo_id IS NOT NULL;

-- Trigger: aplica el movimiento sobre parts_stock y recalcula valor_promedio si es entrada.
CREATE OR REPLACE FUNCTION fn_apply_movement() RETURNS TRIGGER AS $$
DECLARE
  stock_total_previo numeric(14, 3);
  promedio_actual numeric(15, 4);
BEGIN
  IF NEW.tipo = 'entrada' OR NEW.tipo = 'reverso_ot' OR NEW.tipo = 'ajuste' THEN
    -- Recalcular valor promedio ponderado SOLO en entradas con valor_unit.
    IF NEW.tipo = 'entrada' AND NEW.valor_unit IS NOT NULL THEN
      SELECT COALESCE(SUM(cantidad), 0), COALESCE((SELECT valor_promedio FROM parts WHERE id = NEW.part_id), 0)
        INTO stock_total_previo, promedio_actual
        FROM parts_stock WHERE part_id = NEW.part_id;
      IF stock_total_previo + NEW.cantidad > 0 THEN
        UPDATE parts SET
          valor_promedio = ((stock_total_previo * promedio_actual) + (NEW.cantidad * NEW.valor_unit)) / (stock_total_previo + NEW.cantidad),
          updated_at = NOW()
        WHERE id = NEW.part_id;
      END IF;
    END IF;
    INSERT INTO parts_stock (part_id, location_id, cantidad)
      VALUES (NEW.part_id, NEW.ubicacion_destino_id, NEW.cantidad)
      ON CONFLICT (part_id, location_id) DO UPDATE SET
        cantidad = parts_stock.cantidad + NEW.cantidad,
        updated_at = NOW();

  ELSIF NEW.tipo = 'salida' THEN
    UPDATE parts_stock SET
      cantidad = cantidad - NEW.cantidad,
      updated_at = NOW()
    WHERE part_id = NEW.part_id AND location_id = NEW.ubicacion_origen_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sin stock para part_id=% en location_id=%', NEW.part_id, NEW.ubicacion_origen_id;
    END IF;

  ELSIF NEW.tipo = 'traslado' THEN
    UPDATE parts_stock SET cantidad = cantidad - NEW.cantidad, updated_at = NOW()
      WHERE part_id = NEW.part_id AND location_id = NEW.ubicacion_origen_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sin stock origen para traslado part_id=% loc=%', NEW.part_id, NEW.ubicacion_origen_id;
    END IF;
    INSERT INTO parts_stock (part_id, location_id, cantidad)
      VALUES (NEW.part_id, NEW.ubicacion_destino_id, NEW.cantidad)
      ON CONFLICT (part_id, location_id) DO UPDATE SET
        cantidad = parts_stock.cantidad + NEW.cantidad,
        updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_apply_movement ON parts_movements;
CREATE TRIGGER tg_apply_movement
  AFTER INSERT ON parts_movements
  FOR EACH ROW EXECUTE FUNCTION fn_apply_movement();
