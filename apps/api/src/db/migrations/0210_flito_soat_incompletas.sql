-- 0210_flito_soat_incompletas.sql
-- Autor: David Chica (backend-agent)
-- HU #12996 (Feature #12841, Épica #12616; ADR-0019 opción A, diseño §5.1).
-- Tabla de ESPERA del canal Cliente: la solicitud cuyo RUNT no respondió se aparca aquí con su
-- factura y su propietario, y NO es una fila de `flito_soat` (ningún lector de la cola, del Excel,
-- del ZIP ni del envío al gestor la ve). La incompleta abierta ocupa el VIN (índice único parcial);
-- la descartada no. El propietario vive en `flito_compradores` con un tercer padre opcional
-- (`soat_incompleta_id`), y el CHECK de padre se amplía para admitirlo.
--
-- Idempotente (se puede correr dos veces). Sin BEGIN/COMMIT: el runner envuelve (ADR-DB-001).

CREATE TABLE IF NOT EXISTS flito_soat_incompletas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  soat_id_reservado      uuid NOT NULL UNIQUE,
  soat_id                uuid REFERENCES flito_soat(id),
  compania_id            integer NOT NULL REFERENCES clients(id),
  vin                    varchar(17) NOT NULL,
  estado                 varchar(12) NOT NULL DEFAULT 'incompleta',
  factura_storage_key    text NOT NULL,
  factura_hash           varchar(64) NOT NULL,
  factura_nombre_archivo varchar(255) NOT NULL,
  factura_content_type   varchar(100) NOT NULL,
  factura_tamano_bytes   integer NOT NULL,
  solicitado_por_id      integer REFERENCES users(id),
  solicitado_por_nombre  varchar(150) NOT NULL,
  solicitado_en          timestamptz NOT NULL DEFAULT now(),
  intentos               smallint NOT NULL DEFAULT 1,
  ultimo_intento_en      timestamptz NOT NULL DEFAULT now(),
  ultimo_intento_por_id  integer REFERENCES users(id),
  ultima_causa_caida     varchar(10),
  resuelta_por_id        integer REFERENCES users(id),
  resuelta_por_nombre    varchar(150),
  resuelta_en            timestamptz,
  motivo_descarte        varchar(40),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_soat_incompletas_estado_chk
    CHECK (estado IN ('incompleta', 'completada', 'descartada')),
  CONSTRAINT flito_soat_incompletas_motivo_chk
    CHECK (motivo_descarte IS NULL OR motivo_descarte IN
      ('soat_vigente', 'runt_no_cuadra', 'runt_sin_registro', 'runt_sin_vin', 'solicitud_existente')),
  CONSTRAINT flito_soat_incompletas_causa_chk
    CHECK (ultima_causa_caida IS NULL OR ultima_causa_caida IN ('timeout', 'red', 'circuito', 'otro')),
  CONSTRAINT flito_soat_incompletas_intentos_chk CHECK (intentos >= 1),
  CONSTRAINT flito_soat_incompletas_descarte_chk
    CHECK ((estado = 'descartada') =
      (motivo_descarte IS NOT NULL AND resuelta_en IS NOT NULL AND resuelta_por_nombre IS NOT NULL)),
  CONSTRAINT flito_soat_incompletas_completada_chk
    CHECK ((estado = 'completada') =
      (soat_id IS NOT NULL AND soat_id = soat_id_reservado AND resuelta_en IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_incompletas_vin_abierta
  ON flito_soat_incompletas (vin) WHERE estado = 'incompleta';
CREATE INDEX IF NOT EXISTS idx_flito_soat_incompletas_compania_estado
  ON flito_soat_incompletas (compania_id, estado);

COMMENT ON TABLE flito_soat_incompletas IS
  'Feature #12841 / ADR-0019: solicitudes del canal Cliente aparcadas porque el RUNT no respondió. NO son SOAT: no las lee ningún lector de flito_soat.';

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS soat_incompleta_id uuid REFERENCES flito_soat_incompletas(id);
CREATE INDEX IF NOT EXISTS idx_flito_compradores_soat_incompleta
  ON flito_compradores (soat_incompleta_id) WHERE soat_incompleta_id IS NOT NULL;

-- El CHECK de padre era «trámite XOR SOAT». Pasa a «trámite XOR (SOAT o incompleta)»: la fila del
-- canal Cliente cuelga de la incompleta mientras espera y, al completarse (HU de reintento del Feature #12841), gana también
-- `soat_id` sin perder el rastro. Una fila de trámite nunca lleva ninguno de los dos del canal.
-- Solo se reemplaza si la definición vigente aún no cuenta la columna nueva (segunda corrida = no-op).
DO $padre_0210$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flito_compradores_padre_chk'
      AND conrelid = 'flito_compradores'::regclass
      AND pg_get_constraintdef(oid) LIKE '%soat_incompleta_id%'
  ) THEN
    ALTER TABLE flito_compradores DROP CONSTRAINT IF EXISTS flito_compradores_padre_chk;
    ALTER TABLE flito_compradores
      ADD CONSTRAINT flito_compradores_padre_chk
      CHECK ((tramite_id IS NOT NULL) <> (soat_id IS NOT NULL OR soat_incompleta_id IS NOT NULL));
  END IF;
END $padre_0210$;

DO $verifica_0210$
BEGIN
  IF to_regclass('public.flito_soat_incompletas') IS NULL THEN
    RAISE EXCEPTION '0210: falta la tabla flito_soat_incompletas';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'flito_soat_incompletas'
      AND indexname = 'uq_flito_soat_incompletas_vin_abierta'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%incompleta%'
  ) THEN
    RAISE EXCEPTION '0210: falta el índice único parcial uq_flito_soat_incompletas_vin_abierta';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'flito_compradores' AND column_name = 'soat_incompleta_id'
  ) THEN
    RAISE EXCEPTION '0210: falta la columna flito_compradores.soat_incompleta_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flito_compradores_padre_chk'
      AND conrelid = 'flito_compradores'::regclass
      AND pg_get_constraintdef(oid) LIKE '%soat_incompleta_id%'
  ) THEN
    RAISE EXCEPTION '0210: flito_compradores_padre_chk no cuenta soat_incompleta_id';
  END IF;
END $verifica_0210$;
