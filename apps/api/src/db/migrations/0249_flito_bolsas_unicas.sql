-- 0249_flito_bolsas_unicas.sql
-- HU #13899 (Feature #13886, Épica #13412) — modelo ÚNICO de bolsa (ADR-0029, Opción A).
-- Diseño: docs/arquitectura/feature-13886-13887-bolsa-unica.md («Modelo de datos», «Plan de migración»).
--
-- Solo DDL: seis tablas nuevas `flito_bolsas_unicas*`. Los datos del cliente los copia la 0250; los de
-- tránsito, la 0251 (HU-F). Los libros viejos quedan intactos hasta la migración de retiro (HU-I).
-- Espejo de `src/db/schema/flito-bolsas-unicas.ts` (CHECKs e índices en los dos lados, lección 0157).
-- Autor: backend-agent (HU #13899), revisión humana en el PR.
-- Idempotente; sin control de transacción propio (lo pone el runner, ADR-DB-001).

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alcance               varchar(12)   NOT NULL,
  nombre                varchar(120),
  compania_id           integer       REFERENCES clients(id) ON DELETE RESTRICT,
  activa                boolean       NOT NULL DEFAULT true,
  saldo                 numeric(14,2) NOT NULL DEFAULT 0,
  ultima_entrada_valor  numeric(14,2),
  ultima_entrada_en     timestamptz,
  inactivada_en         timestamptz,
  inactivada_por_id     integer       REFERENCES users(id) ON DELETE SET NULL,
  inactivada_por_nombre varchar(150),
  motivo_inactivacion   text,
  creada_por_id         integer       REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT flito_bolsas_unicas_alcance_chk CHECK (alcance IN ('compania','transito')),
  CONSTRAINT flito_bolsas_unicas_forma_chk CHECK (
    (alcance = 'compania' AND compania_id IS NOT NULL)
    OR (alcance = 'transito' AND compania_id IS NULL AND nombre IS NOT NULL)),
  CONSTRAINT flito_bolsas_unicas_inactiva_chk CHECK (activa OR inactivada_en IS NOT NULL)
);
-- D1/D3: 1:1 compañía-bolsa INCLUIDA la inactiva. Parcial: la tabla NO tiene unique(compania_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_compania
  ON flito_bolsas_unicas (compania_id) WHERE alcance = 'compania';
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_nombre_transito
  ON flito_bolsas_unicas (nombre) WHERE alcance = 'transito';

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas_conceptos (
  bolsa_id uuid        NOT NULL REFERENCES flito_bolsas_unicas(id) ON DELETE RESTRICT,
  concepto varchar(30) NOT NULL,
  CONSTRAINT flito_bolsas_unicas_conceptos_pk PRIMARY KEY (bolsa_id, concepto),
  CONSTRAINT flito_bolsas_unicas_conceptos_chk CHECK (concepto IN
    ('soat','impuesto','derecho','tramite_digital','logistica','servicios_adicionales'))
);

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas_cobertura (
  bolsa_id         uuid        NOT NULL REFERENCES flito_bolsas_unicas(id) ON DELETE RESTRICT,
  organismo_codigo varchar(5)  NOT NULL REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  concepto         varchar(20) NOT NULL,
  activa           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_bolsas_unicas_cobertura_pk PRIMARY KEY (bolsa_id, organismo_codigo, concepto),
  CONSTRAINT flito_bolsas_unicas_cobertura_concepto_chk CHECK (concepto IN ('derecho','soat','impuesto'))
);
-- D3: sucesor de uq_bolsa_transito_cobertura, ahora SOLO entre activas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_cobertura_activa
  ON flito_bolsas_unicas_cobertura (organismo_codigo, concepto) WHERE activa;
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_cobertura_bolsa
  ON flito_bolsas_unicas_cobertura (bolsa_id);

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas_movimientos (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id               uuid          NOT NULL REFERENCES flito_bolsas_unicas(id) ON DELETE RESTRICT,
  tipo                   varchar(10)   NOT NULL,
  origen                 varchar(20)   NOT NULL,
  concepto               varchar(30),
  organismo_codigo       varchar(5)    REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  tramite_id             uuid          REFERENCES flito_tramites(id) ON DELETE SET NULL,
  comprobante_id         uuid          REFERENCES flito_comprobantes(id) ON DELETE RESTRICT,
  valor                  numeric(14,2) NOT NULL,
  saldo_resultante       numeric(14,2) NOT NULL,
  periodo                varchar(7)    NOT NULL,
  fecha                  date          NOT NULL,
  observacion            text,
  soporte_id             uuid          REFERENCES flito_soportes(id) ON DELETE RESTRICT,
  registrado_por_id      integer       REFERENCES users(id) ON DELETE SET NULL,
  registrado_por_nombre  varchar(150)  NOT NULL,
  llave_idempotencia     varchar(200),
  corrige_movimiento_id  uuid,
  revierte_movimiento_id uuid,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT flito_bolsas_unicas_mov_tipo_chk CHECK (tipo IN ('entrada','salida')),
  CONSTRAINT flito_bolsas_unicas_mov_valor_chk CHECK (valor > 0)
);
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_bolsa
  ON flito_bolsas_unicas_movimientos (bolsa_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_periodo
  ON flito_bolsas_unicas_movimientos (bolsa_id, periodo);
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_organismo
  ON flito_bolsas_unicas_movimientos (organismo_codigo, concepto) WHERE organismo_codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_tramite
  ON flito_bolsas_unicas_movimientos (tramite_id) WHERE tramite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_comprobante
  ON flito_bolsas_unicas_movimientos (comprobante_id) WHERE comprobante_id IS NOT NULL;
-- Única protección anti doble cobro (llaves de ADR-0006 incluidas).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_mov_llave
  ON flito_bolsas_unicas_movimientos (llave_idempotencia) WHERE llave_idempotencia IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_mov_corrige
  ON flito_bolsas_unicas_movimientos (corrige_movimiento_id) WHERE corrige_movimiento_id IS NOT NULL;
-- D13: una sola reversión por movimiento original.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_mov_revierte
  ON flito_bolsas_unicas_movimientos (revierte_movimiento_id) WHERE revierte_movimiento_id IS NOT NULL;

-- FK auto-referenciales (Drizzle no las tipa bien en self-ref): solo en el SQL.
DO $m0249$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_corrige_fk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_corrige_fk
      FOREIGN KEY (corrige_movimiento_id) REFERENCES flito_bolsas_unicas_movimientos(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_revierte_fk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_revierte_fk
      FOREIGN KEY (revierte_movimiento_id) REFERENCES flito_bolsas_unicas_movimientos(id) ON DELETE RESTRICT;
  END IF;
END $m0249$;

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas_cierres (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id           uuid          NOT NULL REFERENCES flito_bolsas_unicas(id) ON DELETE RESTRICT,
  periodo            varchar(7)    NOT NULL,
  saldo_inicial      numeric(14,2) NOT NULL,
  total_entradas     numeric(14,2) NOT NULL,
  total_salidas      numeric(14,2) NOT NULL,
  saldo_final        numeric(14,2) NOT NULL,
  movimientos        integer       NOT NULL,
  observaciones      text,
  cerrado_por_id     integer       REFERENCES users(id) ON DELETE SET NULL,
  cerrado_por_nombre varchar(150)  NOT NULL,
  cerrado_en         timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_unicas_cierre_periodo
  ON flito_bolsas_unicas_cierres (bolsa_id, periodo);

CREATE TABLE IF NOT EXISTS flito_bolsas_unicas_eventos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolsa_id       uuid         NOT NULL REFERENCES flito_bolsas_unicas(id) ON DELETE RESTRICT,
  accion         varchar(20)  NOT NULL,
  motivo         text,
  snapshot       jsonb        NOT NULL,
  usuario_id     integer      REFERENCES users(id) ON DELETE SET NULL,
  usuario_nombre varchar(150) NOT NULL,
  created_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_unicas_eventos_bolsa
  ON flito_bolsas_unicas_eventos (bolsa_id, created_at);

-- CHECKs heredados de los libros viejos (0116, 0117, 0118). Van FUERA del CREATE TABLE, uno por uno
-- con IF NOT EXISTS, para que entren también donde la tabla ya existía (re-ejecución idempotente).
--   · periodo con formato: el bloqueo de mes cerrado compara el periodo como cadena, así que uno mal
--     formado se saltaría el cierre;
--   · dominio de `origen` (OrigenMovimientoBolsa + 'comprobante', que llega con la HU-C de #13886);
--   · un movimiento no se corrige ni se revierte a sí mismo;
--   · totales y conteo de un cierre no negativos;
--   · valor y fecha de la última entrada van juntos.
DO $m0249chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_ultima_entrada_chk') THEN
    ALTER TABLE flito_bolsas_unicas ADD CONSTRAINT flito_bolsas_unicas_ultima_entrada_chk
      CHECK ((ultima_entrada_valor IS NULL) = (ultima_entrada_en IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_periodo_chk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_periodo_chk
      CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_origen_chk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_origen_chk
      CHECK (origen IN ('recarga','automatico','manual','conciliacion','comprobante'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_corrige_chk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_corrige_chk
      CHECK (corrige_movimiento_id IS NULL OR corrige_movimiento_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_mov_revierte_chk') THEN
    ALTER TABLE flito_bolsas_unicas_movimientos ADD CONSTRAINT flito_bolsas_unicas_mov_revierte_chk
      CHECK (revierte_movimiento_id IS NULL OR revierte_movimiento_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_cierre_periodo_chk') THEN
    ALTER TABLE flito_bolsas_unicas_cierres ADD CONSTRAINT flito_bolsas_unicas_cierre_periodo_chk
      CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_cierre_totales_chk') THEN
    ALTER TABLE flito_bolsas_unicas_cierres ADD CONSTRAINT flito_bolsas_unicas_cierre_totales_chk
      CHECK (total_entradas >= 0 AND total_salidas >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_bolsas_unicas_cierre_movimientos_chk') THEN
    ALTER TABLE flito_bolsas_unicas_cierres ADD CONSTRAINT flito_bolsas_unicas_cierre_movimientos_chk
      CHECK (movimientos >= 0);
  END IF;
END $m0249chk$;
