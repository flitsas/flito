-- Documentos del conductor (similar a vehicle_documents pero FK a users).
-- Tabla driver_alerts_sent dedicada (no se reusa alerts_sent que tiene FK rígida a vehicle_documents).

CREATE TABLE IF NOT EXISTS driver_document_types (
  id serial PRIMARY KEY,
  codigo varchar(40) NOT NULL UNIQUE,
  nombre varchar(120) NOT NULL,
  requiere_vigencia boolean NOT NULL DEFAULT true,
  dias_alerta integer[] NOT NULL DEFAULT '{30,15,7,0}',
  destinatarios_default text[] NOT NULL DEFAULT '{}',
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO driver_document_types (codigo, nombre, requiere_vigencia, dias_alerta, orden) VALUES
  ('licencia_conduccion',  'Licencia de Conducción',                true,  ARRAY[60,30,15,7,0], 10),
  ('examen_psico',         'Examen Psicosensométrico',              true,  ARRAY[60,30,15,7,0], 20),
  ('examen_ocupacional',   'Examen Médico Ocupacional',             true,  ARRAY[30,15,7,0],    30),
  ('arl_afiliacion',       'Afiliación ARL',                        true,  ARRAY[30,15,7,0],    40),
  ('eps_afiliacion',       'Afiliación EPS',                        true,  ARRAY[30,15,7,0],    50),
  ('contrato_laboral',     'Contrato Laboral',                      false, ARRAY[30,0],         60),
  ('cert_capacitacion',    'Certificado de Capacitación Vial',      true,  ARRAY[30,15,0],      70)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS driver_documents (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo_id integer NOT NULL REFERENCES driver_document_types(id) ON DELETE RESTRICT,
  numero varchar(80),
  vigencia_desde date,
  vigencia_hasta date,
  archivo_storage_key varchar(500),
  archivo_filename varchar(300),
  archivo_size integer,
  archivo_mime varchar(100),
  estado doc_estado NOT NULL DEFAULT 'vigente',
  destinatarios_extra text[] NOT NULL DEFAULT '{}',
  notas text,
  subido_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driverdocs_user_tipo ON driver_documents(user_id, tipo_id);
CREATE INDEX IF NOT EXISTS idx_driverdocs_vencimiento
  ON driver_documents(vigencia_hasta)
  WHERE estado IN ('vigente', 'por_vencer') AND vigencia_hasta IS NOT NULL;

CREATE TABLE IF NOT EXISTS driver_alerts_sent (
  id bigserial PRIMARY KEY,
  documento_id integer NOT NULL REFERENCES driver_documents(id) ON DELETE CASCADE,
  dias_anticipacion integer NOT NULL,
  enviado_at timestamptz NOT NULL DEFAULT NOW(),
  destinatarios text[] NOT NULL,
  email_message_id varchar(200),
  resultado varchar(20) NOT NULL,
  error_msg text,
  CONSTRAINT uq_driver_alert_doc_dias UNIQUE (documento_id, dias_anticipacion)
);
