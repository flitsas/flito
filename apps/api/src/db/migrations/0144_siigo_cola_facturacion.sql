-- 0144_siigo_cola_facturacion.sql
-- Feature #11242 — Emisión de factura electrónica. HU #11327 (cola y trabajador con reintentos).
-- Autor: equipo FLITO. Motivo: que pedir factura no obligue a esperar a Siigo, y que lo que queda
-- por facturar sea una fila que alguien pueda mirar en vez de una promesa dentro de un proceso.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ ESTA TABLA EXISTE — Y POR QUÉ NO ES UNA COLUMNA DE siigo_facturas
-- ============================================================================
--
-- `siigo_facturas` responde «¿qué le pasó al DOCUMENTO?» y por eso **no tiene estado `pendiente`**:
-- su fila nace cuando se reserva la clave de idempotencia, y reservar la clave ya es estar en
-- proceso. Lo que está pendiente no es el documento: es el trámite. Meter aquí un `pendiente` sería
-- crear una factura que todavía no se ha decidido emitir, con su clave ocupada, y esa clave ocupada
-- es justo lo que bloquea el trámite.
--
-- Son dos ejes y cada uno tiene su tabla, igual que ya se hizo con `siigo_factura_estados_dian` (el
-- estado ante la DIAN) y `siigo_factura_correcciones` (lo que se corrigió por fuera).
--
-- ============================================================================
-- LO QUE ESTA TABLA **NO** GARANTIZA
-- ============================================================================
--
-- **La cola no impide la doble factura.** Eso lo impiden, y siguen impidiéndolo, tres cosas que no
-- están aquí: `idx_siigo_facturas_idem` (la clave de idempotencia, una por ambiente),
-- `idx_siigo_factura_tramites_vivo` (un trámite no puede estar en dos facturas vivas) y el
-- `Idempotency-Key` que viaja a Siigo. Si la cola desapareciera mañana, seguirían sin poder salir dos
-- facturas del mismo lote.
--
-- Lo que la cola impide es el **trabajo duplicado**: que dos instancias del servidor gasten cuota de
-- las 100 peticiones por minuto intentando lo mismo para que una de las dos descubra que la clave ya
-- estaba tomada. Y lo impide con el ARRENDAMIENTO, no con una variable en memoria: la exclusión la
-- decide PostgreSQL en la misma sentencia que selecciona y marca (ver `tomarLote`).

-- ── Qué contiene un lote ────────────────────────────────────────────────────
--
-- El lote se identifica por su HUELLA —sha256 del conjunto ordenado de trámites— y esa huella no se
-- puede invertir: sirve para reconocer «esto ya se encoló», no para saber qué hay dentro. Mientras
-- el único que emitía era quien acababa de elegir los trámites, daba igual; el trabajador de esta HU
-- toma una fila con un `lote_id` y **nada más**, así que sin esta tabla no puede saber qué factura.
--
-- La pertenencia se guarda en el LOTE y no en la cola a propósito: la cola no duplica la identidad
-- del conjunto. Una fila de cola dice cuándo toca trabajar; el lote dice sobre qué.

CREATE TABLE IF NOT EXISTS siigo_lote_tramites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE y no RESTRICT: estas filas son parte del lote, no un hecho independiente. Si algún día
  -- se borra un lote sin facturas, su contenido se va con él.
  lote_id    uuid NOT NULL REFERENCES siigo_lotes_facturacion(id) ON DELETE CASCADE,
  -- RESTRICT: un trámite que se encoló para facturar no se puede borrar dejando el lote apuntando
  -- al vacío. Es el mismo criterio de `siigo_factura_tramites`.
  tramite_id uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotencia del alta: `asegurarLote` se llama en cada emisión y en cada encolado del mismo
-- conjunto, y tiene que poder repetirse sin duplicar la pertenencia.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_lote_tramites_par
    ON siigo_lote_tramites (lote_id, tramite_id);
-- «¿En qué lotes está este trámite?» — lo pregunta la consulta de estado de la cola.
CREATE INDEX IF NOT EXISTS idx_siigo_lote_tramites_tramite
    ON siigo_lote_tramites (tramite_id);

-- Los lotes que ya existían (HU #11326) nacieron sin pertenencia. Se reconstruye desde las facturas
-- que salieron de ellos, que es donde estaba escrita hasta hoy. Sin esto, un lote viejo reencolado
-- daría un trabajo sin trámites y acabaría en `fallido_definitivo` sin motivo comprensible.
INSERT INTO siigo_lote_tramites (lote_id, tramite_id)
SELECT DISTINCT f.lote_id, ft.tramite_id
  FROM siigo_facturas f
  JOIN siigo_factura_tramites ft ON ft.factura_id = f.id
ON CONFLICT (lote_id, tramite_id) DO NOTHING;

COMMENT ON TABLE siigo_lote_tramites IS
  'Qué trámites contiene un lote. La huella lo IDENTIFICA pero no se puede invertir: sin esta tabla el trabajador no sabría qué facturar.';

-- ── La cola ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS siigo_cola_facturacion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: la fila de cola es el rastro de que alguien pidió facturar esto. Borrar el lote
  -- dejándola huérfana convertiría ese rastro en un identificador que no lleva a ninguna parte.
  lote_id            uuid NOT NULL REFERENCES siigo_lotes_facturacion(id) ON DELETE RESTRICT,
  -- Denormalizado del lote, y con CHECK. El trabajador selecciona por (ambiente, cita) miles de
  -- veces al día: obligar a un JOIN con el lote en la sentencia que además BLOQUEA filas es
  -- ampliar el alcance del candado a una tabla que no hace falta bloquear. El lote es inmutable
  -- por contenido, así que la copia no puede quedar desalineada.
  ambiente           varchar(12) NOT NULL,

  estado             varchar(24) NOT NULL DEFAULT 'pendiente',

  -- Dos contadores con dos techos. `intentos` cuenta DESENLACES (Siigo contestó y rechazó);
  -- `esperas` cuenta ciclos SIN desenlace (clave tomada, POST sin respuesta, huérfana). Con un solo
  -- contador, un Siigo lento quema los cinco intentos sin que nadie haya rechazado nada y la fila
  -- acaba dada por perdida con el documento posiblemente vivo ante la DIAN.
  intentos           integer NOT NULL DEFAULT 0,
  max_intentos       integer NOT NULL DEFAULT 5,
  esperas            integer NOT NULL DEFAULT 0,
  max_esperas        integer NOT NULL DEFAULT 20,

  -- Cuándo le toca. NOT NULL con DEFAULT now(): una fila sin cita es una fila que no vuelve jamás,
  -- y no vuelve en silencio — nadie recibe un error, simplemente ese trámite deja de facturarse.
  proximo_intento_at timestamptz NOT NULL DEFAULT now(),
  ultimo_intento_at  timestamptz,

  -- El arrendamiento. NO es un quinto estado (los estados son cuatro y no se solapan): es una
  -- propiedad de la fila. Como estado habría que devolverlo a `pendiente` cuando el proceso muere
  -- —y si murió, justamente no queda nadie que lo devuelva—. Al vencer, la fila vuelve a ser
  -- elegible sola, sin que nadie limpie nada.
  tomado_por         varchar(120),
  tomado_en          timestamptz,

  -- La factura que produjo el trabajo. La cola NO la escribe: la lee del resultado de emitir.
  factura_id         uuid REFERENCES siigo_facturas(id) ON DELETE RESTRICT,
  desenlace          varchar(20),
  error_code         varchar(80),
  error_detalle      text,

  encolado_por       integer REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_cola_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion')),
  -- El desenlace también es un catálogo, y en este módulo los catálogos se restringen en la base:
  -- un valor inventado aquí no rompe nada hoy, pero deja una fila que ninguna pantalla sabe pintar
  -- y que nadie descubre hasta que alguien la mira. La lista vive en `SIIGO_COLA_DESENLACES` y una
  -- prueba compara las dos, igual que se hace con los estados.
  CONSTRAINT siigo_cola_desenlace_chk CHECK (
    desenlace IS NULL OR desenlace IN (
      'emitida', 'ya_emitida', 'en_curso', 'huerfana', 'fallida', 'no_elegible', 'error_interno')),
  CONSTRAINT siigo_cola_estado_chk
    CHECK (estado IN ('pendiente', 'enviado', 'error', 'fallido_definitivo')),
  CONSTRAINT siigo_cola_contadores_chk CHECK (intentos >= 0 AND esperas >= 0),
  CONSTRAINT siigo_cola_topes_chk
    CHECK (max_intentos BETWEEN 1 AND 50 AND max_esperas BETWEEN 1 AND 500),
  -- Una fila en error SIEMPRE tiene cita. Hoy la columna es NOT NULL y el CHECK parece redundante:
  -- está escrito para que quitar el NOT NULL —que es lo que hará quien quiera «pausar» una fila—
  -- no abra sin querer la puerta a filas en error que nadie vuelve a mirar.
  CONSTRAINT siigo_cola_cita_chk
    CHECK (estado <> 'error' OR proximo_intento_at IS NOT NULL),
  -- Enviado significa que hay documento. Sin identificador de factura no hay nada que enseñar ni
  -- que reconciliar, y la fila afirmaría un envío que no se puede seguir hasta ninguna parte.
  CONSTRAINT siigo_cola_enviado_chk
    CHECK (estado <> 'enviado' OR factura_id IS NOT NULL),
  -- Un trabajo terminado no puede estar arrendado. Sin esto, una fila `enviado` con arrendamiento
  -- vivo sería invisible para cualquier diagnóstico de «¿qué está procesando quién?».
  CONSTRAINT siigo_cola_arrendamiento_estado_chk
    CHECK (estado IN ('pendiente', 'error') OR tomado_por IS NULL),
  -- Las dos columnas del arrendamiento van juntas o no van. Con solo una, el vencimiento no se
  -- puede calcular y la fila queda tomada para siempre por nadie.
  CONSTRAINT siigo_cola_arrendamiento_chk
    CHECK ((tomado_por IS NULL) = (tomado_en IS NULL))
);

-- AC1 — una fila por lote. Reencolar el mismo conjunto NO crea una segunda fila, y lo garantiza el
-- índice y no el servicio: entre un SELECT y un INSERT cabe otra petición.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_cola_lote
    ON siigo_cola_facturacion (lote_id);

-- La consulta del trabajador, exactamente. Parcial a propósito: lo terminado —`enviado` y
-- `fallido_definitivo`— es la mayor parte de la tabla con el tiempo y no se vuelve a mirar nunca,
-- así que no tiene por qué ocupar el índice por el que se pregunta cada dos minutos.
CREATE INDEX IF NOT EXISTS idx_siigo_cola_lista
    ON siigo_cola_facturacion (ambiente, proximo_intento_at, created_at)
    WHERE estado IN ('pendiente', 'error');

-- La bandeja: «qué hay en cada estado», lo más reciente primero.
CREATE INDEX IF NOT EXISTS idx_siigo_cola_estado
    ON siigo_cola_facturacion (ambiente, estado, created_at DESC);

-- Ir de la factura a la petición que la originó. Parcial: la mayoría de las filas vivas todavía no
-- tienen factura, y las nulas no responden a esta pregunta.
CREATE INDEX IF NOT EXISTS idx_siigo_cola_factura
    ON siigo_cola_facturacion (factura_id)
    WHERE factura_id IS NOT NULL;

COMMENT ON TABLE siigo_cola_facturacion IS
  'Qué queda por facturar y cuándo le toca (HU #11327). Eje APARTE de siigo_facturas, que dice qué le paso al documento. '
  'NO impide la doble factura —eso son la reserva de clave, el indice de tramites vivos y el Idempotency-Key—: impide el TRABAJO duplicado.';
COMMENT ON COLUMN siigo_cola_facturacion.ambiente IS
  'Denormalizado del lote para que la sentencia que selecciona Y BLOQUEA no tenga que ampliar su alcance a otra tabla.';
COMMENT ON COLUMN siigo_cola_facturacion.intentos IS
  'Desenlaces de red: Siigo contesto y rechazo. Son los que gastan el techo.';
COMMENT ON COLUMN siigo_cola_facturacion.esperas IS
  'Ciclos SIN desenlace (clave tomada, POST sin respuesta, huerfana). Techo propio: un Siigo lento no puede dar una factura por perdida.';
COMMENT ON COLUMN siigo_cola_facturacion.proximo_intento_at IS
  'Cuando le toca. NOT NULL: una fila sin cita deja de facturarse en silencio, sin que nadie reciba un error.';
COMMENT ON COLUMN siigo_cola_facturacion.tomado_por IS
  'Arrendamiento, NO un quinto estado. Al vencer la fila vuelve a ser elegible sola: nadie tiene que limpiar tras un proceso caido.';
COMMENT ON COLUMN siigo_cola_facturacion.factura_id IS
  'La factura que produjo el trabajo. La cola la LEE del resultado de emitir; nunca escribe en siigo_facturas.';

-- ── Permisos ────────────────────────────────────────────────────────────────
--
-- SELECT, INSERT y UPDATE. **Sin DELETE**: una fila de cola es el rastro de que alguien pidió
-- facturar algo. Borrarla no arregla nada —el trabajo ya se hizo o ya se dio por perdido— y en
-- cambio hace desaparecer la única prueba de que se pidió. Lo mismo para la pertenencia del lote:
-- borrarla dejaría un lote que ya no sabe qué contiene, con sus facturas ya emitidas.
--
-- El guard existe porque en docker-compose el POSTGRES_USER es `operaciones_app` y en otras
-- instalaciones no: sin él la cadena moriría con `role ... does not exist`.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON siigo_cola_facturacion TO operaciones_app;
    -- Sin UPDATE, y no por simetría: nadie actualiza esta tabla —el único escritor es un
    -- `INSERT ... ON CONFLICT DO NOTHING`— y un UPDATE aquí es precisamente lo que rompería la
    -- correspondencia entre la huella del lote y su contenido, con la factura ya emitida. Mismo
    -- criterio que la 0140.
    GRANT SELECT, INSERT ON siigo_lote_tramites TO operaciones_app;
  END IF;
END $$;
