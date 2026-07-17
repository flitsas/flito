-- LAFT/SARLAFT v2 — F5: Manual SARLAFT versionado WORM, designación oficial cumplimiento,
-- plan anual de auditorías internas/revisor fiscal. Resolución 4607/2026 SuperTransporte.
--
-- WORM (Write-Once-Read-Many) en manual: sólo se permite editar columnas de firma/publicación
-- mientras la versión esté en borrador. Una vez publicada, ni UPDATE ni DELETE — se crea
-- una nueva versión.
--
-- Designación de oficial cumplimiento: histórica con valid_from/valid_to. Cuando se designa
-- nuevo principal, el anterior queda con valid_to = nuevo.valid_from - 1 (atómico en TX).
-- ISO/IEC 17024 es certificación de personas — flag boolean + storage_key del documento.
--
-- Plan anual de auditorías: idempotente por (anio, tipo). Cierre exige hallazgos+conclusiones+evidencia.
--
-- Rol auditor: read-only LAFT (auditoría interna/externa que sólo necesita inspeccionar).

BEGIN;

-- ============================================================================
-- 1. Manual SARLAFT versionado WORM
-- ============================================================================
CREATE TABLE IF NOT EXISTS laft_manual_versions (
  id BIGSERIAL PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  titulo VARCHAR(200) NOT NULL DEFAULT 'Manual SARLAFT',
  contenido_md TEXT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  pdf_storage_key TEXT,
  firmado_por_representante INTEGER REFERENCES users(id),
  firmado_por_oficial INTEGER REFERENCES users(id),
  firmado_at TIMESTAMPTZ,
  publicado BOOLEAN NOT NULL DEFAULT false,
  publicado_at TIMESTAMPTZ,
  motivo_cambio TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_laft_manual_publicado
  ON laft_manual_versions(version DESC) WHERE publicado = true;

CREATE INDEX IF NOT EXISTS idx_laft_manual_borrador
  ON laft_manual_versions(version DESC) WHERE publicado = false;

-- WORM defensa profunda: no se puede UPDATE/DELETE post-publicación.
-- Antes de publicar (publicado=false) sí se permite UPDATE para registrar firmas y
-- ajustar contenido. La publicación es el punto de no retorno.
CREATE OR REPLACE FUNCTION fn_laft_manual_worm() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.publicado = true THEN
      RAISE EXCEPTION 'Manual SARLAFT versión publicada es WORM — no admite DELETE'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.publicado = true THEN
    RAISE EXCEPTION 'Manual SARLAFT versión publicada es WORM — crear nueva versión'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_laft_manual_worm ON laft_manual_versions;
CREATE TRIGGER trg_laft_manual_worm
  BEFORE UPDATE OR DELETE ON laft_manual_versions
  FOR EACH ROW EXECUTE FUNCTION fn_laft_manual_worm();

-- ============================================================================
-- 2. Designación de oficial cumplimiento
-- ============================================================================
CREATE TABLE IF NOT EXISTS laft_compliance_officers (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  rol VARCHAR(20) NOT NULL CHECK (rol IN ('principal','suplente')),
  certificacion_iso17024 BOOLEAN NOT NULL DEFAULT false,
  certificacion_doc_storage_key TEXT,
  designado_por INTEGER NOT NULL REFERENCES users(id),
  acta_junta_storage_key TEXT,
  valid_from DATE NOT NULL,
  valid_to DATE,
  revocado_at TIMESTAMPTZ,
  revocado_motivo TEXT,
  revocado_por INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_valid_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Índice parcial para resolución rápida de "vigentes" (NULL valid_to + sin revocar).
CREATE INDEX IF NOT EXISTS idx_laft_officer_vigentes
  ON laft_compliance_officers(rol)
  WHERE valid_to IS NULL AND revocado_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_laft_officer_user
  ON laft_compliance_officers(user_id);

-- ============================================================================
-- 3. Plan de auditorías (interna + revisor fiscal)
-- ============================================================================
CREATE TABLE IF NOT EXISTS laft_audit_plans (
  id BIGSERIAL PRIMARY KEY,
  anio INT NOT NULL,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('interna','revisor_fiscal')),
  alcance TEXT,
  responsable_user_id INTEGER REFERENCES users(id),
  responsable_externo_nombre VARCHAR(150),
  responsable_externo_nit VARCHAR(20),
  fecha_planificada DATE NOT NULL,
  fecha_ejecutada DATE,
  hallazgos_md TEXT,
  conclusiones_md TEXT,
  evidencia_storage_key TEXT,
  estado VARCHAR(20) NOT NULL DEFAULT 'planeada'
    CHECK (estado IN ('planeada','en_ejecucion','cerrada','cancelada')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_audit_anio_tipo UNIQUE (anio, tipo)
);

CREATE INDEX IF NOT EXISTS idx_laft_audit_plan_anio ON laft_audit_plans(anio DESC, tipo);
CREATE INDEX IF NOT EXISTS idx_laft_audit_plan_estado ON laft_audit_plans(estado);

-- Trigger de updated_at: reusa función global tg_set_updated_at si existe.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'tg_set_updated_at') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS tr_laft_audit_plans_updated ON laft_audit_plans';
    EXECUTE 'CREATE TRIGGER tr_laft_audit_plans_updated
              BEFORE UPDATE ON laft_audit_plans
              FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at()';
  END IF;
END $$;

-- ============================================================================
-- 4. Rol "auditor" (read-only LAFT) — agregado al enum user_role
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumlabel = 'auditor'
       AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    ALTER TYPE user_role ADD VALUE 'auditor';
  END IF;
END $$;

-- ============================================================================
-- 5. Page grants — slugs LAFT F5 a admin/compliance/auditor
-- ============================================================================
WITH new_slugs AS (
  SELECT unnest(ARRAY['laft_manual','laft_oficial','laft_audit_plan','laft_dashboard']) AS slug
)
UPDATE users u
   SET allowed_pages = (
     SELECT ARRAY(
       SELECT DISTINCT s
       FROM unnest(COALESCE(u.allowed_pages, '{}'::text[]) ||
                   ARRAY(SELECT slug FROM new_slugs)) AS s
     )
   )
 WHERE u.role IN ('admin', 'compliance');

-- ============================================================================
-- 6. Permisos del rol app sobre tablas nuevas
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      laft_manual_versions, laft_compliance_officers, laft_audit_plans
      TO operaciones_app;
    -- DELETE solo en borrador-manual (trigger lo bloquea post-publish) y para compliance officers
    -- borramos sólo a través de "revocar" que es UPDATE, no DELETE.
    GRANT DELETE ON laft_manual_versions, laft_audit_plans TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE
      laft_manual_versions_id_seq,
      laft_compliance_officers_id_seq,
      laft_audit_plans_id_seq
      TO operaciones_app;
  END IF;
END $$;

COMMIT;
