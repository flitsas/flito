-- E4: Gestión documental con vencimientos y alertas.
-- document_types     — catálogo configurable (SOAT, técnico-mecánica, póliza, etc.)
-- vehicle_documents  — un documento concreto adjunto a un vehículo, con vigencia.
-- alerts_sent        — control de idempotencia para no reenviar la misma alerta dos veces.

DO $$ BEGIN
  CREATE TYPE doc_estado AS ENUM ('vigente', 'por_vencer', 'vencido', 'archivado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS document_types (
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

-- Seed con los 8 tipos de documento más usados en flotas colombianas.
INSERT INTO document_types (codigo, nombre, requiere_vigencia, orden) VALUES
  ('soat',                'SOAT',                                  true,  10),
  ('rtm',                 'Revisión Técnico-Mecánica (RTM)',       true,  20),
  ('poliza_contractual',  'Póliza Contractual',                    true,  30),
  ('poliza_extra',        'Póliza Extracontractual',               true,  40),
  ('tarjeta_propiedad',   'Tarjeta de Propiedad',                  false, 50),
  ('tarjeta_operacion',   'Tarjeta de Operación',                  true,  60),
  ('cert_emisiones',      'Certificado de Emisiones',              true,  70),
  ('runt',                'Inscripción RUNT',                      false, 80)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS vehicle_documents (
  id serial PRIMARY KEY,
  vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  tipo_id integer NOT NULL REFERENCES document_types(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS idx_vehdocs_vehicle ON vehicle_documents(vehicle_id, tipo_id);
CREATE INDEX IF NOT EXISTS idx_vehdocs_vencimiento
  ON vehicle_documents(vigencia_hasta)
  WHERE estado IN ('vigente', 'por_vencer') AND vigencia_hasta IS NOT NULL;

CREATE TABLE IF NOT EXISTS alerts_sent (
  id bigserial PRIMARY KEY,
  documento_id integer NOT NULL REFERENCES vehicle_documents(id) ON DELETE CASCADE,
  dias_anticipacion integer NOT NULL,
  enviado_at timestamptz NOT NULL DEFAULT NOW(),
  destinatarios text[] NOT NULL,
  email_message_id varchar(200),
  resultado varchar(20) NOT NULL,
  error_msg text,
  CONSTRAINT uq_alert_doc_dias UNIQUE (documento_id, dias_anticipacion)
);
