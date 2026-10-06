-- 0221_flito_impuesto_envios_destino_flit1.sql
-- HU #13310 (Feature #13309, Épica #12741) — el outbox del comprobante de pago (0219) pasa a servir a dos
--   destinos: FLIT 2 (como hasta hoy) y FLIT 1 (trámites fuente 'flit', subida en tres pasos). Una fila por
--   impuesto sigue siendo la regla: un trámite tiene una sola fuente, así que un solo destino.
-- Autor: equipo FLITO. Antecedentes: 0219, ADR-0020, ADR-0021 (Aceptado 2026-10-06),
--   docs/diseno/feature-13309-envio-comprobante-flit1.md §6.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo.
--   - Idempotente: ADD COLUMN IF NOT EXISTS; cada CHECK se añade solo si no existe en pg_constraint.
--   - Sin backfill de filas nuevas (AC8: no hay envío retroactivo). La tabla NO se renombra.

-- Las filas existentes son todas de FLIT 2: el DEFAULT las rellena (metadato en PG >= 11, sin reescritura).
-- El DEFAULT 'flit2' es TRANSITORIO y se conserva a propósito: compatibilidad en caliente con el binario
-- anterior, cuyo pago inserta en este outbox sin `destino` dentro de su transacción (sin DEFAULT → 23502 y
-- pago abortado en la ventana del CD o tras un rollback de imagen). Se retira en una migración posterior,
-- cuando el binario de la #13310 esté en todos los ambientes (README de migraciones: los cierres de
-- NOT NULL/retiros en tabla existente van en la migración siguiente). Drizzle no lo declara: TS obliga a
-- pasar `destino` en todo insert nuevo.
ALTER TABLE flito_impuesto_envios_flit2 ADD COLUMN IF NOT EXISTS destino varchar(10) NOT NULL DEFAULT 'flit2';
-- Id del archivo en FLIT 1 (paso 1), solo tras subirlo bien (paso 2): permite reintentar solo el PUT.
ALTER TABLE flito_impuesto_envios_flit2 ADD COLUMN IF NOT EXISTS archivo_flit1_id varchar(100) NULL;
-- Paso (1-3) del último desenlace de FLIT 1; null en pre-validación local.
ALTER TABLE flito_impuesto_envios_flit2 ADD COLUMN IF NOT EXISTS ultimo_paso smallint NULL;

DO $m0221$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_impuesto_envios_flit2_destino') THEN
    ALTER TABLE flito_impuesto_envios_flit2 ADD CONSTRAINT ck_flito_impuesto_envios_flit2_destino
      CHECK (destino IN ('flit1','flit2'));
  END IF;
  -- Una fila FLIT 1 nunca usa la semántica de FLIT 2 (en_espera, gestor, estado remoto, adjunto de FLIT 2).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_impuesto_envios_flit2_flit1_estado') THEN
    ALTER TABLE flito_impuesto_envios_flit2 ADD CONSTRAINT ck_flito_impuesto_envios_flit2_flit1_estado
      CHECK (destino = 'flit2' OR (
        estado IN ('pendiente','enviado','error','sin_comprobante')
        AND sync_version_espera IS NULL AND en_espera_desde IS NULL
        AND estado_flit2 IS NULL AND adjunto_id IS NULL));
  END IF;
  -- Y una fila FLIT 2 nunca lleva columnas de FLIT 1.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_impuesto_envios_flit2_flit1_cols') THEN
    ALTER TABLE flito_impuesto_envios_flit2 ADD CONSTRAINT ck_flito_impuesto_envios_flit2_flit1_cols
      CHECK (destino = 'flit1' OR (archivo_flit1_id IS NULL AND ultimo_paso IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_impuesto_envios_flit2_ultimo_paso') THEN
    ALTER TABLE flito_impuesto_envios_flit2 ADD CONSTRAINT ck_flito_impuesto_envios_flit2_ultimo_paso
      CHECK (ultimo_paso IS NULL OR ultimo_paso BETWEEN 1 AND 3);
  END IF;
END $m0221$;

COMMENT ON TABLE flito_impuesto_envios_flit2 IS
  'Outbox del envío del comprobante de pago del impuesto (una fila por impuesto). Pese al nombre, sirve a FLIT 2 y a FLIT 1 según la columna destino (0221, ADR-0021).';
