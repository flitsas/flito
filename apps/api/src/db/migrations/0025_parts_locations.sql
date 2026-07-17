-- Sprint 2A — Ubicaciones físicas para inventario de repuestos.

CREATE TABLE IF NOT EXISTS parts_locations (
  id serial PRIMARY KEY,
  codigo varchar(20) NOT NULL UNIQUE,
  nombre varchar(80) NOT NULL,
  bodega varchar(80),
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO parts_locations (codigo, nombre, bodega) VALUES
  ('BPP', 'Bodega Principal', 'Sede principal')
ON CONFLICT (codigo) DO NOTHING;
