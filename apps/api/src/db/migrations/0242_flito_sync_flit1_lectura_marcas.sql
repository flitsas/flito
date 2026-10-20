-- 0242_flito_sync_flit1_lectura_marcas.sql
-- HU #13629 (Feature #13612, Épica #13576) — marcas de la lectura automática de FLIT 1.
--   `ultima_corrida_en`: inicio de la última corrida automática (buena o fallida). Se escribe AL EMPEZAR,
--     con el candado tomado: un proceso que muere a mitad no provoca un reintento cada minuto.
--   `nocturna_buena_dia`: día (America/Bogota) de la última lectura nocturna buena.
-- Autor: equipo FLITO. Antecedente: 0241 (tabla y fila única). Diseño: docs/diseno/hu-13629-lectura-automatica-flit1.md §D2.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ADD COLUMN IF NOT EXISTS; COMMENT ON es repetible.
--   - Sin literales de rol ni filas de permisos.
--   - Columnas nullables sin default: no reescriben la tabla (una fila) y no cambian el estado expuesto.

ALTER TABLE flito_sync_flit1_lectura ADD COLUMN IF NOT EXISTS ultima_corrida_en  timestamptz NULL;
ALTER TABLE flito_sync_flit1_lectura ADD COLUMN IF NOT EXISTS nocturna_buena_dia date        NULL;

COMMENT ON COLUMN flito_sync_flit1_lectura.ultima_corrida_en IS
  'HU #13629: inicio de la última corrida automática de FLIT 1 (buena o fallida). Base de «¿toca la periódica?».';
COMMENT ON COLUMN flito_sync_flit1_lectura.nocturna_buena_dia IS
  'HU #13629: día (America/Bogota) de la última lectura nocturna buena de FLIT 1.';

DO $resumen0242$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'flito_sync_flit1_lectura'
     AND column_name IN ('ultima_corrida_en', 'nocturna_buena_dia');
  IF n <> 2 THEN RAISE EXCEPTION '0242: faltan columnas de marcas en flito_sync_flit1_lectura (n=%)', n; END IF;
  RAISE NOTICE '0242: flito_sync_flit1_lectura con ultima_corrida_en y nocturna_buena_dia';
END $resumen0242$;
