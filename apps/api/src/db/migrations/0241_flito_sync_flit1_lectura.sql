-- 0241_flito_sync_flit1_lectura.sql
-- HU #13628 (Feature #13612, Épica #13576) — parámetros de la lectura automática de FLIT 1 y estado de
--   la lectura (lo llena la HU #13629). Fila única sembrada con los defaults: sin cambio de
--   comportamiento al desplegar. Los parámetros son propios de cada ambiente: viven en la base.
-- Autor: equipo FLITO. Antecedentes: 0215 (fila única de lectura de FLIT 2, calco), 0217 (interruptor por
--   fuente; NO se reutiliza: su fila se bloquea en cada guarda del cron), ADR-DB-001 (sin control de
--   transacción propio). Diseño: docs/diseno/hu-13628-parametros-lectura-flit1.md.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING. La 2a pasada NO pisa parámetros guardados.
--   - SIN literales de rol ni filas de permisos: no hay función ni página nueva (el PUT reutiliza
--     `tramites.sincronizacion.configurar`, sembrada por la 0217; la 0227 tumbó DEV por FK a roles).
--   - «arranque no futuro» no es CHECK (depende de now(), que no es inmutable): lo valida el API.
--   - Los límites de los CHECK repiten `LIMITES_PARAMETROS_LECTURA_FLIT1` (shared-types); el test de la
--     migración ata ambos.

CREATE TABLE IF NOT EXISTS flito_sync_flit1_lectura (
  id                          smallint    PRIMARY KEY DEFAULT 1,
  frecuencia_minutos          smallint    NOT NULL DEFAULT 2,
  ventana_dias                smallint    NOT NULL DEFAULT 7,
  ventana_nocturna_dias       smallint    NOT NULL DEFAULT 60,
  arranque                    date        NULL,          -- null = «hoy − 1 mes» (Bogotá), calculado al leer
  parametros_actualizados_en  timestamptz NULL,          -- null = nadie los ha guardado (AC1)
  parametros_actualizados_por integer     NULL REFERENCES users(id),
  ultima_buena_en             timestamptz NULL,          -- AC8, lo escribe la #13629
  proxima_prevista_en         timestamptz NULL,          -- AC8, lo escribe la #13629
  ultimo_fallo_en             timestamptz NULL,          -- AC8, lo escribe la #13629
  ultimo_fallo_codigo         varchar(40) NULL,          -- AC8, código técnico, nunca texto libre
  CONSTRAINT ck_flito_sync_flit1_lectura_una_fila   CHECK (id = 1),
  CONSTRAINT ck_flito_sync_flit1_lectura_frecuencia CHECK (frecuencia_minutos BETWEEN 2 AND 60),
  CONSTRAINT ck_flito_sync_flit1_lectura_ventana    CHECK (ventana_dias BETWEEN 1 AND 90),
  CONSTRAINT ck_flito_sync_flit1_lectura_nocturna   CHECK (ventana_nocturna_dias BETWEEN 7 AND 90),
  CONSTRAINT ck_flito_sync_flit1_lectura_nocturna_ge_ventana CHECK (ventana_nocturna_dias >= ventana_dias),
  CONSTRAINT ck_flito_sync_flit1_lectura_fallo_par  CHECK ((ultimo_fallo_en IS NULL) = (ultimo_fallo_codigo IS NULL)),
  CONSTRAINT ck_flito_sync_flit1_lectura_fallo_codigo CHECK (ultimo_fallo_codigo IS NULL OR ultimo_fallo_codigo ~ '^[a-z0-9_]{1,40}$')
);

COMMENT ON TABLE flito_sync_flit1_lectura IS
  'HU #13628: parámetros de la lectura automática de FLIT 1 (propios del ambiente) y estado de la lectura (HU #13629). Una fila (id = 1). arranque null = hoy − 1 mes en America/Bogota.';

INSERT INTO flito_sync_flit1_lectura (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $resumen0241$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM flito_sync_flit1_lectura WHERE id = 1;
  IF n <> 1 THEN RAISE EXCEPTION '0241: flito_sync_flit1_lectura sin su fila única (n=%)', n; END IF;
  RAISE NOTICE '0241: flito_sync_flit1_lectura lista (fila única sembrada con los defaults)';
END $resumen0241$;
