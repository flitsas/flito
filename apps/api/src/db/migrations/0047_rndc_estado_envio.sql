-- Sprint 4 Fase 4.2 — Estado de envío RNDC + idempotencia persistente + outbox de notificaciones
-- Hardening QA: Map en memoria del mock NO sirve en cluster PM2 / restart → tabla persistente.
-- Hardening QA: emails fallidos NO se pierden → outbox con su propio retry.

-- ENUM estado_envio
DO $$ BEGIN
  CREATE TYPE rndc_estado_envio AS ENUM (
    'no_aplica', 'pendiente_envio', 'enviando', 'aceptado',
    'error_envio', 'fallido_temporal', 'fallido_definitivo', 'cancelado_pre_envio'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Columnas de tracking en remesas.
ALTER TABLE remesas
  ADD COLUMN IF NOT EXISTS estado_envio rndc_estado_envio NOT NULL DEFAULT 'no_aplica',
  ADD COLUMN IF NOT EXISTS intentos_envio smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS proximo_intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_error text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

ALTER TABLE manifiestos
  ADD COLUMN IF NOT EXISTS estado_envio rndc_estado_envio NOT NULL DEFAULT 'no_aplica',
  ADD COLUMN IF NOT EXISTS intentos_envio smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS proximo_intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_error text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

-- Índices para el cron retry (lectura rápida de pendientes).
CREATE INDEX IF NOT EXISTS idx_remesas_pendiente_envio
  ON remesas(estado_envio, proximo_intento_at)
  WHERE estado_envio IN ('pendiente_envio', 'error_envio', 'fallido_temporal');

CREATE INDEX IF NOT EXISTS idx_manifiestos_pendiente_envio
  ON manifiestos(estado_envio, proximo_intento_at)
  WHERE estado_envio IN ('pendiente_envio', 'error_envio', 'fallido_temporal');

-- Índices para rescate de filas zombi (en estado 'enviando' demasiado tiempo).
CREATE INDEX IF NOT EXISTS idx_remesas_enviando
  ON remesas(estado_envio, ultimo_intento_at)
  WHERE estado_envio = 'enviando';

CREATE INDEX IF NOT EXISTS idx_manifiestos_enviando
  ON manifiestos(estado_envio, ultimo_intento_at)
  WHERE estado_envio = 'enviando';

-- Tabla de idempotencia: clave_local → consecutivo_rndc + hash del request.
-- Reemplaza al Map en memoria. Sobrevive reinicios y soporta cluster.
CREATE TABLE IF NOT EXISTS rndc_idempotency_keys (
  consecutivo_local varchar(40) PRIMARY KEY,
  entidad_tipo varchar(20) NOT NULL,
  entidad_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  consecutivo_rndc varchar(30),
  resultado varchar(20),
  modo varchar(10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rndc_idem_entidad
  ON rndc_idempotency_keys(entidad_tipo, entidad_id);

DROP TRIGGER IF EXISTS trg_rndc_idem_touch ON rndc_idempotency_keys;
CREATE TRIGGER trg_rndc_idem_touch BEFORE UPDATE ON rndc_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Outbox transaccional para notificaciones (emails). Cron lo procesa con su propio retry.
DO $$ BEGIN
  CREATE TYPE outbox_estado AS ENUM ('pendiente', 'enviado', 'error', 'fallido_definitivo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id bigserial PRIMARY KEY,
  canal varchar(20) NOT NULL DEFAULT 'email',
  destinatarios text NOT NULL,             -- JSON array de emails
  asunto text NOT NULL,
  cuerpo_html text NOT NULL,
  cuerpo_texto text,
  estado outbox_estado NOT NULL DEFAULT 'pendiente',
  intentos smallint NOT NULL DEFAULT 0,
  ultimo_intento_at timestamptz,
  proximo_intento_at timestamptz,
  ultimo_error text,
  message_id text,
  enviado_at timestamptz,
  contexto_tipo varchar(40),               -- 'rndc_fallido', 'soat_pendiente', etc.
  contexto_id integer,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by integer REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_outbox_pendiente
  ON notification_outbox(estado, proximo_intento_at)
  WHERE estado IN ('pendiente', 'error');

GRANT SELECT, INSERT, UPDATE ON rndc_idempotency_keys TO operaciones_app;
GRANT SELECT, INSERT, UPDATE ON notification_outbox TO operaciones_app;
GRANT USAGE, SELECT ON SEQUENCE notification_outbox_id_seq TO operaciones_app;

-- Touch updated_at en remesas y manifiestos (si ya existe trigger, reusar).
DROP TRIGGER IF EXISTS trg_remesas_touch ON remesas;
CREATE TRIGGER trg_remesas_touch BEFORE UPDATE ON remesas
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_manifiestos_touch ON manifiestos;
CREATE TRIGGER trg_manifiestos_touch BEFORE UPDATE ON manifiestos
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
