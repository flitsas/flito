-- 0157_flito_conciliacion_boletas.sql
-- Feature #11623 — Conciliación de boletas SOAT con bolsas. HU #11673 (esquema, póliza y origen).
-- Autor: equipo FLITO. Motivo: el descuento de bolsa deja de ocurrir SOLO al sellar la liquidación.
-- Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada no cambia NI UNA FILA.
--
-- Ningún comentario de este archivo escribe el par de dólares que abre un bloque: el guarda de
-- ADR-DB-001 (`scanForTxControl`) tapa los bloques citados con dólares ANTES de quitar los
-- comentarios, así que un par suelto dentro de un `--` emparejaría con el que abre el bloque de
-- GRANTs del final, dejaría su BEGIN a la intemperie y abortaría el `db:apply` con exit 2 por una
-- migración que está bien. Lección de la 0156.
--
-- ============================================================================
-- QUÉ TRAE Y POR QUÉ, EN UNA FRASE CADA COSA
-- ============================================================================
--
--   1. `flito_conciliacion_boletas` — un pago hecho en el portal externo, con su Excel y su total.
--   2. `flito_conciliacion_lineas`  — una fila de ese Excel, con el SOAT que le encontró el cruce.
--   3. `flito_soportes.conciliacion_boleta_id` — dónde cuelga el comprobante PSE (CF-06).
--   4. `flito_soat.numero_poliza`   — la llave del cruce, hoy sepultada en un jsonb del OCR.
--   5. El origen 'conciliacion' en los DOS libros de bolsa. Es lo que no se ve en `schema.ts`.
--
-- El punto 5 es el caro: `origen` lleva un CHECK en la base que el esquema de Drizzle NO declara,
-- así que leer solo `schema.ts` lleva a concluir que añadir un valor no necesita migración. La
-- necesita, y sin ella el primer INSERT de una conciliación muere con 23514 DENTRO de la
-- transacción que mueve el dinero.

-- ── 1. Referencia legible de la boleta ───────────────────────────────────────
-- Una secuencia y no un contador por año: 'BOL-000123' tiene que ser irrepetible para siempre,
-- porque va escrito en la observación de un movimiento de bolsa que nadie va a poder editar.
CREATE SEQUENCE IF NOT EXISTS flito_conciliacion_boleta_seq;

-- ── 2. Boletas ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_conciliacion_boletas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referencia             varchar(20) NOT NULL UNIQUE
                           DEFAULT ('BOL-' || lpad(nextval('flito_conciliacion_boleta_seq')::text, 6, '0')),
  compania_id            integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  concepto               varchar(20) NOT NULL DEFAULT 'soat',
  estado                 varchar(20) NOT NULL DEFAULT 'cargada',
  archivo_nombre         varchar(300) NOT NULL,
  archivo_hash           varchar(64)  NOT NULL,
  filas                  integer NOT NULL,
  total_declarado        numeric(14,2) NOT NULL,
  total_cruzado          numeric(14,2),
  fecha_pago             date NOT NULL,
  -- RESTRICT explícito (ADR-0005): quién cargó y quién concilió son la prueba de un acto que movió
  -- dinero. `SET NULL` dejaría boletas que dicen «esto lo concilió nadie».
  cargada_por_id         integer REFERENCES users(id) ON DELETE RESTRICT,
  cargada_por_nombre     varchar(150) NOT NULL,
  conciliada_en          timestamptz,
  conciliada_por_id      integer REFERENCES users(id) ON DELETE RESTRICT,
  conciliada_por_nombre  varchar(150),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_concil_boleta_concepto_chk CHECK (concepto IN ('soat')),
  CONSTRAINT flito_concil_boleta_estado_chk   CHECK (estado IN ('cargada','conciliada','descartada')),
  CONSTRAINT flito_concil_boleta_filas_chk    CHECK (filas > 0),
  CONSTRAINT flito_concil_boleta_total_chk    CHECK (total_declarado > 0),
  -- El sello de la conciliación es una sola cosa: o están los tres campos o no está ninguno. Mismo
  -- criterio que `flito_comparendos_gestion_auditoria_chk` (0156).
  CONSTRAINT flito_concil_boleta_sello_chk
    CHECK ((conciliada_en IS NULL) = (conciliada_por_id IS NULL)
       AND (conciliada_en IS NULL) = (conciliada_por_nombre IS NULL)),
  -- Y el estado no puede mentir sobre el sello.
  CONSTRAINT flito_concil_boleta_estado_sello_chk
    CHECK (estado <> 'conciliada' OR conciliada_en IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_flito_concil_boleta_compania
  ON flito_conciliacion_boletas (compania_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flito_concil_boleta_estado
  ON flito_conciliacion_boletas (estado);
-- El mismo archivo no se carga dos veces. Parcial sobre `descartada` para que rehacer una boleta
-- mal cargada no exija renombrar el .xlsx.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_concil_boleta_hash
  ON flito_conciliacion_boletas (archivo_hash) WHERE estado <> 'descartada';

-- ── 3. Líneas ────────────────────────────────────────────────────────────────
--
-- NO lleva columna de placa, y no es un olvido: el Excel del portal no la trae. La placa que la
-- pantalla enseña sale del SOAT cruzado, que es la única fuente que puede afirmarla.
CREATE TABLE IF NOT EXISTS flito_conciliacion_lineas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boleta_id              uuid NOT NULL REFERENCES flito_conciliacion_boletas(id) ON DELETE CASCADE,
  fila_numero            integer NOT NULL,
  numero_poliza_norm     varchar(60) NOT NULL,
  valor_declarado        numeric(14,2) NOT NULL,
  -- SET NULL y no RESTRICT: una línea CONCILIADA ya está protegida por el sello de abajo, que exige
  -- `soat_id IS NOT NULL` en cuanto hay `conciliada_en` — borrar un SOAT conciliado falla igual, por
  -- el CHECK en vez de por la FK. Lo que SET NULL permite es solo lo que debe permitirse: borrar un
  -- SOAT que aparece en una línea que nunca movió un peso.
  soat_id                uuid REFERENCES flito_soat(id) ON DELETE SET NULL,
  resultado              varchar(24) NOT NULL,
  detalle                text,
  movimiento_bolsa_id    uuid REFERENCES flito_bolsa_movimientos(id) ON DELETE RESTRICT,
  movimiento_transito_id uuid REFERENCES flito_bolsa_transito_movimientos(id) ON DELETE RESTRICT,
  conciliada_en          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_concil_linea_resultado_chk CHECK (resultado IN
    ('ok','no_encontrada','no_pagado','valor_distinto','poliza_duplicada','otra_compania','ya_conciliada')),
  -- La póliza se guarda YA normalizada. Si algún camino de código escribe el valor crudo, esto lo
  -- convierte en un 23514 inmediato en vez de en una fila que no cruzará nunca con nada.
  CONSTRAINT flito_concil_linea_poliza_norm_chk CHECK (numero_poliza_norm ~ '^[A-Z0-9]{1,60}$'),
  -- Solo una línea que cruzó puede quedar conciliada, y solo una conciliada puede tener movimiento.
  CONSTRAINT flito_concil_linea_sello_chk
    CHECK (conciliada_en IS NULL OR (soat_id IS NOT NULL AND resultado = 'ok')),
  -- LOS DOS movimientos, no solo el del libro del cliente. Con `movimiento_transito_id` fuera del
  -- CHECK, una línea con el asiento de tránsito puesto y `conciliada_en` en NULL era un estado
  -- LEGAL, y ese UPDATE lo puede hacer `operaciones_app` (tiene UPDATE sobre la tabla). Des-sellar
  -- así una línea la saca de `idx_flito_concil_linea_soat_unica` —que es PARCIAL sobre
  -- `conciliada_en IS NOT NULL`— y libera el SOAT para conciliarse otra vez en otra boleta, con su
  -- salida de tránsito ya asentada y sin contramovimiento: doble descuento, que es justo lo que
  -- el CF-04 prohíbe. El CHECK es la única barrera; la FK es RESTRICT, pero RESTRICT protege al
  -- movimiento de que lo borren, no a la línea de que la des-sellen.
  CONSTRAINT flito_concil_linea_mov_chk
    CHECK ((movimiento_bolsa_id IS NULL AND movimiento_transito_id IS NULL)
           OR conciliada_en IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_concil_linea_fila
  ON flito_conciliacion_lineas (boleta_id, fila_numero);
-- Una póliza no se repite DENTRO de una boleta: dos filas con la misma póliza son el mismo pago
-- contado dos veces, y cada una intentaría su propia salida de bolsa por el mismo SOAT. La carga
-- (HU #11676) tiene que detectarlo al leer el Excel y rechazar el archivo con un motivo legible;
-- esto es la red de abajo, para que un descuido no termine en dos descuentos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_concil_linea_poliza
  ON flito_conciliacion_lineas (boleta_id, numero_poliza_norm);
CREATE INDEX IF NOT EXISTS idx_flito_concil_linea_soat
  ON flito_conciliacion_lineas (soat_id) WHERE soat_id IS NOT NULL;
-- UN SOAT SE CONCILIA UNA VEZ. Es la única barrera de la base contra el doble descuento por la vía
-- de dos boletas distintas; la otra (el mismo SOAT, dos veces, entre conciliación y sellado) la pone
-- `idx_flito_bolsa_mov_llave` con la llave `salida:soat:<id>`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_concil_linea_soat_unica
  ON flito_conciliacion_lineas (soat_id) WHERE soat_id IS NOT NULL AND conciliada_en IS NOT NULL;

-- ── 4. El comprobante PSE cuelga de la boleta ────────────────────────────────
-- Quinta FK nullable del mismo patrón que soat_id / impuesto_id / derecho_id / siigo_factura_id.
ALTER TABLE flito_soportes
  ADD COLUMN IF NOT EXISTS conciliacion_boleta_id uuid
  REFERENCES flito_conciliacion_boletas(id) ON DELETE CASCADE;

-- Un solo comprobante VIVO de cada tipo por boleta. Calcado de idx_flito_soportes_factura_tipo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_soportes_boleta_tipo
  ON flito_soportes (conciliacion_boleta_id, tipo)
  WHERE conciliacion_boleta_id IS NOT NULL AND descartado = false;

-- Y el «uno y solo uno» se ensancha a la columna nueva. La 0139 escribió
-- `flito_soportes_factura_excluyente_chk` para su propia FK y no volvió a mirarse: añadir la quinta
-- sin tocarlo dejaba legal un soporte con `conciliacion_boleta_id` Y `siigo_factura_id` a la vez,
-- que contaría como comprobante vivo en los DOS índices parciales y —las dos FK son CASCADE— haría
-- que borrar la factura se llevara por delante el comprobante PSE de una boleta conciliada.
--
-- Se valida al vuelo sin escanear la tabla, por el mismo argumento que escribió la 0139: hoy TODAS
-- las filas tienen `conciliacion_boleta_id` NULL, así que satisfacen el predicado trivialmente, y
-- toda fila que pasaba el CHECK viejo pasa este.
--
-- Las tres FK viejas siguen SIN excluirse entre sí, también como en la 0139: eso es una regla
-- vigente desde mucho antes y cambiarla no es alcance de esta migración.
ALTER TABLE flito_soportes DROP CONSTRAINT IF EXISTS flito_soportes_factura_excluyente_chk;
ALTER TABLE flito_soportes ADD CONSTRAINT flito_soportes_factura_excluyente_chk
  CHECK ((siigo_factura_id IS NULL
          OR (soat_id IS NULL AND impuesto_id IS NULL AND derecho_id IS NULL
              AND conciliacion_boleta_id IS NULL))
     AND (conciliacion_boleta_id IS NULL
          OR (soat_id IS NULL AND impuesto_id IS NULL AND derecho_id IS NULL)));

-- ── 5. El número de póliza, promovido a columna ──────────────────────────────
ALTER TABLE flito_soat ADD COLUMN IF NOT EXISTS numero_poliza varchar(60);

-- BACKFILL. Idempotente por el `numero_poliza IS NULL`: la segunda pasada no toca ninguna fila, y
-- —lo que importa más— una corrección manual posterior de la columna NO se pisa si alguien
-- re-aplica la migración en un ambiente rezagado.
--
-- La normalización es «deja solo A-Z0-9 y pasa a mayúsculas», y tiene que ser BIT A BIT la misma que
-- `normalizarPoliza()` de packages/shared-types. Si divergen, el backfill y el cruce discrepan en
-- silencio y el síntoma es «esta póliza no aparece», sin ningún error en ningún log. El orden
-- —filtrar y DESPUÉS pasar a mayúsculas— es parte de la equivalencia: al revés, JavaScript convierte
-- algunos caracteres que aquí se tiran (ß, ﬁ) en dos letras que se quedarían.
--
-- El guarda de longitud evita dos cosas: un 22001 si el OCR leyó un párrafo entero en vez de un
-- número, y escribir la cadena vacía —que pasaría el CHECK de abajo por los pelos y cruzaría con
-- cualquier otra fila vacía—.
UPDATE flito_soat
   SET numero_poliza = upper(regexp_replace(extraccion->'numeroPoliza'->>'valor', '[^A-Za-z0-9]', '', 'g'))
 WHERE numero_poliza IS NULL
   AND extraccion->'numeroPoliza'->>'valor' IS NOT NULL
   AND length(regexp_replace(extraccion->'numeroPoliza'->>'valor', '[^A-Za-z0-9]', '', 'g')) BETWEEN 1 AND 60;

-- NO ÚNICO, a propósito. Un UNIQUE lo crearía esta misma migración, y dos SOAT con la póliza
-- colisionada —una reexpedición, un 0 leído como O— pararían la cadena de migraciones entera en el
-- despliegue, por un dato viejo y a deshora. El duplicado se resuelve en el cruce, delante de quien
-- puede arreglarlo (resultado 'poliza_duplicada'). Parcial: los SOAT pendientes no tienen póliza.
CREATE INDEX IF NOT EXISTS idx_flito_soat_numero_poliza
  ON flito_soat (numero_poliza) WHERE numero_poliza IS NOT NULL;

-- El FORMATO sí se afirma. Va DESPUÉS del backfill, que es quien lo cumple por construcción.
-- DROP + ADD y no `ADD ... IF NOT EXISTS`, que PostgreSQL no admite para constraints: la pareja es
-- idempotente por composición.
ALTER TABLE flito_soat DROP CONSTRAINT IF EXISTS flito_soat_numero_poliza_norm_chk;
ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_numero_poliza_norm_chk
  CHECK (numero_poliza IS NULL OR numero_poliza ~ '^[A-Z0-9]{1,60}$');

-- ── 6. El origen nuevo, en los DOS libros ────────────────────────────────────
--
-- Esto es lo que `schema.ts` no sabe. Las dos columnas son varchar(20) —no hay enum de PostgreSQL
-- que alterar, y por tanto tampoco el problema de la 0154 con los valores nuevos dentro de la misma
-- transacción— pero las dos llevan un CHECK que enumera los orígenes válidos, escrito en la 0116 y
-- en la 0120.
--
-- Ensanchar un CHECK a un SUPERCONJUNTO no puede fallar sobre las filas que ya están: toda fila que
-- pasaba la lista corta pasa la larga. Lo único que cuesta es el escaneo bajo ACCESS EXCLUSIVE; si
-- el libro crece hasta que eso importe, la salida es partirlo en NOT VALID aquí y VALIDATE en una
-- migración posterior (dos transacciones). Para decidirlo:
--   SELECT count(*) FROM flito_bolsa_movimientos;

ALTER TABLE flito_bolsa_movimientos DROP CONSTRAINT IF EXISTS flito_bolsa_mov_origen_valido;
ALTER TABLE flito_bolsa_movimientos ADD CONSTRAINT flito_bolsa_mov_origen_valido
  CHECK (origen IN ('recarga','automatico','manual','conciliacion'));

-- Ojo con el NOMBRE: la 0124 renombró la tabla (flito_organismo_movimientos →
-- flito_bolsa_transito_movimientos) pero NO esta restricción, que conserva el nombre de la 0120.
ALTER TABLE flito_bolsa_transito_movimientos DROP CONSTRAINT IF EXISTS flito_org_mov_origen_valido;
ALTER TABLE flito_bolsa_transito_movimientos ADD CONSTRAINT flito_org_mov_origen_valido
  CHECK (origen IN ('carga','automatico','conciliacion'));

-- ── 7. Permisos ──────────────────────────────────────────────────────────────
--
-- El guard existe porque en docker-compose el POSTGRES_USER es `operaciones_app` y en otras
-- instalaciones no: sin él la cadena moriría con `role ... does not exist`.
--
-- Sin DELETE sobre las boletas: una boleta conciliada es un documento contable y descartar es un
-- UPDATE de estado. Las LÍNEAS sí lo llevan, porque descartar una boleta todavía 'cargada' borra sus
-- filas — y porque el CASCADE desde la boleta lo necesitaría si algún día se borrara una.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE         ON flito_conciliacion_boletas TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON flito_conciliacion_lineas  TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE flito_conciliacion_boleta_seq TO operaciones_app;
  END IF;
END $$;

-- ── 8. Comentarios ───────────────────────────────────────────────────────────
COMMENT ON COLUMN flito_soat.numero_poliza IS
  'Numero de poliza normalizado (solo A-Z0-9, mayusculas), promovido desde extraccion->numeroPoliza '
  'para poder indexarlo y cruzarlo (Feature #11623). NO sustituye a extraccion, que es la prueba de '
  'lo que leyo el OCR con su confianza. Cuasi-PII: no viaja en path ni en query (AGENTS.md 14).';

COMMENT ON COLUMN flito_conciliacion_lineas.soat_id IS
  'SOAT con el que cruzo la fila. NULL cuando no cruzo. El indice parcial unico sobre esta columna '
  '(WHERE conciliada_en IS NOT NULL) es lo que impide que el mismo SOAT se concilie en dos boletas.';

COMMENT ON CONSTRAINT flito_bolsa_mov_origen_valido ON flito_bolsa_movimientos IS
  'Origenes validos del libro. conciliacion se anadio en la 0157: es lo que deja el movimiento FUERA '
  'del barrido de reversarSalidasLiquidacion, que filtra origen = automatico (CF-07 del #11623). '
  'Anadir un origen aqui NO basta: hay que anadirlo tambien a OrigenMovimientoBolsa en shared-types.';

COMMENT ON CONSTRAINT flito_org_mov_origen_valido ON flito_bolsa_transito_movimientos IS
  'Origenes validos del libro de transito. Conserva el nombre que le dio la 0120, anterior al '
  'rename de la tabla en la 0124. conciliacion se anadio en la 0157, por el mismo motivo que en el '
  'libro del cliente: el consumo conciliado no vuelve cuando el tramite retrocede (CF-07).';
