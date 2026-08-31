-- 0171_flito_soat_organismo_nullable_verificacion.sql
-- Feature #11912 — Solicitud de SOAT sin trámite (canal Cliente). HU #11935 (alta sin RUNT
-- bloqueante y verificación post-commit).
-- Autor: equipo FLITO. Diseño: docs/diseno-hu-11935-alta-sin-runt-bloqueante.md
-- ADR: docs/adr/ADR-0009-flito-soat-runt-no-bloquea-alta.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada no cambia NI UNA FILA.
--
-- ============================================================================
-- QUE TRAE
-- ============================================================================
--
-- 1. `flito_soat.organismo_codigo` deja de ser NOT NULL. El canal Cliente nace sin organismo
--    (el RUNT ya no es compuerta del INSERT). La FK a `organismos_transito_config(codigo)`
--    QUEDA: un codigo que se escriba sigue teniendo que existir. El sync y el tramite no
--    cambian de escritor y siguen mandando codigo.
--
-- 2. Cuatro columnas derivadas en el satelite `flito_soat_solicitud` (NO jsonb crudo del RUNT,
--    ADR-0008 §1.6 se conserva en eso): estado de la verificacion, vigencia, fecha y codigo
--    maquina. CHECK sobre `verificacion_estado`.
--
-- 3. Backfill: las filas YA radicadas del canal pasaron por RUNT bloqueante, asi que su
--    organismo no es NULL. Se marcan `verificacion_estado = 'ok'`. `soat_vigente*` se deja
--    NULL (no se persistia). Las filas nuevas del canal nacen con organismo NULL y se quedan
--    en `pendiente` — el predicado del UPDATE no las toca.
--
-- DROP NOT NULL dos veces es un no-op. ADD COLUMN IF NOT EXISTS igual. El CHECK se recicla
-- con DROP IF EXISTS + ADD, el mismo patron de la 0167.

-- ── 1. organismo_codigo nullable ─────────────────────────────────────────────
--
-- Idempotente por definicion: quitar NOT NULL de una columna que ya admite NULL no cambia
-- nada. La FK no se nombra a proposito: no se toca.
ALTER TABLE flito_soat
  ALTER COLUMN organismo_codigo DROP NOT NULL;

-- ── 2. Satelite: cuatro columnas de producto ─────────────────────────────────

ALTER TABLE flito_soat_solicitud
  ADD COLUMN IF NOT EXISTS verificacion_estado varchar(20) NOT NULL DEFAULT 'pendiente';

ALTER TABLE flito_soat_solicitud
  ADD COLUMN IF NOT EXISTS soat_vigente boolean;

ALTER TABLE flito_soat_solicitud
  ADD COLUMN IF NOT EXISTS soat_vigente_hasta date;

ALTER TABLE flito_soat_solicitud
  ADD COLUMN IF NOT EXISTS verificacion_codigo varchar(40);

-- PostgreSQL no admite ADD CONSTRAINT IF NOT EXISTS. DROP + ADD, como la 0167.
ALTER TABLE flito_soat_solicitud
  DROP CONSTRAINT IF EXISTS flito_soat_solicitud_verificacion_estado_chk;
ALTER TABLE flito_soat_solicitud
  ADD CONSTRAINT flito_soat_solicitud_verificacion_estado_chk
  CHECK (verificacion_estado IN ('pendiente', 'caido', 'sin_registro', 'no_cuadra', 'ok'));

COMMENT ON COLUMN flito_soat_solicitud.verificacion_estado IS
  'HU #11935: pendiente (aun no corrio) | caido | sin_registro | no_cuadra | ok. '
  'No se persiste el payload crudo del RUNT.';

COMMENT ON COLUMN flito_soat_solicitud.soat_vigente IS
  'true/false solo con lectura concluyente (ok). NULL en pendiente/caido/sin_registro/no_cuadra.';

COMMENT ON COLUMN flito_soat_solicitud.soat_vigente_hasta IS
  'yyyy-mm-dd si soat_vigente=true y el RUNT trajo fecha. NULL si no.';

COMMENT ON COLUMN flito_soat_solicitud.verificacion_codigo IS
  'Codigo maquina: runt_no_disponible | runt_sin_registro | runt_no_cuadra | organismo_no_catalogado. '
  'Nunca el payload crudo.';

-- ── 3. Backfill de filas viejas del canal ────────────────────────────────────
--
-- Predicado: origen=cliente AND organismo_codigo IS NOT NULL AND todavia pendiente.
-- Las filas historicas tenian organismo obligatorio (ADR-0008). Las que nazcan con esta HU
-- tienen organismo NULL hasta que el job cruce catalogo, y se quedan en pendiente.
-- Segunda pasada: las ya marcadas `ok` no entran en el WHERE.
UPDATE flito_soat_solicitud s
   SET verificacion_estado = 'ok'
  FROM flito_soat so
 WHERE s.soat_id = so.id
   AND so.origen = 'cliente'
   AND so.organismo_codigo IS NOT NULL
   AND s.verificacion_estado = 'pendiente';
