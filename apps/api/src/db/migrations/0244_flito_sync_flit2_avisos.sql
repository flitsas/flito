-- 0244_flito_sync_flit2_avisos.sql
-- HU #13632 (Feature #13613, Épica #13576) — marcas de los avisos firmados de FLIT 2 en la fila única de
-- lectura (`flito_sync_flit2_lectura`, id = 1, sembrada por la 0215).
--   `ultimo_aviso_en`: último aviso con cuerpo válido (cualquier tipo, también duplicados).
--   `rechazos_firma_seguidos`: avisos con firma ausente, mal formada o incorrecta desde la última firma válida.
-- Autor: equipo FLITO. Diseño: docs/diseno/hu-13632-avisos-flit2.md §(c) y «Modelo de datos».
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: ADD COLUMN IF NOT EXISTS, CHECK solo si no existe, COMMENT ON es repetible.
--   - Sin literales de rol ni filas de permisos.
--   - Tabla de una fila: el ADD COLUMN con DEFAULT 0 es instantáneo.

ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS ultimo_aviso_en         timestamptz NULL;
ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS rechazos_firma_seguidos integer     NOT NULL DEFAULT 0;

DO $check0244$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_sync_flit2_lectura_rechazos_firma') THEN
    ALTER TABLE flito_sync_flit2_lectura
      ADD CONSTRAINT ck_flito_sync_flit2_lectura_rechazos_firma CHECK (rechazos_firma_seguidos >= 0);
    RAISE NOTICE '0244: CHECK ck_flito_sync_flit2_lectura_rechazos_firma creado';
  ELSE
    RAISE NOTICE '0244: CHECK ck_flito_sync_flit2_lectura_rechazos_firma ya existía';
  END IF;
END $check0244$;

COMMENT ON COLUMN flito_sync_flit2_lectura.ultimo_aviso_en IS
  'HU #13632: último aviso de FLIT 2 con firma y cuerpo válidos.';
COMMENT ON COLUMN flito_sync_flit2_lectura.rechazos_firma_seguidos IS
  'HU #13632: avisos con firma inválida desde la última firma válida (aproximado con varios procesos).';

DO $resumen0244$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'flito_sync_flit2_lectura'
     AND column_name IN ('ultimo_aviso_en', 'rechazos_firma_seguidos');
  IF n <> 2 THEN RAISE EXCEPTION '0244: faltan columnas de avisos en flito_sync_flit2_lectura (n=%)', n; END IF;
  RAISE NOTICE '0244: flito_sync_flit2_lectura con ultimo_aviso_en y rechazos_firma_seguidos';
END $resumen0244$;
