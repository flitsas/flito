-- Sprint PESV-S9 · Pasos menores 1.5 RACI + 1.7 tracker normativo + 19 retención
--
-- Tablas:
--   - pesv_raci                  (Paso 1.5 — matriz Responsible/Accountable/Consulted/Informed)
--   - pesv_normativa             (Paso 1.7 — registro de normativa aplicable + próxima revisión)
--   - pesv_normativa_revisiones  (audit append-only de revisiones normativa)
--   - pesv_retencion_politicas   (Paso 19 — retención documental Ley 594/2000)
--   - pesv_retencion_log         (audit append-only de purgas/anonimizaciones)

BEGIN;

-- ============================================================================
-- 1. pesv_raci — Paso 1.5 (matriz de responsabilidades por proceso PESV)
--    Cruza pasos PHVA × roles del sistema con flag R/A/C/I.
--    UNIQUE compuesta evita duplicados (proceso, rol, tipo).
-- ============================================================================
CREATE TYPE pesv_raci_tipo AS ENUM ('R', 'A', 'C', 'I');

CREATE TABLE pesv_raci (
  id              serial PRIMARY KEY,
  proceso_codigo  varchar(20) NOT NULL,        -- 'S1.1', 'S2.4', 'S3.2' (matchea pesv_estandares_catalogo.codigo)
  proceso_nombre  varchar(200) NOT NULL,
  rol             varchar(40) NOT NULL,        -- 'admin','lider_pesv','supervisor_flota','conductor','compliance','proveedor','transito'
  tipo            pesv_raci_tipo NOT NULL,
  descripcion     text,
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_raci_proceso_rol_tipo UNIQUE (proceso_codigo, rol, tipo)
);
CREATE INDEX idx_raci_proceso ON pesv_raci(proceso_codigo);
CREATE INDEX idx_raci_rol ON pesv_raci(rol);
CREATE TRIGGER tr_raci_updated BEFORE UPDATE ON pesv_raci
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ============================================================================
-- 2. pesv_normativa — Paso 1.7 (tracker de normativa aplicable)
-- ============================================================================
CREATE TYPE pesv_normativa_tipo AS ENUM ('ley', 'decreto', 'resolucion', 'concepto', 'circular', 'norma_tecnica');

CREATE TABLE pesv_normativa (
  id              serial PRIMARY KEY,
  codigo          varchar(80) NOT NULL UNIQUE,  -- 'RES-40595-2022', 'LEY-1581-2012'
  tipo            pesv_normativa_tipo NOT NULL,
  titulo          text NOT NULL,
  emisor          varchar(120) NOT NULL,         -- 'MinTransporte','MinTrabajo','Congreso','SuperT', etc.
  fecha_publicacion date NOT NULL,
  vigente         boolean NOT NULL DEFAULT true,
  aplica_a        text[] NOT NULL DEFAULT ARRAY[]::text[],  -- ['pesv','jornadas','rutas','incidentes','laft','rndc','flota']
  url_oficial     varchar(500),
  resumen_md      text,
  ultima_revision_at timestamptz,
  ultima_revision_por integer REFERENCES users(id),
  proxima_revision_at timestamptz NOT NULL,       -- alerta cuando se aproxima
  notas_md        text,
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_normativa_vigente ON pesv_normativa(vigente);
CREATE INDEX idx_normativa_proxima_rev ON pesv_normativa(proxima_revision_at) WHERE vigente = true;
CREATE INDEX idx_normativa_aplica_gin ON pesv_normativa USING gin(aplica_a);
CREATE TRIGGER tr_normativa_updated BEFORE UPDATE ON pesv_normativa
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- Audit append-only de revisiones (cada vez que alguien marca "revisada" deja huella)
CREATE TABLE pesv_normativa_revisiones (
  id              bigserial PRIMARY KEY,
  normativa_id    integer NOT NULL REFERENCES pesv_normativa(id) ON DELETE CASCADE,
  revisada_at     timestamptz NOT NULL DEFAULT now(),
  revisada_por    integer NOT NULL REFERENCES users(id),
  cambios_observados text,                   -- ¿qué cambió en esta revisión?
  proxima_revision_at timestamptz NOT NULL   -- snapshot histórico
);
CREATE INDEX idx_norm_rev_norm ON pesv_normativa_revisiones(normativa_id, revisada_at DESC);

CREATE OR REPLACE FUNCTION tg_normativa_rev_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'pesv_normativa_revisiones es append-only (audit)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pesv_normativa_revisiones no admite DELETE (audit)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_norm_rev_append BEFORE UPDATE OR DELETE ON pesv_normativa_revisiones
  FOR EACH ROW EXECUTE FUNCTION tg_normativa_rev_append_only();

-- ============================================================================
-- 3. pesv_retencion_politicas — Paso 19 (retención documental Ley 594/2000)
-- ============================================================================
CREATE TYPE pesv_retencion_accion AS ENUM ('purgar', 'archivar_offline', 'anonimizar');

CREATE TABLE pesv_retencion_politicas (
  id              serial PRIMARY KEY,
  tipo_documento  varchar(60) NOT NULL UNIQUE,   -- 'incidente_vial','manifiesto','alcohol_test','checklist','acta_comite','pii_access_log','jornada','audit_log'
  retencion_anios smallint NOT NULL CHECK (retencion_anios BETWEEN 1 AND 100),
  base_legal      varchar(200) NOT NULL,         -- 'Ley 594/2000','Res 40595/2022 art X', etc.
  accion          pesv_retencion_accion NOT NULL DEFAULT 'archivar_offline',
  habilitado      boolean NOT NULL DEFAULT true,
  notas_md        text,
  optimistic_v    integer NOT NULL DEFAULT 1,
  created_by      integer NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_retencion_habilitado ON pesv_retencion_politicas(habilitado);
CREATE TRIGGER tr_retencion_updated BEFORE UPDATE ON pesv_retencion_politicas
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- Audit append-only de ejecuciones del cron de retención
CREATE TABLE pesv_retencion_log (
  id              bigserial PRIMARY KEY,
  politica_id     integer REFERENCES pesv_retencion_politicas(id) ON DELETE SET NULL,
  tipo_documento  varchar(60) NOT NULL,
  cantidad_afectada integer NOT NULL DEFAULT 0,
  cutoff_date     date NOT NULL,                  -- registros anteriores a esta fecha quedaron afectados
  accion          pesv_retencion_accion NOT NULL,
  ejecutado_at    timestamptz NOT NULL DEFAULT now(),
  ejecutado_por_cron boolean NOT NULL DEFAULT true,
  ejecutado_por_user integer REFERENCES users(id),
  detalle_md      text                            -- resumen humano: rangos, errores, etc.
);
CREATE INDEX idx_retencion_log_fecha ON pesv_retencion_log(ejecutado_at DESC);
CREATE INDEX idx_retencion_log_tipo ON pesv_retencion_log(tipo_documento, ejecutado_at DESC);

CREATE OR REPLACE FUNCTION tg_retencion_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'pesv_retencion_log es append-only (audit)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pesv_retencion_log no admite DELETE (audit)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_retencion_log_append BEFORE UPDATE OR DELETE ON pesv_retencion_log
  FOR EACH ROW EXECUTE FUNCTION tg_retencion_log_append_only();

-- ============================================================================
-- 4. Page grants — agrega slugs a users.allowed_pages para roles relevantes
--    (sistema usa array text[] en users, no tablas pages/role_pages)
-- ============================================================================
WITH new_slugs AS (
  SELECT unnest(ARRAY['pesv_raci','pesv_normativa','pesv_retencion']) AS slug
)
UPDATE users u
   SET allowed_pages = (
     SELECT ARRAY(
       SELECT DISTINCT s
       FROM unnest(COALESCE(u.allowed_pages, '{}'::text[]) ||
                   ARRAY(SELECT slug FROM new_slugs)) AS s
     )
   )
 WHERE u.role IN ('admin', 'lider_pesv', 'compliance');

-- Permisos sobre tablas nuevas
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pesv_raci, pesv_normativa, pesv_normativa_revisiones,
  pesv_retencion_politicas, pesv_retencion_log
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  pesv_raci_id_seq, pesv_normativa_id_seq, pesv_normativa_revisiones_id_seq,
  pesv_retencion_politicas_id_seq, pesv_retencion_log_id_seq
  TO operaciones_app;

-- ============================================================================
-- 5. Seed inicial de normativa esencial (idempotente por codigo UNIQUE)
-- ============================================================================
INSERT INTO pesv_normativa (codigo, tipo, titulo, emisor, fecha_publicacion, aplica_a, url_oficial, proxima_revision_at, created_by, resumen_md)
SELECT * FROM (VALUES
  ('RES-40595-2022', 'resolucion'::pesv_normativa_tipo,
   'Resolución 40595 de 2022 — PESV ajuste 24 pasos PHVA',
   'MinTransporte', '2022-04-21'::date,
   ARRAY['pesv','flota','incidentes','jornadas']::text[],
   'https://www.mintransporte.gov.co/loader.php?lServicio=Tools2&lTipo=descargas&lFuncion=descargar&idFile=33077',
   (now() + interval '6 months')::timestamptz,
   1::integer,
   'PESV reformado a 24 pasos PHVA. Aplica a empresas con flota propia o terceros >= 10 vehículos.'),
  ('LEY-1581-2012', 'ley'::pesv_normativa_tipo,
   'Ley 1581 de 2012 — Habeas data',
   'Congreso de la República', '2012-10-17'::date,
   ARRAY['pesv','laft','flota']::text[],
   'http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html',
   (now() + interval '12 months')::timestamptz,
   1::integer,
   'Régimen general de protección de datos personales. Multa hasta 2000 SMMLV. Art 17: registro accesos.'),
  ('DEC-1079-2015', 'decreto'::pesv_normativa_tipo,
   'Decreto 1079 de 2015 — Único reglamentario sector transporte',
   'MinTransporte', '2015-05-26'::date,
   ARRAY['flota','jornadas','rutas','rndc']::text[],
   'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=77889',
   (now() + interval '12 months')::timestamptz,
   1::integer,
   'Compila reglamentación sector transporte. Art 2.2.1.7.1.10: jornada conductor servicio público.'),
  ('RES-12379-2012', 'resolucion'::pesv_normativa_tipo,
   'Resolución 12379 de 2012 — Tiempos de conducción y descanso',
   'MinTransporte', '2012-12-28'::date,
   ARRAY['jornadas','flota']::text[],
   'https://www.mintransporte.gov.co/loader.php?lServicio=Tools2&lTipo=descargas&lFuncion=descargar&idFile=2967',
   (now() + interval '12 months')::timestamptz,
   1::integer,
   '4h continuas máximo, pausa 30min cada 4h, jornada 10h/día, 60h/semana, descanso mínimo 8h.'),
  ('LEY-594-2000', 'ley'::pesv_normativa_tipo,
   'Ley 594 de 2000 — Ley General de Archivos',
   'Congreso de la República', '2000-07-14'::date,
   ARRAY['pesv','flota','laft','rndc']::text[],
   'http://www.secretariasenado.gov.co/senado/basedoc/ley_0594_2000.html',
   (now() + interval '24 months')::timestamptz,
   1::integer,
   'Establece tablas de retención documental (TRD). Base legal de las políticas de retención.')
) AS s(codigo, tipo, titulo, emisor, fecha_publicacion, aplica_a, url_oficial, proxima_revision_at, created_by, resumen_md)
WHERE EXISTS (SELECT 1 FROM users WHERE id = 1)  -- solo seed si admin (id=1) existe
ON CONFLICT (codigo) DO NOTHING;

-- Seed inicial de políticas de retención (idempotente por tipo_documento UNIQUE)
INSERT INTO pesv_retencion_politicas (tipo_documento, retencion_anios, base_legal, accion, notas_md, created_by)
SELECT * FROM (VALUES
  ('incidente_vial',  10, 'Res 40595/2022 + Ley 594/2000', 'archivar_offline'::pesv_retencion_accion, 'Conservar 10 años post-cierre. Soporte ante demandas civiles.', 1),
  ('manifiesto',      5,  'Decreto 1079/2015',             'archivar_offline'::pesv_retencion_accion, '5 años desde fecha de origen. Auditoría RNDC/MinTransporte.', 1),
  ('alcohol_test',    5,  'Res 1565/2014 + Res 40595',     'anonimizar'::pesv_retencion_accion,        'Conservar resultado agregado, anonimizar conductor a los 5 años.', 1),
  ('checklist',       3,  'Res 40595/2022',                'purgar'::pesv_retencion_accion,            'Preoperacional sin evento: 3 años.', 1),
  ('acta_comite',     20, 'Ley 594/2000',                  'archivar_offline'::pesv_retencion_accion, 'Documento histórico de la organización. WORM ya cubre integridad.', 1),
  ('pii_access_log',  6,  'Ley 1581 art 17',               'anonimizar'::pesv_retencion_accion,        'Anonimizar user_id, mantener métricas agregadas.', 1),
  ('audit_log',       6,  'ISO 27001 A.12.4',              'archivar_offline'::pesv_retencion_accion, 'Auditoría de eventos de seguridad.', 1)
) AS s(tipo_documento, retencion_anios, base_legal, accion, notas_md, created_by)
WHERE EXISTS (SELECT 1 FROM users WHERE id = 1)
ON CONFLICT (tipo_documento) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verificaciones post-deploy:
--   SELECT count(*) FROM pesv_raci;
--   SELECT codigo, proxima_revision_at FROM pesv_normativa ORDER BY proxima_revision_at;
--   SELECT tipo_documento, retencion_anios, accion FROM pesv_retencion_politicas;
-- ============================================================================
