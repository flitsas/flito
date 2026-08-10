-- 0135_siigo_facturacion.sql
-- Feature #11242 — Emisión de factura electrónica. HU #11323.
-- Autor: equipo FLITO. Motivo: el modelo de datos del lote, la factura y los trámites que cubre.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- LO QUE ESTE ARCHIVO IMPIDE
-- ============================================================================
--
-- Una factura electrónica aceptada por la DIAN **no se puede deshacer**. Emitir dos por el mismo
-- trámite no es un duplicado en una tabla: son dos documentos ante la autoridad tributaria, y
-- corregirlo exige una nota crédito que hoy ni siquiera sabemos cómo se hace (pregunta 8 abierta).
--
-- Por eso aquí la unicidad **la impone la base de datos, nunca el código**. Tres cierres, cada uno
-- tapando la misma carrera a una altura distinta:
--
--   1. `idx_siigo_lotes_natural` — el lote se identifica por LO QUE CONTIENE. Con un id aleatorio,
--      dos encolados del mismo trámite producirían dos lotes, dos claves de idempotencia distintas
--      y **dos facturas DIAN reales**. Es la carrera un nivel más arriba de donde la ve el UNIQUE
--      sobre `idempotency_key`, y es la que el texto original del Feature no cubría.
--   2. `idx_siigo_facturas_idem` — la clave de idempotencia, única DENTRO de su ambiente.
--   3. `idx_siigo_factura_tramites_vivo` — el mismo cierre desde el lado del trámite: no puede
--      estar en dos facturas vivas a la vez.
--
-- Y una advertencia sobre el alcance del punto 2: **el UNIQUE es por ambiente, no global**. Global
-- parece más seguro y es justo lo contrario: `pruebas` y `produccion` son empresas distintas de
-- Siigo, así que un lote ensayado en pruebas dejaría su clave ocupada y **la emisión real del mismo
-- lote fallaría para siempre**, sin que nadie entendiera por qué.

-- ── El lote ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siigo_lotes_facturacion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ambiente      varchar(12) NOT NULL,
  -- Un solo valor admitido hoy. Habilitar la consolidación exige una migración, y con ella una
  -- decisión explícita de negocio (D-1, diferida). Mismo patrón que `estrategia_numeracion`.
  estrategia    varchar(30) NOT NULL DEFAULT 'por_tramite',
  -- Huella del conjunto ORDENADO de trámites: sha256 en hexadecimal. Es lo que hace determinista
  -- la identidad del lote. Se calcula sobre los ids ordenados para que el orden de selección en la
  -- pantalla no produzca lotes distintos con el mismo contenido.
  huella        varchar(64) NOT NULL,
  creado_por    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siigo_lotes_ambiente_chk   CHECK (ambiente IN ('pruebas', 'produccion')),
  CONSTRAINT siigo_lotes_estrategia_chk CHECK (estrategia IN ('por_tramite'))
);

-- AC1 — reencolar el mismo conjunto devuelve el lote que ya existía. Lo garantiza el índice, no
-- una comprobación del código: entre el SELECT y el INSERT cabe otra petición.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_lotes_natural
    ON siigo_lotes_facturacion (ambiente, estrategia, huella);

COMMENT ON TABLE siigo_lotes_facturacion IS
  'Conjunto de trámites que se factura junto. Identidad determinista por contenido: reencolar lo mismo NO crea un lote nuevo.';
COMMENT ON COLUMN siigo_lotes_facturacion.estrategia IS
  'Solo por_tramite (D-1 diferida). Consolidar exige migración, es decir, una decisión.';
COMMENT ON COLUMN siigo_lotes_facturacion.huella IS
  'sha256 hex de los ids de trámite ORDENADOS. El orden de selección no puede cambiar la identidad del lote.';

-- ── La factura ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siigo_facturas (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id            uuid NOT NULL REFERENCES siigo_lotes_facturacion(id) ON DELETE RESTRICT,
  ambiente           varchar(12) NOT NULL,
  -- El NIT desde el que se emitió. Hoy hay una sola empresa emisora (pregunta 9 abierta), pero
  -- registrarlo en cada factura es gratis ahora e imposible de reconstruir después.
  empresa_emisora_nit varchar(20),

  idempotency_key    varchar(30) NOT NULL,

  -- Lo que devuelve Siigo. Todo nulo hasta que la emisión responde.
  siigo_invoice_id   varchar(60),
  numero             varchar(60),
  comprobante_nombre varchar(120),
  cufe               varchar(200),
  public_url         text,
  total_siigo        numeric(14, 2),

  estado             varchar(20) NOT NULL DEFAULT 'en_proceso',
  -- Desde cuándo está en proceso. Es el reloj del arrendamiento: sin esta columna, una fila que se
  -- quedó a medias por un worker caído bloquea su clave para siempre y nadie puede distinguirla de
  -- una emisión que va en camino.
  en_proceso_desde   timestamptz,
  intentos           integer NOT NULL DEFAULT 0,
  error_code         varchar(80),
  error_detalle      text,
  enviada_en         timestamptz,

  -- Marca APARTE del estado (AC5). Una factura emitida cuyo total no cuadra con la liquidación
  -- sigue estando emitida —el documento existe ante la DIAN— y además necesita que alguien la mire.
  -- Meter 'revisar' como estado habría hecho perder esa primera mitad.
  requiere_revision  boolean NOT NULL DEFAULT false,
  revision_motivo    text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_facturas_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion')),
  CONSTRAINT siigo_facturas_estado_chk   CHECK (estado IN ('en_proceso', 'emitida', 'fallida')),
  -- El contrato de Siigo: alfanumérico, ≤30, sin espacios ni especiales. `siigo.client.ts` ya lo
  -- rechaza antes de salir a la red; aquí se impide siquiera guardarlo, porque una clave inválida
  -- guardada es una emisión que fallará para siempre sin que se vea el motivo.
  CONSTRAINT siigo_facturas_idem_formato_chk CHECK (idempotency_key ~ '^[A-Za-z0-9]{1,30}$'),
  -- Una fila en proceso sin reloj no se puede detectar como huérfana.
  CONSTRAINT siigo_facturas_en_proceso_chk
    CHECK (estado <> 'en_proceso' OR en_proceso_desde IS NOT NULL),
  -- Emitida significa que Siigo la aceptó: sin su identificador no hay nada que reconciliar.
  CONSTRAINT siigo_facturas_emitida_chk
    CHECK (estado <> 'emitida' OR siigo_invoice_id IS NOT NULL)
);

-- AC3 — única DENTRO del ambiente. Ver la advertencia del encabezado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_facturas_idem
    ON siigo_facturas (ambiente, idempotency_key);

-- El barrido de huérfanas: «en proceso desde hace más de N minutos».
CREATE INDEX IF NOT EXISTS idx_siigo_facturas_en_proceso
    ON siigo_facturas (en_proceso_desde) WHERE estado = 'en_proceso';

-- La bandeja de fallidos y la de revisión.
CREATE INDEX IF NOT EXISTS idx_siigo_facturas_estado
    ON siigo_facturas (ambiente, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_siigo_facturas_revision
    ON siigo_facturas (ambiente, created_at DESC) WHERE requiere_revision;

COMMENT ON COLUMN siigo_facturas.idempotency_key IS
  'Clave estable derivada del lote, NUNCA aleatoria ni el id crudo: el contrato exige alfanumérico <=30.';
COMMENT ON COLUMN siigo_facturas.en_proceso_desde IS
  'Reloj del arrendamiento. Pasados arrendamiento_en_proceso_min se considera huérfana y se reconcilia.';
COMMENT ON COLUMN siigo_facturas.requiere_revision IS
  'Marca aparte del estado: una factura emitida con total discrepante SIGUE emitida ante la DIAN.';

-- ── Los trámites que cubre la factura ───────────────────────────────────────
--
-- N:1 desde el primer día aunque hoy siempre tenga una sola fila (AC2). Es lo que permitirá
-- habilitar la facturación consolidada sin migrar la tabla principal.

CREATE TABLE IF NOT EXISTS siigo_factura_tramites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factura_id     uuid NOT NULL REFERENCES siigo_facturas(id) ON DELETE CASCADE,
  tramite_id     uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE RESTRICT,
  -- La liquidación sellada de la que salieron los valores. Se guarda para poder explicar una
  -- factura vieja aunque la liquidación cambie después.
  liquidacion_id uuid REFERENCES flito_liquidaciones(id) ON DELETE SET NULL,
  -- Espejo de «su factura no está fallida». Ver el bloque de abajo: existe porque el predicado de
  -- un índice parcial NO admite subconsultas.
  activo         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_siigo_factura_tramites_factura
    ON siigo_factura_tramites (factura_id);

-- AC4 — un trámite no puede estar en dos facturas VIVAS.
--
-- **Por qué hay una columna espejo y un disparador en vez de un índice sobre el estado de la
-- factura.** Lo natural sería `WHERE factura_id IN (SELECT id FROM siigo_facturas WHERE estado <>
-- 'fallida')`, y PostgreSQL lo rechaza: el predicado de un índice parcial solo puede referirse a
-- columnas de la propia tabla y tiene que ser inmutable. La alternativa —comprobarlo en el
-- servicio— no sirve aquí: entre el SELECT y el INSERT caben dos peticiones concurrentes, y el
-- resultado de esa carrera son dos facturas DIAN reales sobre el mismo trámite.
--
-- Así que el estado se refleja en la fila puente y el índice se apoya en ese reflejo. El disparador
-- mantiene el espejo; el índice hace de la unicidad una garantía de la base, no una intención.
--
-- Parcial a propósito: una factura `fallida` **no** ocupa el trámite, porque el reintento legítimo
-- tiene que poder volver a facturarlo. Sin ese matiz, un solo intento fallido dejaría un trámite
-- sin poder facturarse nunca más.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_factura_tramites_vivo
    ON siigo_factura_tramites (tramite_id) WHERE activo;

CREATE OR REPLACE FUNCTION siigo_sync_factura_tramite_activo() RETURNS trigger AS $$
BEGIN
  -- Una factura fallida libera sus trámites; cualquier otro estado los ocupa.
  UPDATE siigo_factura_tramites
     SET activo = (NEW.estado <> 'fallida')
   WHERE factura_id = NEW.id
     AND activo <> (NEW.estado <> 'fallida');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_siigo_factura_tramite_activo ON siigo_facturas;
CREATE TRIGGER trg_siigo_factura_tramite_activo
  AFTER UPDATE OF estado ON siigo_facturas
  FOR EACH ROW
  WHEN (OLD.estado IS DISTINCT FROM NEW.estado)
  EXECUTE FUNCTION siigo_sync_factura_tramite_activo();

COMMENT ON COLUMN siigo_factura_tramites.activo IS
  'Espejo de «su factura no esta fallida», mantenido por trigger. Existe porque el predicado de un indice parcial no admite subconsultas.';

COMMENT ON TABLE siigo_factura_tramites IS
  'Puente N:1 desde el día uno: hoy una fila por factura, preparado para consolidar sin migrar siigo_facturas.';

-- ── Las preguntas abiertas, como configuración y no como supuesto (AC6) ─────
--
-- Ninguno de estos cuatro valores está decidido. Viven en la configuración de emisión —que ya es
-- por ambiente e historiada— para que responderlos sea un UPDATE y no tocar código. Cada uno lleva
-- escrita la pregunta que lo gobierna, para que dentro de un año se sepa que era una incógnita y
-- no una decisión.

ALTER TABLE siigo_config_emision
  ADD COLUMN IF NOT EXISTS retenciones_estrategia varchar(30) NOT NULL DEFAULT 'ninguna';
ALTER TABLE siigo_config_emision
  ADD COLUMN IF NOT EXISTS moneda varchar(3) NOT NULL DEFAULT 'COP';
ALTER TABLE siigo_config_emision
  ADD COLUMN IF NOT EXISTS historico_desde date NOT NULL DEFAULT current_date;
ALTER TABLE siigo_config_emision
  ADD COLUMN IF NOT EXISTS arrendamiento_en_proceso_min integer NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siigo_config_retenciones_chk') THEN
    ALTER TABLE siigo_config_emision ADD CONSTRAINT siigo_config_retenciones_chk
      CHECK (retenciones_estrategia IN ('ninguna'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siigo_config_moneda_chk') THEN
    ALTER TABLE siigo_config_emision ADD CONSTRAINT siigo_config_moneda_chk
      CHECK (moneda IN ('COP'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'siigo_config_arrendamiento_chk') THEN
    ALTER TABLE siigo_config_emision ADD CONSTRAINT siigo_config_arrendamiento_chk
      CHECK (arrendamiento_en_proceso_min BETWEEN 1 AND 1440);
  END IF;
END $$;

COMMENT ON COLUMN siigo_config_emision.retenciones_estrategia IS
  'PREGUNTA ABIERTA 7: no se sabe si aplican ReteICA/ReteIVA/autorretencion. Un solo valor admitido; ampliarlo exige migración.';
COMMENT ON COLUMN siigo_config_emision.moneda IS
  'PREGUNTA ABIERTA 15: se asume COP. Un solo valor admitido.';
COMMENT ON COLUMN siigo_config_emision.historico_desde IS
  'PREGUNTA ABIERTA 13: que se facture el historico ya marcado como facturado no esta decidido. Por defecto el dia de instalacion, que es la respuesta conservadora; ampliarlo es un UPDATE.';
COMMENT ON COLUMN siigo_config_emision.arrendamiento_en_proceso_min IS
  'Minutos tras los cuales una factura en_proceso se considera huerfana y entra a reconciliacion.';
