-- 0219_flito_impuesto_envios_flit2.sql
-- HU #13268 (Feature #13267, Épica #12741) — outbox del envío del comprobante de pago del impuesto a
--   FLIT 2: una fila por impuesto (`flito_impuesto_envios_flit2`) con el estado vigente del envío,
--   sus intentos y el último desenlace. La programa el pago (dentro de su transacción) y la vacía el
--   cron `flito-impuestos-envio-flit2`. Nace ya con `en_espera` (409 terminal:false, D-1), las
--   columnas de espera y su CHECK bicondicional. SIN backfill: los pagados previos no tienen fila (AC3).
-- Autor: equipo FLITO. Antecedentes: 0215 (`id_flit2`/`sync_version` en `flito_tramites`), diseño
--   `docs/diseno/feature-13267-envio-comprobante-flit2.md` §6, ADR-0020, ADR-DB-001.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo.
--   - Idempotente: CREATE TABLE / INDEX IF NOT EXISTS (los CHECK van dentro de la tabla); la 2a
--     pasada no toca nada.
--   - `estado` es varchar + CHECK, no enum: ampliar un enum es la trampa 55P04 (0101, 0176).
--   - `soporte_id` sin FK (se re-resuelve al enviar, RN-06); `impuesto_id` con FK ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS flito_impuesto_envios_flit2 (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  impuesto_id         uuid         NOT NULL REFERENCES flito_impuestos(id) ON DELETE CASCADE,
  estado              varchar(20)  NOT NULL,
  soporte_id          uuid         NULL,
  intentos            smallint     NOT NULL DEFAULT 0,
  proximo_intento_en  timestamptz  NULL,
  ultimo_intento_en   timestamptz  NULL,
  ultimo_resultado    varchar(40)  NULL,
  ultimo_status       smallint     NULL,
  estado_flit2        varchar(30)  NULL,
  sync_version_espera bigint       NULL,
  en_espera_desde     timestamptz  NULL,
  adjunto_id          uuid         NULL,
  sha256              varchar(64)  NULL,
  soporte_enviado_id  uuid         NULL,
  reemplazo_de        uuid         NULL,
  en_matriz           boolean      NULL,
  pagado_marcado      boolean      NULL,
  enviado_en          timestamptz  NULL,
  version             integer      NOT NULL DEFAULT 1,
  tomado_por          varchar(100) NULL,
  tomado_en           timestamptz  NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_flito_impuesto_envios_flit2_estado
    CHECK (estado IN ('pendiente','en_espera','enviado','ya_cargado_gestor','error','sin_comprobante')),
  CONSTRAINT ck_flito_impuesto_envios_flit2_soporte
    CHECK ((estado = 'sin_comprobante') = (soporte_id IS NULL)),
  CONSTRAINT ck_flito_impuesto_envios_flit2_espera
    CHECK ((estado = 'en_espera') = (sync_version_espera IS NOT NULL AND en_espera_desde IS NOT NULL)),
  CONSTRAINT ck_flito_impuesto_envios_flit2_intentos
    CHECK (intentos BETWEEN 0 AND 10)
);

-- Una fila por impuesto: impide dos envíos vivos del mismo impuesto y es el blanco del ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_impuesto_envios_flit2_impuesto
  ON flito_impuesto_envios_flit2 (impuesto_id);

-- Índice parcial de la cola: solo lo que el cron puede tomar.
CREATE INDEX IF NOT EXISTS idx_flito_impuesto_envios_flit2_cola
  ON flito_impuesto_envios_flit2 (estado, proximo_intento_en)
  WHERE estado IN ('pendiente','en_espera');
