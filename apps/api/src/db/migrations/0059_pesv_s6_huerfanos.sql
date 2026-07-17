-- Sprint PESV-S6 · Cierre de 7 estándares huérfanos + log PII Ley 1581
--
-- Tablas:
--   - pii_access_log         (Ley 1581 — audit append-only de accesos a PII conductor)
--   - pesv_auditorias        (Paso 22 — auditoría anual PESV)
--   - pesv_auditoria_hallazgos (hallazgos por auditoría)
--   - pesv_comunicaciones    (Paso 1.8 + Paso 24 — broadcasts internos)
--   - pesv_comunicacion_acuses (acuse de recibo por usuario)
--   - pesv_contratistas      (Paso 18 — terceros transportadores con evaluación PESV)
--
-- Extensiones a tablas existentes:
--   - road_incidents.causa_raiz_metodo + causa_raiz_jsonb (Paso 13 Ishikawa/5-porqués)

BEGIN;

-- ============================================================================
-- 1. pii_access_log — Ley 1581 art. 17 (audit log accesos a datos personales)
--    Append-only por trigger; multa hasta 2000 SMMLV por incumplimiento.
-- ============================================================================
CREATE TABLE pii_access_log (
  id              bigserial PRIMARY KEY,
  user_id         integer REFERENCES users(id),
  user_role       varchar(40),
  resource_tipo   varchar(50) NOT NULL,    -- 'driver_profile', 'manifiesto_titular', 'aspirante', etc.
  resource_id     integer,                  -- id del registro accedido
  accion          varchar(20) NOT NULL,     -- 'read', 'export', 'decrypt', 'search'
  campos_accedidos text[] NOT NULL DEFAULT ARRAY[]::text[],  -- ['cedula', 'licencia', 'runt_payload']
  motivo          varchar(200),             -- propósito del acceso (PESV, validación, ROS LAFT, etc.)
  ip_origen       varchar(45),
  user_agent      text,
  request_id      uuid,
  accessed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pii_access_user ON pii_access_log(user_id, accessed_at DESC);
CREATE INDEX idx_pii_access_resource ON pii_access_log(resource_tipo, resource_id);
CREATE INDEX idx_pii_access_fecha ON pii_access_log(accessed_at DESC);

-- Append-only: bloquea UPDATE y DELETE.
CREATE OR REPLACE FUNCTION tg_pii_access_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'pii_access_log es append-only (Ley 1581 art. 17)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pii_access_log no admite DELETE (Ley 1581 art. 17)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_pii_access_log_append BEFORE UPDATE OR DELETE ON pii_access_log
  FOR EACH ROW EXECUTE FUNCTION tg_pii_access_log_append_only();

-- ============================================================================
-- 2. pesv_auditorias — Paso 22 (auditoría anual PESV)
-- ============================================================================
CREATE TYPE pesv_auditoria_tipo AS ENUM ('interna', 'externa', 'supert', 'onac');
CREATE TYPE pesv_auditoria_estado AS ENUM ('planificada', 'en_curso', 'cerrada');
CREATE TYPE pesv_hallazgo_severidad AS ENUM ('observacion', 'no_conformidad_menor', 'no_conformidad_mayor', 'critico');
CREATE TYPE pesv_hallazgo_estado AS ENUM ('abierto', 'en_remediacion', 'cerrado', 'aceptado');

CREATE TABLE pesv_auditorias (
  id              serial PRIMARY KEY,
  anio            smallint NOT NULL,
  tipo            pesv_auditoria_tipo NOT NULL,
  alcance         text NOT NULL,
  fecha_planificada date NOT NULL,
  fecha_inicio    date,
  fecha_cierre    date,
  auditor_externo varchar(200),
  auditor_lider_id integer REFERENCES users(id),
  estado          pesv_auditoria_estado NOT NULL DEFAULT 'planificada',
  resumen         text,
  evidencia_keys  text[] NOT NULL DEFAULT ARRAY[]::text[],
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_audit_cierre_posterior CHECK (fecha_cierre IS NULL OR fecha_cierre >= fecha_inicio)
);
CREATE INDEX idx_pesv_audit_anio ON pesv_auditorias(anio DESC);
CREATE INDEX idx_pesv_audit_estado ON pesv_auditorias(estado);
CREATE TRIGGER tr_pesv_audit_updated BEFORE UPDATE ON pesv_auditorias
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE TABLE pesv_auditoria_hallazgos (
  id              serial PRIMARY KEY,
  auditoria_id    integer NOT NULL REFERENCES pesv_auditorias(id) ON DELETE CASCADE,
  paso_pesv       smallint REFERENCES pesv_estandares_catalogo(paso),
  severidad       pesv_hallazgo_severidad NOT NULL,
  descripcion     text NOT NULL,
  evidencia_keys  text[] NOT NULL DEFAULT ARRAY[]::text[],
  responsable_id  integer REFERENCES users(id),
  fecha_limite    date,
  estado          pesv_hallazgo_estado NOT NULL DEFAULT 'abierto',
  acciones_md     text,
  cierre_observaciones text,
  cerrado_at      timestamptz,
  cerrado_por     integer REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pesv_hallazgo_audit ON pesv_auditoria_hallazgos(auditoria_id);
CREATE INDEX idx_pesv_hallazgo_estado ON pesv_auditoria_hallazgos(estado) WHERE estado != 'cerrado';
CREATE TRIGGER tr_pesv_hallazgo_updated BEFORE UPDATE ON pesv_auditoria_hallazgos
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 3. pesv_comunicaciones — Paso 1.8 + Paso 24 (difusión interna)
-- ============================================================================
CREATE TYPE pesv_comunicacion_tipo AS ENUM ('politica', 'lecciones_aprendidas', 'capacitacion', 'recordatorio', 'otro');

CREATE TABLE pesv_comunicaciones (
  id              serial PRIMARY KEY,
  tipo            pesv_comunicacion_tipo NOT NULL,
  asunto          varchar(200) NOT NULL,
  cuerpo_md       text NOT NULL,
  pdf_storage_key varchar(500),
  destinatarios_roles text[] NOT NULL DEFAULT ARRAY[]::text[],  -- ['conductor','supervisor_flota'] o [] = todos
  publicado_at    timestamptz,
  publicado_por   integer REFERENCES users(id),
  vencimiento_acuse date,        -- fecha límite para que confirmen lectura
  acuses_count    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pesv_com_publicado ON pesv_comunicaciones(publicado_at DESC NULLS LAST);
CREATE INDEX idx_pesv_com_tipo ON pesv_comunicaciones(tipo);

CREATE TABLE pesv_comunicacion_acuses (
  comunicacion_id integer NOT NULL REFERENCES pesv_comunicaciones(id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acuse_at        timestamptz NOT NULL DEFAULT now(),
  ip_origen       varchar(45),
  PRIMARY KEY (comunicacion_id, user_id)
);
CREATE INDEX idx_pesv_acuse_user ON pesv_comunicacion_acuses(user_id);

-- ============================================================================
-- 4. pesv_contratistas — Paso 18 (terceros transportadores con evaluación PESV)
-- ============================================================================
CREATE TYPE pesv_contratista_estado AS ENUM ('vinculado', 'suspendido', 'desvinculado');
CREATE TYPE pesv_contratista_evaluacion AS ENUM ('apto', 'apto_condicional', 'no_apto');

CREATE TABLE pesv_contratistas (
  id              serial PRIMARY KEY,
  razon_social    varchar(200) NOT NULL,
  nit             varchar(20) NOT NULL UNIQUE,
  contacto_nombre varchar(150),
  contacto_email  varchar(150),
  contacto_telefono varchar(40),
  pesv_nivel      varchar(20),  -- 'basico', 'estandar', 'avanzado', 'no_aplica'
  pesv_certificado_storage_key varchar(500),
  pesv_vencimiento date,
  evaluacion      pesv_contratista_evaluacion NOT NULL DEFAULT 'apto_condicional',
  proxima_evaluacion date,
  estado          pesv_contratista_estado NOT NULL DEFAULT 'vinculado',
  observaciones   text,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pesv_contrat_estado ON pesv_contratistas(estado);
CREATE INDEX idx_pesv_contrat_vencimiento ON pesv_contratistas(pesv_vencimiento) WHERE pesv_vencimiento IS NOT NULL;
CREATE TRIGGER tr_pesv_contrat_updated BEFORE UPDATE ON pesv_contratistas
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 5. road_incidents extensión — Paso 13 (investigación causa raíz estructurada)
-- ============================================================================
CREATE TYPE pesv_causa_raiz_metodo AS ENUM ('5_porques', 'ishikawa', 'arbol_causas', 'otro');

ALTER TABLE road_incidents
  ADD COLUMN IF NOT EXISTS causa_raiz_metodo pesv_causa_raiz_metodo,
  ADD COLUMN IF NOT EXISTS causa_raiz_jsonb jsonb,  -- estructura: {porques: [...]} o {categorias: {humano:[],vehiculo:[],...}}
  ADD COLUMN IF NOT EXISTS investigacion_responsable_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS investigacion_cerrada_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_road_inc_investigacion ON road_incidents(investigacion_cerrada_at) WHERE investigacion_cerrada_at IS NULL;

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'pesv_%' OR table_name = 'pii_access_log';
--   SELECT typname FROM pg_type WHERE typname LIKE 'pesv_%' OR typname = 'pesv_causa_raiz_metodo';
-- ============================================================================
