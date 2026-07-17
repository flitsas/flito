-- Sprint 3B — Checklist preoperacional (Resolución 40595/2022 paso 21).
-- Plantillas configurables versionadas + ejecuciones por conductor+vehículo con firma PIN.

DO $$ BEGIN
  CREATE TYPE checklist_freq AS ENUM ('diaria', 'semanal', 'mensual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE checklist_decision AS ENUM ('apto', 'no_apto', 'condicional');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE item_criterio AS ENUM ('booleano', 'tres_estados', 'numerico');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE item_estado AS ENUM ('bueno', 'regular', 'malo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS checklist_templates (
  id serial PRIMARY KEY,
  titulo varchar(150) NOT NULL,
  vehiculo_tipo vehicle_type,
  frecuencia checklist_freq NOT NULL DEFAULT 'diaria',
  vigente boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id),
  CONSTRAINT uq_template_titulo_version UNIQUE (titulo, version)
);

CREATE INDEX IF NOT EXISTS idx_templates_vigente ON checklist_templates(vehiculo_tipo, frecuencia)
  WHERE vigente = true;

CREATE TABLE IF NOT EXISTS checklist_template_items (
  id serial PRIMARY KEY,
  template_id integer NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  orden integer NOT NULL,
  categoria varchar(40),
  label varchar(200) NOT NULL,
  criterio item_criterio NOT NULL DEFAULT 'tres_estados',
  obligatorio boolean NOT NULL DEFAULT true,
  critico boolean NOT NULL DEFAULT false,
  unidad varchar(20),
  min_valor numeric,
  max_valor numeric,
  CONSTRAINT uq_item_template_orden UNIQUE (template_id, orden)
);

CREATE INDEX IF NOT EXISTS idx_items_template ON checklist_template_items(template_id);

CREATE TABLE IF NOT EXISTS checklists (
  id serial PRIMARY KEY,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  conductor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id integer NOT NULL REFERENCES checklist_templates(id) ON DELETE RESTRICT,
  template_version integer NOT NULL,
  fecha_hora timestamptz NOT NULL DEFAULT NOW(),
  medicion_actual integer,
  lat numeric(9, 6),
  lng numeric(9, 6),
  decision checklist_decision NOT NULL,
  firma_pin_verificado boolean NOT NULL DEFAULT false,
  qr_token varchar(64) UNIQUE NOT NULL,
  observaciones_generales text,
  anulado_at timestamptz,
  anulado_por integer REFERENCES users(id),
  anulado_motivo text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checklists_vehicle ON checklists(vehicle_id, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_checklists_conductor ON checklists(conductor_id, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_checklists_no_apto ON checklists(decision, fecha_hora DESC) WHERE decision = 'no_apto';

CREATE TABLE IF NOT EXISTS checklist_responses (
  id bigserial PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  item_id integer NOT NULL REFERENCES checklist_template_items(id) ON DELETE RESTRICT,
  valor_bool boolean,
  valor_estado item_estado,
  valor_num numeric(12, 2),
  observacion text,
  foto_storage_keys text[] NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT uq_response_checklist_item UNIQUE (checklist_id, item_id),
  CONSTRAINT chk_response_un_valor CHECK (
    (valor_bool IS NOT NULL)::int + (valor_estado IS NOT NULL)::int + (valor_num IS NOT NULL)::int >= 1
  )
);

-- Seed: plantilla preoperacional diaria estándar para flota de carga.
INSERT INTO checklist_templates (titulo, vehiculo_tipo, frecuencia, vigente, created_at)
SELECT 'Preoperacional Diaria — Carga', NULL, 'diaria', true, NOW()
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE titulo = 'Preoperacional Diaria — Carga' AND version = 1);

DO $$
DECLARE template_id_var integer;
BEGIN
  SELECT id INTO template_id_var FROM checklist_templates WHERE titulo = 'Preoperacional Diaria — Carga' AND version = 1 LIMIT 1;
  IF template_id_var IS NOT NULL THEN
    INSERT INTO checklist_template_items (template_id, orden, categoria, label, criterio, obligatorio, critico) VALUES
      (template_id_var, 10, 'seguridad',  'Sistema de frenos (pedal y freno parqueo)',     'tres_estados', true, true),
      (template_id_var, 20, 'seguridad',  'Luces (altas, bajas, direccionales, freno)',    'tres_estados', true, true),
      (template_id_var, 30, 'seguridad',  'Espejos retrovisores (estado y ajuste)',         'booleano',     true, false),
      (template_id_var, 40, 'seguridad',  'Llantas (presión, labrado, daños)',              'tres_estados', true, true),
      (template_id_var, 50, 'seguridad',  'Sistema de dirección (juego volante)',           'tres_estados', true, true),
      (template_id_var, 60, 'fluidos',    'Niveles (aceite, refrigerante, frenos)',         'tres_estados', true, false),
      (template_id_var, 70, 'documentos', 'Documentos a bordo (SOAT, RTM, tarjeta)',        'booleano',     true, true),
      (template_id_var, 80, 'externos',   'Kit de carretera completo',                      'booleano',     true, false),
      (template_id_var, 90, 'externos',   'Extintor vigente y accesible',                   'booleano',     true, true),
      (template_id_var, 100,'externos',   'Botiquín completo y vigente',                    'booleano',     true, false)
    ON CONFLICT (template_id, orden) DO NOTHING;
  END IF;
END $$;
