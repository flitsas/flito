-- Sprint PESV Compliance Fase 2 · Paso 4 Infraestructura segura (Res. 40595/2022)
--
-- Tablas: routes, route_waypoints, route_risk_analyses, route_risk_items,
--         route_pernocta_zones, route_assignments.
--
-- Decisiones (del Arquitecto):
-- - Rutas como lista plana ordenada de waypoints (NO grafo). Caso de uso lineal.
-- - UNIQUE (route_id, trimestre) en análisis trimestrales.
-- - WORM en route_risk_analyses cuando estado='aprobado'.
-- - Advisory locks para reordenamiento de waypoints sin race.
-- - Optimistic locking en routes y risk_analyses.

BEGIN;

-- ============================================================================
-- 1. routes — catálogo de rutas operativas
-- ============================================================================
CREATE TYPE route_criticidad AS ENUM ('baja', 'media', 'alta', 'critica');

CREATE TABLE routes (
  id              serial PRIMARY KEY,
  codigo          varchar(30) NOT NULL UNIQUE,
  nombre          varchar(200) NOT NULL,
  origen          varchar(200) NOT NULL,
  destino         varchar(200) NOT NULL,
  distancia_km    numeric(8, 2),
  duracion_estimada_min integer,
  criticidad      route_criticidad NOT NULL DEFAULT 'media',
  modo_operacion  varchar(50),  -- 'carga', 'paquetería', 'liquidos', etc.
  vehiculo_tipo   varchar(50),  -- 'tractomula', 'camion', etc.
  notas           text,
  activo          boolean NOT NULL DEFAULT true,
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_routes_activo ON routes(activo) WHERE activo = true;
CREATE INDEX idx_routes_criticidad ON routes(criticidad);
CREATE TRIGGER tr_routes_updated BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 2. route_waypoints — puntos a lo largo de la ruta (origen, paradas, riesgos)
-- ============================================================================
CREATE TYPE route_waypoint_tipo AS ENUM (
  'origen', 'destino', 'parada_segura', 'area_descanso',
  'punto_riesgo', 'zona_peligrosa', 'peaje', 'pernocta', 'cargue', 'descargue'
);

CREATE TABLE route_waypoints (
  id              serial PRIMARY KEY,
  route_id        integer NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  orden           smallint NOT NULL,
  tipo            route_waypoint_tipo NOT NULL,
  nombre          varchar(200) NOT NULL,
  descripcion     text,
  lat             numeric(9, 6),
  lng             numeric(9, 6),
  telefono_contacto varchar(40),
  observaciones   text,
  CONSTRAINT chk_waypoint_lat CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  CONSTRAINT chk_waypoint_lng CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  CONSTRAINT uq_waypoint_orden UNIQUE (route_id, orden)
);
CREATE INDEX idx_waypoint_route ON route_waypoints(route_id, orden);
CREATE INDEX idx_waypoint_tipo ON route_waypoints(tipo);

-- ============================================================================
-- 3. route_risk_analyses — análisis trimestral por ruta
-- ============================================================================
CREATE TYPE route_risk_estado AS ENUM ('borrador', 'aprobado');

CREATE TABLE route_risk_analyses (
  id              serial PRIMARY KEY,
  route_id        integer NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  trimestre       varchar(7) NOT NULL,  -- e.g. '2026-Q2'
  fecha           date NOT NULL,
  evaluador_id    integer NOT NULL REFERENCES users(id),
  resumen         text,
  estado          route_risk_estado NOT NULL DEFAULT 'borrador',
  optimistic_v    integer NOT NULL DEFAULT 1,
  aprobado_at     timestamptz,
  aprobado_por    integer REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_risk_trimestre UNIQUE (route_id, trimestre),
  CONSTRAINT chk_trimestre_format CHECK (trimestre ~ '^[0-9]{4}-Q[1-4]$')
);
CREATE INDEX idx_risk_route ON route_risk_analyses(route_id, fecha DESC);
CREATE TRIGGER tr_risk_updated BEFORE UPDATE ON route_risk_analyses
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
-- WORM cuando estado='aprobado' usando trigger genérico de Fase 1.
CREATE TRIGGER tr_risk_worm BEFORE UPDATE OR DELETE ON route_risk_analyses
  FOR EACH ROW EXECUTE FUNCTION tg_pesv_worm('estado', 'aprobado');

-- ============================================================================
-- 4. route_risk_items — items de la matriz prob × impacto
-- ============================================================================
CREATE TABLE route_risk_items (
  id              serial PRIMARY KEY,
  analisis_id     integer NOT NULL REFERENCES route_risk_analyses(id) ON DELETE CASCADE,
  peligro         varchar(300) NOT NULL,
  probabilidad    smallint NOT NULL CHECK (probabilidad BETWEEN 1 AND 5),
  impacto         smallint NOT NULL CHECK (impacto BETWEEN 1 AND 5),
  score           smallint GENERATED ALWAYS AS (probabilidad * impacto) STORED,
  controles_actuales text,
  residual_prob   smallint CHECK (residual_prob IS NULL OR residual_prob BETWEEN 1 AND 5),
  residual_imp    smallint CHECK (residual_imp IS NULL OR residual_imp BETWEEN 1 AND 5),
  residual_score  smallint GENERATED ALWAYS AS (
    CASE WHEN residual_prob IS NOT NULL AND residual_imp IS NOT NULL
      THEN residual_prob * residual_imp ELSE NULL END
  ) STORED,
  plan_accion     text,
  responsable_id  integer REFERENCES users(id),
  fecha_limite    date
);
CREATE INDEX idx_risk_item_analisis ON route_risk_items(analisis_id);

-- ============================================================================
-- 5. route_pernocta_zones — zonas de pernocta y parqueo seguro
-- ============================================================================
CREATE TABLE route_pernocta_zones (
  id              serial PRIMARY KEY,
  nombre          varchar(200) NOT NULL,
  route_id        integer REFERENCES routes(id) ON DELETE SET NULL,  -- NULL = global
  lat             numeric(9, 6),
  lng             numeric(9, 6),
  capacidad       integer,
  contacto        varchar(150),
  telefono        varchar(40),
  protocolo_md    text,
  servicios       text[] NOT NULL DEFAULT ARRAY[]::text[],  -- ['baño', 'duchas', 'cafetería', 'vigilancia']
  vigente         boolean NOT NULL DEFAULT true,
  created_by      integer REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pernocta_lat CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  CONSTRAINT chk_pernocta_lng CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180))
);
CREATE INDEX idx_pernocta_vigente ON route_pernocta_zones(vigente) WHERE vigente = true;
CREATE INDEX idx_pernocta_route ON route_pernocta_zones(route_id) WHERE route_id IS NOT NULL;
CREATE TRIGGER tr_pernocta_updated BEFORE UPDATE ON route_pernocta_zones
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 6. route_assignments — vinculación opcional ruta ↔ remesa/manifiesto
-- ============================================================================
CREATE TABLE route_assignments (
  id              bigserial PRIMARY KEY,
  route_id        integer NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  remesa_id       bigint REFERENCES remesas(id) ON DELETE CASCADE,
  manifiesto_id   bigint REFERENCES manifiestos(id) ON DELETE CASCADE,
  asignado_por    integer NOT NULL REFERENCES users(id),
  asignado_at     timestamptz NOT NULL DEFAULT now(),
  notas           text,
  CONSTRAINT chk_assignment_target CHECK (
    (remesa_id IS NOT NULL AND manifiesto_id IS NULL)
    OR (manifiesto_id IS NOT NULL AND remesa_id IS NULL)
  )
);
CREATE INDEX idx_assign_route ON route_assignments(route_id);
CREATE INDEX idx_assign_remesa ON route_assignments(remesa_id) WHERE remesa_id IS NOT NULL;
CREATE INDEX idx_assign_manifiesto ON route_assignments(manifiesto_id) WHERE manifiesto_id IS NOT NULL;
-- Una remesa/manifiesto solo puede tener UNA asignación activa.
CREATE UNIQUE INDEX uq_assign_remesa ON route_assignments(remesa_id) WHERE remesa_id IS NOT NULL;
CREATE UNIQUE INDEX uq_assign_manifiesto ON route_assignments(manifiesto_id) WHERE manifiesto_id IS NOT NULL;

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'route%';  -- 6
--   SELECT typname FROM pg_type WHERE typname LIKE 'route_%';
--     route_criticidad, route_waypoint_tipo, route_risk_estado
-- ============================================================================
