-- Sprint PESV Compliance Fase 1 · Paso 1 Gestión Institucional
-- Res. 40595/2022 + Res. 20223040045295 (30 estándares mínimos)
--
-- Tablas: pesv_policy, pesv_comite, pesv_comite_miembros, pesv_comite_actas,
--         pesv_plan_anual, pesv_plan_objetivos, pesv_plan_acciones,
--         pesv_estandares_catalogo (seed 30 filas), pesv_diagnosticos, pesv_diagnostico_items.
--
-- Patrones aplicados:
-- - WORM trigger parametrizable bloquea UPDATE/DELETE en estados terminales.
-- - Optimistic locking (version int) en tablas con FSM (policy, plan, diagnostico).
-- - Advisory locks por entidad para numeración correlativa de actas (sin race).
-- - UNIQUE parcial (una sola política vigente, un diagnóstico por año).
-- - Audit log se hace en backend vía middleware existente (no triggers DB).

BEGIN;

-- ============================================================================
-- 0. Trigger genérico WORM (Write-Once-Read-Many)
--    Bloquea UPDATE/DELETE cuando la fila tiene un estado terminal.
--    Cada tabla pasa los estados bloqueados como argumento del trigger.
-- ============================================================================
CREATE OR REPLACE FUNCTION tg_pesv_worm() RETURNS trigger AS $$
DECLARE
  v_estado_col text := TG_ARGV[0];
  v_estados_bloqueados text[] := TG_ARGV[1:];
  v_estado_actual text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT ($1).%I::text', v_estado_col) INTO v_estado_actual USING OLD;
  ELSE
    EXECUTE format('SELECT ($1).%I::text', v_estado_col) INTO v_estado_actual USING OLD;
  END IF;
  IF v_estado_actual = ANY (v_estados_bloqueados) THEN
    RAISE EXCEPTION 'WORM violation: fila en estado terminal "%" no admite % en tabla %',
      v_estado_actual, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. pesv_policy — Política de Seguridad Vial versionada
-- ============================================================================
CREATE TYPE pesv_policy_estado AS ENUM ('borrador', 'vigente', 'reemplazada');

CREATE TABLE pesv_policy (
  id              serial PRIMARY KEY,
  version         integer NOT NULL,
  titulo          varchar(200) NOT NULL,
  contenido_md    text NOT NULL,
  pdf_storage_key varchar(500),
  vigencia_desde  date NOT NULL,
  vigencia_hasta  date,
  firmada_por     integer REFERENCES users(id),
  firmada_at      timestamptz,
  hash_sha256     bytea,
  estado          pesv_policy_estado NOT NULL DEFAULT 'borrador',
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_policy_vigente_firmada CHECK (
    estado <> 'vigente' OR (firmada_at IS NOT NULL AND firmada_por IS NOT NULL)
  ),
  CONSTRAINT chk_policy_hash_size CHECK (hash_sha256 IS NULL OR octet_length(hash_sha256) = 32)
);
CREATE UNIQUE INDEX uq_pesv_policy_vigente ON pesv_policy(estado) WHERE estado = 'vigente';
CREATE INDEX idx_pesv_policy_estado ON pesv_policy(estado);
CREATE TRIGGER tr_pesv_policy_worm
  BEFORE UPDATE OR DELETE ON pesv_policy
  FOR EACH ROW EXECUTE FUNCTION tg_pesv_worm('estado', 'reemplazada');

-- ============================================================================
-- 2. pesv_comite — Comité de Seguridad Vial
-- ============================================================================
CREATE TYPE pesv_comite_periodicidad AS ENUM ('mensual', 'bimestral', 'trimestral', 'semestral');
CREATE TYPE pesv_comite_rol AS ENUM ('presidente', 'secretario', 'lider_pesv', 'vocal', 'representante_conductores', 'hse', 'mantenimiento');

CREATE TABLE pesv_comite (
  id              serial PRIMARY KEY,
  nombre          varchar(150) NOT NULL,
  periodicidad    pesv_comite_periodicidad NOT NULL DEFAULT 'trimestral',
  activo          boolean NOT NULL DEFAULT true,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pesv_comite_miembros (
  comite_id       integer NOT NULL REFERENCES pesv_comite(id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users(id),
  rol             pesv_comite_rol NOT NULL,
  desde           date NOT NULL,
  hasta           date,
  PRIMARY KEY (comite_id, user_id, desde)
);
CREATE INDEX idx_pesv_comite_miembros_user ON pesv_comite_miembros(user_id);

-- ============================================================================
-- 3. pesv_comite_actas — Actas del comité (numeración correlativa por comité)
-- ============================================================================
CREATE TYPE pesv_acta_estado AS ENUM ('borrador', 'cerrada');

CREATE TABLE pesv_comite_actas (
  id              serial PRIMARY KEY,
  comite_id       integer NOT NULL REFERENCES pesv_comite(id),
  numero          integer NOT NULL,
  fecha           date NOT NULL,
  lugar           varchar(200),
  agenda_md       text,
  decisiones_md   text,
  asistentes_ids  integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  ausentes_ids    integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  pdf_storage_key varchar(500),
  hash_sha256     bytea,
  estado          pesv_acta_estado NOT NULL DEFAULT 'borrador',
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pesv_acta_numero UNIQUE (comite_id, numero),
  CONSTRAINT chk_acta_hash_size CHECK (hash_sha256 IS NULL OR octet_length(hash_sha256) = 32)
);
CREATE INDEX idx_pesv_acta_comite_fecha ON pesv_comite_actas(comite_id, fecha DESC);
CREATE TRIGGER tr_pesv_acta_worm
  BEFORE UPDATE OR DELETE ON pesv_comite_actas
  FOR EACH ROW EXECUTE FUNCTION tg_pesv_worm('estado', 'cerrada');

-- ============================================================================
-- 4. pesv_plan_anual + objetivos + acciones
-- ============================================================================
CREATE TYPE pesv_plan_estado AS ENUM ('borrador', 'aprobado', 'cerrado');
CREATE TYPE pesv_accion_estado AS ENUM ('pendiente', 'en_proceso', 'cumplida', 'vencida');

CREATE TABLE pesv_plan_anual (
  id              serial PRIMARY KEY,
  anio            smallint NOT NULL UNIQUE,
  objetivo_general text NOT NULL,
  presupuesto_cop numeric(14, 2) NOT NULL DEFAULT 0,
  aprobado_por    integer REFERENCES users(id),
  aprobado_at     timestamptz,
  estado          pesv_plan_estado NOT NULL DEFAULT 'borrador',
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_plan_aprobado CHECK (estado = 'borrador' OR (aprobado_at IS NOT NULL AND aprobado_por IS NOT NULL))
);
CREATE TRIGGER tr_pesv_plan_worm
  BEFORE UPDATE OR DELETE ON pesv_plan_anual
  FOR EACH ROW EXECUTE FUNCTION tg_pesv_worm('estado', 'cerrado');

CREATE TABLE pesv_plan_objetivos (
  id              serial PRIMARY KEY,
  plan_id         integer NOT NULL REFERENCES pesv_plan_anual(id) ON DELETE CASCADE,
  codigo          varchar(20) NOT NULL,
  descripcion     text NOT NULL,
  meta_pct        numeric(5, 2) NOT NULL CHECK (meta_pct >= 0 AND meta_pct <= 100),
  unidad          varchar(50),
  responsable_id  integer REFERENCES users(id),
  fecha_limite    date,
  CONSTRAINT uq_pesv_obj_codigo UNIQUE (plan_id, codigo)
);
CREATE INDEX idx_pesv_obj_plan ON pesv_plan_objetivos(plan_id);

CREATE TABLE pesv_plan_acciones (
  id              serial PRIMARY KEY,
  objetivo_id     integer NOT NULL REFERENCES pesv_plan_objetivos(id) ON DELETE CASCADE,
  descripcion     text NOT NULL,
  responsable_id  integer REFERENCES users(id),
  fecha_inicio    date,
  fecha_fin       date,
  presupuesto_cop numeric(14, 2) NOT NULL DEFAULT 0,
  avance_pct      numeric(5, 2) NOT NULL DEFAULT 0 CHECK (avance_pct >= 0 AND avance_pct <= 100),
  estado          pesv_accion_estado NOT NULL DEFAULT 'pendiente',
  evidencia_keys  text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pesv_acc_obj ON pesv_plan_acciones(objetivo_id);
CREATE INDEX idx_pesv_acc_responsable ON pesv_plan_acciones(responsable_id) WHERE responsable_id IS NOT NULL;

-- ============================================================================
-- 5. pesv_estandares_catalogo — 30 estándares Res. 20223040045295 (seed)
-- ============================================================================
CREATE TABLE pesv_estandares_catalogo (
  id              serial PRIMARY KEY,
  codigo          varchar(20) NOT NULL UNIQUE,
  paso            smallint NOT NULL CHECK (paso BETWEEN 1 AND 5),
  nombre          varchar(200) NOT NULL,
  descripcion     text,
  peso            numeric(5, 2) NOT NULL DEFAULT 1.0,
  vigente         boolean NOT NULL DEFAULT true,
  orden           smallint NOT NULL,
  CONSTRAINT uq_estandar_orden UNIQUE (paso, orden)
);
CREATE INDEX idx_estandar_paso ON pesv_estandares_catalogo(paso, orden);

-- Seed 30 estándares (5 pasos × items distribuidos según Res. 45295)
-- Paso 1: Fortalecimiento gestión institucional (10 estándares)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, nombre, descripcion, peso) VALUES
  ('1.1', 1, 1, 'Política de Seguridad Vial', 'Política firmada por representante legal, publicada y difundida.', 1.5),
  ('1.2', 1, 2, 'Comité de Seguridad Vial', 'Conformación, integrantes, periodicidad y actas.', 1.5),
  ('1.3', 1, 3, 'Plan Anual PESV', 'Objetivos SMART, metas, acciones, presupuesto y responsables.', 1.5),
  ('1.4', 1, 4, 'Diagnóstico / Línea base', 'Autoevaluación inicial documentada con evidencia.', 1.0),
  ('1.5', 1, 5, 'Roles y responsabilidades', 'Matriz de responsabilidades documentada.', 1.0),
  ('1.6', 1, 6, 'Recursos asignados', 'Presupuesto y talento humano asignado al PESV.', 1.0),
  ('1.7', 1, 7, 'Cumplimiento normativo', 'Identificación y seguimiento de requisitos legales.', 1.0),
  ('1.8', 1, 8, 'Comunicación y difusión interna', 'Mecanismos para divulgar política y plan.', 0.8),
  ('1.9', 1, 9, 'Aliados estratégicos / terceros', 'Evaluación PESV de transportistas tercerizados.', 1.2),
  ('1.10', 1, 10, 'Auditoría interna PESV', 'Programa de auditoría con cronograma y hallazgos.', 1.0);
-- Paso 2: Comportamiento humano (6 estándares)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, nombre, descripcion, peso) VALUES
  ('2.1', 2, 1, 'Selección y contratación de conductores', 'Perfil, antecedentes RUNT, judiciales y disciplinarios.', 1.5),
  ('2.2', 2, 2, 'Plan anual de capacitación', 'Capacitaciones técnicas, conducción defensiva, primeros auxilios.', 1.5),
  ('2.3', 2, 3, 'Pruebas de alcohol y sustancias psicoactivas', 'Programa con periodicidad, equipo calibrado y registro.', 1.5),
  ('2.4', 2, 4, 'Exámenes médicos ocupacionales', 'Ingreso, periódico (psico, audiometría, optometría) y egreso.', 1.5),
  ('2.5', 2, 5, 'Control de jornada y fatiga', 'Registro de jornadas, alarmas y descansos (Decreto 1079).', 1.5),
  ('2.6', 2, 6, 'Hojas de vida del conductor', 'Documentos vigentes, comparendos, restricciones.', 1.0);
-- Paso 3: Vehículos seguros (5 estándares)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, nombre, descripcion, peso) VALUES
  ('3.1', 3, 1, 'Inspección preoperacional', 'Checklist diario por vehículo y conductor con evidencia.', 1.5),
  ('3.2', 3, 2, 'Mantenimiento preventivo', 'Rutinas programadas por km/tiempo, work orders y trazabilidad.', 1.5),
  ('3.3', 3, 3, 'Documentos vigentes (SOAT/RTM/póliza)', 'Control de vencimientos con alertas automáticas.', 1.5),
  ('3.4', 3, 4, 'Kit carretera, botiquín, extintor', 'Inventario obligatorio Res. 19200 con vencimientos.', 1.0),
  ('3.5', 3, 5, 'Hoja de vida del vehículo', 'Mantenimientos, documentos y siniestros consolidados.', 1.0);
-- Paso 4: Infraestructura segura (4 estándares)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, nombre, descripcion, peso) VALUES
  ('4.1', 4, 1, 'Caracterización de rutas', 'Ruta documentada con riesgos, paradas y zonas seguras.', 1.5),
  ('4.2', 4, 2, 'Análisis de riesgo trimestral', 'Matriz prob × impacto + controles + residual por ruta.', 1.5),
  ('4.3', 4, 3, 'Procedimiento de pernocta y parqueo', 'Zonas seguras certificadas con contactos.', 1.0),
  ('4.4', 4, 4, 'Cargue y descargue seguro', 'Puntos georreferenciados con protocolos.', 1.0);
-- Paso 5: Atención a víctimas (5 estándares)
INSERT INTO pesv_estandares_catalogo (codigo, paso, orden, nombre, descripcion, peso) VALUES
  ('5.1', 5, 1, 'Plan de respuesta ante emergencias', 'Protocolos por tipo de emergencia con recursos.', 1.5),
  ('5.2', 5, 2, 'Simulacros con plan de mejora', 'Ejecución periódica con evidencia y lecciones aprendidas.', 1.0),
  ('5.3', 5, 3, 'Investigación de incidentes', 'Causa raíz (5-porqués / Ishikawa) y acciones correctivas.', 1.5),
  ('5.4', 5, 4, 'Atención a víctimas', 'Datos personales, ARL, EPS, seguimiento y cierre.', 1.5),
  ('5.5', 5, 5, 'Lecciones aprendidas y difusión', 'Registro consolidado y difundido a la flota.', 1.0);

-- ============================================================================
-- 6. pesv_diagnosticos + items
-- ============================================================================
CREATE TYPE pesv_diag_estado AS ENUM ('borrador', 'cerrado');

CREATE TABLE pesv_diagnosticos (
  id              serial PRIMARY KEY,
  anio            smallint NOT NULL,
  fecha           date NOT NULL,
  responsable_id  integer NOT NULL REFERENCES users(id),
  score_global    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (score_global >= 0 AND score_global <= 100),
  estado          pesv_diag_estado NOT NULL DEFAULT 'borrador',
  optimistic_v    integer NOT NULL DEFAULT 1,
  observaciones   text,
  cerrado_at      timestamptz,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_diag_anio ON pesv_diagnosticos(anio);
CREATE TRIGGER tr_pesv_diag_worm
  BEFORE UPDATE OR DELETE ON pesv_diagnosticos
  FOR EACH ROW EXECUTE FUNCTION tg_pesv_worm('estado', 'cerrado');

CREATE TABLE pesv_diagnostico_items (
  diagnostico_id  integer NOT NULL REFERENCES pesv_diagnosticos(id) ON DELETE CASCADE,
  estandar_id     integer NOT NULL REFERENCES pesv_estandares_catalogo(id),
  score_pct       numeric(5, 2) NOT NULL DEFAULT 0 CHECK (score_pct >= 0 AND score_pct <= 100),
  evidencia_keys  text[] NOT NULL DEFAULT ARRAY[]::text[],
  comentarios     text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (diagnostico_id, estandar_id)
);

-- ============================================================================
-- 7. updated_at trigger genérico (reuso patrón existente si lo hay)
-- ============================================================================
CREATE OR REPLACE FUNCTION tg_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_pesv_policy_updated BEFORE UPDATE ON pesv_policy
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER tr_pesv_comite_updated BEFORE UPDATE ON pesv_comite
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER tr_pesv_acta_updated BEFORE UPDATE ON pesv_comite_actas
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER tr_pesv_plan_updated BEFORE UPDATE ON pesv_plan_anual
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER tr_pesv_accion_updated BEFORE UPDATE ON pesv_plan_acciones
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER tr_pesv_diag_updated BEFORE UPDATE ON pesv_diagnosticos
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM pesv_estandares_catalogo;        -- 30
--   SELECT paso, count(*) FROM pesv_estandares_catalogo GROUP BY 1 ORDER BY 1;
--     1|10, 2|6, 3|5, 4|4, 5|5
--   SELECT trigger_name FROM information_schema.triggers WHERE event_object_table LIKE 'pesv_%';
--     debe haber tr_*_worm (4) + tr_*_updated (6)
-- ============================================================================
