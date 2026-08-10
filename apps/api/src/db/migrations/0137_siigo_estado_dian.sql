-- 0137_siigo_estado_dian.sql
-- Feature #11243 — Seguimiento del documento ante la DIAN. HU #11330.
-- Autor: equipo FLITO. Motivo: el estado ante la autoridad tributaria y su historial.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ ESTA TABLA EXISTE EN VEZ DE UNA COLUMNA
-- ============================================================================
--
-- Lo barato habría sido añadir `estado_dian` a `siigo_facturas`. Dos razones para no hacerlo, y
-- ninguna es de gusto:
--
--   1. **Son dos ejes distintos.** El `estado` de `siigo_facturas` (`en_proceso | emitida |
--      fallida`) responde «¿consiguió FLITO emitirla?» y pertenece a la Feature #11242. Este
--      responde «¿qué dice la DIAN del documento que ya existe?». Metidos en el mismo campo, una
--      factura `anulada` dejaría de constar como `emitida` — y el documento existe ante la
--      autoridad y existirá siempre. Anular no deshace: añade un hecho encima.
--   2. **Ninguna HU de las Features #11243 y #11244 agrega columnas a `siigo_facturas`.** Todo son
--      tablas nuevas con clave foránea HACIA ella. Eso es lo que permite que la Feature #11242
--      evolucione su fila sin arrastrar a estas dos. Aquí se respeta al pie de la letra: este
--      archivo no lleva un solo `ALTER TABLE siigo_facturas`.
--
-- Y la razón por la que es un HISTORIAL y no un campo: «¿cuándo pasó a rechazada y por qué?» es la
-- pregunta que se hace cuando algo va mal, y un campo sobrescrito no la puede responder. El estado
-- vigente es la última fila.
--
-- ============================================================================
-- QUÉ SE PUEDE CAMBIAR DE UNA FILA YA ESCRITA: SOLO `verificado_en`
-- ============================================================================
--
-- La tabla es append-only, pero no del todo WORM como `siigo_operaciones`. Hay exactamente una
-- excepción, y está reglada por disparador: `verificado_en` puede avanzar.
--
-- El motivo es que confirmar que una factura sigue aceptada NO es un hecho nuevo del documento —es
-- una observación nuestra— y si cada sondeo escribiera una fila, un mes de consultas cada quince
-- minutos dejaría ~2900 filas idénticas por factura y el historial dejaría de ser legible justo
-- para la pregunta que existe para responder. Así que el hecho (`estado`, `cufe`, `motivo`,
-- `fuente`, `payload`, `created_at`) es inmutable y la observación (`verificado_en`) avanza.
--
-- El disparador comprueba las dos mitades: que ninguna columna del hecho cambie, y que
-- `verificado_en` no retroceda. Un dato que llega tarde y desordenado —el caso natural cuando
-- conviven un webhook y un sondeo— no puede hacer parecer más vieja una verificación reciente.

-- ── El historial ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siigo_factura_estados_dian (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factura_id    uuid NOT NULL REFERENCES siigo_facturas(id) ON DELETE CASCADE,

  -- Orden total de la bitácora. NO sobra teniendo `created_at`: el `now()` de PostgreSQL es la hora
  -- de INICIO DE LA TRANSACCIÓN, así que dos filas escritas en la misma transacción comparten
  -- instante al microsegundo. Con `id` uuid aleatorio, el desempate sería aleatorio también, y «el
  -- estado vigente es la última fila» se volvería una lotería exactamente en el momento en que
  -- importa. Por eso «la última» se decide por `secuencia` y nunca por fecha.
  secuencia     bigserial NOT NULL,

  estado        varchar(20) NOT NULL,
  -- El CUFE observado. Se repite en cada fila a propósito: sirve para probar que el documento del
  -- que habla esta fila es el mismo del que hablaba la anterior.
  cufe          varchar(200),
  -- Por qué. Es el campo que da sentido a `rechazada`; sin él, el historial dice que algo falló y
  -- no dice qué.
  motivo        text,
  fuente        varchar(12) NOT NULL,
  -- La respuesta cruda que sostuvo el registro, ya saneada por la capa de aplicación. Es lo que
  -- permite reconstruir una decisión cuando el mapeo a nuestro catálogo resulte estar mal.
  payload       jsonb,
  registrado_por integer REFERENCES users(id) ON DELETE RESTRICT,

  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Cuándo se confirmó por última vez que el estado seguía siendo este. La única columna mutable.
  verificado_en timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_estado_dian_estado_chk
    CHECK (estado IN ('en_validacion', 'aceptada', 'rechazada', 'anulada')),
  CONSTRAINT siigo_estado_dian_fuente_chk
    CHECK (fuente IN ('emision', 'sondeo', 'webhook', 'manual')),
  -- Una verificación anterior a la propia creación de la fila es un reloj mal puesto, no un dato.
  CONSTRAINT siigo_estado_dian_verificado_chk
    CHECK (verificado_en >= created_at)
);

-- «¿Cuál es el estado vigente?» y «¿cuál es el historial completo de esta factura?» son la misma
-- consulta con distinto LIMIT, y las dos se resuelven aquí sin tocar la tabla entera.
--
-- UNIQUE y no un índice normal: la secuencia viene de un `bigserial`, que se puede sobrescribir en
-- un INSERT manual o reiniciar con `setval`. Si dos filas de la misma factura compartieran número,
-- «la última» volvería a ser ambigua, que es justo lo que esta columna existe para impedir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_estado_dian_secuencia
    ON siigo_factura_estados_dian (factura_id, secuencia DESC);

-- El índice por factura y fecha que pide la HU: sirve a los informes por rango, que preguntan por
-- fecha y no por número de secuencia.
CREATE INDEX IF NOT EXISTS idx_siigo_estado_dian_factura_fecha
    ON siigo_factura_estados_dian (factura_id, created_at DESC);

-- «Dame las que la DIAN todavía no ha resuelto» — el sondeo de la HU siguiente. Parcial: las
-- aceptadas y anuladas son la inmensa mayoría de la tabla y no hay nada que volver a preguntar.
CREATE INDEX IF NOT EXISTS idx_siigo_estado_dian_pendientes
    ON siigo_factura_estados_dian (verificado_en)
    WHERE estado = 'en_validacion';

COMMENT ON TABLE siigo_factura_estados_dian IS
  'Historial append-only del estado ante la DIAN. Eje APARTE del estado de emision de siigo_facturas (HU #11330).';
COMMENT ON COLUMN siigo_factura_estados_dian.secuencia IS
  'Orden total. created_at NO sirve para desempatar: now() es la hora de inicio de la transaccion.';
COMMENT ON COLUMN siigo_factura_estados_dian.fuente IS
  'emision | sondeo | webhook | manual. webhook existe aunque el grupo Webhooks de Siigo siga sin revisar.';
COMMENT ON COLUMN siigo_factura_estados_dian.verificado_en IS
  'Unica columna mutable, y solo hacia adelante: confirmar que sigue aceptada no es un hecho nuevo del documento.';
COMMENT ON COLUMN siigo_factura_estados_dian.payload IS
  'Respuesta cruda ya saneada: nunca contiene access_key ni cabecera de autorizacion.';

-- ── Append-only, con la única excepción reglada ─────────────────────────────
--
-- Se hace con disparadores y no «teniendo cuidado en el servicio» por la misma razón que en la
-- 0135: entre la intención y el `UPDATE` de otra persona no hay nada que la haga cumplir. Un
-- historial que se puede reescribir no prueba nada, y este en concreto es la respuesta a una
-- pregunta de la DIAN.

CREATE OR REPLACE FUNCTION fn_siigo_estado_dian_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'siigo_factura_estados_dian es append-only: DELETE no permitido'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: solo `verificado_en`, y solo hacia adelante.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.factura_id IS DISTINCT FROM OLD.factura_id
     OR NEW.secuencia IS DISTINCT FROM OLD.secuencia
     OR NEW.estado IS DISTINCT FROM OLD.estado
     OR NEW.cufe IS DISTINCT FROM OLD.cufe
     OR NEW.motivo IS DISTINCT FROM OLD.motivo
     OR NEW.fuente IS DISTINCT FROM OLD.fuente
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'siigo_factura_estados_dian es append-only: solo verificado_en puede cambiar'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.verificado_en < OLD.verificado_en THEN
    RAISE EXCEPTION 'verificado_en no puede retroceder (% -> %)', OLD.verificado_en, NEW.verificado_en
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_siigo_estado_dian_no_delete ON siigo_factura_estados_dian;
CREATE TRIGGER trg_siigo_estado_dian_no_delete BEFORE DELETE ON siigo_factura_estados_dian
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_estado_dian_append_only();

DROP TRIGGER IF EXISTS trg_siigo_estado_dian_solo_verificado ON siigo_factura_estados_dian;
CREATE TRIGGER trg_siigo_estado_dian_solo_verificado BEFORE UPDATE ON siigo_factura_estados_dian
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_estado_dian_append_only();

-- Endurecimiento por ownership, igual que en 0126_siigo_operaciones_worm.sql. El guard es por
-- docker-compose: allí POSTGRES_USER es `operaciones_app` y no existe ningún rol `postgres`, así
-- que sin guard la cadena moría con `role "postgres" does not exist`. Los disparadores de arriba sí
-- se crean siempre; lo condicional es solo el endurecimiento.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER TABLE siigo_factura_estados_dian OWNER TO postgres;
    ALTER FUNCTION fn_siigo_estado_dian_append_only() OWNER TO postgres;
  END IF;
END $$;

-- UPDATE se concede porque `verificado_en` tiene que poder avanzar; el disparador es quien impide
-- que ese permiso sirva para reescribir un hecho. DELETE y TRUNCATE no se conceden nunca.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON siigo_factura_estados_dian TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE siigo_factura_estados_dian_secuencia_seq TO operaciones_app;
  END IF;
END $$;
