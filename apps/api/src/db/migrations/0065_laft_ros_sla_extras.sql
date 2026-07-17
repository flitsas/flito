-- 0065: Extiende laft_ros_drafts para soportar el flujo F4 SARLAFT v2:
--   - clasificado_at + sla_due_at: timer de 24h desde clasificación (Resolución UIAF 122/2021).
--   - export_pdf/csv_storage_key + export_sha256: artefacto generado para data-entry humano en SIREL.
--     SIREL es web-form (https://www.uiaf.gov.co/sirel) y NO expone API/XSD pública,
--     por eso el sistema produce PDF + CSV — el oficial de cumplimiento los consulta y
--     transcribe en el portal. NO se envía SOAP/REST a la UIAF.
--   - sirel_acuse_at + sirel_radicado: cierre del SLA cuando el oficial registra
--     el número de radicado tras hacer el data-entry manual.
--
-- Tabla auxiliar laft_ros_sla_alarmas: trazabilidad WORM-ish de las alertas que el
-- cron envía cuando el SLA está por vencer (warn_12h, warn_4h) o ya venció (breach).
-- UNIQUE(ros_draft_id, tipo) garantiza que cada tipo de alarma se dispara una sola vez.
--
-- Defensa en profundidad: REVOKE UPDATE/DELETE para que la app no pueda reescribir
-- la historia de alarmas — solo INSERT y UPDATE focalizado vía acuse.

ALTER TABLE laft_ros_drafts
  ADD COLUMN IF NOT EXISTS clasificado_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS export_pdf_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS export_csv_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS export_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS sirel_acuse_at TIMESTAMPTZ;

-- sirel_radicado ya existe en la tabla original (varchar(50)). Ampliamos para soportar
-- formatos UIAF más largos (60 chars) sin romper datos existentes.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'laft_ros_drafts' AND column_name = 'sirel_radicado'
      AND character_maximum_length < 60
  ) THEN
    ALTER TABLE laft_ros_drafts ALTER COLUMN sirel_radicado TYPE VARCHAR(60);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_laft_ros_sla
  ON laft_ros_drafts(sla_due_at)
  WHERE sirel_acuse_at IS NULL AND sla_breached = false;

CREATE INDEX IF NOT EXISTS idx_laft_ros_breached
  ON laft_ros_drafts(clasificado_at DESC)
  WHERE sla_breached = true;

-- Tabla de alarmas SLA — auditoría de cuándo alertamos al oficial de cumplimiento.
CREATE TABLE IF NOT EXISTS laft_ros_sla_alarmas (
  id BIGSERIAL PRIMARY KEY,
  ros_draft_id INTEGER NOT NULL REFERENCES laft_ros_drafts(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('warn_12h','warn_4h','breach')),
  alarmada_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  destinatarios TEXT,
  acuse_at TIMESTAMPTZ,
  acuse_por INTEGER REFERENCES users(id),
  CONSTRAINT uq_alarma_ros_tipo UNIQUE (ros_draft_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_laft_ros_alarmas_pending
  ON laft_ros_sla_alarmas(alarmada_at DESC)
  WHERE acuse_at IS NULL;

-- WORM defensivo: nadie borra alarmas; el UPDATE solo se permite vía acuse_at + acuse_por.
REVOKE UPDATE, DELETE ON laft_ros_sla_alarmas FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE DELETE ON laft_ros_sla_alarmas FROM operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON laft_ros_sla_alarmas TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_ros_sla_alarmas_id_seq TO operaciones_app;
  END IF;
END $$;
