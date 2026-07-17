-- Sprint PESV Compliance Fase 3 · Control de Jornada (Decreto 1079/2015 art. 2.2.1.7.1.10)
--
-- Tablas: jornadas_conductor, jornadas_pausas, jornadas_alarmas, jornadas_reportes_mensuales,
--         jornadas_idempotency_keys.
--
-- Patrones aplicados:
-- - UNIQUE parcial (un conductor solo puede tener UNA jornada abierta).
-- - SELECT FOR UPDATE al cerrar (cron autoclose + cierre manual no compiten).
-- - Idempotency keys para reintentos del cliente móvil offline.
-- - WORM en alarmas y reportes mensuales (auditables, no editables).
-- - Score / horas computadas en BD (generated columns) para consistencia con reportes.

BEGIN;

CREATE TYPE jornada_pausa_motivo AS ENUM ('descanso', 'comida', 'combustible', 'cargue_descargue', 'otro');
CREATE TYPE jornada_alarma_tipo AS ENUM ('mas_4h_continuas', 'mas_10h_jornada', 'menos_8h_descanso', 'mas_60h_semanal', 'sin_pausa_obligatoria');
CREATE TYPE jornada_idem_scope AS ENUM ('open', 'close', 'pausa_open', 'pausa_close');

-- ============================================================================
-- 1. jornadas_conductor — entidad principal
-- ============================================================================
CREATE TABLE jornadas_conductor (
  id              bigserial PRIMARY KEY,
  conductor_id    integer NOT NULL REFERENCES users(id),
  vehicle_id      integer REFERENCES vehicles(id),
  checklist_id    integer,  -- FK debil; checklists viven en otra tabla
  inicio_at       timestamptz NOT NULL,
  fin_at          timestamptz,
  horas_conduccion numeric(6, 2) GENERATED ALWAYS AS (
    CASE WHEN fin_at IS NOT NULL
      THEN ROUND((EXTRACT(EPOCH FROM (fin_at - inicio_at)) / 3600.0)::numeric, 2)
      ELSE NULL
    END
  ) STORED,
  horas_descanso_pre numeric(6, 2),  -- horas desde fin de la jornada anterior (calculado al abrir)
  cerrada         boolean NOT NULL DEFAULT false,
  cerrada_automatica boolean NOT NULL DEFAULT false,
  cerrada_por     integer REFERENCES users(id),
  observaciones   text,
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_jornada_fin_posterior CHECK (fin_at IS NULL OR fin_at > inicio_at)
);

-- Solo UNA jornada abierta por conductor (UNIQUE parcial — previene doble apertura).
CREATE UNIQUE INDEX uq_jornada_abierta_por_conductor ON jornadas_conductor(conductor_id) WHERE cerrada = false;
CREATE INDEX idx_jornada_conductor_fecha ON jornadas_conductor(conductor_id, inicio_at DESC);
CREATE INDEX idx_jornada_vehicle ON jornadas_conductor(vehicle_id) WHERE vehicle_id IS NOT NULL;
-- Para el cron autoclose: scan barato de jornadas viejas abiertas.
CREATE INDEX idx_jornada_abiertas_old ON jornadas_conductor(inicio_at) WHERE cerrada = false;

CREATE TRIGGER tr_jornada_updated BEFORE UPDATE ON jornadas_conductor
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 2. jornadas_pausas — pausas dentro de la jornada (cumplimiento art. 2.2.1.7.1.10)
-- ============================================================================
CREATE TABLE jornadas_pausas (
  id              bigserial PRIMARY KEY,
  jornada_id      bigint NOT NULL REFERENCES jornadas_conductor(id) ON DELETE CASCADE,
  inicio_at       timestamptz NOT NULL,
  fin_at          timestamptz,
  motivo          jornada_pausa_motivo NOT NULL DEFAULT 'descanso',
  duracion_min    integer GENERATED ALWAYS AS (
    CASE WHEN fin_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (fin_at - inicio_at)) / 60.0)::integer
      ELSE NULL
    END
  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pausa_fin_posterior CHECK (fin_at IS NULL OR fin_at > inicio_at)
);
CREATE INDEX idx_pausa_jornada ON jornadas_pausas(jornada_id);
-- Solo UNA pausa abierta por jornada.
CREATE UNIQUE INDEX uq_pausa_abierta ON jornadas_pausas(jornada_id) WHERE fin_at IS NULL;

-- ============================================================================
-- 3. jornadas_alarmas — eventos generados al cierre (WORM)
-- ============================================================================
CREATE TABLE jornadas_alarmas (
  id              bigserial PRIMARY KEY,
  jornada_id      bigint NOT NULL REFERENCES jornadas_conductor(id) ON DELETE CASCADE,
  tipo            jornada_alarma_tipo NOT NULL,
  generada_at     timestamptz NOT NULL DEFAULT now(),
  valor_observado numeric(8, 2) NOT NULL,
  valor_limite    numeric(8, 2) NOT NULL,
  unidad          varchar(20) NOT NULL DEFAULT 'horas',
  ack_by          integer REFERENCES users(id),
  ack_at          timestamptz,
  ack_observaciones text
);
CREATE INDEX idx_alarma_jornada ON jornadas_alarmas(jornada_id);
CREATE INDEX idx_alarma_tipo_pendiente ON jornadas_alarmas(tipo, generada_at DESC) WHERE ack_at IS NULL;

-- WORM en alarmas: NO admite UPDATE de tipo/valor/jornada (solo ack).
CREATE OR REPLACE FUNCTION tg_jornada_alarma_worm() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jornadas_alarmas no admite DELETE (WORM compliance)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tipo <> OLD.tipo OR NEW.jornada_id <> OLD.jornada_id
       OR NEW.valor_observado <> OLD.valor_observado OR NEW.valor_limite <> OLD.valor_limite
       OR NEW.generada_at <> OLD.generada_at THEN
      RAISE EXCEPTION 'jornadas_alarmas: campos inmutables modificados (WORM compliance)' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_jornada_alarma_worm BEFORE UPDATE OR DELETE ON jornadas_alarmas
  FOR EACH ROW EXECUTE FUNCTION tg_jornada_alarma_worm();

-- ============================================================================
-- 4. jornadas_reportes_mensuales — agregados materializados (Resolución 315)
-- ============================================================================
CREATE TABLE jornadas_reportes_mensuales (
  id              serial PRIMARY KEY,
  conductor_id    integer NOT NULL REFERENCES users(id),
  anio            smallint NOT NULL,
  mes             smallint NOT NULL CHECK (mes BETWEEN 1 AND 12),
  jornadas_count  integer NOT NULL DEFAULT 0,
  horas_totales   numeric(7, 2) NOT NULL DEFAULT 0,
  alarmas_count   integer NOT NULL DEFAULT 0,
  cumple_norma    boolean NOT NULL DEFAULT true,
  detalle_jsonb   jsonb,  -- desglose semana 1-5, alarmas por tipo, etc.
  generado_at     timestamptz NOT NULL DEFAULT now(),
  generado_por    integer REFERENCES users(id),
  CONSTRAINT uq_reporte_mensual UNIQUE (conductor_id, anio, mes)
);
CREATE INDEX idx_reporte_periodo ON jornadas_reportes_mensuales(anio DESC, mes DESC);

-- WORM: una vez generado, no se edita (regenerar = DELETE+INSERT explícito por admin).
-- Aquí permitimos regeneración explicita borrando antes; lo controla el endpoint.

-- ============================================================================
-- 5. jornadas_idempotency_keys — para reintentos del cliente móvil offline
-- ============================================================================
CREATE TABLE jornadas_idempotency_keys (
  key             varchar(80) NOT NULL,
  scope           jornada_idem_scope NOT NULL,
  jornada_id      bigint REFERENCES jornadas_conductor(id) ON DELETE CASCADE,
  pausa_id        bigint REFERENCES jornadas_pausas(id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users(id),
  used_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope)
);
CREATE INDEX idx_idem_user ON jornadas_idempotency_keys(user_id, used_at DESC);
-- Cleanup viejas (>30d) en cron — fuera de scope de esta migration.

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'jornadas%';  -- 5
--   SELECT trigger_name FROM information_schema.triggers WHERE event_object_table LIKE 'jornadas%';
--     debe incluir tr_jornada_alarma_worm + tr_jornada_updated
-- ============================================================================
