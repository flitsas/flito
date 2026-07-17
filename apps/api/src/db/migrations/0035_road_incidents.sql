-- Incidentes viales: accidentes, casi-accidentes, comparendos.
-- Indicadores PESV: tasa accidentalidad, severidad, frecuencia derivan de aquí.

DO $$ BEGIN
  CREATE TYPE incident_tipo AS ENUM ('accidente', 'casi_accidente', 'comparendo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE incident_gravedad AS ENUM ('sin', 'leve', 'grave', 'fatal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE incident_estado AS ENUM ('abierto', 'investigacion', 'cerrado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE action_estado AS ENUM ('pendiente', 'en_proceso', 'cumplida', 'vencida');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS road_incidents (
  id serial PRIMARY KEY,
  tipo incident_tipo NOT NULL,
  vehicle_id integer REFERENCES vehicles(id) ON DELETE SET NULL,
  conductor_id integer REFERENCES users(id) ON DELETE SET NULL,
  fecha date NOT NULL,
  hora time,
  lugar_texto varchar(300),
  lat numeric(9, 6),
  lng numeric(9, 6),
  gravedad incident_gravedad NOT NULL DEFAULT 'sin',
  descripcion text,
  costos numeric(12, 2) NOT NULL DEFAULT 0,
  victimas_count integer NOT NULL DEFAULT 0,
  dias_perdidos integer NOT NULL DEFAULT 0,
  comparendo_numero varchar(40),
  valor_multa numeric(12, 2),
  fotos_keys text[] NOT NULL DEFAULT '{}'::text[],
  reportado_por integer REFERENCES users(id),
  estado incident_estado NOT NULL DEFAULT 'abierto',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz,
  CONSTRAINT chk_inc_costos_pos CHECK (costos >= 0),
  CONSTRAINT chk_inc_dias_perdidos_pos CHECK (dias_perdidos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_incidents_fecha_grav ON road_incidents(fecha DESC, gravedad);
CREATE INDEX IF NOT EXISTS idx_incidents_conductor ON road_incidents(conductor_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_vehicle ON road_incidents(vehicle_id, fecha DESC);

CREATE TABLE IF NOT EXISTS incident_actions (
  id serial PRIMARY KEY,
  incident_id integer NOT NULL REFERENCES road_incidents(id) ON DELETE CASCADE,
  descripcion text NOT NULL,
  responsable_id integer REFERENCES users(id),
  fecha_limite date,
  fecha_cumplimiento date,
  evidencia_storage_key varchar(500),
  estado action_estado NOT NULL DEFAULT 'pendiente',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inc_actions_incident ON incident_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_inc_actions_pendientes ON incident_actions(estado) WHERE estado IN ('pendiente', 'en_proceso');
